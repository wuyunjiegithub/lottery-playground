/**
 * 内存存储后端。
 *
 * 存在的理由：verify.mjs 之类的脚本跑在 Node 里，没有 IndexedDB；
 * 隐私模式下浏览器也可能拒绝建库。这两种情况下降级到此实现，
 * 保证业务层不用到处判断「存储是否可用」。
 *
 * 数据随进程生命周期消失，故 clearAll 之外的操作都等价于普通对象读写。
 */
import type { Draw, LotteryType } from '../../types'
import {
  DEFAULT_USER_STATE,
  type StorageAdapter,
  type RunMeta,
  type SummaryRow,
  type UserState,
} from './types'

export function createMemoryAdapter(): StorageAdapter {
  const draws = new Map<string, Draw>()
  const runs = new Map<string, RunMeta>()
  const summary = new Map<string, SummaryRow>()
  const kv = new Map<string, unknown>()
  let user: UserState = { ...DEFAULT_USER_STATE }

  const dkey = (lottery: string, issue: string) => `${lottery}:${issue}`
  const skey = (runKey: string, modelId: string) => `${runKey}:${modelId}`

  return {
    kind: 'memory',

    async getDraws(lottery: LotteryType): Promise<Draw[]> {
      return [...draws.values()]
        .filter((d) => d.lottery === lottery)
        .sort((a, b) => a.issue.localeCompare(b.issue))
    },

    async upsertDraws(list: Draw[]): Promise<number> {
      let added = 0
      for (const d of list) {
        const k = dkey(d.lottery, d.issue)
        if (draws.has(k)) continue
        draws.set(k, { ...d })
        added++
      }
      return added
    },

    async countDraws(lottery: LotteryType): Promise<number> {
      let n = 0
      for (const k of draws.keys()) if (k.startsWith(`${lottery}:`)) n++
      return n
    },

    async putRun(meta: RunMeta): Promise<void> {
      runs.set(meta.runKey, { ...meta })
    },

    async getRun(runKey: string): Promise<RunMeta | null> {
      return runs.get(runKey) || null
    },

    async listRuns(lottery?: LotteryType): Promise<RunMeta[]> {
      return [...runs.values()]
        .filter((r) => !lottery || r.lottery === lottery)
        .sort((a, b) => b.createdAt - a.createdAt)
    },

    async deleteRun(runKey: string): Promise<void> {
      runs.delete(runKey)
      for (const k of [...summary.keys()]) {
        if (k.startsWith(`${runKey}:`)) summary.delete(k)
      }
    },

    async putSummary(rows: SummaryRow[]): Promise<void> {
      const runKeys = new Set(rows.map((r) => r.runKey))
      for (const k of [...summary.keys()]) {
        if (runKeys.has(k.split(':')[0])) summary.delete(k)
      }
      for (const r of rows) summary.set(skey(r.runKey, r.modelId), { ...r })
    },

    async getSummary(runKey: string): Promise<SummaryRow[]> {
      return [...summary.values()]
        .filter((r) => r.runKey === runKey)
        .sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
    },

    async getUserState(): Promise<UserState> {
      return { ...user }
    },

    async putUserState(state: UserState): Promise<void> {
      user = { ...state }
    },

    async getKV<T>(k: string): Promise<T | null> {
      return kv.has(k) ? (kv.get(k) as T) : null
    },

    async putKV<T>(k: string, v: T): Promise<void> {
      kv.set(k, v)
    },

    async clearAll(): Promise<void> {
      draws.clear()
      runs.clear()
      summary.clear()
      kv.clear()
      user = { ...DEFAULT_USER_STATE }
    },
  }
}
