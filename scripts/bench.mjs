/**
 * 回测性能探针（临时脚本，验证完可删除）。
 * 用 Vite 的 ssrLoadModule 直接加载 TS 源码，在 Node 里跑真实回测计时。
 *
 *   node scripts/bench.mjs
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
  const all = packet.draws

  const models = await server.ssrLoadModule('/src/core/models/index.ts')
  const bt = await server.ssrLoadModule('/src/core/backtest.ts')
  const ticket = await server.ssrLoadModule('/src/core/ticket.ts')

  for (const lottery of ['ssq', 'dlt']) {
    const history = all
      .filter((d) => d.lottery === lottery)
      .sort((a, b) => a.issue.localeCompare(b.issue))
    console.log(`\n=== ${lottery} 共 ${history.length} 期 ===`)

    // 单个周期：模型预测 + 枚举 + 优选，测一次冷成本
    const m = models.getModel('M01')
    const profile = {}
    const t0 = performance.now()
    const pred = m.predict({
      history: history.slice(0, -1),
      lottery,
      nextDate: new Date(),
      profile,
    })
    const plans = ticket.enumeratePlans(lottery, pred, 30)
    const { best } = ticket.recommend(plans, 30)
    console.log(
      `单期流程 ${(performance.now() - t0).toFixed(1)}ms  候选 ${plans.length} 种  推荐 ${best?.label} ${best?.cost}元`
    )
    console.log(`  中奖率 ${(best.metrics.pWin * 100).toFixed(2)}%  覆盖 ${best.metrics.coverage}`)

    // 全模型排行榜：这才是页面上真正会卡住的操作
    for (const periods of [40, 80]) {
      const t1 = performance.now()
      const board = bt.leaderboard({
        lottery,
        history,
        periods,
      budget: 30,
      profile,
    })
      const ms = performance.now() - t1
      console.log(
        `排行榜 ${periods} 期 × ${board.length} 模型 = ${(ms / 1000).toFixed(1)}s  ` +
          `冠军 ${board[0].modelId} ${(board[0].roi * 100).toFixed(1)}%  ` +
          `基线B01 ${(board.find((b) => b.modelId === 'B01').roi * 100).toFixed(1)}%`
      )
    }
  }

  // 精确金额核对：文档里写死的几组必须复现
  console.log('\n=== 票型成本核对 ===')
  const check = (t, expect) =>
    console.log(`  ${t.label.padEnd(18)} ${String(t.bets).padStart(4)} 注 ${String(t.cost).padStart(5)} 元  ${expect}`)
  const pred = models.getModel('B01').predict({
    history: all.filter((d) => d.lottery === 'ssq').slice(0, 200),
    lottery: 'ssq',
    nextDate: new Date(),
    profile: {},
  })
  for (const [n, m, expect] of [
    [6, 1, '单式 2 元（需求文档表）'],
    [7, 2, '14 注 28 元（需求文档示例）'],
    [8, 3, '84 注 168 元（需求文档表）'],
  ]) {
    const p = ticket.enumeratePlans('ssq', pred, 100000, false).find((x) => x.kind !== 'dantuo' && x.frontNums.length === n && x.backNums.length === m)
    if (p) check(p, expect)
    else console.log(`  ${n}+${m} 未枚举到`)
  }
} finally {
  await server.close()
}
