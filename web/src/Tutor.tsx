import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type RemoteTrack,
  type TranscriptionSegment,
} from 'livekit-client'
import History from './History'
import {
  consumeOAuthHash,
  fetchRoomToken,
  getUnitStats,
  githubAuthUrl,
  putSession,
  saveApiToken,
  type Account,
  type Correction,
  type SessionPayload,
} from './api'
import UnitDrawer from './UnitDrawer'
import { loadUnits, unitBrief, unitLabel, type UnitData } from './units'

/** GitHub 账号列表(写历史凭证)与当前登录者,存 localStorage */
const ACCOUNTS_KEY = 'tutor-accounts'
const CURRENT_KEY = 'tutor-current'
/** 我方 participant identity(后端签 token 时写死),转录按身份区分左右气泡 */
const MY_IDENTITY = 'max'
/** 前端版本号:每次改前端手动 +1,页脚展示,用于核对线上是否为最新部署 */
const APP_VERSION = 'v13'
/** 挂断自动保存的最多尝试次数 */
const SAVE_ATTEMPTS = 3
/** 新纠错提示在视频上停留的毫秒数 */
const TOAST_MS = 5000
/** 页面参数:?unit=N 练指定单元;?history=unit:N 打开历史并只看该单元(站点学习路径页跳来) */
const PARAMS = new URLSearchParams(location.search)
const PARAM_UNIT = PARAMS.has('unit') ? Number(PARAMS.get('unit')) : null
const PARAM_HISTORY_UNIT = /^unit:(\d+)$/.exec(PARAMS.get('history') ?? '')?.[1]
/** 首页场景快捷按钮:点一下填进场景输入框 */
const SCENARIO_CHIPS = ['点咖啡', '问路', '自我介绍', '超市购物', '等公交']

type Status = 'idle' | 'connecting' | 'connected'
type Tab = 'chat' | 'notes'

/** 一条字幕:同 id 的流式片段会反复到达,聚合覆盖 */
export type Msg = { id: string; role: 'emma' | 'me'; text: string }

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

/** 比较句子时忽略大小写、标点和多余空格 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')

const KIND_LABEL: Record<string, string> = {
  grammar: '语法',
  word: '用词',
  pronunciation: '发音',
}

/** 一张纠错卡:原句→正确句 + 中文讲解 + 发音重点词(悬停看技巧)。通话中实时出现,历史回放复用 */
export function CorrectionItem({ c }: { c: Correction }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
        <span className="shrink-0 rounded-md bg-amber-400/15 px-2 py-0.5 text-xs text-amber-300">
          {KIND_LABEL[c.kind] ?? '纠错'}
        </span>
        <span className="text-gray-400 line-through decoration-gray-500">{c.original}</span>
        <span className="text-gray-400">→</span>
        <span className="font-semibold text-cyan-200">{c.corrected}</span>
      </div>
      {c.point && <p className="text-sm leading-relaxed text-slate-300">{c.point}</p>}
      {(c.words?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {c.words.map((w, i) => (
            <span
              key={i}
              className="rounded-lg bg-violet-400/10 px-2.5 py-0.5 text-[13px] text-violet-200"
              title={w.tip_cn}
            >
              {w.word} <span className="text-violet-400">{w.ipa}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 一条对话气泡:Emma 在左带头像,我在右;通话中与历史回放共用 */
export function Bubble({
  role,
  text,
  flagged,
  onFlagClick,
}: {
  role: Msg['role']
  text: string
  flagged?: boolean
  onFlagClick?: () => void
}) {
  if (role === 'emma') {
    return (
      <div className="flex items-end gap-2.5">
        <div className="emma-avatar flex size-7 flex-none items-center justify-center rounded-full text-[13px] font-bold">
          E
        </div>
        <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-[#12233a] px-3.5 py-2.5 text-[15px] leading-normal text-sky-50">
          {text}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[#2e1f5c] px-3.5 py-2.5 text-[15px] leading-normal text-violet-50">
        {text}
      </div>
      {flagged && (
        <button
          onClick={onFlagClick}
          className="rounded-md bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300 hover:bg-amber-400/20"
        >
          已记入错题本
        </button>
      )}
    </div>
  )
}

/** 说话声波:4 根柱跳动 */
function Wave() {
  const colors = ['#22d3ee', '#38bdf8', '#818cf8', '#a78bfa']
  return (
    <span aria-hidden="true" className="flex h-4 items-center gap-[3px]">
      {colors.map((c, i) => (
        <span
          key={c}
          className="wave-bar h-full w-[3px] rounded-sm"
          style={{ background: c, animationDelay: `${i * 0.13}s` }}
        />
      ))}
    </span>
  )
}

/** Emma 头像圆 + 光环;className 给尺寸与字号(可响应式) */
function EmmaAvatar({ className, pulse }: { className: string; pulse: boolean }) {
  return (
    <div className={`relative ${className}`}>
      {pulse && (
        <>
          <div className="ring absolute inset-0 rounded-full border-2 border-cyan-400" />
          <div
            className="ring absolute inset-0 rounded-full border-2 border-violet-400"
            style={{ animationDelay: '0.9s' }}
          />
        </>
      )}
      <div className="emma-avatar absolute inset-0 flex items-center justify-center rounded-full font-bold">
        E
      </div>
    </div>
  )
}

const iconProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  viewBox: '0 0 24 24',
}

function HangUpIcon() {
  return (
    <svg {...iconProps} width="28" height="28" style={{ transform: 'rotate(135deg)' }}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  )
}

function MicIcon() {
  return (
    <svg {...iconProps} width="22" height="22">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg {...iconProps} width="18" height="18">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  )
}

/**
 * AI 英语陪练页:开始练习时向后端现领短时 LiveKit token(token 里带 agent dispatch,
 * Emma 自动进房),双人短句教学;纠错卡经 data channel 实时推送。
 * 练什么:场景优先;没选场景就练多邻国单元(默认当前单元,可换已学单元复习),
 * 单元数据打开页面时从个人站点仓库实时读取(units.ts),随 token 请求交给后端→Emma。
 * 首页(单元 + 场景 + 历史抽屉)与通话页(全屏视频舞台 + 对话/错题本侧栏)两个界面。
 */
export default function Tutor() {
  /** 今日练习场景(可选):开练时随 token 请求交给 Emma 直接入戏;优先于单元 */
  const [scenario, setScenario] = useState('')
  /** 多邻国单元数据(读不到时为 null,隐藏单元卡片);选中的单元编号 */
  const [unitData, setUnitData] = useState<UnitData | null>(null)
  const [unitIdx, setUnitIdx] = useState<number | null>(null)
  /** 单元抽屉:列表 + 详情(指南)合一,本页打开不跳走 */
  const [showUnits, setShowUnits] = useState(false)
  /** 每个单元练过几次(换单元列表里显示;未登录为 null) */
  const [practiced, setPracticed] = useState<Record<number, number> | null>(null)
  /** 当前登录账号(GitHub OAuth);null 表示未登录 */
  const [current, setCurrent] = useState<Account | null>(() => {
    try {
      const list = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]') as Account[]
      return list.find((a) => a.user === localStorage.getItem(CURRENT_KEY)) ?? null
    } catch {
      return null
    }
  })
  const [showHistory, setShowHistory] = useState(PARAM_HISTORY_UNIT != null)
  /** 通知 History 重新拉取:会话保存成功时 +1 */
  const [historyTick, setHistoryTick] = useState(0)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [msgs, setMsgs] = useState<Msg[]>([])
  /** 实时错题本:agent 经 data channel(topic=correction)逐张推来 */
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [speaking, setSpeaking] = useState<'emma' | 'me' | null>(null)
  /** 头像视频(Simli 开启时 agent 侧会发布视频轨) */
  const [avatarVideo, setAvatarVideo] = useState(false)
  // Emma 的 agent 真正进房并开始工作(免费版冷启动要 10~20s,之前说话没人听)
  const [agentReady, setAgentReady] = useState(false)
  const [tab, setTab] = useState<Tab>('chat')
  /** 视频上的新纠错提示 */
  const [toast, setToast] = useState<Correction | null>(null)
  const roomRef = useRef<Room | null>(null)
  const msgIndex = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 通话中状态快照:事件回调闭包读不到最新 state,走 ref */
  const msgsRef = useRef<Msg[]>([])
  const correctionsRef = useRef<Correction[]>([])
  /** 本次会话 id:后端签房间 token 时建好(开始时间也取服务器时间) */
  const sessionIdRef = useRef<number | null>(null)
  const accountRef = useRef<Account | null>(null)
  /** 通话页顶部显示的练习内容(场景名或单元) */
  const practiceRef = useRef('')
  const endedRef = useRef(true)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  /** 头像视频轨:<video> 挂载后直接 attach(不经隐藏元素,避免双元素黑屏) */
  const avatarTrackRef = useRef<RemoteTrack | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // <video> 渲染出来后,把 track 直接挂上去
  useEffect(() => {
    if (avatarVideo && avatarTrackRef.current && videoElRef.current) {
      avatarTrackRef.current.attach(videoElRef.current)
    }
  }, [avatarVideo])

  useEffect(() => {
    document.title = 'AI English Tutor'
  }, [])

  // 读多邻国单元:默认当前单元,?unit=N 且可练时用它
  useEffect(() => {
    loadUnits()
      .then((d) => {
        setUnitData(d)
        const wanted = d.units.find((u) => u.unitIndex === PARAM_UNIT)
        setUnitIdx(wanted?.unitIndex ?? d.units[0]?.unitIndex ?? null)
      })
      .catch(() => setUnitData(null)) // 读不到就只有场景/自由聊天
  }, [])

  // 登录后、每次保存完会话后刷新各单元练习次数
  useEffect(() => {
    if (!current) {
      setPracticed(null)
      return
    }
    getUnitStats(current)
      .then(setPracticed)
      .catch(() => setPracticed(null))
  }, [current, historyTick])

  // OAuth 回跳:hash 里带 #gh=<jwt>&user=<login>,存下并设为当前账号(读完即清)
  useEffect(() => {
    const oauth = consumeOAuthHash()
    if (!oauth) return
    saveApiToken(oauth.user, oauth.token)
    const account: Account = { user: oauth.user, token: '' }
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify([account]))
    localStorage.setItem(CURRENT_KEY, oauth.user)
    setCurrent(account)
  }, [])

  useEffect(() => {
    if (status !== 'connected') return
    setSeconds(0)
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [status])

  // 新字幕进来(或切回对话页)自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, corrections, tab])

  // 离开页面时:先保存本次会话再挂断
  useEffect(
    () => () => {
      endSession()
      roomRef.current?.disconnect()
      roomRef.current = null
      clearTimeout(toastTimer.current)
    },
    [],
  )

  /** 被纠错的那句话(我说的):对话里标「已记入错题本」 */
  const flaggedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const c of corrections) {
      const target = norm(c.original)
      if (!target) continue
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m.role === 'me' && norm(m.text).includes(target)) {
          ids.add(m.id)
          break
        }
      }
    }
    return ids
  }, [msgs, corrections])

  /** 转录流式片段:同 id 反复到达(逐字补全),聚合到同一条气泡 */
  function onTranscription(segments: TranscriptionSegment[], participantIdentity?: string) {
    const role: Msg['role'] = participantIdentity === MY_IDENTITY ? 'me' : 'emma'
    setMsgs((prev) => {
      const next = [...prev]
      for (const seg of segments) {
        const key = `${participantIdentity ?? 'emma'}:${seg.id}`
        const i = msgIndex.current.get(key)
        if (i == null) {
          msgIndex.current.set(key, next.length)
          next.push({ id: key, role, text: seg.text })
        } else if (seg.text) {
          next[i] = { ...next[i], text: seg.text }
        }
      }
      msgsRef.current = next
      return next
    })
  }

  /** 新纠错卡:视频上提示几秒(正在看错题本时不打扰) */
  function showToast(card: Correction) {
    clearTimeout(toastTimer.current)
    setToast(card)
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS)
  }

  /** 通话结束:自动保存到后端(为空不存),成功后通知历史区刷新;endedRef 防挂断事件重复触发 */
  function endSession() {
    if (endedRef.current) return
    endedRef.current = true
    const id = sessionIdRef.current
    const account = accountRef.current
    const snapshot = msgsRef.current
    if (id == null || !account || !snapshot.length) return
    void saveSession(account, id, {
      msgs: snapshot.map(({ role, text }) => ({ role, text })),
      corrections: correctionsRef.current,
    })
  }

  /** 保存可重复调用(后端整体覆盖),失败间隔重试,最终失败才提示 */
  async function saveSession(account: Account, id: number, payload: SessionPayload) {
    for (let attempt = 1; ; attempt++) {
      try {
        await putSession(account, id, payload)
        setHistoryTick((t) => t + 1)
        return
      } catch (e) {
        if (attempt >= SAVE_ATTEMPTS) {
          setError(`本次练习保存失败:${e instanceof Error ? e.message : String(e)}`)
          return
        }
        await new Promise((r) => setTimeout(r, attempt * 1500))
      }
    }
  }

  function logout() {
    setCurrent(null)
    setShowHistory(false)
    localStorage.removeItem(CURRENT_KEY)
  }

  async function start() {
    if (!current) {
      window.location.href = githubAuthUrl()
      return
    }
    setStatus('connecting')
    setError('')
    setTab('chat')
    setToast(null)
    setShowHistory(false)
    setMsgs([])
    setCorrections([])
    setAgentReady(false)
    const room = new Room()
    roomRef.current = room
    // agent 的 lk.agent.state 离开 initializing 才算真在听;Simli 头像也是 agent
    // 类参与者但没有这个属性,不会误判
    const checkAgent = () => {
      for (const p of room.remoteParticipants.values()) {
        const st = p.attributes['lk.agent.state']
        if (p.isAgent && st && st !== 'initializing') {
          setAgentReady(true)
          return
        }
      }
    }
    room.on(RoomEvent.ParticipantConnected, checkAgent)
    room.on(RoomEvent.ParticipantAttributesChanged, checkAgent)
    const els: HTMLMediaElement[] = []
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach()
        el.style.display = 'none'
        document.body.appendChild(el)
        els.push(el)
      } else if (track.kind === Track.Kind.Video) {
        // Emma 的头像视频(Simli 开启时 avatar 代替 agent 发布音视频):
        // 只记 track,等 <video> 挂载后直接 attach
        avatarTrackRef.current = track
        setAvatarVideo(true)
      }
    })
    room.on(RoomEvent.TranscriptionReceived, (segments, participant) =>
      onTranscription(segments, participant?.identity),
    )
    // agent 推来的纠错卡(topic=correction),进实时错题本
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _p?: Participant, _k?: unknown, topic?: string) => {
        if (topic !== 'correction') return
        try {
          const card = JSON.parse(new TextDecoder().decode(payload)) as Correction
          if (!card.original || !card.corrected) return
          setCorrections((prev) => {
            const next = [...prev, card]
            correctionsRef.current = next
            return next
          })
          showToast(card)
        } catch {
          // 坏卡直接丢弃,不影响通话
        }
      },
    )
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const sp = speakers.find((s) => s.audioLevel > 0.15)
      setSpeaking(sp ? (sp.identity === MY_IDENTITY ? 'me' : 'emma') : null)
    })
    const cleanup = () => {
      els.forEach((el) => el.remove())
      avatarTrackRef.current?.detach()
      avatarTrackRef.current = null
      setAvatarVideo(false)
      clearTimeout(toastTimer.current)
      setToast(null)
    }
    room.on(RoomEvent.Disconnected, () => {
      endSession()
      cleanup()
      setSpeaking(null)
      setStatus('idle')
    })
    // Emma 说再见主动挂断(session shutdown)后,页面跟着结束回到初始态
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity !== MY_IDENTITY) {
        endSession()
        cleanup()
        setSpeaking(null)
        setStatus('idle')
      }
    })
    try {
      // 每次开练都向后端现领一个短时 token(密钥只在服务端,不再手工粘贴)
      // 练什么:场景优先,其次选中的单元,都没有就自由聊天(Emma 先问你想练什么)
      const sc = scenario.trim()
      const unit = sc ? undefined : unitData?.units.find((u) => u.unitIndex === unitIdx)
      practiceRef.current = sc
        ? `场景:${sc}`
        : unit
          ? `${unitLabel(unit)} · ${unit.objective}`
          : ''
      const { token: roomToken, url, sessionId } = await fetchRoomToken(
        current,
        sc ? { scenario: sc } : unit ? { unit: unitBrief(unit) } : {},
      )
      await room.connect(url, roomToken)
      await room.localParticipant.setMicrophoneEnabled(true)
      checkAgent() // 进房前 agent 已在(热启动)时不会再有 connected 事件
      msgIndex.current.clear()
      msgsRef.current = []
      correctionsRef.current = []
      sessionIdRef.current = sessionId
      accountRef.current = current
      endedRef.current = false
      setStatus('connected')
    } catch (e) {
      els.forEach((el) => el.remove())
      setStatus('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function hangUp() {
    endSession()
    roomRef.current?.disconnect()
  }

  function openNotes() {
    setTab('notes')
    setToast(null)
  }

  // ---------------------------------------------------------------- 通话页
  if (status !== 'idle') {
    const connected = status === 'connected'
    const emmaSpoke = msgs.some((m) => m.role === 'emma')
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-[#030712] lg:flex-row lg:gap-5 lg:p-5">
        {/* 视频舞台 */}
        <section
          aria-label="Emma 视频"
          className="relative h-[55dvh] shrink-0 overflow-hidden rounded-b-[28px] border-b border-gray-800 bg-[radial-gradient(120%_90%_at_50%_35%,#111c33_0%,#070b16_60%,#030712_100%)] lg:h-auto lg:flex-1 lg:rounded-[28px] lg:border"
        >
          {/* 占位:一连上就按完整尺寸显示,视频到了淡入盖上;无头像时就是语音界面 */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 pb-24">
            <EmmaAvatar
              className="size-[132px] text-[56px] lg:size-[200px] lg:text-[84px]"
              pulse={!emmaSpoke || speaking === 'emma'}
            />
            <div className="flex flex-col items-center gap-1.5 text-center">
              <div className="text-lg font-semibold lg:text-xl">
                {!connected
                  ? '正在接通…'
                  : !agentReady
                    ? 'Emma 正在上线…'
                    : emmaSpoke
                      ? 'Emma'
                      : 'Emma 马上开口…'}
              </div>
              {connected && !agentReady && (
                <div className="text-sm text-gray-400">
                  服务刚被唤醒，通常要 10～20 秒，她到之前先别说话
                </div>
              )}
            </div>
          </div>
          {avatarVideo && (
            <video
              ref={videoElRef}
              autoPlay
              playsInline
              muted /* 声音走音频轨,这里只放画面 */
              className="fade-in absolute inset-0 size-full bg-black object-cover"
            />
          )}

          {/* 顶部:名字 + 计时 / 练习内容 */}
          <div className="absolute inset-x-4 top-4 flex items-center justify-between gap-3 lg:inset-x-5 lg:top-5">
            <div className="flex items-center gap-2.5 rounded-full bg-[#030712]/65 px-3.5 py-2 text-sm backdrop-blur">
              <span
                className={`size-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-gray-500'}`}
              />
              <span className="font-semibold">Emma</span>
              <span className="tabular-nums text-gray-400">{fmt(seconds)}</span>
            </div>
            {practiceRef.current && connected && (
              <div className="truncate rounded-full bg-[#030712]/65 px-3.5 py-2 text-[13px] text-slate-300 backdrop-blur">
                {practiceRef.current}
              </div>
            )}
          </div>

          {/* 新纠错提示 */}
          {toast && tab !== 'notes' && (
            <div className="absolute inset-x-4 top-16 flex justify-center lg:top-[76px]">
              <div className="flex max-w-full items-center gap-2.5 rounded-2xl border border-amber-400/35 bg-[#291e08]/95 py-2 pl-4 pr-2 text-sm">
                <span className="shrink-0 font-semibold text-amber-400">新纠错</span>
                <span className="truncate text-gray-400 line-through">{toast.original}</span>
                <span className="shrink-0 text-gray-400">→</span>
                <span className="truncate font-semibold text-cyan-200">{toast.corrected}</span>
                <button
                  onClick={openNotes}
                  className="shrink-0 rounded-lg bg-amber-400/20 px-2.5 py-1.5 text-[13px] text-amber-200 hover:bg-amber-400/30"
                >
                  查看
                </button>
              </div>
            </div>
          )}

          {/* 底部:说话状态 + 挂断(字幕不叠在视频上,看侧栏对话) */}
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-b from-transparent to-[#030712]/70 px-4 pb-4 pt-8 lg:gap-[18px] lg:px-8 lg:pb-7 lg:pt-10">
            <div className="flex items-center gap-2.5 rounded-full bg-slate-900/80 px-4 py-2 text-sm">
              {speaking === 'emma' ? (
                <>
                  <Wave />
                  <span className="text-cyan-300">Emma 正在说…</span>
                </>
              ) : speaking === 'me' ? (
                <>
                  <span className="size-2 rounded-full bg-violet-400" />
                  <span className="text-violet-300">在听你说…</span>
                </>
              ) : (
                <span className="text-slate-300">
                  {!connected
                    ? '正在接通…'
                    : !agentReady
                      ? 'Emma 还在路上，先别开口'
                      : !emmaSpoke
                        ? 'Emma 马上开口…'
                        : '轮到你了，直接开口'}
                </span>
              )}
            </div>
            <button
              onClick={hangUp}
              aria-label="结束通话"
              className="flex size-14 items-center justify-center rounded-full bg-rose-600 text-white shadow-[0_8px_24px_rgba(225,29,72,.35)] hover:bg-rose-500 lg:size-[68px]"
            >
              <HangUpIcon />
            </button>
          </div>
        </section>

        {/* 侧栏:对话 / 错题本 */}
        <aside
          aria-label="对话与错题本"
          className="flex min-h-0 flex-1 flex-col overflow-hidden lg:w-[400px] lg:flex-none lg:rounded-[28px] lg:border lg:border-gray-800 lg:bg-[#0b1220]"
        >
          <div role="tablist" className="flex gap-1.5 px-3.5 pb-2 pt-3 lg:border-b lg:border-gray-800 lg:pb-3.5">
            {(
              [
                ['chat', '对话'],
                ['notes', '错题本'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => (k === 'notes' ? openNotes() : setTab(k))}
                className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-[15px] ${
                  tab === k
                    ? 'bg-slate-800 font-semibold text-slate-50'
                    : 'font-medium text-gray-400 hover:text-gray-200'
                }`}
              >
                {label}
                {k === 'notes' && corrections.length > 0 && (
                  <span className="rounded-full bg-amber-400/20 px-2 text-xs text-amber-300">
                    {corrections.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div
            ref={scrollRef}
            className="thin-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 pb-4 pt-1.5 lg:p-[18px]"
          >
            {tab === 'chat' ? (
              msgs.length === 0 ? (
                <p className="py-6 text-center text-sm text-gray-400">
                  说点什么吧，对话会显示在这里
                </p>
              ) : (
                msgs.map((m) => (
                  <Bubble
                    key={m.id}
                    role={m.role}
                    text={m.text}
                    flagged={flaggedIds.has(m.id)}
                    onFlagClick={openNotes}
                  />
                ))
              )
            ) : (
              <>
                <p className="text-[13px] text-gray-400">说错的地方悄悄记在这里，不打断对话</p>
                {corrections.length === 0 ? (
                  <p className="py-6 text-center text-sm text-gray-400">
                    还没有纠错卡，大胆说，错了也没关系
                  </p>
                ) : (
                  corrections.map((c, i) => <CorrectionItem key={i} c={c} />)
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    )
  }

  // ---------------------------------------------------------------- 首页
  const selectedUnit = unitData?.units.find((u) => u.unitIndex === unitIdx)
  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden bg-[radial-gradient(90%_70%_at_50%_30%,#0d1830_0%,#030712_70%)]">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-7 sm:py-5">
        <div className="text-lg font-bold tracking-tight">AI English Tutor</div>
        <nav className="flex items-center gap-2.5">
          {current ? (
            <>
              <button
                onClick={() => setShowHistory(true)}
                className="flex min-h-11 items-center gap-2 rounded-xl border border-gray-800 bg-[#0b1220] px-4 text-sm text-gray-200 hover:bg-slate-800/60"
              >
                <ClockIcon />
                练习历史
              </button>
              <button
                onClick={logout}
                title="退出登录"
                className="group flex min-h-11 items-center gap-2 rounded-xl border border-gray-800 px-3.5 text-sm text-slate-300 hover:bg-slate-800/60"
              >
                <span className="size-2 rounded-full bg-emerald-400" />
                <span className="group-hover:hidden">{current.user}</span>
                <span className="hidden group-hover:inline">退出</span>
              </button>
            </>
          ) : (
            <a
              href={githubAuthUrl()}
              className="flex min-h-11 items-center rounded-xl border border-gray-800 bg-[#0b1220] px-4 text-sm text-gray-200 hover:bg-slate-800/60"
            >
              GitHub 登录
            </a>
          )}
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-7 px-5 pb-16 pt-6 text-center">
        <EmmaAvatar className="size-[168px] text-7xl" pulse />
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-bold tracking-tight sm:text-[44px]">和 Emma 练口语</h1>
          <p className="text-[17px] text-gray-400">短句、慢速、中英双语，说错了悄悄帮你记下来</p>
        </div>

        <div className="flex w-full max-w-[520px] flex-col gap-3">
          {selectedUnit && (
            <div className="flex flex-col gap-1.5">
              {/* 整张卡片就是入口:点开单元抽屉,直接看详情,也能换单元 */}
              <button
                onClick={() => setShowUnits(true)}
                className={`group flex items-center gap-3 rounded-2xl border p-4 text-left transition-opacity ${
                  scenario.trim()
                    ? 'border-gray-800 bg-[#0b1220] opacity-50'
                    : 'border-cyan-400/40 bg-cyan-400/5 hover:bg-cyan-400/10'
                }`}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[13px] text-cyan-300">
                    {selectedUnit.unitIndex === unitData?.current ? '当前单元' : '复习单元'} ·{' '}
                    {unitLabel(selectedUnit)}
                    {practiced?.[selectedUnit.unitIndex]
                      ? ` · 练过 ${practiced[selectedUnit.unitIndex]} 次`
                      : ''}
                  </span>
                  <span className="truncate text-[17px] font-semibold">{selectedUnit.objective}</span>
                  <span className="text-[13px] text-gray-400">查看重点句和语法 · 换单元</span>
                </span>
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none text-gray-400 group-hover:text-gray-200">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
              {scenario.trim() && (
                <p className="text-left text-[13px] text-amber-300">已选场景，本次练场景，不练单元</p>
              )}
            </div>
          )}
          <label htmlFor="scenario" className="text-left text-sm text-slate-300">
            {selectedUnit
              ? '或者练一个场景(可选，选了就不练单元)'
              : '今天练什么?(可选，留空 Emma 会问你)'}
          </label>
          <input
            id="scenario"
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            placeholder="例如：点咖啡"
            className="min-h-[52px] rounded-2xl border border-gray-800 bg-[#0b1220] px-[18px] text-base text-gray-100 placeholder:text-gray-500 focus:border-cyan-400/60 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            {SCENARIO_CHIPS.map((chip) => {
              const on = scenario.trim() === chip
              return (
                <button
                  key={chip}
                  onClick={() => setScenario(on ? '' : chip)}
                  aria-pressed={on}
                  className={`min-h-9 rounded-full border px-3.5 text-sm ${
                    on
                      ? 'border-cyan-400 bg-cyan-400/10 text-cyan-200'
                      : 'border-gray-800 text-slate-300 hover:border-gray-600'
                  }`}
                >
                  {chip}
                </button>
              )
            })}
          </div>
        </div>

        <button
          onClick={start}
          className="btn-primary flex min-h-[60px] items-center gap-3 rounded-full px-9 text-lg shadow-[0_12px_32px_rgba(124,58,237,.3)]"
        >
          <MicIcon />
          {current ? '开始通话' : '登录 GitHub 后开始'}
        </button>
        {error ? (
          <p className="max-w-md text-sm text-rose-400">{error}</p>
        ) : (
          <p className="text-[13px] text-gray-400">说 “Bye” 她会告别并自动挂断</p>
        )}
      </main>

      {/* 部署版本:改前端时把上面的 APP_VERSION +1 */}
      <footer className="pb-4 text-center text-xs text-gray-600">deploy {APP_VERSION}</footer>

      {showUnits && selectedUnit && unitData && (
        <UnitDrawer
          units={unitData.units}
          current={unitData.current}
          selected={selectedUnit.unitIndex}
          ttsBase={unitData.ttsBase}
          practiced={practiced}
          onPick={(idx) => {
            setUnitIdx(idx)
            setShowUnits(false)
          }}
          onClose={() => setShowUnits(false)}
        />
      )}

      <History
        account={current}
        tick={historyTick}
        open={showHistory}
        onClose={() => setShowHistory(false)}
        initialUnit={PARAM_HISTORY_UNIT != null ? Number(PARAM_HISTORY_UNIT) : null}
      />
    </div>
  )
}
