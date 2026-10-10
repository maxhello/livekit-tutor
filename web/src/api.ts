/**
 * 后端 API 客户端(后端见 server/main.py,部署见 server/deploy/README.md)。
 *
 * 登录沿用 GitHub PAT:页面把 PAT 发给后端,后端调 GitHub API 校验并按白名单
 * 放行,签发 30 天 JWT;之后所有请求带 JWT,过期(401)用本地 PAT 静默重签。
 */

/** 后端地址:k3s Traefik 入口的 HTTPS 域名。sslip.io 规则:IP 1.2.3.4 → 1-2-3-4.sslip.io */
export const API_BASE = 'https://203-0-113-10.sslip.io' // TODO 部署后替换成你的域名

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

export type SessionPayload = {
  seconds: number
  scenario: string
  msgs: { role: 'emma' | 'me'; text: string }[]
  corrections: Correction[]
}

/** 列表条目(只有计数,不含正文) */
export type SessionSummary = {
  startedAt: number
  seconds: number
  scenario: string
  msgs: number
  corrections: number
}

/** 详情(含正文与纠错卡) */
export type SessionDetail = SessionPayload & { startedAt: number }

/** 每个账号的 JWT 分开存 */
const tokenKey = (user: string) => `tutor-api-token:${user}`

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
    r = await doFetch(await login(account.user, account.token))
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
export function getSession(
  account: Account,
  startedAt: number,
): Promise<SessionDetail> {
  return json(account, 'GET', `/api/sessions/${startedAt}`)
}

/** 整体 upsert 一条会话(挂断时提交) */
export async function putSession(
  account: Account,
  startedAt: number,
  payload: SessionPayload,
): Promise<void> {
  await json(account, 'PUT', `/api/sessions/${startedAt}`, payload)
}
