/**
 * 在 Node 里加载前端的 TypeScript 回测引擎。
 *
 * 为什么要绕这一层：引擎是 TS 源码，浏览器由 Vite 编译，Node 没法直接 import。
 * 用 Vite 的 SSR 通道直载源码，服务端和网页跑的就是**同一份代码**——
 * 不会出现「网页算 78 个模型、服务端算出来是另一套数字」这种事。
 *
 * 项目自带的 scripts/verify.mjs 用的就是这个办法。
 */
import { createServer } from 'vite'

let cached = null

export async function getEngine() {
  if (cached) return cached
  const server = await createServer({
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true },
    appType: 'custom',
    // 纯 SSR 直载源码，无需依赖预扫描；关掉可规避 esbuild scan 的竞态
    optimizeDeps: { noDiscovery: true, include: [] },
  })

  const [models, runner, schema] = await Promise.all([
    server.ssrLoadModule('/src/core/models/index.ts'),
    server.ssrLoadModule('/src/core/backtestRunner.ts'),
    server.ssrLoadModule('/src/adapters/storage/schema.ts'),
  ])

  cached = {
    server,
    ALL_MODELS: models.ALL_MODELS,
    MODEL_COUNT: models.MODEL_COUNT,
    runLeaderboardAsync: runner.runLeaderboardAsync,
    runDetailAsync: runner.runDetailAsync,
    accumsToResults: runner.accumsToResults,
    ENGINE_VERSION: runner.ENGINE_VERSION,
    BacktestCancelled: runner.BacktestCancelled,
    CREATE_TABLES: schema.CREATE_TABLES,
    ALTER_COLUMNS: schema.ALTER_COLUMNS,
    packStop: schema.packStop,
    unpackStop: schema.unpackStop,
    SQL: schema.SQL,
    SCHEMA_VERSION: schema.SCHEMA_VERSION,
  }
  return cached
}
