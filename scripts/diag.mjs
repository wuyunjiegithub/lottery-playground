/**
 * 诊断脚本（临时）：核查回测里「正收益模型」到底是怎么挣钱的。
 * 若某个模型能在彩票这种负期望游戏里长期盈利，说明中奖判定有 bug，
 * 而本项目最核心的「真相卡片」结论就站不住，必须查清。
 *
 *   node scripts/diag.mjs
 */
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
  // 纯 SSR 直载源码，不需要依赖预扫描；关掉可规避 esbuild scan 的竞态
  optimizeDeps: { noDiscovery: true, include: [] },
})

try {
  const packet = JSON.parse(
    readFileSync(new URL('../src/assets/lottery-data.json', import.meta.url), 'utf8')
  )
  const models = await server.ssrLoadModule('/src/core/models/index.ts')
  const bt = await server.ssrLoadModule('/src/core/backtest.ts')
  const lottery = await server.ssrLoadModule('/src/core/lottery.ts')

  console.log('=== 奖级判定自检（拿需求文档第 7 章逐条对照）===')
  const cases = [
    // [彩种, 前区命中, 后区命中, 期望奖级]
    ['ssq', 6, 1, 1], ['ssq', 6, 0, 2], ['ssq', 5, 1, 3], ['ssq', 5, 0, 4],
    ['ssq', 4, 1, 4], ['ssq', 4, 0, 5], ['ssq', 3, 1, 5], ['ssq', 2, 1, 6],
    ['ssq', 1, 1, 6], ['ssq', 0, 1, 6], ['ssq', 3, 0, 0], ['ssq', 2, 0, 0],
    ['dlt', 5, 2, 1], ['dlt', 5, 1, 2], ['dlt', 5, 0, 3], ['dlt', 4, 2, 4],
    ['dlt', 4, 1, 5], ['dlt', 3, 2, 6], ['dlt', 4, 0, 7], ['dlt', 3, 1, 8],
    ['dlt', 2, 2, 8], ['dlt', 3, 0, 9], ['dlt', 0, 2, 9], ['dlt', 2, 1, 9],
    ['dlt', 1, 1, 0],
  ]
  let bad = 0
  for (const [lt, f, b, want] of cases) {
    const got = lottery.judgeLevel(lt, f, b)
    const ok = got === want
    if (!ok) { bad++; console.log(`  ✗ ${lt} ${f}+${b} 期望${want} 实得${got}`) }
  }
  console.log(`  共 ${cases.length} 条，错 ${bad} 条`)

  const history = packet.draws
    .filter((d) => d.lottery === 'ssq')
    .sort((a, b) => a.issue.localeCompare(b.issue))

  console.log('\n=== 80 期回测：Top 5 与基线逐项拆解 ===')
  const board = bt.leaderboard({
    lottery: 'ssq', history, periods: 80,
    budget: 30, profile: {},
  })
  const top = board.slice(0, 5)
  const base = board.find((b) => b.modelId === 'B01')
  for (const r of [base, ...top]) {
    const isBase = r.modelId === 'B01'
    const p = base ? bt.permutationTest(r, base) : 1
    const prizes = Object.entries(r.hits)
      .sort((a, c) => Number(a[0]) - Number(c[0]))
      .map(([lv, n]) => `${lv}等×${n}`)
      .join(' ') || '无'
    console.log(
      `${isBase ? '[基线]' : '      '} ${r.modelId.padEnd(4)} ROI ${(r.roi * 100).toFixed(1).padStart(7)}%  ` +
      `投入 ${String(r.totalCost).padStart(5)} 返还 ${String(r.totalPrize).padStart(7)}  ` +
      `中奖率 ${(r.winRate * 100).toFixed(1).padStart(5)}%  p=${p.toFixed(3)}`
    )
    console.log(`         命中：${prizes}`)
  }

  console.log('\n=== 真相卡片会下什么结论 ===')
  const noDiff = board.filter((r) => r.modelId !== 'B01' && bt.permutationTest(r, base) > 0.05).length
  const diff = board.filter((r) => r.modelId !== 'B01' && bt.permutationTest(r, base) <= 0.05)
  console.log(`  共 ${board.length} 个模型，无显著差异 ${noDiff} 个`)
  console.log(`  ⚠ 被判「显著优于随机」的有 ${diff.length} 个：${diff.map((r) => `${r.modelId}(${(r.roi * 100).toFixed(1)}%,p=${bt.permutationTest(r, base).toFixed(3)})`).join(' ')}`)

  console.log('\n=== 加大样本后是否回归（同样 SSQ，200 期）===')
  const board200 = bt.leaderboard({
    lottery: 'ssq', history, periods: 200,
    budget: 30, profile: {},
  })
  const base200 = board200.find((b) => b.modelId === 'B01')
  console.log(`  B01 基线 ROI ${(base200.roi * 100).toFixed(1)}%`)
  console.log(`  200 期冠军 ${board200[0].modelId} ROI ${(board200[0].roi * 100).toFixed(1)}%  p=${bt.permutationTest(board200[0], base200).toFixed(3)}`)
  const positives = board200.filter((r) => r.roi > 0)
  console.log(`  200 期中仍为正收益的模型：${positives.length} 个 ${positives.slice(0, 5).map((r) => `${r.modelId}(${(r.roi * 100).toFixed(0)}%)`).join(' ')}`)
} finally {
  await server.close()
}
