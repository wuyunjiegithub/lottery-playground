/**
 * 标定「全部 78 个模型」的每期成本。
 *
 * 为什么要重测：回测从「默认 64 轻量」改成「必跑全部 78」，
 * 而重型模型（GA / PSO / ML / NN）不是贵一点，是贵一个量级。
 * 之前的耗时提示（"上次用了 X 秒"）和分片粒度都建立在那批轻模型上，
 * 不实测就会在用户点下按钮后才发现要等半小时。
 *
 * 测法：backtest 的 start = max(60, total - periods)，训练长度 = total - periods。
 * 所以用小 total 复现同样的 trainLen，秒级就能定标，再按复杂度外推。
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const M = await server.ssrLoadModule('/src/core/models/index.ts')
const BT = await server.ssrLoadModule('/src/core/backtest.ts')
const { loadPacket } = await server.ssrLoadModule('/src/adapters/net.ts')

const packet = await loadPacket()
const all = packet.filter((d) => d.lottery === 'ssq').sort((a, b) => a.issue.localeCompare(b.issue))
const TOTAL = all.length

/**
 * 逐模型跑再排序——**不能直接调leaderboard(models)**。
 * 它只接受 BacktestOptions，模型集合写死为全部 78 个；
 * 传一个 models 参数进去会被静默忽略，于是"轻量组"其实也跑了 78 个，
 * 测出来的倍数全是 1.00，结论完全无效（这个坑踩过一次）。
 */
const run = (models, history, periods) => {
  const t = performance.now()
  models
    .map((m) => BT.backtest(m, { lottery: 'ssq', history, periods, budget: 30, profile: {} }))
    .sort((a, b) => b.roi - a.roi)
  return performance.now() - t
}

console.log(`双色球全量 ${TOTAL} 期｜轻量 ${M.LIGHT_MODELS.length} + 重型 ${M.HEAVY_MODELS.length} = ${M.ALL_MODELS.length}\n`)

// ---- 1) 单次 predict 的分量：逐个模型跑全量历史，排出谁最贵
console.log('── 单模型 predict 成本（全量历史，各跑 1 次）──')
const per = []
for (const m of M.ALL_MODELS) {
  const t = performance.now()
  m.predict({ history: all, lottery: 'ssq', nextDate: new Date(2026, 0, 1), profile: {} })
  per.push({ id: m.meta.id, name: m.meta.name, ms: performance.now() - t, heavy: !!m.heavy })
}
per.sort((a, b) => b.ms - a.ms)
for (const p of per.slice(0, 10)) {
  console.log(`  ${p.id} ${p.heavy ? '[重]' : '[轻]'} ${p.ms.toFixed(1).padStart(7)} ms  ${p.name}`)
}
const lightSum = per.filter((p) => !p.heavy).reduce((a, b) => a + b.ms, 0)
const heavySum = per.filter((p) => p.heavy).reduce((a, b) => a + b.ms, 0)
console.log(`  轻量合计 ${lightSum.toFixed(0)} ms｜重型合计 ${heavySum.toFixed(0)} ms` +
  `（重型是轻量的 ${(heavySum / lightSum).toFixed(1)} 倍）\n`)

// ---- 2) 每期成本 vs 训练长度
console.log('── 每期成本（ms/期）vs 训练历史长度 ──')
console.log('训练长度   回测期数   轻量64    全部78    倍数')
const rows = []
for (const [total, periods] of [
  [1100, 100],
  [1500, 200],
  [2000, 200],
]) {
  const history = all.slice(0, total)
  const msL = run(M.LIGHT_MODELS, history, periods)
  const msA = run(M.ALL_MODELS, history, periods)
  const train = total - periods
  rows.push({ train, periods, perL: msL / periods, perA: msA / periods })
  console.log(
    `${String(train).padStart(8)}   ${String(periods).padStart(8)}   ` +
      `${(msL / periods).toFixed(1).padStart(7)}   ${(msA / periods).toFixed(1).padStart(7)}   ` +
      `${(msA / msL).toFixed(2).padStart(5)}x`
  )
}

// 按「与训练长度基本无关的固定项 + 与长度相关的扫描项」拟合全量曲线
const fit = (key) => {
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const r of rows) { sx += r.train; sy += r[key]; sxx += r.train ** 2; sxy += r.train * r[key] }
  const n = rows.length
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  return { a: (sy - b * sx) / n, b }
}
const fL = fit('perL')
const fA = fit('perA')
const perAt = (f, train) => f.a + f.b * train

console.log('\n── 拟合 ──')
console.log(`  轻量64: per = ${fL.a.toFixed(2)} + ${fL.b.toFixed(4)} × train`)
console.log(`  全部78: per = ${fA.a.toFixed(2)} + ${fA.b.toFixed(4)} × train`)

console.log('\n── 外推到真实场景（全量历史训练）──')
for (const sample of [1000, 2000]) {
  const train = sample
  const periods = TOTAL - sample
  const secA = (perAt(fA, train) * periods) / 1000
  console.log(`  样本 ${sample} → 回测 ${periods} 期：${perAt(fA, train).toFixed(0)} ms/期 ⇒ ` +
    `${secA < 90 ? (secA / 60).toFixed(1) + ' 分钟' : (secA / 60).toFixed(0) + ' 分钟'}`)
}

console.log('\n── 页面默认（样本 1000 ⇒ 训练 1000 期，回测 ' + (TOTAL - 1000) + ' 期）耗时 ──')
{
  const periods = TOTAL - 1000
  const sec = (perAt(fA, 1000) * periods) / 1000
  console.log(`  轻量64 ≈ ${((perAt(fL, 1000) * periods) / 1000 / 60).toFixed(1)} 分钟`)
  console.log(`  全部78 ≈ ${(sec / 60).toFixed(1)} 分钟  ← 改成必跑全量后的真实代价`)
}

await server.close()