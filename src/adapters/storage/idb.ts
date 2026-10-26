/**
 * IndexedDB 存储后端（网页端主力）。
 *
 * 用 IndexedDB 而不是浏览器键值对：后者 5 MB 上限装不下回测汇总
 * （78 模型 × 净值序列约 1.5 MB，再叠加长期使用会满）。
 *
 * 逻辑 schema 与 SQLite 端保持一致，方便将来互换：
 *   draws   keyPath "pk"      lottery:issue
 *   runs    keyPath "runKey"
 *   summary keyPath "pk"      runKey:modelId
 *   kv      keyPath "k"       用户状态
 */
import type { Draw, LotteryType } from '../../types'
import {
  DEFAULT_USER_STATE,
  type StorageAdapter,
  type RunMeta,
  type SummaryRow,
  type UserState,
} from './types'

const DB_NAME = 'lottery_playground'
const DB_VERSION = 1

const S_DRAWS = 'draws'
const S_RUNS = 'runs'
const S_SUMMARY = 'summary'
const S_KV = 'kv'
const K_USER = 'user_state'

export const drawKey = (lottery: string, issue: string) => `${lottery}:${issue}`
export const summaryKey = (runKey: string, modelId: string) => `${runKey}:${modelId}`

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(S_DRAWS)) {
        db.createObjectStore(S_DRAWS, { keyPath: 'pk' })
      }
      if (!db.objectStoreNames.contains(S_RUNS)) {
        db.createObjectStore(S_RUNS, { keyPath: 'runKey' })
      }
      if (!db.objectStoreNames.contains(S_SUMMARY)) {
        db.createObjectStore(S_SUMMARY, { keyPath: 'pk' })
      }
      if (!db.objectStoreNames.contains(S_KV)) {
        db.createObjectStore(S_KV, { keyPath: 'k' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'))
  })
  return dbPromise
}

/**
 * 去掉 Vue 的响应式代理，返回一个纯数据副本。
 *
 * **为什么必须有它**：IndexedDB 写入走结构化克隆，而**克隆不了 Proxy** ——
 * 传进去直接抛 DataCloneError。调用方拿到的却几乎都是 Pinia state
 * （`store.profile`、`store.favorites`、`boardInfo`、回测汇总……全是 reactive proxy），
 * 于是每次写入都在底层失败。界面上表现为「点了保存、弹窗说成功、刷新就没了」，
 * 而错误被 persist 的 catch 吞掉，一年都没人发现。
 *
 * 与其要求每个调用点记得 toRaw（漏一处就重现一次），不如在落库这层统一净化。
 * 只用于写入路径，且每次只净化一条记录，开销可忽略。
 */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 把 IndexedDB 的请求式 API 包成 Promise */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB 操作失败'))
  })
}

async function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error || new Error('事务失败'))
    tx.onabort = () => reject(tx.error || new Error('事务中止'))
  })
}

type Mode = IDBTransactionMode

async function run<T>(
  stores: string | string[],
  mode: Mode,
  fn: (tx: IDBTransaction) => Promise<T>
): Promise<T> {
  const db = await open()
  const tx = db.transaction(stores, mode)
  const out = await fn(tx)
  await txDone(tx)
  return out
}

function numFrontBack(d: Draw) {
  return {
    front: d.front.join(','),
    back: d.back.join(','),
  }
}

export const idbAdapter: StorageAdapter = {
  kind: 'idb',

  async getDraws(lottery: LotteryType): Promise<Draw[]> {
    const rows = await run(S_DRAWS, 'readonly', async (tx) => {
      const store = tx.objectStore(S_DRAWS)
      return reqToPromise(store.getAll() as IDBRequest<Draw[]>)
    })
    return rows
      .filter((r: any) => r.lottery === lottery)
      .map((r: any) => ({
        lottery: r.lottery,
        issue: r.issue,
        date: r.date,
        front: typeof r.front === 'string' ? r.front.split(',').map(Number) : r.front,
        back: typeof r.back === 'string' ? r.back.split(',').map(Number) : r.back,
        pool: r.pool,
        sales: r.sales,
        prizes: r.prizes,
        source: r.source,
      }))
      .sort((a, b) => a.issue.localeCompare(b.issue))
  },

  async upsertDraws(draws: Draw[]): Promise<number> {
    if (!draws.length) return 0
    return run(S_DRAWS, 'readwrite', async (tx) => {
      const store = tx.objectStore(S_DRAWS)
      const keys = draws.map((d) => drawKey(d.lottery, d.issue))
      // 主键已存在的是旧数据，只数新来的
      const existing = new Set<string>()
      for (const k of keys) {
        const hit = await reqToPromise(store.getKey(k) as IDBRequest<IDBValidKey | undefined>)
        if (hit !== undefined) existing.add(k)
      }
      let added = 0
      for (const d of draws) {
        const k = drawKey(d.lottery, d.issue)
        if (existing.has(k)) continue
        store.put(plain({ ...d, pk: k, ...numFrontBack(d) }))
        added++
      }
      return added
    })
  },

  async countDraws(lottery: LotteryType): Promise<number> {
    const rows = await run(S_DRAWS, 'readonly', async (tx) => {
      const store = tx.objectStore(S_DRAWS)
      return reqToPromise(store.getAllKeys() as IDBRequest<IDBValidKey[]>)
    })
    return rows.filter((k) => String(k).startsWith(`${lottery}:`)).length
  },

  async putRun(meta: RunMeta): Promise<void> {
    await run(S_RUNS, 'readwrite', async (tx) => {
      tx.objectStore(S_RUNS).put(plain(meta))
    })
  },

  async getRun(runKey: string): Promise<RunMeta | null> {
    const r = await run(S_RUNS, 'readonly', async (tx) => {
      return reqToPromise(tx.objectStore(S_RUNS).get(runKey) as IDBRequest<RunMeta | undefined>)
    })
    return r || null
  },

  async listRuns(lottery?: LotteryType): Promise<RunMeta[]> {
    const rows = await run(S_RUNS, 'readonly', async (tx) => {
      return reqToPromise(tx.objectStore(S_RUNS).getAll() as IDBRequest<RunMeta[]>)
    })
    const list = lottery ? rows.filter((r) => r.lottery === lottery) : rows
    return list.sort((a, b) => b.createdAt - a.createdAt)
  },

  async deleteRun(runKey: string): Promise<void> {
    await run([S_RUNS, S_SUMMARY], 'readwrite', async (tx) => {
      tx.objectStore(S_RUNS).delete(runKey)
      const store = tx.objectStore(S_SUMMARY)
      const keys = await reqToPromise(
        store.getAllKeys() as IDBRequest<IDBValidKey[]>
      )
      for (const k of keys) {
        if (String(k).startsWith(`${runKey}:`)) store.delete(k)
      }
    })
  },

  async putSummary(rows: SummaryRow[]): Promise<void> {
    if (!rows.length) return
    await run(S_SUMMARY, 'readwrite', async (tx) => {
      const store = tx.objectStore(S_SUMMARY)
      // 同一 runKey 重跑时先清干净，避免模型数量变化留下脏行
      const keys = await reqToPromise(store.getAllKeys() as IDBRequest<IDBValidKey[]>)
      const runKeys = new Set(rows.map((r) => r.runKey))
      for (const k of keys) {
        const prefix = String(k).split(':')[0]
        if (runKeys.has(prefix)) store.delete(k)
      }
      for (const r of rows) store.put(plain({ ...r, pk: summaryKey(r.runKey, r.modelId) }))
    })
  },

  async getSummary(runKey: string): Promise<SummaryRow[]> {
    const rows = await run(S_SUMMARY, 'readonly', async (tx) => {
      return reqToPromise(tx.objectStore(S_SUMMARY).getAll() as IDBRequest<SummaryRow[]>)
    })
    return rows
      .filter((r) => r.runKey === runKey)
      .sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  },

  async getUserState(): Promise<UserState> {
    const r = await run(S_KV, 'readonly', async (tx) => {
      return reqToPromise(
        tx.objectStore(S_KV).get(K_USER) as IDBRequest<{ k: string; v: UserState } | undefined>
      )
    })
    return { ...DEFAULT_USER_STATE, ...(r?.v || {}) }
  },

  async putUserState(state: UserState): Promise<void> {
    await run(S_KV, 'readwrite', async (tx) => {
      tx.objectStore(S_KV).put({ k: K_USER, v: plain(state) })
    })
  },

  async getKV<T>(k: string): Promise<T | null> {
    const r = await run(S_KV, 'readonly', async (tx) => {
      return reqToPromise(
        tx.objectStore(S_KV).get(k) as IDBRequest<{ k: string; v: T } | undefined>
      )
    })
    return r ? (r.v as T) : null
  },

  async putKV<T>(k: string, v: T): Promise<void> {
    await run(S_KV, 'readwrite', async (tx) => {
      tx.objectStore(S_KV).put({ k, v: plain(v) })
    })
  },

  async clearAll(): Promise<void> {
    await run([S_DRAWS, S_RUNS, S_SUMMARY, S_KV], 'readwrite', async (tx) => {
      tx.objectStore(S_DRAWS).clear()
      tx.objectStore(S_RUNS).clear()
      tx.objectStore(S_SUMMARY).clear()
      tx.objectStore(S_KV).clear()
    })
  },
}
