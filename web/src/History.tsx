import { useEffect, useState } from 'react'
import {
  type Account,
  type SessionDetail,
  type SessionSummary,
  getSession,
  listSessions,
} from './api'
import { CorrectionItem } from './Tutor'

const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (ts: number) => {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}分${pad(s % 60)}秒`

/**
 * 练习历史:全部来自后端(挂断时已自动保存),列表 + 点开气泡/纠错卡回看。
 * 不再写 localStorage —— 换浏览器/设备登录同账号看到的是同一份。
 */
export default function History({
  account,
  tick,
}: {
  account: Account | null
  tick: number
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  /** 已拉过的详情,按会话 id 缓存 */
  const [details, setDetails] = useState<Record<number, SessionDetail>>({})
  const [expanded, setExpanded] = useState<number | null>(null)
  const [err, setErr] = useState('')

  // 登录/切账号或有新会话保存成功(tick++)后重新拉列表
  useEffect(() => {
    if (!account) {
      setSessions([])
      return
    }
    let alive = true
    setLoading(true)
    setErr('')
    listSessions(account)
      .then((list) => alive && setSessions(list))
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [account, tick])

  async function toggle(id: number) {
    if (expanded === id) {
      setExpanded(null)
      return
    }
    setExpanded(id)
    if (details[id] || !account) return
    try {
      const data = await getSession(account, id)
      setDetails((prev) => ({ ...prev, [id]: data }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (!account) return null

  return (
    <section className="card mt-4 flex flex-col p-4">
      <h2 className="mb-2 text-sm font-medium text-gray-300">📚 练习历史</h2>
      {err && <p className="mb-2 text-xs text-rose-400/90">{err}</p>}
      <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {sessions.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">
            {loading ? '加载中…' : '还没有练习记录'}
          </p>
        )}
        {sessions.map((s) => {
          const detail = details[s.id]
          return (
            <div key={s.id}>
              <button
                onClick={() => toggle(s.id)}
                className="flex w-full items-center gap-2 rounded-lg border border-gray-800/60 bg-gray-900/40 px-3 py-2 text-left text-xs"
              >
                <span className="shrink-0 text-gray-300">{fmtDate(s.startedAt)}</span>
                {s.seconds > 0 && <span className="shrink-0 text-gray-500">{fmtDur(s.seconds)}</span>}
                <span className="min-w-0 flex-1 truncate text-gray-400">
                  {s.scenario || '自由聊天'}
                </span>
                {s.corrections > 0 && (
                  <span
                    className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300"
                    title="纠错卡数"
                  >
                    ✍ {s.corrections}
                  </span>
                )}
              </button>
              {expanded === s.id && (
                <div className="mt-1.5 space-y-1.5 rounded-lg bg-gray-900/60 p-3">
                  {!detail ? (
                    <p className="py-2 text-center text-xs text-gray-500">加载中…</p>
                  ) : (
                    <>
                      {detail.msgs.map((m, i) => (
                        <div key={i} className={m.role === 'me' ? 'text-right' : 'text-left'}>
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
                      {detail.corrections.length > 0 && (
                        <div className="mt-2 space-y-2 border-t border-gray-800/60 pt-2">
                          {detail.corrections.map((c, i) => (
                            <CorrectionItem key={i} c={c} />
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
