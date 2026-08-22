import { useEffect, useMemo, useState } from 'react'
import {
  type Account,
  type RemoteEntry,
  getRemote,
  listRemote,
  putSession,
  sessionPath,
} from './github'
import type { Msg } from './Tutor'

const HISTORY_KEY = 'tutor-history'
/** 历史上限(条),防 localStorage 膨胀 */
const HISTORY_MAX = 50

/** 一次会话的存档:起止、时长、双方对话 + 持久化状态 */
export type Session = {
  id: number // = startedAt(ms),天然唯一
  startedAt: number
  seconds: number
  scenario: string
  msgs: Msg[]
  synced: boolean
  owner: string // 同步时的 GitHub 用户名;未同步为 ''
  path?: string // sessions/{owner}/xxx.json
}

export function loadSessions(): Session[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as Session[]
  } catch {
    return []
  }
}

/** 落盘本地;msgs 为空的远端占位条目只留在内存,不写 localStorage */
export function persistSessions(list: Session[]): void {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(list.filter((s) => s.msgs.length > 0).slice(0, HISTORY_MAX)),
  )
}

/** 通话结束时追加一条(最新在前) */
export function appendSession(s: Session): void {
  persistSessions([s, ...loadSessions()])
}

/** 文件名时间戳 → startedAt:sessions/用户/2026-08-22_10-32-07.json */
function idFromPath(path: string): number {
  const m = path.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/)
  if (!m) return 0
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (ts: number) => {
  const d = new Date(ts)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fmtDur = (s: number) => `${Math.floor(s / 60)}分${pad(s % 60)}秒`

/** 远端会话文件的 JSON 结构(见 github.ts SessionPayload) */
type RemoteSession = {
  startedAt: number
  seconds: number
  scenario: string
  owner?: string
  msgs: { role: Msg['role']; text: string }[]
}

/**
 * 练习历史:列表 + 挑好的「保存」到 GitHub + 点开气泡回看。
 * 本地(localStorage)为准;登录后合并远端独有记录 —— 换浏览器/设备登录同账号即可找回。
 */
export default function History({ account, tick }: { account: Account | null; tick: number }) {
  const [sessions, setSessions] = useState<Session[]>(loadSessions)
  /** 账号筛选('' = 全部);默认当前账号 */
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState('')
  const [loadingOne, setLoadingOne] = useState(false)
  const [syncing, setSyncing] = useState<{ done: number; total: number } | null>(null)
  const [err, setErr] = useState('')

  // 新会话落盘/同步完成(tick++)后重读本地;内存里的远端占位条目补回来
  useEffect(() => {
    setSessions((prev) => {
      const fresh = loadSessions()
      const haveIds = new Set(fresh.map((s) => s.id))
      const remoteOnly = prev.filter((s) => s.msgs.length === 0 && !haveIds.has(s.id))
      return remoteOnly.length ? [...fresh, ...remoteOnly] : fresh
    })
  }, [tick])

  // 切账号时默认只看该账号
  useEffect(() => {
    setFilter(account?.user ?? '')
  }, [account?.user])

  // 登录后合并远端:本机没有的已同步记录在此找回(public 仓库匿名可读)
  useEffect(() => {
    if (!account) return
    let alive = true
    listRemote(account.user, account.token)
      .then((entries: RemoteEntry[]) => {
        if (!alive) return
        setSessions((prev) => {
          const haveIds = new Set(prev.map((s) => s.id))
          const remotes = entries
            .map((e) => ({ entry: e, id: idFromPath(e.path) }))
            .filter(({ id }) => id && !haveIds.has(id))
            .map(({ entry, id }) => ({
              id,
              startedAt: id,
              seconds: 0,
              scenario: '',
              msgs: [] as Msg[],
              synced: true,
              owner: account.user,
              path: entry.path,
            }))
          return remotes.length ? [...prev, ...remotes] : prev
        })
      })
      .catch(() => {}) // 远端拉不到不影响本地列表
    return () => {
      alive = false
    }
  }, [account?.user, account?.token])

  const owners = useMemo(
    () => Array.from(new Set(sessions.map((s) => s.owner).filter(Boolean))),
    [sessions],
  )
  /** 未同步的记录不筛掉(还没归属,同步时才写当前账号) */
  const visible = useMemo(() => {
    const list = filter ? sessions.filter((s) => s.owner === filter || !s.synced) : sessions
    return [...list].sort((a, b) => b.startedAt - a.startedAt)
  }, [sessions, filter])
  const pendingCount = visible.filter((s) => !s.synced && s.msgs.length > 0).length

  async function syncOne(s: Session): Promise<void> {
    if (!account) throw new Error('请先在底部登录 GitHub 账号')
    const path = s.path ?? sessionPath(account.user, s.startedAt)
    await putSession(
      account,
      {
        startedAt: s.startedAt,
        seconds: s.seconds,
        scenario: s.scenario,
        owner: account.user,
        msgs: s.msgs.map(({ role, text }) => ({ role, text })),
      },
      path,
    )
    setSessions((prev) => {
      const next = prev.map((x) =>
        x.id === s.id ? { ...x, synced: true, owner: account.user, path } : x,
      )
      persistSessions(next)
      return next
    })
  }

  async function onSyncOne(s: Session) {
    setErr('')
    try {
      await syncOne(s)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function onSyncAll() {
    const pending = visible.filter((s) => !s.synced && s.msgs.length > 0)
    if (!pending.length) return
    setErr('')
    setSyncing({ done: 0, total: pending.length })
    try {
      for (let i = 0; i < pending.length; i++) {
        await syncOne(pending[i])
        setSyncing({ done: i + 1, total: pending.length })
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(null)
    }
  }

  async function toggle(s: Session) {
    const key = `${s.owner}:${s.id}`
    if (expanded === key) {
      setExpanded('')
      return
    }
    setExpanded(key)
    // 远端占位条目:首次展开拉全文,并回写本地缓存(下次离线可看)
    if (s.msgs.length === 0 && s.path) {
      setLoadingOne(true)
      try {
        const data = JSON.parse(await getRemote(s.owner, s.path)) as RemoteSession
        setSessions((prev) => {
          const next = prev.map((x) =>
            x.id === s.id
              ? {
                  ...x,
                  seconds: data.seconds || x.seconds,
                  scenario: data.scenario || '',
                  owner: data.owner || x.owner,
                  msgs: (data.msgs ?? []).map((m, i) => ({
                    id: `${s.path}:${i}`,
                    role: m.role,
                    text: m.text,
                  })),
                }
              : x,
          )
          persistSessions(next)
          return next
        })
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setLoadingOne(false)
      }
    }
  }

  if (sessions.length === 0 && !account) return null

  return (
    <section className="card mt-4 flex flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">📚 练习历史</h2>
        {syncing ? (
          <span className="text-xs text-gray-500">
            保存中 {syncing.done}/{syncing.total}
          </span>
        ) : (
          pendingCount > 0 && (
            <button onClick={onSyncAll} className="btn-ghost px-3 py-1 text-xs">
              全部保存({pendingCount})
            </button>
          )
        )}
      </div>
      {owners.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1.5 text-xs">
          {[{ k: '', label: '全部' }, ...owners.map((o) => ({ k: o, label: o }))].map((c) => (
            <button
              key={c.k}
              onClick={() => setFilter(c.k)}
              className={`rounded-full border px-2.5 py-0.5 ${
                filter === c.k
                  ? 'border-cyan-400/60 text-cyan-200'
                  : 'border-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {err && <p className="mb-2 text-xs text-rose-400/90">{err}</p>}
      <div className="max-h-80 space-y-1.5 overflow-y-auto pr-1">
        {visible.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">还没有练习记录</p>
        )}
        {visible.map((s) => {
          const key = `${s.owner}:${s.id}`
          return (
            <div key={key}>
              <div className="flex items-center gap-2 rounded-lg border border-gray-800/60 bg-gray-900/40 px-3 py-2 text-xs">
                <button onClick={() => toggle(s)} className="flex flex-1 items-center gap-2 text-left">
                  <span className="shrink-0 text-gray-300">{fmtDate(s.startedAt)}</span>
                  {(s.msgs.length > 0 || !s.synced) && (
                    <span className="shrink-0 text-gray-500">{fmtDur(s.seconds)}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-gray-400">
                    {s.scenario || (s.msgs.length > 0 ? '自由聊天' : '远端记录,点击加载')}
                  </span>
                  {owners.length > 1 && s.owner && (
                    <span className="shrink-0 rounded bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-400">
                      {s.owner}
                    </span>
                  )}
                </button>
                {s.synced ? (
                  <span className="shrink-0 text-emerald-500/80" title="已保存到 GitHub">
                    ✓
                  </span>
                ) : (
                  <button onClick={() => onSyncOne(s)} className="btn-ghost shrink-0 px-2.5 py-1 text-[11px]">
                    保存
                  </button>
                )}
              </div>
              {expanded === key && (
                <div className="mt-1.5 space-y-1.5 rounded-lg bg-gray-900/60 p-3">
                  {s.msgs.length === 0 ? (
                    <p className="py-2 text-center text-xs text-gray-500">
                      {loadingOne ? '加载中…' : '暂无内容'}
                    </p>
                  ) : (
                    s.msgs.map((m) => (
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
                    ))
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
