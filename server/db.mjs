/**
 * SQLite 落库层。
 *
 * 用 Node 22 内置的 `node:sqlite`，不引入任何三方依赖——
 * better-sqlite3 要走 node-gyp 编译，装不动的机器上一个 `npm i` 就卡死。
 *
 * 建表语句直接复用前端 `src/adapters/storage/schema.ts` 里的 CREATE_TABLES，
 * 服务端和原生端（Tauri / Capacitor）是同一套 schema，不会各自漂移。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const DB_PATH = process.env.LOTTERY_DB || resolve(here, 'data/lottery.db')

export async function openDb() {
  if (process.env.LOTTERY_DB !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  // WAL：服务端可能在写回测结果，同时前端在轮询读进度，别互相堵
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  return db
}

export async function migrate(db, engine) {
  for (const sql of engine.CREATE_TABLES) db.exec(sql)
  // 后加的列进不了已存在的表，得逐列 ALTER（见 schema.ts 的 ALTER_COLUMNS）
  for (const a of engine.ALTER_COLUMNS || []) {
    const cols = db.prepare(`PRAGMA table_info(${a.table})`).all().map((c) => c.name)
    if (!cols.includes(a.column)) db.exec(a.ddl)
  }
}

// ---------------------------------------------------------------- 开奖历史

export function countDraws(db, lottery) {
  const r = db.prepare('SELECT COUNT(*) AS n FROM draws WHERE lottery = ?1').get(lottery)
  return Number(r?.n ?? 0)
}

export function getDraws(db, lottery) {
  const rows = db
    .prepare(
      `SELECT lottery, issue, date, front, back, pool, sales, prizes, source
         FROM draws WHERE lottery = ?1 ORDER BY issue ASC`
    )
    .all(lottery)
  return rows.map(deserializeDraw)
}

function deserializeDraw(r) {
  const num = (s) => (s == null || s === '' ? [] : String(s).split(',').map(Number))
  let prizes = {}
  if (r.prizes) {
    try {
      prizes = JSON.parse(r.prizes)
    } catch {
      prizes = {}
    }
  }
  return {
    lottery: r.lottery,
    issue: r.issue,
    date: r.date || '',
    front: num(r.front),
    back: num(r.back),
    pool: r.pool ?? null,
    sales: r.sales ?? null,
    prizes,
    source: r.source || 'official',
  }
}

/** 落库并按主键去重，返回真正新增的条数 */
export function upsertDraws(db, engine, draws) {
  const before = db.prepare('SELECT COUNT(*) AS n FROM draws').get().n
  const ins = db.prepare(engine.SQL.upsertDraw)
  const tx = db.exec('BEGIN')
  void tx
  try {
    for (const d of draws) {
      ins.run(
        d.lottery,
        d.issue,
        d.date || '',
        d.front.join(','),
        d.back.join(','),
        d.pool == null ? null : String(d.pool),
        d.sales == null ? null : String(d.sales),
        JSON.stringify(d.prizes || {}),
        d.source || 'official'
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM draws').get().n
  return Number(after - before)
}

// ---------------------------------------------------------------- 回测批次

export function upsertRun(db, engine, m) {
  db.prepare(engine.SQL.upsertRun).run(
    m.runKey,
    m.lottery,
    m.budget,
    m.sample,
    m.periods,
    m.modelCount,
    m.createdAt
  )
}

export function getRun(db, runKey) {
  const r = db.prepare('SELECT * FROM runs WHERE run_key = ?1').get(runKey)
  return r ? mapRun(r) : null
}

export function listRuns(db, lottery) {
  const rows = lottery
    ? db.prepare('SELECT * FROM runs WHERE lottery = ?1 ORDER BY created_at DESC').all(lottery)
    : db.prepare('SELECT * FROM runs ORDER BY created_at DESC').all()
  return rows.map(mapRun)
}

export function deleteRun(db, runKey) {
  db.prepare('DELETE FROM runs WHERE run_key = ?1').run(runKey)
  db.prepare('DELETE FROM summary WHERE run_key = ?1').run(runKey)
  db.prepare('DELETE FROM details WHERE run_key = ?1').run(runKey)
}

function mapRun(r) {
  return {
    runKey: r.run_key,
    lottery: r.lottery,
    budget: r.budget,
    sample: r.sample,
    periods: r.periods,
    modelCount: r.model_count,
    createdAt: r.created_at,
  }
}

// ---------------------------------------------------------------- 回测汇总

export function putSummary(db, engine, rows) {
  const ins = db.prepare(engine.SQL.upsertSummary)
  db.exec('BEGIN')
  try {
    for (const s of rows) {
      ins.run(
        s.runKey,
        s.modelId,
        s.modelName,
        s.category,
        s.trials,
        s.totalCost,
        s.totalPrize,
        s.roi,
        s.winRate,
        s.bestLevel,
        JSON.stringify(s.hits || {}),
        JSON.stringify(s.equity || []),
        engine.packStop(s)
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function getSummary(db, engine, runKey) {
  return db
    .prepare('SELECT * FROM summary WHERE run_key = ?1 ORDER BY roi DESC')
    .all(runKey)
    .map((r) => {
      let hits = {}
      let equity = []
      try {
        hits = JSON.parse(r.hits || '{}')
      } catch {}
      try {
        equity = JSON.parse(r.equity || '[]')
      } catch {}
      return {
        runKey: r.run_key,
        modelId: r.model_id,
        modelName: r.model_name,
        category: r.category,
        trials: r.trials,
        totalCost: r.total_cost,
        totalPrize: r.total_prize,
        roi: r.roi,
        winRate: r.win_rate,
        bestLevel: r.best_level,
        hits,
        equity,
        // 老库（没有 stop_data 列 / 旧引擎写下的行）这里解出零值；
        // 这类缓存由 ENGINE_VERSION 变更整体作废，不会再拿 0 冒充结果
        ...engine.unpackStop(r.stop_data),
      }
    })
}

// ---------------------------------------------------------------- 逐期明细（懒缓存）

export function getDetail(db, engine, runKey, modelId) {
  const r = db
    .prepare('SELECT * FROM details WHERE run_key = ?1 AND model_id = ?2')
    .get(runKey, modelId)
  if (!r) return null
  let rows = []
  try {
    rows = JSON.parse(r.rows || '[]')
  } catch {
    return null
  }
  return {
    runKey: r.run_key,
    modelId: r.model_id,
    start: r.start,
    upTo: r.up_to,
    engine: r.engine,
    rows,
    createdAt: r.created_at,
  }
}

export function putDetail(db, engine, d) {
  db.prepare(engine.SQL.upsertDetail).run(
    d.runKey,
    d.modelId,
    d.start,
    d.upTo,
    d.engine,
    JSON.stringify(d.rows || []),
    d.createdAt || Date.now()
  )
}

/**
 * 写入「已经是 JSON 文本」的明细。
 *
 * 回测主循环里为了不把 15 万个对象同时留在堆上，每期算完就序列化了；
 * 到这里再 JSON.stringify 一遍等于把 50 MB 文本重新拼一次，纯浪费。
 */
export function putDetailRaw(db, engine, d) {
  db.prepare(engine.SQL.upsertDetail).run(
    d.runKey,
    d.modelId,
    d.start,
    d.upTo,
    d.engine,
    d.rowsJson || '[]',
    d.createdAt || Date.now()
  )
}

export function deleteDetails(db, runKey) {
  db.prepare('DELETE FROM details WHERE run_key = ?1').run(runKey)
}

// ---------------------------------------------------------------- 键值 / 用户

export function getKV(db, k) {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?1').get(k)
  if (!r) return null
  try {
    return JSON.parse(r.v)
  } catch {
    return r.v
  }
}

export function putKV(db, k, v) {
  db.prepare(
    `INSERT INTO kv (k, v) VALUES (?1, ?2)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ).run(k, JSON.stringify(v))
}

export function clearAll(db) {
  db.exec('DELETE FROM draws; DELETE FROM runs; DELETE FROM summary; DELETE FROM details; DELETE FROM kv;')
}
