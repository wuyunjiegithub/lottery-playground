/**
 * 服务端 API 的公共取址与请求封装。
 *
 * 取址优先级：
 *   1. `VITE_API_BASE` 环境变量 —— 部署时显式指定
 *   2. 开发环境默认 `http://localhost:8787`（`npm run server` 起的那个）
 *   3. 生产环境默认同源 `/api` —— 假定后端同时托管了静态资源
 */
export const apiBase: string = (
  (import.meta.env?.VITE_API_BASE as string) ||
  (import.meta.env?.DEV ? 'http://localhost:8787' : '/api')
).replace(/\/$/, '')

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return (await res.json()) as T
}

export function serverGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function serverPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export function serverDel<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' })
}
