/**
 * 后端 API 客户端(后端见 server/main.py)。
 *
 * 登录沿用 GitHub PAT:页面把 PAT 发给后端,后端调 GitHub API 校验并按白名单
 * 放行,签发 30 天 JWT;之后所有请求带 JWT,过期(401)用本地 PAT 静默重签。
 */

/** 后端地址:k3s Traefik 入口的 HTTPS 域名。sslip.io 规则:IP 1.2.3.4 → 1-2-3-4.sslip.io */
export const API_BASE = 'https://tutor.161-118-222-205.sslip.io' // 本服务的 sslip.io 子域名(每服务一个)

/** GitHub 账号:token 是 PAT(用于向后端换取/续期 JWT) */
export type Account = { user: string; token: string }

/** 一张纠错卡(agent data channel 与后端共用同一形状) */
export type Correction = {
  original: string
  corrected: string
  kind: string // 'grammar' | 'word' | 'pronunciation'
  point: string // 中文语法点
  words: { word: string; ipa: string; tip_cn: string }[] // 发音重点词
  at: number // 距会话开始毫秒
}

/** 挂断时上传的会话内容;会话 id、起止时间都由后端生成 */
export type SessionPayload = {
  scenario: string
  msgs: { role: 'emma' | 'me'; text: string }[]
  corrections: Correction[]
}

/** 列表条目(只有计数,不含正文);startedAt/seconds 由后端时间算出 */
export type SessionSummary = {
  id: number
  startedAt: number
  seconds: number
  scenario: string
  msgs: number
  corrections: number
}

/** 详情(含正文与纠错卡) */
export type SessionDetail = SessionPayload & { id: number; startedAt: number; seconds: number }

/** 每个账号的 JWT 分开存 */
const tokenKey = (user: string) => `tutor-api-token:${user}`

/**
 * GitHub OAuth 一键登录入口(整页跳转;回来时 URL hash 带 #gh=<jwt>&user=<login>)。
 * 带上当前页面地址,授权完跳回这里(后端只认允许的来源,本地 dev 也能登录)。
 */
export const githubAuthUrl = () =>
  `${API_BASE}/api/auth/github?redirect=${encodeURIComponent(location.origin + location.pathname)}`

/** 保存某账号的后端 JWT(登录/续期后调用) */
export function saveApiToken(user: string, token: string): void {
  localStorage.setItem(tokenKey(user), token)
}

/** 读取并清掉 OAuth 回跳落在 hash 里的结果;没有则 null */
export function consumeOAuthHash(): { user: string; token: string } | null {
  const m = location.hash.match(/[#&]gh=([^&]+)&user=([^&]+)/)
  if (!m) return null
  const out = { token: decodeURIComponent(m[1]), user: decodeURIComponent(m[2]) }
  history.replaceState(null, '', location.pathname + location.search)
  return out
}

const errMsg = (status: number, text: string) => {
  if (status === 401) return 'GitHub token 无效,或与用户名不符'
  if (status === 403) return '该账号不在后端白名单里(服务器 GITHUB_ALLOWLIST)'
  return `后端错误 ${status}:${text.slice(0, 120)}`
}

/** PAT 换 JWT(登录/续期);成功后存 localStorage */
export async function login(user: string, pat: string): Promise<string> {
  let r: Response
  try {
    r = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pat }),
    })
  } catch {
    throw new Error('连不上后端服务,请稍后再试')
  }
  if (!r.ok) throw new Error(errMsg(r.status, await r.text().catch(() => '')))
  const { token } = (await r.json()) as { token: string }
  localStorage.setItem(tokenKey(user), token)
  return token
}

async function getApiToken(account: Account): Promise<string> {
  return (
    localStorage.getItem(tokenKey(account.user)) ??
    (await login(account.user, account.token))
  )
}

/** 带鉴权请求;JWT 过期(401)时用 PAT 静默重签一次再试 */
async function request(
  account: Account,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const doFetch = (jwt: string) =>
    fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  let r = await doFetch(await getApiToken(account))
  if (r.status === 401) {
    if (account.token) {
      // PAT 账号:用 PAT 静默重签一次
      r = await doFetch(await login(account.user, account.token))
    } else {
      // OAuth 账号:30 天 JWT 过期,重新走一次授权
      window.location.href = githubAuthUrl()
      throw new Error('登录已过期,正在重新跳转 GitHub 授权…')
    }
  }
  return r
}

async function json<T>(
  account: Account,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let r: Response
  try {
    r = await request(account, method, path, body)
  } catch {
    throw new Error('连不上后端服务,请稍后再试')
  }
  if (!r.ok) throw new Error(errMsg(r.status, await r.text().catch(() => '')))
  return (await r.json()) as T
}

/** 远端会话列表(新→旧,条目只带计数) */
export function listSessions(account: Account): Promise<SessionSummary[]> {
  return json(account, 'GET', '/api/sessions')
}

/** 单条详情(消息 + 纠错卡) */
export function getSession(account: Account, id: number): Promise<SessionDetail> {
  return json(account, 'GET', `/api/sessions/${id}`)
}

/** 整体覆盖保存一条会话(挂断时自动提交,可重复调用) */
export async function putSession(
  account: Account,
  id: number,
  payload: SessionPayload,
): Promise<void> {
  await json(account, 'PUT', `/api/sessions/${id}`, payload)
}

/**
 * 现领一个短时 LiveKit 房间 token(内嵌 agent dispatch,Emma 自动进房)。需登录。
 * 后端同时建好本次会话(开始时间取服务器时间),返回 sessionId 供挂断时保存。
 */
export function fetchRoomToken(
  account: Account,
): Promise<{ token: string; url: string; sessionId: number }> {
  return json(account, 'POST', '/api/token')
}
