import { useEffect, useRef, useState } from 'react'
import { Room, RoomEvent, Track, type TranscriptionSegment } from 'livekit-client'

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

/**
 * AI 英语陪练页:livekit-client 直连 LiveKit Cloud 房间,token 里带 agent dispatch,
 * Emma(云端 voice agent)自动进房,双语短句教学。长期 token 只存 localStorage。
 * agent 与用户双方的语音转录(SDK 默认开启)在页面上实时滚动显示。
 */
export default function Tutor() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [msgs, setMsgs] = useState<Msg[]>([])
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
    if (!token) return
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
    room.on(RoomEvent.Disconnected, () => {
      els.forEach((el) => el.remove())
      setStatus('idle')
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
          ? `${e.message}(token 可能已过期,重新生成后在下方 Replace)`
          : String(e),
      )
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
    setEditing(false)
    setError('')
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-10">
      <div className="text-center">
        <h1 className="text-3xl font-bold">
          <span className="heading-gradient">AI English Tutor</span>
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Voice practice with Emma — a bilingual speaking coach for A1 beginners
        </p>
      </div>

      {/* 通话控制 */}
      <div className="card flex flex-col items-center gap-5 p-8">
        {status === 'connected' ? (
          <>
            <div className="heading-gradient text-4xl font-bold tabular-nums">{fmt(seconds)}</div>
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
              Emma is in the room — just speak up 🦉
            </div>
            <button onClick={hangUp} className="btn-ghost px-8 py-2.5 text-sm">
              End session
            </button>
          </>
        ) : status === 'connecting' ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <span className="size-8 animate-spin rounded-full border-2 border-gray-700 border-t-cyan-400" />
            <span className="text-sm text-gray-400">Connecting &amp; waking Emma up…</span>
          </div>
        ) : (
          <button
            onClick={start}
            disabled={!token}
            className="btn-primary w-full max-w-xs py-4 text-lg"
          >
            Start session 🎤
          </button>
        )}
        {error && <p className="max-w-md text-center text-xs text-rose-400/90">{error}</p>}
      </div>

      {/* 实时字幕:agent/用户转录(SDK 默认 forward 到房间) */}
      {status === 'connected' && (
        <div className="card flex flex-col p-4">
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
        </div>
      )}

      {/* Token 管理:长期 token 即"门票",粘贴一次存 localStorage */}
      <div className="card space-y-3 p-6">
        <h2 className="text-sm font-medium text-gray-300">Access token</h2>
        {token && !editing ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <code className="truncate rounded-lg bg-gray-900/70 px-3 py-1.5 font-mono text-xs text-gray-400">
              {token.slice(0, 24)}…{token.slice(-8)}
            </code>
            <button onClick={() => setEditing(true)} className="btn-ghost px-4 py-1.5 text-xs">
              Replace
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={4}
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
                <button onClick={() => setEditing(false)} className="btn-ghost px-5 py-2 text-sm">
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        <p className="text-xs text-gray-500">
          Token 是进房间的长期门票,只存在这台浏览器里。过期或怀疑泄露时用
          <code className="mx-1 rounded bg-gray-900/70 px-1 py-0.5 font-mono text-[10px]">
            lk token create
          </code>
          重新生成并 Replace 即可。
        </p>
      </div>

      {/* 怎么练 */}
      <div className="card space-y-2 p-6 text-sm text-gray-400">
        <h2 className="text-sm font-medium text-gray-300">How it works</h2>
        <ul className="list-inside list-disc space-y-1.5">
          <li>点 Start → 授权麦克风 → Emma 自动加入,先用英语教你 3 个场景关键词</li>
          <li>她每次只说 5~8 个词的短句,并紧跟中文解释,听不懂也能跟上节奏</li>
          <li>说错了会被中文"更正",卡住了她会给 3~4 个词的跟读模板</li>
          <li>麦克风没声音:先检查浏览器地址栏的麦克风权限</li>
        </ul>
      </div>
    </div>
  )
}
