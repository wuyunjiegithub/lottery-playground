/**
 * Capacitor 端 SQLite 存储桥（安卓 WebView）。
 *
 * 与 Tauri 端共用 adapters/storage/schema.ts 里的同一份 SQL，
 * 差异只在驱动方式——这里是 @capacitor-community/sqlite 插件实例。
 *
 * 插件未安装或未完成 npm/i 时 isAvailable() 返回 false，
 * index.ts 自动降级到 IndexedDB，网页端行为不受影响。
 */
import type { DetailCache, RunMeta, SummaryRow, UserState } from './types'
import { packStop, unpackStop } from './schema'
import type { Draw, LotteryType } from '../../types'

const DB_NAME = 'lottery_playground'

let connPromise: Promise<any> | null = null

async function conn(): Promise<any> {
  if (!connPromise) {
    connPromise = (async () => {
      const { CapacitorSQLite, SQLiteConnection } = await import(
        '@capacitor-community/sqlite'
      )
      const sqlite = new SQLiteConnection(CapacitorSQLite)
      const c = await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false)
      await c.open()
      return c
    })()
  }
  return connPromise
}

async function query<T = any>(sql: string, values: any[] = []): Promise<T[]> {
  const c = await conn()
  const res = await c.query(sql, values)
  return (res?.values || []) as T[]
}

async function execute(sql: string, values: any[] = []): Promise<void> {
  const c = await conn()
  await c.run(sql, values)
}

export async function isAvailable(): Promise<boolean> {
  try {
    await conn()
    return true
  } catch {
    return false
  }
}

/**
 * 老库补列：`stop_data` 是后加的（见 schema.ts 的 ALTER_COLUMNS）。
 * SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，重复执行会报错，所以只试一次并吞掉异常。
 */
let stopColumnEnsured = false
async function ensureStopColumn(): Promise<void> {
  if (stopColumnEnsured) return
  stopColumnEnsured = true
  try {
    await execute('ALTER TABLE summary ADD COLUMN stop_data TEXT')
  } catch {
    // 已经有了
  }
}

/** 明细表是本轮新加的，安卓端没有 Rust 那种迁移，写入前补建一次 */
let detailTableEnsured = false
async function ensureDetailTable(): Promise<void> {
  if (detailTableEnsured) return
  detailTableEnsured = true
  await execute(`CREATE TABLE IF NOT EXISTS details (
     run_key    TEXT NOT NULL,
     model_id   TEXT NOT NULL,
     start      INTEGER NOT NULL,
     up_to      INTEGER NOT NULL,
     engine     INTEGER NOT NULL,
     rows       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (run_key, model_id)
   )`)
}

const toDraw = (r: any): Draw => ({
  lottery: r.lottery,
  issue: r.issue,
  date: r.date,
  front: String(r.front).split(',').map(Number),
  back: String(r.back).split(',').map(Number),
  pool: r.pool,
  sales: r.sales,
  prizes: r.prizes ? JSON.parse(r.prizes) : undefined,
  source: r.source,
})

export const capacitorAdapter = {
  async getDraws(lottery: LotteryType): Promise<Draw[]> {
    return query<Draw>(
      'SELECT * FROM draws WHERE lottery = ? ORDER BY issue',
      [lottery]
    ).then((rs) => rs.map(toDraw))
  },

  async upsertDraws(draws: Draw[]): Promise<number> {
    let added = 0
    for (const d of draws) {
      const [row] = await query(
        'SELECT 1 AS hit FROM draws WHERE lottery = ? AND issue = ?',
        [d.lottery, d.issue]
      )
      if (row) continue
      await execute(
        `INSERT INTO draws (lottery, issue, date, front, back, pool, sales, prizes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          d.lottery, d.issue, d.date ?? null, d.front.join(','), d.back.join(','),
          d.pool ?? null, d.sales ?? null,
          d.prizes ? JSON.stringify(d.prizes) : null, d.source ?? null,
        ]
      )
      added++
    }
    return added
  },

  countDraws(lottery: LotteryType): Promise<number> {
    return query<{ n: number }>('SELECT COUNT(*) AS n FROM draws WHERE lottery = ?', [lottery])
      .then((rs) => rs[0]?.n ?? 0)
  },

  putRun(meta: RunMeta): Promise<void> {
    return execute(
      `INSERT INTO runs (run_key, lottery, budget, sample, periods, model_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key) DO UPDATE SET
         periods = excluded.periods, model_count = excluded.model_count,
         created_at = excluded.created_at`,
      [meta.runKey, meta.lottery, meta.budget, meta.sample,
       meta.periods, meta.modelCount, meta.createdAt]
    )
  },

  getRun(runKey: string): Promise<RunMeta | null> {
    return query<RunMeta>('SELECT * FROM runs WHERE run_key = ?', [runKey])
      .then((rs) => rs[0] ?? null)
  },

  listRuns(lottery?: LotteryType): Promise<RunMeta[]> {
    return lottery
      ? query<RunMeta>('SELECT * FROM runs WHERE lottery = ? ORDER BY created_at DESC', [lottery])
      : query<RunMeta>('SELECT * FROM runs ORDER BY created_at DESC')
  },

  deleteRun(runKey: string): Promise<void> {
    return execute('DELETE FROM runs WHERE run_key = ?', [runKey]).then(async () => {
      await execute('DELETE FROM summary WHERE run_key = ?', [runKey])
      await execute('DELETE FROM details WHERE run_key = ?', [runKey])
    })
  },

  async putSummary(rows: SummaryRow[]): Promise<void> {
    await ensureStopColumn()
    const runKeys = [...new Set(rows.map((r) => r.runKey))]
    for (const k of runKeys) await execute('DELETE FROM summary WHERE run_key = ?', [k])
    for (const r of rows) {
      await execute(
        `INSERT INTO summary (run_key, model_id, model_name, category, trials,
           total_cost, total_prize, roi, win_rate, best_level, hits, equity, stop_data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.runKey, r.modelId, r.modelName, r.category, r.trials, r.totalCost,
         r.totalPrize, r.roi, r.winRate, r.bestLevel,
         JSON.stringify(r.hits || {}), JSON.stringify(r.equity || []), packStop(r)]
      )
    }
  },

  getSummary(runKey: string): Promise<SummaryRow[]> {
    return query<any>('SELECT * FROM summary WHERE run_key = ? ORDER BY roi DESC', [runKey])
      .then((rs) =>
        rs.map((r) => ({
          ...unpackStop(r.stop_data),
          ...r,
          hits: r.hits ? JSON.parse(r.hits) : {},
          equity: r.equity ? JSON.parse(r.equity) : [],
        }))
      )
  },

  getDetail(runKey: string, modelId: string): Promise<DetailCache | null> {
    return query<any>('SELECT * FROM details WHERE run_key = ? AND model_id = ?', [
      runKey,
      modelId,
    ]).then((rs) => {
      const r = rs[0]
      if (!r) return null
      return {
        runKey: r.run_key,
        modelId: r.model_id,
        start: r.start,
        upTo: r.up_to,
        engine: r.engine,
        rows: r.rows ? JSON.parse(r.rows) : [],
        createdAt: r.created_at,
      } as DetailCache
    })
  },

  async putDetail(d: DetailCache): Promise<void> {
    await ensureDetailTable()
    await execute(
      `INSERT INTO details (run_key, model_id, start, up_to, engine, rows, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_key, model_id) DO UPDATE SET
         start = excluded.start, up_to = excluded.up_to, engine = excluded.engine,
         rows = excluded.rows, created_at = excluded.created_at`,
      [d.runKey, d.modelId, d.start, d.upTo, d.engine, JSON.stringify(d.rows || []), d.createdAt]
    )
  },

  getUserState(): Promise<UserState> {
    return query<{ v: string }>("SELECT v FROM kv WHERE k = 'user_state'", [])
      .then((rs) => (rs[0] ? JSON.parse(rs[0].v) : ({} as UserState)))
  },

  putUserState(state: UserState): Promise<void> {
    return execute("INSERT INTO kv (k, v) VALUES ('user_state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [
      JSON.stringify(state),
    ])
  },

  getKV<T>(k: string): Promise<T | null> {
    return query<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]).then((rs) =>
      rs[0]?.v ? (JSON.parse(rs[0].v) as T) : null
    )
  },

  putKV<T>(k: string, v: T): Promise<void> {
    return execute('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [
      k,
      JSON.stringify(v),
    ])
  },

  async clearAll(): Promise<void> {
    await execute('DELETE FROM draws')
    await execute('DELETE FROM runs')
    await execute('DELETE FROM summary')
    await execute('DELETE FROM details')
    await execute('DELETE FROM kv')
  },
}
