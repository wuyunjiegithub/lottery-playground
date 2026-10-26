import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const M = await server.ssrLoadModule('/src/core/models/index.ts')
const BT = await server.ssrLoadModule('/src/core/backtest.ts')
const { readFileSync } = await import('node:fs')

const raw = JSON.parse(readFileSync('src/assets/lottery-data.json', 'utf-8'))
const ssq = raw.draws
  .filter((d) => d.lottery === 'ssq')
  .sort((a, b) => a.issue.localeCompare(b.issue))

const TOTAL = ssq.length
console.log(`双色球共 ${TOTAL} 期`)
console.log(`用法：history 传全量，periods = N ⇒ 训练从第 ${TOTAL}-N 期开始前的所有数据\n`)

// 单次 predict 成本随训练集增长，总成本 ∝ Σ(start..TOTAL) i ≈ N(2·TOTAL - N)
const cost = (n) => n * (2 * TOTAL - n)

const points = []
for (const n of [150, 400]) {
  const t0 = performance.now()
  BT.leaderboard({
    lottery: 'ssq', history: ssq, periods: n, budget: 30, profile: {},
  })
  const ms = performance.now() - t0
  points.push({ n, ms })
  console.log(`  回测 ${String(n).padStart(4)} 期（样本 ${TOTAL - n} 期）× 78 模型 → ${(ms / 1000).toFixed(1)} s`)
}

// 用复杂度模型外推：bt.ms / cost(bt.n) 近似为常数
const rates = points.map((p) => p.ms / cost(p.n))
const rate = rates.reduce((a, b) => a + b, 0) / rates.length
console.log(`\n  单位复杂度耗时 ≈ ${(rate * 1e6).toFixed(2)} ms / 百万单位`)
console.log('  一致性检查（两个测点算出的速率应当接近）：', rates.map((r) => (r * 1e6).toFixed(2)).join(' vs '))

const FULL = 2509
const estLight = (rate * cost(FULL)) / 1000
console.log(`\n=== 外推：回测 ${FULL} 期（样本 1000 期）==`)
console.log(`  轻模型集 64 个 ≈ ${(estLight / 60).toFixed(1)} 分钟`)
console.log(`  全部 78 个   ≈ ${((estLight * 78 / 64) / 60).toFixed(1)} 分钟`)

const rows = FULL * 78
console.log(`\n=== 落库体量 ===`)
console.log(`  逐期明细  ${rows.toLocaleString()} 条 ≈ ${(rows * 115 / 1024 / 1024).toFixed(1)} MB`)
console.log(`  仅 equity 78 × ${FULL} 个数字 ≈ ${(78 * FULL * 8 / 1024 / 1024).toFixed(1)} MB`)
const cap = 5
console.log(`  浏览器键值对上限 ${cap} MB → ${rows * 115 / 1024 / 1024 > cap ? '❌ 存不下' : '✓ 够用'}`)
console.log(`  IndexedDB 配额数百 MB      → ✓ 够用`)
console.log(`  SQLite                     → ✓ 够用，且支持 SQL 聚合`)

await server.close()
