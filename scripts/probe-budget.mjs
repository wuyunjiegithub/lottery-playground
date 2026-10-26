import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const { enumeratePlans, recommend, budgetFit } = await server.ssrLoadModule('/src/core/ticket.ts')
const { RULES } = await server.ssrLoadModule('/src/core/lottery.ts')

function uniformPred(lottery) {
  const r = RULES[lottery]
  // Prediction.frontProbs 是数组：index i -> 号码 i+1
  const fp = new Array(r.frontMax).fill(1 / r.frontMax)
  const bp = new Array(r.backMax).fill(1 / r.backMax)
  return { frontProbs: fp, backProbs: bp, narrative: '', confidence: 0.5 }
}

const pad = (v, n) => String(v).padStart(n)

for (const lottery of ['ssq', 'dlt']) {
  const r = RULES[lottery]
  const pred = uniformPred(lottery)
  console.log('\n=== ' + r.name + ' 前区选' + r.frontCount + '/' + r.frontMax + ' 后区选' + r.backCount + '/' + r.backMax + ' ===')
  for (const budget of [10, 30, 50, 100, 200]) {
    const t0 = performance.now()
    const plans = enumeratePlans(lottery, pred, budget, false)
    const ms = (performance.now() - t0).toFixed(1)
    const maxCost = plans.reduce((m, p) => Math.max(m, p.cost), 0)
    const exact = maxCost === budget
    const best = plans.filter((p) => p.cost === maxCost).sort((a, b) => b.bets - a.bets)[0]
    console.log(
      '预算 ' + pad(budget, 3) + ' 元 → 票型 ' + pad(plans.length, 3) + ' 种, 实际最多 ' +
      pad(maxCost, 3) + ' 元 (' + pad(maxCost / 2, 3) + ' 注) ' +
      (exact ? '[正好]' : '[差 ' + (budget - maxCost) + ' 元]') +
      ', 代表票面: ' + (best ? best.label : '-') + ', ' + ms + 'ms'
    )
  }
  console.log('  -- 推荐结果（统一均衡策略） --')
  for (const budget of [10, 30, 50, 100, 200]) {
    const fit0 = budgetFit(lottery, budget)
    const plans = enumeratePlans(lottery, pred, budget)
    const { best } = recommend(plans, budget)
    const u = ((best.cost / budget) * 100).toFixed(0)
    console.log('  ' + pad(budget, 3) + ' 元 上限' + pad(fit0.cost, 4) + '元 | 推荐: ' + best.label + ' ' + best.cost + '元(' + u + '%)')
  }
}

await server.close()
