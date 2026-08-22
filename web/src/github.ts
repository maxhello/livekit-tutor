/**
 * GitHub 持久化:拿 Contents API 当存储服务,延续零后端。
 * 仓库是 public:读匿名可用,写需要 PAT(owner 用 fine-grained 仅授权本仓库,
 * 其他使用者加 collaborator 后用 classic public_repo,详见 README)。
 */

const API = 'https://api.github.com'
const REPO = 'livekit-tutor'

/** 一套写凭证 + 身份标签,存 localStorage */
export type Account = { user: string; token: string }

/** sessions/<user>/ 下一个已同步的会话文件 */
export type RemoteEntry = { name: string; path: string }

/** 落盘的会话载荷:msgs 剥掉流式 id,只留角色和文本 */
export type SessionPayload = {
  startedAt: number
  seconds: number
  scenario: string
  owner: string
  msgs: { role: 'emma' | 'me'; text: string }[]
}

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

/** 常见状态码 → 中文提示;其余带 GitHub 返回的 message */
function friendly(status: number, fallback: string): string {
  if (status === 401)
    return 'GitHub 拒绝了这个 token(401 Bad credentials):可能已过期、复制不完整,或粘错了内容'
  if (status === 403) return 'token 无权限(需要本仓库 Contents 读写)'
  if (status === 404) return '仓库不存在,或 token 无权限访问它'
  return `GitHub ${status}:${fallback}`
}

async function parseError(res: Response): Promise<Error> {
  const { message } = (await res.json().catch(() => ({}))) as { message?: string }
  return new Error(friendly(res.status, message ?? res.statusText))
}

/** UTF-8 安全的 base64(对话里有中文) */
function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

async function ghFetch(path: string, token?: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: { ...headers(token), ...init?.headers },
    })
  } catch {
    throw new Error('网络错误:连不上 GitHub')
  }
}

/** 校验 token 有效,且属于输入的账号 */
export async function verifyCreds(user: string, token: string): Promise<void> {
  // 先看形状:GitHub PAT 只有这两种前缀,粘错内容(如 LiveKit 的 eyJ… JWT)直接指出
  if (!/^(github_pat_|ghp_)/.test(token)) {
    throw new Error(
      '这不像 GitHub token:应以 github_pat_(fine-grained)或 ghp_(classic)开头;eyJ 开头的是 LiveKit 房间 token,别粘到这里',
    )
  }
  const res = await ghFetch('/user', token)
  if (!res.ok) throw (await parseError(res)) as Error
  const data = (await res.json()) as { login?: string }
  if (data.login?.toLowerCase() !== user.toLowerCase()) {
    throw new Error(`token 属于账号 ${data.login},和你输入的 ${user} 不一致`)
  }
}

/** 会话文件路径:纯时间戳命名,唯一且字典序 = 时间序 */
export function sessionPath(user: string, startedAt: number): string {
  const d = new Date(startedAt)
  const p = (n: number) => String(n).padStart(2, '0')
  const name = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  return `sessions/${user}/${name}.json`
}

async function getSha(user: string, path: string, token?: string): Promise<string> {
  const res = await ghFetch(`/repos/${user}/${REPO}/contents/${path}`, token)
  if (!res.ok) throw (await parseError(res)) as Error
  return ((await res.json()) as { sha: string }).sha
}

/** 上传一个会话;文件已存在(重传)时取 sha 覆盖 */
export async function putSession(
  account: Account,
  payload: SessionPayload,
  path: string,
): Promise<void> {
  const content = toBase64(JSON.stringify(payload, null, 2))
  const put = (sha?: string) =>
    ghFetch(`/repos/${account.user}/${REPO}/contents/${path}`, account.token, {
      method: 'PUT',
      body: JSON.stringify({
        message: `save session ${path}`,
        content,
        ...(sha ? { sha } : {}),
      }),
    })
  let res = await put()
  if (res.status === 422 || res.status === 409) {
    res = await put(await getSha(account.user, path, account.token))
  }
  if (!res.ok) throw (await parseError(res)) as Error
}

/** 列出账号名下的已同步会话(公开仓库,匿名可读) */
export async function listRemote(user: string, token?: string): Promise<RemoteEntry[]> {
  const res = await ghFetch(`/repos/${user}/${REPO}/contents/sessions/${user}`, token)
  if (res.status === 404) return [] // 该账号还没有任何记录
  if (!res.ok) throw (await parseError(res)) as Error
  const data = (await res.json()) as RemoteEntry[]
  return Array.isArray(data) ? data.filter((f) => f.name.endsWith('.json')) : []
}

/** 拉取单个会话文件的内容(JSON 字符串) */
export async function getRemote(user: string, path: string, token?: string): Promise<string> {
  const res = await ghFetch(`/repos/${user}/${REPO}/contents/${path}`, token)
  if (!res.ok) throw (await parseError(res)) as Error
  const { content } = (await res.json()) as { content: string }
  return fromBase64(content)
}
