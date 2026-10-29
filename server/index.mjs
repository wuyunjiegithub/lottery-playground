/**
 * 概率游乐场 · 本地后端
 *
 * 零三方依赖：HTTP 用 node:http，数据库用 Node 22 内置的 node:sqlite。
 * 存在的理由就三条：
 *   1. 网页版拿不到最新开奖数据（CORS + WAF，浏览器边界，无解）——服务端能拿
 *   2. 回测结果只存在浏览器 IndexedDB 里，清个缓存就全没了——落到 SQLite 才叫真存住
 *   3. 78 个模型全量回测得跑十几分钟，浏览器主线程扛不住、切后台还被降频——挪到服务端
 *
 * 回测引擎直接跑前端那份 TS 源码（server/engine.mjs 走 Vite SSR 直载），
 * 服务端与网页算出来的是同一套数字。
 *
 *   node server/index.mjs           # 默认 8787
 *   PORT=9000 node server/index.mjs
 */
import { createServer as createHttp } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import * as db from './db.mjs'
import { getEngine } from './engine.mjs'
import { fetchLatest } from './fetcher.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const PORT = Number(process.env.PORT || 8787)

/** 回测任务表。进程内内存态——重启即丢，但结果已落 SQLite，丢了也不影响已算完的 */
const jobs = new Map()

let database = null
let engine = null

// ------------------------------------------------------------------ 工具

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  })
  res.end(buf)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

/** hits 的键经 JSON 一轮会变成字符串，取回来要还原成数字奖级 */
function fixHits(h) {
  const o = {}
  for (const [k, v] of Object.entries(h || {})) o[Number(k)] = v
  return o
}

function summaryToResult(s) {
  return {
    modelId: s.modelId,
    modelName: s.modelName,
    category: s.category,
    trials: s.trials,
    totalCost: s.totalCost,
    totalPrize: s.totalPrize,
    roi: s.roi,
    hits: fixHits(s.hits),
    bestLevel: s.bestLevel,
    winRate: s.winRate,
    equity: s.equity || [],
    stopped: s.stopped,
    stopIssue: s.stopIssue ?? null,
    stopIndex: s.stopIndex ?? null,
    stopLevel: s.stopLevel ?? null,
    trialsStop: s.trialsStop || 0,
    totalCostStop: s.totalCostStop || 0,
    totalPrizeStop: s.totalPrizeStop || 0,
    roiStop: s.roiStop || 0,
    winRateStop: s.winRateStop || 0,
    bestLevelStop: s.bestLevelStop || 0,
    hitsStop: fixHits(s.hitsStop),
  }
}

// ------------------------------------------------------------------ 首次启动灌数据

async function seedIfEmpty() {
  for (const lot of ['ssq', 'dlt']) {
    if (db.countDraws(database, lot) > 0) continue
    try {
      const packet = JSON.parse(
        readFileSync(resolve(ROOT, 'src/assets/lottery-data.json'), 'utf8')
      )
      const rows = packet.draws.filter((d) => d.lottery === lot)
      const n = db.upsertDraws(database, engine, rows)
      console.log(`[seed] ${lot} 灌入 ${n} 期（来自内置数据包）`)
    } catch (e) {
      console.warn(`[seed] ${lot} 失败:`, e.message)
    }
  }
}

// ------------------------------------------------------------------ 回测任务

async function startBacktest(args) {
  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const job = {
    id,
    status: 'running',
    cancel: false,
    startedAt: Date.now(),
    progress: { phase: 'running', ratio: 0, periodsDone: 0, periodCount: 0, currentModelName: '' },
    results: null,
    error: null,
    durationMs: 0,
  }
  jobs.set(id, job)

  // 不 await：让它自己跑，HTTP 那边靠事件循环里的让出间隙回应轮询
  void runJob(job, args)
  return id
}

async function runJob(job, args) {
  const { lottery, budget, sample, periods, profile, runKey } = args
  const t0 = Date.now()
  try {
    const history = db.getDraws(database, lottery)
    if (!history.length) throw new Error(`库里没有 ${lottery} 的开奖数据`)
    const to = history.length
    // 与前端 store 的窗口同口径：max(60, 历史长度 - 期数)。
    // 两边不一致的话，落库的明细 start/upTo 与界面请求的对不上，等于白存。
    const from = Math.max(60, to - periods)

    const accums = await engine.runLeaderboardAsync(
      {
        models: engine.ALL_MODELS,
        history,
        lottery,
        budget,
        profile: profile || {},
        from,
        to,
        // 顺手把逐期明细一起算出来：predict 与回测完全同一次，
        // 不像事后重放那样把 78 个模型的算力再烧一遍
        collectDetail: true,
      },
      {
        onProgress: (p) => {
          job.progress = p
          if (p.phase && p.phase !== 'running') job.status = p.phase
        },
        shouldCancel: () => job.cancel,
        onModelDetails: (modelId, rowsJson) => {
          db.putDetailRaw(database, engine, {
            runKey,
            modelId,
            start: from,
            upTo: to,
            engine: engine.ENGINE_VERSION,
            rowsJson,
            createdAt: Date.now(),
          })
        },
      }
    )
    const results = engine.accumsToResults(accums)
    const durationMs = Date.now() - t0

    const rows = results.map((r) => ({
      runKey,
      modelId: r.modelId,
      modelName: r.modelName,
      category: r.category,
      trials: r.trials,
      totalCost: r.totalCost,
      totalPrize: r.totalPrize,
      roi: r.roi,
      winRate: r.winRate,
      bestLevel: r.bestLevel,
      hits: r.hits,
      equity: r.equity,
      stopped: r.stopped,
      stopIssue: r.stopIssue,
      stopIndex: r.stopIndex,
      stopLevel: r.stopLevel,
      trialsStop: r.trialsStop,
      totalCostStop: r.totalCostStop,
      totalPrizeStop: r.totalPrizeStop,
      roiStop: r.roiStop,
      winRateStop: r.winRateStop,
      bestLevelStop: r.bestLevelStop,
      hitsStop: r.hitsStop,
    }))
    db.putSummary(database, engine, rows)
    db.upsertRun(database, engine, {
      runKey,
      lottery,
      budget,
      sample,
      periods,
      modelCount: results.length,
      createdAt: Date.now(),
    })
    db.putKV(database, `server_board:${runKey}`, {
      upTo: to,
      periods,
      modelCount: results.length,
      lottery,
      budget,
      sample,
      durationMs,
      engine: engine.ENGINE_VERSION,
      createdAt: Date.now(),
    })

    job.status = 'done'
    job.results = results
    job.durationMs = durationMs
    job.progress = { phase: 'done', ratio: 1, periodsDone: periods, periodCount: periods }

    // 汇总写完后，后台把 78 个模型的逐期明细也补进 details 表。
    // 不 await：明细是「点开才看」的东西，不该让回测成功状态多等两三分钟。
    void archiveDetails({ runKey, lottery, budget, periods, profile })
  } catch (e) {
    job.status = e?.name === 'BacktestCancelled' || job.cancel ? 'cancelled' : 'error'
    job.error = e?.message || String(e)
    job.progress = { phase: job.status, ratio: 0, periodsDone: 0, periodCount: 0 }
  }
}

// ------------------------------------------------------- 逐期明细自动存档

/**
 * 回测结束后把每个模型的逐期明细补齐到 details 表。
 *
 * 现在新跑的回测已经在主循环里顺手产出了明细（collectDetail），这里主要是
 * **兜底 + 增量**：老批次没有明细、上次存档被中断、或者库里多了一两期新开奖。
 * 增量那一条很关键：号码只跟 (期序号, 模型序号) 有关，新开奖不会让老几期的
 * 号码变样，所以存过的一段可以直接复用，只补末尾新增的那几期。
 */
const archiving = new Set()

async function archiveDetails({ runKey, lottery, budget, periods, profile }) {
  if (archiving.has(runKey)) return
  archiving.add(runKey)

  const models = engine.ALL_MODELS
  const total = models.length
  const key = `detail_archive:${runKey}`
  try {
    const history = db.getDraws(database, lottery)
    if (!history.length) throw new Error(`库里没有 ${lottery} 的开奖数据`)
    const to = history.length
    // 与前端 store 的 detailStart 同口径：max(60, 历史长度 - 窗口期数)。
    // 两边一旦不一致，存档的 start/upTo 就和界面请求的对不上，等于白存。
    const from = Math.max(60, to - periods)

    db.putKV(database, key, { status: 'running', done: 0, total, start: from, upTo: to })

    for (let mi = 0; mi < total; mi++) {
      const model = models[mi]
      const modelId = model.meta.id
      const exist = db.getDetail(database, engine, runKey, modelId)
      // 覆盖了 [from, min(upTo, to)] 就算可用：起点不晚于本次、终点落在窗口内
      const base =
        exist &&
        exist.engine === engine.ENGINE_VERSION &&
        exist.start <= from &&
        exist.upTo >= from &&
        exist.upTo <= to
          ? exist
          : null
      if (!base || base.upTo !== to) {
        const tailFrom = base ? base.upTo : from
        const tail = await engine.runDetailAsync({
          lottery,
          history,
          budget,
          profile: profile || {},
          model,
          modelIndex: mi,
          from: tailFrom,
          to,
        })
        const rows = base ? base.rows.filter((r) => r.index >= from).concat(tail) : tail
        db.putDetail(database, engine, {
          runKey,
          modelId,
          start: from,
          upTo: to,
          engine: engine.ENGINE_VERSION,
          rows,
          createdAt: Date.now(),
        })
      }
      db.putKV(database, key, { status: 'running', done: mi + 1, total, start: from, upTo: to })
      // 让出事件循环，别把轮询接口饿死
      await new Promise((r) => setImmediate(r))
    }
    db.putKV(database, key, { status: 'done', done: total, total, start: from, upTo: to })
    console.log(`[detail] ${runKey} 逐期明细已存档 ${total} 个模型`)
  } catch (e) {
    db.putKV(database, key, { status: 'error', done: 0, total, msg: e?.message || String(e) })
    console.warn('[detail] 存档失败:', e?.message || e)
  } finally {
    archiving.delete(runKey)
  }
}

/** 命中缓存就直接返回结果，不再算一遍 */
function tryCached(runKey, lottery, periods) {
  const meta = db.getKV(database, `server_board:${runKey}`)
  if (!meta) return null
  if (meta.engine !== engine.ENGINE_VERSION) return null
  if (meta.modelCount !== engine.ALL_MODELS.length) return null
  const history = db.getDraws(database, lottery)
  if (meta.upTo !== history.length || meta.periods !== periods) return null
  const rows = db.getSummary(database, engine, runKey)
  if (rows.length !== meta.modelCount) return null
  return { results: rows.map(summaryToResult), meta }
}

// ------------------------------------------------------------------ 路由

async function route(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const p = url.pathname
  const m = req.method

  if (m === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    })
    return res.end()
  }

  // ---- 健康
  if (p === '/api/health') {
    return json(res, 200, {
      ok: true,
      engine: engine.ENGINE_VERSION,
      models: engine.ALL_MODELS.length,
      draws: { ssq: db.countDraws(database, 'ssq'), dlt: db.countDraws(database, 'dlt') },
      dbPath: db.DB_PATH,
    })
  }

  // ---- 开奖历史
  if (p === '/api/draws' && m === 'GET') {
    const lot = url.searchParams.get('lottery') || 'dlt'
    return json(res, 200, { draws: db.getDraws(database, lot) })
  }

  if (p === '/api/draws' && m === 'POST') {
    const b = await readBody(req)
    const added = db.upsertDraws(database, engine, b.draws || [])
    return json(res, 200, { added })
  }
  if (p === '/api/draws/count' && m === 'GET') {
    const lot = url.searchParams.get('lottery') || 'dlt'
    return json(res, 200, { count: db.countDraws(database, lot) })
  }

  if (p === '/api/draws/refresh' && m === 'POST') {
    const body = await readBody(req)
    const lot = body.lottery || 'dlt'
    try {
      const incoming = await fetchLatest(lot, body.count || 60)
      const added = db.upsertDraws(database, engine, incoming)
      return json(res, 200, {
        ok: true,
        added,
        fetched: incoming.length,
        total: db.countDraws(database, lot),
        latest: incoming[0] || null,
      })
    } catch (e) {
      return json(res, 502, { ok: false, msg: e?.message || String(e) })
    }
  }

  // ---- 存储：批次 / 汇总 / kv / 清空（对应 StorageAdapter）
  if (p === '/api/runs' && m === 'GET') {
    return json(res, 200, { runs: db.listRuns(database, url.searchParams.get('lottery') || undefined) })
  }
  if (p === '/api/runs' && m === 'POST') {
    const b = await readBody(req)
    db.upsertRun(database, engine, b)
    return json(res, 200, { ok: true })
  }
  if (p === '/api/runs' && m === 'DELETE') {
    db.deleteRun(database, url.searchParams.get('runKey'))
    return json(res, 200, { ok: true })
  }
  if (p === '/api/summary' && m === 'GET') {
    return json(res, 200, { rows: db.getSummary(database, engine, url.searchParams.get('runKey')) })
  }
  if (p === '/api/summary' && m === 'POST') {
    const b = await readBody(req)
    db.putSummary(database, engine, b.rows || [])
    return json(res, 200, { ok: true })
  }
  // ---- 逐期明细（懒缓存：点开过就存一行，下次直接读）
  if (p === '/api/detail' && m === 'GET') {
    const runKey = url.searchParams.get('runKey')
    const modelId = url.searchParams.get('modelId')
    return json(res, 200, { detail: db.getDetail(database, engine, runKey, modelId) })
  }
  if (p === '/api/detail' && m === 'POST') {
    const b = await readBody(req)
    db.putDetail(database, engine, {
      runKey: b.runKey,
      modelId: b.modelId,
      start: Number(b.start) || 0,
      upTo: Number(b.upTo) || 0,
      engine: Number(b.engine) || engine.ENGINE_VERSION,
      rows: b.rows || [],
      createdAt: Date.now(),
    })
    return json(res, 200, { ok: true })
  }
  if (p === '/api/kv' && m === 'GET') {
    return json(res, 200, { value: db.getKV(database, url.searchParams.get('k')) })
  }
  if (p === '/api/kv' && m === 'POST') {
    const b = await readBody(req)
    db.putKV(database, b.k, b.v)
    return json(res, 200, { ok: true })
  }
  if (p === '/api/clear' && m === 'POST') {
    db.clearAll(database)
    return json(res, 200, { ok: true })
  }

  // ---- 回测
  if (p === '/api/backtest' && m === 'POST') {
    const b = await readBody(req)
    const lottery = b.lottery || 'dlt'
    const budget = Number(b.budget || 30)
    const sample = Number(b.sample || 1000)
    const profile = b.profile || {}
    const runKey = b.runKey || `${lottery}-${budget}-${sample}`
    const history = db.getDraws(database, lottery)
    const periods = Number(b.periods || Math.max(60, history.length - sample))

    const hit = tryCached(runKey, lottery, periods)
    if (hit) {
      // 命中缓存时也检查一次明细：上次可能在存档途中重启，这里顺手补齐已缺的部分
      void archiveDetails({ runKey, lottery, budget, periods, profile })
      const id = `cached_${Date.now().toString(36)}`
      jobs.set(id, {
        id,
        status: 'done',
        cancel: false,
        startedAt: Date.now(),
        progress: { phase: 'done', ratio: 1, periodsDone: periods, periodCount: periods },
        results: hit.results,
        error: null,
        durationMs: hit.meta.durationMs || 0,
      })
      return json(res, 200, { jobId: id, cached: true, durationMs: hit.meta.durationMs || 0 })
    }

    const id = await startBacktest({ lottery, budget, sample, periods, profile, runKey })
    return json(res, 202, { jobId: id, cached: false })
  }

  let mm = /^\/api\/backtest\/([\w-]+)$/.exec(p)
  if (mm && m === 'GET') {
    const job = jobs.get(mm[1])
    if (!job) return json(res, 404, { error: 'no such job' })
    return json(res, 200, {
      id: job.id,
      status: job.status,
      progress: job.progress,
      durationMs: job.durationMs,
      error: job.error,
      results: job.status === 'done' ? job.results : null,
    })
  }
  mm = /^\/api\/backtest\/([\w-]+)\/cancel$/.exec(p)
  if (mm && m === 'POST') {
    const job = jobs.get(mm[1])
    if (job) job.cancel = true
    return json(res, 200, { ok: true })
  }

  return json(res, 404, { error: 'not found', path: p })
}

// ------------------------------------------------------------------ 启动

async function main() {
  engine = await getEngine()
  database = await db.openDb()
  await db.migrate(database, engine)
  await seedIfEmpty()

  createHttp(route).listen(PORT, () => {
    console.log(`\n  概率游乐场后端已启动`)
    console.log(`  接口   http://localhost:${PORT}/api/health`)
    console.log(`  数据库 ${db.DB_PATH}`)
    console.log(`  引擎   v${engine.ENGINE_VERSION} · ${engine.ALL_MODELS.length} 个模型`)
    console.log(`  开奖   ssq ${db.countDraws(database, 'ssq')} 期 / dlt ${db.countDraws(database, 'dlt')} 期\n`)
  })
}

main().catch((e) => {
  console.error('启动失败:', e)
  process.exit(1)
})
