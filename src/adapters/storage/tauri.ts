/**
 * Tauri 端 SQLite 存储桥（Windows / macOS / Linux）。
 *
 * 走官方 tauri-plugin-sql：schema 迁移在 Rust 侧完成（见 src-tauri/src/lib.rs），
 * 这里只负责把 StorageAdapter 的调用翻译成 SQL。
 *
 * 相比裸 rusqlite + 一堆自定义 command，这个写法把 Rust 侧代码压到最小，
 * 也顺带白拿了官方的连接管理与路径解析。
 *
 * 插件未编译进二进制时 isAvailable() 会失败，index.ts 自动降级到 IndexedDB。
 */
import type { Draw, LotteryType } from '../../types'
import type { RunMeta, StorageAdapter, SummaryRow, UserState } from './types'

const DB_URL = 'sqlite:lottery_playground.db'

/** @tauri-apps/plugin-sql 的 Database 的最小子集，避免引 any 导致泛型退化 */
interface SqlDb {
  select<T = any>(sql: string, values?: unknown[]): Promise<T>
  execute(sql: string, values?: unknown[]): Promise<{ rowsAffected: number; lastInsertId?: number }>
  close(): Promise<void>
}

let dbPromise: Promise<SqlDb> | null = null

async function db(): Promise<SqlDb> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const Database = (await import('@tauri-apps/plugin-sql')).default
      return (await Database.load(DB_URL)) as unknown as SqlDb
    })()
  }
  return dbPromise
}

export async function isAvailable(): Promise<boolean> {
  try {
    // 建一次查询，确认库真能打开（插件没注册时会挂在 load 上）
    await (await db()).select('SELECT 1 AS ok')
    return true
  } catch {
    return false
  }
}

type Row = Record<string, any>

const toDraw = (r: Row): Draw => ({
  lottery: r.lottery,
  issue: r.issue,
  date: r.date ?? undefined,
  front: String(r.front).split(',').map(Number),
  back: String(r.back).split(',').map(Number),
  pool: r.pool ?? undefined,
  sales: r.sales ?? undefined,
  prizes: r.prizes ? JSON.parse(r.prizes) : undefined,
  source: r.source ?? undefined,
})

export const adapter: StorageAdapter = {
  kind: 'sqlite',

  async getDraws(lottery: LotteryType): Promise<Draw[]> {
    const rows = await (await db()).select<Row[]>(
      'SELECT * FROM draws WHERE lottery = $1 ORDER BY issue',
      [lottery]
    )
    return rows.map(toDraw)
  },

  async upsertDraws(draws: Draw[]): Promise<number> {
    const c = await db()
    const sql = `INSERT INTO draws (lottery, issue, date, front, back, pool, sales, prizes, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT(lottery, issue) DO UPDATE SET
        date = excluded.date, front = excluded.front, back = excluded.back,
        pool = excluded.pool, sales = excluded.sales, prizes = excluded.prizes,
        source = excluded.source`
    let added = 0
    for (const d of draws) {
      const hit = await c.select<Row[]>(
        'SELECT 1 AS hit FROM draws WHERE lottery = $1 AND issue = $2',
        [d.lottery, d.issue]
      )
      if (hit.length) continue
      await c.execute(sql, [
        d.lottery, d.issue, d.date ?? null, d.front.join(','), d.back.join(','),
        d.pool ?? null, d.sales ?? null,
        d.prizes ? JSON.stringify(d.prizes) : null, d.source ?? null,
      ])
      added++
    }
    return added
  },

  async countDraws(lottery: LotteryType): Promise<number> {
    const rows = await (await db()).select<Row[]>(
      'SELECT COUNT(*) AS n FROM draws WHERE lottery = $1',
      [lottery]
    )
    return Number(rows[0]?.n ?? 0)
  },

  async putRun(meta: RunMeta): Promise<void> {
    const sql = `INSERT INTO runs
        (run_key, lottery, budget, sample, periods, model_count, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT(run_key) DO UPDATE SET
        periods = excluded.periods, model_count = excluded.model_count,
        created_at = excluded.created_at`
    await (await db()).execute(sql, [
      meta.runKey, meta.lottery, meta.budget, meta.sample,
      meta.periods, meta.modelCount, meta.createdAt,
    ])
  },

  async getRun(runKey: string): Promise<RunMeta | null> {
    const rows = await (await db()).select<Row[]>(
      'SELECT * FROM runs WHERE run_key = $1',
      [runKey]
    )
    return (rows[0] as RunMeta) ?? null
  },

  async listRuns(lottery?: LotteryType): Promise<RunMeta[]> {
    const c = await db()
    const rows = lottery
      ? await c.select<Row[]>('SELECT * FROM runs WHERE lottery = $1 ORDER BY created_at DESC', [lottery])
      : await c.select<Row[]>('SELECT * FROM runs ORDER BY created_at DESC')
    return rows as RunMeta[]
  },

  async deleteRun(runKey: string): Promise<void> {
    const c = await db()
    await c.execute('DELETE FROM runs WHERE run_key = $1', [runKey])
    await c.execute('DELETE FROM summary WHERE run_key = $1', [runKey])
  },

  async putSummary(rows: SummaryRow[]): Promise<void> {
    const c = await db()
    // 同一个 runKey 重跑时先清空，避免模型数量变化留下脏行
    for (const k of [...new Set(rows.map((r) => r.runKey))]) {
      await c.execute('DELETE FROM summary WHERE run_key = $1', [k])
    }
    const sql = `INSERT INTO summary
        (run_key, model_id, model_name, category, trials, total_cost, total_prize,
         roi, win_rate, best_level, hits, equity)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`
    for (const r of rows) {
      await c.execute(sql, [
        r.runKey, r.modelId, r.modelName, r.category, r.trials,
        r.totalCost, r.totalPrize, r.roi, r.winRate, r.bestLevel,
        JSON.stringify(r.hits || {}), JSON.stringify(r.equity || []),
      ])
    }
  },

  async getSummary(runKey: string): Promise<SummaryRow[]> {
    const rows = await (await db()).select<Row[]>(
      'SELECT * FROM summary WHERE run_key = $1 ORDER BY roi DESC',
      [runKey]
    )
    return rows.map((r) => ({
      ...r,
      hits: r.hits ? JSON.parse(r.hits) : {},
      equity: r.equity ? JSON.parse(r.equity) : [],
    })) as SummaryRow[]
  },

  async getUserState(): Promise<UserState> {
    const rows = await (await db()).select<Row[]>(
      "SELECT v FROM kv WHERE k = 'user_state'"
    )
    return rows[0]?.v ? JSON.parse(rows[0].v) : ({} as UserState)
  },

  async putUserState(state: UserState): Promise<void> {
    await (await db()).execute(
      "INSERT INTO kv (k, v) VALUES ('user_state', $1) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      [JSON.stringify(state)]
    )
  },

  async getKV<T>(k: string): Promise<T | null> {
    const rows = await (await db()).select<Row[]>('SELECT v FROM kv WHERE k = $1', [k])
    const raw = rows[0]?.v
    return raw ? (JSON.parse(raw) as T) : null
  },

  async putKV<T>(k: string, v: T): Promise<void> {
    await (await db()).execute(
      'INSERT INTO kv (k, v) VALUES ($1, $2) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      [k, JSON.stringify(v)]
    )
  },

  async clearAll(): Promise<void> {
    const c = await db()
    await c.execute('DELETE FROM draws')
    await c.execute('DELETE FROM runs')
    await c.execute('DELETE FROM summary')
    await c.execute('DELETE FROM kv')
  },
}
