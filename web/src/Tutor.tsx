import { useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type TranscriptionSegment,
} from 'livekit-client'
import History, { appendSession } from './History'
import { login as apiLogin, type Account, type Correction } from './api'

const TOKEN_KEY = 'tutor-token'
/** GitHub 账号列表(写历史凭证)与当前登录者,存 localStorage */
const ACCOUNTS_KEY = 'tutor-accounts'
const CURRENT_KEY = 'tutor-current'
/** LiveKit Cloud 项目地址(agent 部署于此) */
const LIVEKIT_URL = 'wss://max-gkpnqhfq.livekit.cloud'
/** 我方 participant identity(token 的 sub),转录按身份区分左右气泡 */
const MY_IDENTITY = 'max'
/** 前端版本号:每次改前端手动 +1,页脚展示,用于核对线上是否为最新部署 */
const APP_VERSION = 'v3'

type Status = 'idle' | 'connecting' | 'connected'

/** 一条字幕:同 id 的流式片段会反复到达,聚合覆盖 */
export type Msg = { id: string; role: 'emma' | 'me'; text: string }

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

const KIND_LABEL: Record<string, string> = {
  grammar: '语法',
  word: '用词',
  pronunciation: '发音',
}

/** 一张纠错卡:原句→正确句 + 中文讲解 + 发音重点词(悬停看技巧)。通话中实时出现,历史回放复用 */
export function CorrectionItem({ c }: { c: Correction }) {
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
          {KIND_LABEL[c.kind] ?? '纠错'}
        </span>
        <span className="text-gray-500 line-through decoration-gray-600">{c.original}</span>
        <span className="text-gray-600">→</span>
        <span className="font-medium text-cyan-200">{c.corrected}</span>
      </div>
      {c.point && <p className="mt-1 text-xs text-gray-400">{c.point}</p>}
      {(c.words?.length ?? 0) > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {c.words.map((w, i) => (
            <span
              key={i}
              className="rounded-lg bg-violet-500/10 px-2 py-0.5 text-xs text-violet-200"
              title={w.tip_cn}
            >
              {w.word} <span className="text-violet-300/70">{w.ipa}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 通话声波:5 根柱,说话时跳动 */
function Wave({ active }: { active: boolean }) {
  return (
    <div className="flex h-6 items-center justify-center gap-1">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-full bg-gradient-to-t from-cyan-400 to-violet-400 transition-all duration-300 ${
            active ? 'wave-bar' : ''
          }`}
          style={
            active
              ? { height: '100%', animationDelay: `${i * 0.13}s`, animationDuration: `${0.8 + (i % 3) * 0.2}s` }
              : { height: '30%' }
          }
        />
      ))}
    </div>
  )
}

/**
 * AI 英语陪练页:livekit-client 直连 LiveKit Cloud 房间,token 里带 agent dispatch,
 * Emma(云端 voice agent)自动进房,双语短句教学。长期 token 只存 localStorage。
 * agent 与用户双方的语音转录(SDK 默认开启)在页面上实时滚动显示。
 */
export default function Tutor() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '')
  const [draft, setDraft] = useState('')
  const [showTokenInput, setShowTokenInput] = useState(false)
  /** 今日练习场景(可选):连接后经 data channel 推给 Emma 直接入戏;留空则她语音问你 */
  const [scenario, setScenario] = useState('')
  /** GitHub 多账号:本地存多套凭证,可切换;current 为 null 表示未登录 */
  const [accounts, setAccounts] = useState<Account[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]') as Account[]
    } catch {
      return []
    }
  })
  const [current, setCurrent] = useState<Account | null>(() => {
    try {
      const list = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? '[]') as Account[]
      return list.find((a) => a.user === localStorage.getItem(CURRENT_KEY)) ?? null
    } catch {
      return null
    }
  })
  const [showLogin, setShowLogin] = useState(false)
  const [ghUser, setGhUser] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [loginErr, setLoginErr] = useState('')
  const [verifying, setVerifying] = useState(false)
  /** 通知 History 重读本地:新会话落盘时 +1 */
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
  const roomRef = useRef<Room | null>(null)
  const msgIndex = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)
  /** 通话中状态快照:事件回调闭包读不到最新 state,走 ref */
  const msgsRef = useRef<Msg[]>([])
  const correctionsRef = useRef<Correction[]>([])
  const startedAtRef = useRef(0)
  const scenarioRef = useRef('')
  const endedRef = useRef(true)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  /** 头像视频轨 attach 出的隐藏元素:srcObject 镜像给主舞台 <video> */
  const avatarSrcElRef = useRef<HTMLMediaElement | null>(null)

  // 头像 <video> 渲染出来后,把镜像轨的流接过去
  useEffect(() => {
    const src = avatarSrcElRef.current
    const video = videoElRef.current
    if (avatarVideo && src && video) {
      video.srcObject = (src as HTMLVideoElement).srcObject
      video.play().catch(() => {})
    }
  }, [avatarVideo])

  useEffect(() => {
    document.title = 'AI English Tutor'
  }, [])

  useEffect(() => {
    if (status !== 'connected') return
    setSeconds(0)
    const t = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(t)
  }, [status])

  // 新字幕进来自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])

  // 离开页面时:先落盘本次会话再挂断
  useEffect(
    () => () => {
      endSession()
      roomRef.current?.disconnect()
      roomRef.current = null
    },
    [],
  )

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

  /** 通话结束:字幕快照落 localStorage(为空不存),通知历史区刷新;endedRef 防挂断事件重复触发 */
  function endSession() {
    if (endedRef.current) return
    endedRef.current = true
    const startedAt = startedAtRef.current
    const snapshot = msgsRef.current
    if (!snapshot.length) return
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
    appendSession({
      id: startedAt,
      startedAt,
      seconds,
      scenario: scenarioRef.current,
      msgs: snapshot,
      corrections: correctionsRef.current,
      synced: false,
      owner: '',
    })
    setHistoryTick((t) => t + 1)
  }

  function switchAccount(a: Account) {
    setCurrent(a)
    localStorage.setItem(CURRENT_KEY, a.user)
    setShowLogin(false)
  }

  function logout() {
    setCurrent(null)
    localStorage.removeItem(CURRENT_KEY)
  }

  function removeAccount(a: Account) {
    setAccounts((prev) => {
      const next = prev.filter((x) => x.user !== a.user)
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(next))
      return next
    })
    if (current?.user === a.user) logout()
  }

  /** 登录:校验 token 确属该账号,存入账号列表并设为当前 */
  async function doLogin() {
    const user = ghUser.trim()
    const token = ghToken.trim()
    if (!user || !token) return
    setVerifying(true)
    setLoginErr('')
    try {
      await apiLogin(user, token) // 后端校验 PAT + 白名单,签发 JWT
      setAccounts((prev) => {
        const next = [...prev.filter((a) => a.user !== user), { user, token }]
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(next))
        return next
      })
      switchAccount({ user, token })
      setGhUser('')
      setGhToken('')
    } catch (e) {
      setLoginErr(e instanceof Error ? e.message : String(e))
    } finally {
      setVerifying(false)
    }
  }

  async function start() {
    if (!token) {
      setShowTokenInput(true)
      return
    }
    setStatus('connecting')
    setError('')
    const room = new Room()
    roomRef.current = room
    const els: HTMLMediaElement[] = []
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach()
        el.style.display = 'none'
        document.body.appendChild(el)
        els.push(el)
      } else if (track.kind === Track.Kind.Video) {
        // Emma 的头像视频(Simli 开启时 avatar 代替 agent 发布音视频)
        const el = track.attach()
        el.style.display = 'none'
        document.body.appendChild(el)
        els.push(el)
        avatarSrcElRef.current = el
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
      avatarSrcElRef.current = null
      setAvatarVideo(false)
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
      await room.connect(LIVEKIT_URL, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setMsgs([])
      setCorrections([])
      msgIndex.current.clear()
      msgsRef.current = []
      correctionsRef.current = []
      startedAtRef.current = Date.now()
      scenarioRef.current = scenario.trim()
      endedRef.current = false
      setStatus('connected')
      // 有指定场景就推给 Emma(topic=scenario),她直接开场入戏
      if (scenario.trim()) {
        await room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify({ scenario: scenario.trim() })),
          { reliable: true, topic: 'scenario' },
        )
      }
    } catch (e) {
      els.forEach((el) => el.remove())
      setStatus('idle')
      setError(
        e instanceof Error
          ? `${e.message} — token 可能已过期,重新生成后替换`
          : String(e),
      )
      setShowTokenInput(true)
    }
  }

  function hangUp() {
    endSession()
    roomRef.current?.disconnect()
  }

  function saveToken() {
    const v = draft.trim()
    if (!v) return
    localStorage.setItem(TOKEN_KEY, v)
    setToken(v)
    setDraft('')
    setShowTokenInput(false)
    setError('')
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-bold">
          <span className="heading-gradient">AI English Tutor</span>
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Voice practice with Emma — bilingual speaking coach for A1 beginners
        </p>
      </header>

      {/* 主舞台:通话 */}
      <main className="card mt-8 flex flex-1 flex-col items-center justify-center gap-6 p-10">
        {status === 'connected' ? (
          <>
            {avatarVideo && (
              <video
                ref={videoElRef}
                autoPlay
                playsInline
                muted /* 声音走音频轨,这里只放画面 */
                className="aspect-video w-full max-w-sm rounded-2xl border border-gray-800 bg-black object-cover"
              />
            )}
            {!avatarVideo && (
              <div className="heading-gradient text-5xl font-bold tabular-nums">
                {fmt(seconds)}
              </div>
            )}
            {avatarVideo && (
              <div className="text-2xl font-bold tabular-nums text-gray-300">
                {fmt(seconds)}
              </div>
            )}
            <Wave active={speaking === 'emma'} />
            <div className="h-5 text-sm text-gray-400">
              {speaking === 'emma' ? (
                <span className="text-cyan-300">Emma is speaking…</span>
              ) : speaking === 'me' ? (
                <span className="text-violet-300">Listening to you…</span>
              ) : (
                'Your turn — just speak up 🦉'
              )}
            </div>
            <button onClick={hangUp} className="btn-ghost px-8 py-2.5 text-sm">
              End session
            </button>
          </>
        ) : status === 'connecting' ? (
          <div className="flex flex-col items-center gap-4 py-10">
            <span className="size-10 animate-spin rounded-full border-2 border-gray-700 border-t-cyan-400" />
            <span className="text-sm text-gray-400">Waking Emma up…</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-10">
            <button
              onClick={start}
              className="btn-primary group relative size-32 rounded-full text-base"
            >
              <span className="text-3xl">🎤</span>
              <span className="mt-1 block">Start</span>
              <span className="absolute inset-0 -z-10 rounded-full bg-cyan-400/20 blur-2xl transition-all group-hover:bg-cyan-400/30" />
            </button>
            <span className="text-sm text-gray-500">
              {token ? 'Emma is ready' : '需要先配置 access token ↓'}
            </span>
            <input
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
              placeholder="Scenario (optional) — e.g. ordering coffee · 留空则 Emma 语音问你"
              className="w-72 rounded-full border border-gray-800 bg-gray-900/70 px-4 py-2 text-center text-xs text-gray-300 placeholder:text-gray-600 focus:border-cyan-400/60 focus:outline-none"
            />
          </div>
        )}
        {error && (
          <p className="max-w-md text-center text-xs text-rose-400/90">{error}</p>
        )}
      </main>

      {/* 实时字幕 */}
      {status === 'connected' && (
        <section className="card mt-4 flex flex-col p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-300">Live transcript</h2>
          <div ref={scrollRef} className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {msgs.length === 0 && (
              <p className="py-4 text-center text-sm text-gray-500">
                Say something — the conversation shows up here 📝
              </p>
            )}
            {msgs.map((m) => (
              <div key={m.id} className={m.role === 'me' ? 'text-right' : 'text-left'}>
                <span
                  className={`inline-block max-w-[85%] rounded-xl px-3 py-1.5 text-sm ${
                    m.role === 'me'
                      ? 'bg-violet-500/15 text-violet-100'
                      : 'bg-cyan-500/10 text-cyan-50'
                  }`}
                >
                  {m.text}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 实时错题本:agent 后台静默分析,卡片不打断对话 */}
      {status === 'connected' && (
        <section className="card mt-4 p-4">
          <h2 className="mb-2 text-sm font-medium text-gray-300">
            📝 错题本{' '}
            <span className="text-xs font-normal text-gray-500">
              说错的地方悄悄记在这里,不打断对话
            </span>
          </h2>
          {corrections.length === 0 ? (
            <p className="py-2 text-center text-sm text-gray-500">
              还没有纠错卡 —— 大胆说,错了也没关系
            </p>
          ) : (
            <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {corrections.map((c, i) => (
                <CorrectionItem key={i} c={c} />
              ))}
            </div>
          )}
        </section>
      )}

      {/* 练习历史:本地记录 + 登录后合并云端 */}
      <History account={current} tick={historyTick} />

      {/* 玩法说明:折叠,不占注意力 */}
      <details className="card mt-4 p-4 text-sm text-gray-400 [&_summary]:cursor-pointer">
        <summary className="text-gray-300">How it works</summary>
        <ul className="mt-2 list-inside list-disc space-y-1.5">
          <li>Start → 授权麦克风 → Emma 教 3 个场景关键词,然后进入公交站情境对话</li>
          <li>她只说 5~8 个词的短句;默认英语,你听不懂时才用中文解释</li>
          <li>说错了会被中文"更正";说 "Bye" 她告别后自动挂断</li>
        </ul>
      </details>

      {/* footer:账号 / 房间 token / 版本,低频配置收成一行小字 */}
      <footer className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs text-gray-600">
        {current ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-cyan-500/70" />
              <button onClick={() => setShowLogin(true)} className="hover:text-gray-300">
                {current.user}
              </button>
            </span>
            <span>·</span>
            <button onClick={logout} className="hover:text-gray-300">
              退出
            </button>
          </>
        ) : (
          <button onClick={() => setShowLogin(true)} className="hover:text-gray-300">
            GitHub 登录(保存历史)
          </button>
        )}
        {token && <span>·</span>}
        {token && !showTokenInput ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-emerald-500/70" />
              room token
            </span>
            <span>·</span>
            <button
              onClick={() => setShowTokenInput(true)}
              className="text-gray-500 underline underline-offset-2 hover:text-gray-300"
            >
              replace
            </button>
          </>
        ) : (
          token && (
            <button
              onClick={() => setShowTokenInput(false)}
              className="text-gray-500 hover:text-gray-300"
            >
              cancel
            </button>
          )
        )}
        <span>·</span>
        {/* 部署版本:改前端时把上面的 APP_VERSION +1 */}
        <span>deploy {APP_VERSION}</span>
      </footer>

      {/* token 输入(首次 / 替换 / 出错时展开) */}
      {showTokenInput && (
        <div className="card mt-3 space-y-3 p-4">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="Paste your LiveKit access token (eyJhbGciOi…)"
            className="w-full resize-none rounded-lg border border-gray-800 bg-gray-900/70 p-3 font-mono text-xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-400/60 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              onClick={saveToken}
              disabled={!draft.trim()}
              className="btn-primary px-5 py-2 text-sm"
            >
              Save
            </button>
            {token && (
              <button
                onClick={() => setShowTokenInput(false)}
                className="btn-ghost px-5 py-2 text-sm"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* GitHub 账号卡(登录/多账号切换):写入历史的凭证 */}
      {showLogin && (
        <div className="card mt-3 space-y-3 p-4">
          <h3 className="text-sm font-medium text-gray-300">GitHub 账号</h3>
          {accounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {accounts.map((a) => (
                <span
                  key={a.user}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                    a.user === current?.user
                      ? 'border-cyan-400/60 text-cyan-200'
                      : 'border-gray-800 text-gray-400'
                  }`}
                >
                  <button onClick={() => switchAccount(a)} className="hover:text-gray-200">
                    {a.user}
                    {a.user === current?.user ? ' ✓' : ''}
                  </button>
                  <button
                    onClick={() => removeAccount(a)}
                    className="text-gray-600 hover:text-rose-400"
                    title="移除此账号"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={ghUser}
              onChange={(e) => setGhUser(e.target.value)}
              placeholder="GitHub 用户名"
              className="flex-1 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-400/60 focus:outline-none"
            />
            <input
              value={ghToken}
              onChange={(e) => setGhToken(e.target.value)}
              type="password"
              placeholder="Access token(仅授权本仓库 Contents 读写)"
              className="flex-1 rounded-lg border border-gray-800 bg-gray-900/70 px-3 py-2 text-xs text-gray-200 placeholder:text-gray-600 focus:border-cyan-400/60 focus:outline-none"
            />
          </div>
          {loginErr && <p className="text-xs text-rose-400/90">{loginErr}</p>}
          <div className="flex gap-2">
            <button
              onClick={doLogin}
              disabled={!ghUser.trim() || !ghToken.trim() || verifying}
              className="btn-primary px-5 py-2 text-sm"
            >
              {verifying ? '验证中…' : '登录'}
            </button>
            <button
              onClick={() => {
                setShowLogin(false)
                setLoginErr('')
              }}
              className="btn-ghost px-5 py-2 text-sm"
            >
              关闭
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-600">
            登录后才能把练习记录保存到 GitHub(token
            创建步骤见项目 README)。记录会提交到公开仓库,介意的内容请勿保存。
          </p>
        </div>
      )}
    </div>
  )
}
