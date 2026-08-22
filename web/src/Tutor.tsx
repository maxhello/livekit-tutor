import { useEffect, useRef, useState } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  type Participant,
  type TranscriptionSegment,
} from 'livekit-client'

const TOKEN_KEY = 'tutor-token'
/** LiveKit Cloud 项目地址(agent 部署于此) */
const LIVEKIT_URL = 'wss://max-gkpnqhfq.livekit.cloud'
/** 我方 participant identity(token 的 sub),转录按身份区分左右气泡 */
const MY_IDENTITY = 'max'

type Status = 'idle' | 'connecting' | 'connected'

/** 一条字幕:同 id 的流式片段会反复到达,聚合覆盖 */
type Msg = { id: string; role: 'emma' | 'me'; text: string }

const fmt = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

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
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [speaking, setSpeaking] = useState<'emma' | 'me' | null>(null)
  const roomRef = useRef<Room | null>(null)
  const msgIndex = useRef(new Map<string, number>())
  const scrollRef = useRef<HTMLDivElement>(null)

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

  // 离开页面时挂断
  useEffect(
    () => () => {
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
      return next
    })
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
      }
    })
    room.on(RoomEvent.TranscriptionReceived, (segments, participant) =>
      onTranscription(segments, participant?.identity),
    )
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const sp = speakers.find((s) => s.audioLevel > 0.15)
      setSpeaking(sp ? (sp.identity === MY_IDENTITY ? 'me' : 'emma') : null)
    })
    room.on(RoomEvent.Disconnected, () => {
      els.forEach((el) => el.remove())
      setSpeaking(null)
      setStatus('idle')
    })
    // Emma 说再见主动挂断(session shutdown)后,页面跟着结束回到初始态
    room.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity !== MY_IDENTITY) {
        els.forEach((el) => el.remove())
        setSpeaking(null)
        setStatus('idle')
      }
    })
    try {
      await room.connect(LIVEKIT_URL, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      setMsgs([])
      msgIndex.current.clear()
      setStatus('connected')
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
            <div className="heading-gradient text-5xl font-bold tabular-nums">
              {fmt(seconds)}
            </div>
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

      {/* 玩法说明:折叠,不占注意力 */}
      <details className="card mt-4 p-4 text-sm text-gray-400 [&_summary]:cursor-pointer">
        <summary className="text-gray-300">How it works</summary>
        <ul className="mt-2 list-inside list-disc space-y-1.5">
          <li>Start → 授权麦克风 → Emma 教 3 个场景关键词,然后进入公交站情境对话</li>
          <li>她只说 5~8 个词的短句;默认英语,你听不懂时才用中文解释</li>
          <li>说错了会被中文"更正";说 "Bye" 她告别后自动挂断</li>
        </ul>
      </details>

      {/* footer:token 是低频配置,收成一行小字 */}
      <footer className="mt-6 flex flex-wrap items-center justify-center gap-3 text-xs text-gray-600">
        {token && !showTokenInput ? (
          <>
            <span className="flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-emerald-500/70" />
              access token saved
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
          <button
            onClick={() => token && setShowTokenInput(false)}
            className={token ? 'text-gray-500 hover:text-gray-300' : 'hidden'}
          >
            {token ? 'cancel' : ''}
          </button>
        )}
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
    </div>
  )
}
