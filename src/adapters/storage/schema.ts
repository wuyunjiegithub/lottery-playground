/**
 * 三端共用的 SQLite 逻辑 schema。
 *
 * Tauri（rusqlite）与 Capacitor（community sqlite）执行的是同一批 SQL，
 * 集中在此避免两端 schema 漂移。IndexedDB 端也按同样的主键/索引语义建 store。
 *
 * 装什么：
 *   - draws    开奖历史。不可再生，丢了要重新爬
 *   - runs     回测批次元信息
 *   - summary  回测汇总（每模型一行 + 净值序列），约 1.5 MB
 *
 * 不装什么：
 *   - 回测逐期明细（约 20 万条 / 21.5 MB）。那是完全可再生的派生产物，
 *     改预算重跑就有，通过导出走文件，不占数据库。
 */

export const SCHEMA_VERSION = 2

export const CREATE_TABLES = [
  `CREATE TABLE IF NOT EXISTS draws (
     lottery TEXT NOT NULL,
     issue   TEXT NOT NULL,
     date    TEXT,
     front   TEXT NOT NULL,
     back    TEXT NOT NULL,
     pool    TEXT,
     sales   TEXT,
     prizes  TEXT,
     source  TEXT,
     PRIMARY KEY (lottery, issue)
   )`,

  `CREATE TABLE IF NOT EXISTS runs (
     run_key     TEXT PRIMARY KEY,
     lottery     TEXT NOT NULL,
     budget      INTEGER NOT NULL,
     sample      INTEGER NOT NULL,
     periods     INTEGER NOT NULL,
     model_count INTEGER NOT NULL,
     created_at  INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS summary (
     run_key     TEXT NOT NULL,
     model_id    TEXT NOT NULL,
     model_name  TEXT,
     category    TEXT,
     trials      INTEGER,
     total_cost  INTEGER,
     total_prize INTEGER,
     roi         REAL,
     win_rate    REAL,
     best_level  INTEGER,
     hits        TEXT,
     equity      TEXT,
     stop_data   TEXT,
     PRIMARY KEY (run_key, model_id)
   )`,

  `CREATE TABLE IF NOT EXISTS kv (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,

  // 逐期明细：懒缓存，只存用户真点开过的模型（一模型 0.3~0.7 MB）
  `CREATE TABLE IF NOT EXISTS details (
     run_key    TEXT NOT NULL,
     model_id   TEXT NOT NULL,
     start      INTEGER NOT NULL,
     up_to      INTEGER NOT NULL,
     engine     INTEGER NOT NULL,
     rows       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (run_key, model_id)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_draws_lottery ON draws(lottery, issue)`,
  `CREATE INDEX IF NOT EXISTS idx_summary_run ON summary(run_key, roi DESC)`,
]

export const SQL = {
  upsertDraw: `INSERT INTO draws (lottery, issue, date, front, back, pool, sales, prizes, source)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    ON CONFLICT(lottery, issue) DO UPDATE SET
      date = excluded.date, front = excluded.front, back = excluded.back,
      pool = excluded.pool, sales = excluded.sales, prizes = excluded.prizes,
      source = excluded.source`,

  upsertSummary: `INSERT INTO summary
      (run_key, model_id, model_name, category, trials, total_cost, total_prize,
       roi, win_rate, best_level, hits, equity, stop_data)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    ON CONFLICT(run_key, model_id) DO UPDATE SET
      model_name = excluded.model_name, category = excluded.category,
      trials = excluded.trials, total_cost = excluded.total_cost,
      total_prize = excluded.total_prize, roi = excluded.roi,
      win_rate = excluded.win_rate, best_level = excluded.best_level,
      hits = excluded.hits, equity = excluded.equity, stop_data = excluded.stop_data`,

  upsertRun: `INSERT INTO runs
      (run_key, lottery, budget, sample, periods, model_count, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(run_key) DO UPDATE SET
      periods = excluded.periods, model_count = excluded.model_count,
      created_at = excluded.created_at`,

  upsertDetail: `INSERT INTO details
      (run_key, model_id, start, up_to, engine, rows, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(run_key, model_id) DO UPDATE SET
      start = excluded.start, up_to = excluded.up_to, engine = excluded.engine,
      rows = excluded.rows, created_at = excluded.created_at`,
}

/**
 * 老库补列清单。
 *
 * `CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，加了字段也进不去——
 * 所以每个后加的列都得单独 ALTER 一次，执行前用 PRAGMA table_info 判断是否已存在
 * （SQLite 的 ADD COLUMN 不支持 IF NOT EXISTS，重复执行会直接报错）。
 */
export const ALTER_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'summary', column: 'stop_data', ddl: 'ALTER TABLE summary ADD COLUMN stop_data TEXT' },
]

/**
 * 「中二等奖及以上即收手」变体打包成一列 JSON。
 *
 * 为什么不摊成 8 个列：这套变体是纯派生数据，只整体读写、从不按列过滤，
 * 摊开既要把 INSERT 参数从 12 个改到 20 个（四端各写一遍），又没法共用一条迁移。
 */
export interface StopData {
  stopped: boolean
  stopIssue: string | null
  stopIndex: number | null
  stopLevel: number | null
  trials: number
  totalCost: number
  totalPrize: number
  roi: number
  winRate: number
  bestLevel: number
  hits: Record<number, number>
}

/** 收手变体在 SummaryRow 上对应的扁平字段 */
export type StopFields = {
  stopped: boolean
  stopIssue: string | null
  stopIndex: number | null
  stopLevel: number | null
  trialsStop: number
  totalCostStop: number
  totalPrizeStop: number
  roiStop: number
  winRateStop: number
  bestLevelStop: number
  hitsStop: Record<number, number>
}

/** SummaryRow -> stop_data 列（JSON 字符串） */
export function packStop(r: {
  stopped?: boolean
  stopIssue?: string | null
  stopIndex?: number | null
  stopLevel?: number | null
  trialsStop?: number
  totalCostStop?: number
  totalPrizeStop?: number
  roiStop?: number
  winRateStop?: number
  bestLevelStop?: number
  hitsStop?: Record<number, number>
}): string {
  const data: StopData = {
    stopped: !!r.stopped,
    stopIssue: r.stopIssue ?? null,
    stopIndex: r.stopIndex ?? null,
    stopLevel: r.stopLevel ?? null,
    trials: r.trialsStop || 0,
    totalCost: r.totalCostStop || 0,
    totalPrize: r.totalPrizeStop || 0,
    roi: r.roiStop || 0,
    winRate: r.winRateStop || 0,
    bestLevel: r.bestLevelStop || 0,
    hits: r.hitsStop || {},
  }
  return JSON.stringify(data)
}

/** stop_data 列 -> 扁平字段。列不存在（老库）或解析失败时给零值 */
export function unpackStop(raw: string | null | undefined): StopFields {
  let d: Partial<StopData> | null = null
  if (raw) {
    try {
      d = JSON.parse(raw)
    } catch {
      d = null
    }
  }
  return {
    stopped: !!d?.stopped,
    stopIssue: d?.stopIssue ?? null,
    stopIndex: d?.stopIndex ?? null,
    stopLevel: d?.stopLevel ?? null,
    trialsStop: d?.trials ?? 0,
    totalCostStop: d?.totalCost ?? 0,
    totalPrizeStop: d?.totalPrize ?? 0,
    roiStop: d?.roi ?? 0,
    winRateStop: d?.winRate ?? 0,
    bestLevelStop: d?.bestLevel ?? 0,
    hitsStop: d?.hits ?? {},
  }
}
