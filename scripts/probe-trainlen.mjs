/**
 * 针对「样本 1000 期」场景的耗时标定。
 *
 * 原理：backtest 的 start = max(60, total - periods)，训练历史长度 = total - periods。
 * 因此用小 total 复现同样的 trainLen，得到的 ms/期 与全量场景一致，
 * 可以在秒级时间内标定出 2509 期的真实耗时。
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const { leaderboard } = await server.ssrLoadModule('/src/core/backtest.ts')
const { loadPacket } = await server.ssrLoadModule('/src/adapters/net.ts')

const packet = await loadPacket()
const all = packet.filter((d) => d.lottery === 'ssq')
console.log(`双色球全量 ${all.length} 期\n`)

console.log('训练历史  回测窗口   每期成本(ms)   备注')
console.log('--------  --------  ------------  ------------------')
const rows = []
for (const [total, periods] of [
  [1100, 100],
  [1500, 300],
  [2000, 500],
]) {
  const history = all.slice(0, total)
  const t = performance.now()
  const r = leaderboard({
    lottery: 'ssq',
    history,
    periods,
    budget: 30,
    profile: {},
  })
  const ms = performance.now() - t
  const per = ms / periods
  const train = total - periods
  rows.push({ train, total, periods, ms, per, count: r.length })
  console.log(
    `${String(train).padStart(8)}  ${String(periods).padStart(8)}  ${per.toFixed(1).padStart(12)}  ` +
      `${r.length} 模型 / ${(ms / 1000).toFixed(1)}s`
  )
}

console.log('\n── 拟合：每期成本 vs 训练历史长度 ──')
// 假设 per = a + b * train（解析项 + 与历史长度相关的扫描项）
let sx = 0,
  sy = 0,
  sxx = 0,
  sxy = 0
for (const r of rows) {
  sx += r.train
  sy += r.per
  sxx += r.train * r.train
  sxy += r.train * r.per
}
const n = rows.length
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
const a = (sy - b * sx) / n
console.log(`  per(train) = ${a.toFixed(2)} + ${b.toFixed(4)} × train`)

console.log('\n── 外推到真实场景 ──')
const TOTAL = all.length
for (const sample of [1000, 2000]) {
  const train = sample
  const periods = TOTAL - sample
  const per = a + b * train
  const sec = (per * periods) / 1000
  console.log(
    `  样本 ${sample} 期 → 回测 ${periods} 期：` +
      `${per.toFixed(0)} ms/期 → ${(sec / 60).toFixed(1)} 分钟` +
      `${sample === 1000 ? '   ← 你的目标场景' : ''}`
  )
}

console.log('\n── 对照：默认 80 期 / 全 78 模型 ──')
const per80 = a + b * (TOTAL - 80)
console.log(`  80 期 × 78 模型：${((per80 * 80) / 1000).toFixed(1)} 秒`)
console.log(`  80 期 × 78 模型：${(((per80 * 80) / 1000) * (78 / 64)).toFixed(1)} 秒（含量模型）`)

await server.close()
