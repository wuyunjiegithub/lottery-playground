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

export const SCHEMA_VERSION = 1

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
     PRIMARY KEY (run_key, model_id)
   )`,

  `CREATE TABLE IF NOT EXISTS kv (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
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
       roi, win_rate, best_level, hits, equity)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
    ON CONFLICT(run_key, model_id) DO UPDATE SET
      model_name = excluded.model_name, category = excluded.category,
      trials = excluded.trials, total_cost = excluded.total_cost,
      total_prize = excluded.total_prize, roi = excluded.roi,
      win_rate = excluded.win_rate, best_level = excluded.best_level,
      hits = excluded.hits, equity = excluded.equity`,

  upsertRun: `INSERT INTO runs
      (run_key, lottery, budget, sample, periods, model_count, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(run_key) DO UPDATE SET
      periods = excluded.periods, model_count = excluded.model_count,
      created_at = excluded.created_at`,
}
