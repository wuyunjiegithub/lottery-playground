/**
 * 服务端存储后端。
 *
 * 有了它，网页版的数据就不再寄居在浏览器的 IndexedDB 里 ——
 * 清缓存、换浏览器、换设备，开奖历史和回测结果都还在你自己机器上的 SQLite 里。
 *
 * 接口语义与 sqlite / idb 两个后端完全一致，业务层无感。
 */
import type { Draw, LotteryType } from '../../types'
import type {
  DetailCache,
  RunMeta,
  StorageAdapter,
  SummaryRow,
  UserState,
} from './types'
import { DEFAULT_USER_STATE } from './types'
import { apiBase, serverGet, serverPost, serverDel } from './http'

const KV_USER = 'user_state'

export const serverAdapter: StorageAdapter = {
  kind: 'server',

  async getDraws(lottery: LotteryType): Promise<Draw[]> {
    const r = await serverGet<{ draws: Draw[] }>(`/api/draws?lottery=${lottery}`)
    return r.draws || []
  },

  async upsertDraws(draws: Draw[]): Promise<number> {
    const r = await serverPost<{ added: number }>('/api/draws', { draws })
    return r.added || 0
  },

  async countDraws(lottery: LotteryType): Promise<number> {
    const r = await serverGet<{ count: number }>(`/api/draws/count?lottery=${lottery}`)
    return r.count || 0
  },

  async putRun(meta: RunMeta): Promise<void> {
    await serverPost('/api/runs', meta)
  },

  async getRun(runKey: string): Promise<RunMeta | null> {
    const r = await serverGet<{ runs: RunMeta[] }>(`/api/runs?runKey=${encodeURIComponent(runKey)}`)
    return r.runs?.find((x) => x.runKey === runKey) || null
  },

  async listRuns(lottery?: LotteryType): Promise<RunMeta[]> {
    const q = lottery ? `?lottery=${lottery}` : ''
    const r = await serverGet<{ runs: RunMeta[] }>(`/api/runs${q}`)
    return r.runs || []
  },

  async deleteRun(runKey: string): Promise<void> {
    await serverDel(`/api/runs?runKey=${encodeURIComponent(runKey)}`)
  },

  async putSummary(rows: SummaryRow[]): Promise<void> {
    await serverPost('/api/summary', { rows })
  },

  async getSummary(runKey: string): Promise<SummaryRow[]> {
    const r = await serverGet<{ rows: SummaryRow[] }>(
      `/api/summary?runKey=${encodeURIComponent(runKey)}`
    )
    return r.rows || []
  },

  async getDetail(runKey: string, modelId: string): Promise<DetailCache | null> {
    const r = await serverGet<{ detail: DetailCache | null }>(
      `/api/detail?runKey=${encodeURIComponent(runKey)}&modelId=${encodeURIComponent(modelId)}`
    )
    return r.detail || null
  },

  async putDetail(detail: DetailCache): Promise<void> {
    await serverPost('/api/detail', detail)
  },

  async getUserState(): Promise<UserState> {
    const r = await serverGet<{ value: UserState | null }>(`/api/kv?k=${KV_USER}`)
    return { ...DEFAULT_USER_STATE, ...(r.value || {}) }
  },

  async putUserState(state: UserState): Promise<void> {
    await serverPost('/api/kv', { k: KV_USER, v: state })
  },

  async getKV<T>(k: string): Promise<T | null> {
    const r = await serverGet<{ value: T | null }>(`/api/kv?k=${encodeURIComponent(k)}`)
    return (r.value ?? null) as T | null
  },

  async putKV<T>(k: string, v: T): Promise<void> {
    await serverPost('/api/kv', { k, v })
  },

  async clearAll(): Promise<void> {
    await serverPost('/api/clear', {})
  },
}

/**
 * 后端是否可用。
 *
 * 只探测一次并缓存结果：后端没起的时候，每次开页面都去撞一次会白等几秒。
 */
let probe: Promise<boolean> | null = null

export function isServerAvailable(): Promise<boolean> {
  if (!probe) {
    probe = (async () => {
      try {
        const r = await serverGet<{ ok: boolean }>('/api/health')
        return !!r.ok
      } catch {
        return false
      }
    })()
  }
  return probe
}

export { apiBase }
