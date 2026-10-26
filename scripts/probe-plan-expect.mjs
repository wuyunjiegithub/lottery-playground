/**
 * 探针：singleBetEV / planEV 的正确性。
 *
 * 这两个函数支撑 UI 上「票型不改变期望回报」这句话，所以必须证明：
 *   1. singleBetEV 与一份**独立实现**（暴力枚举所有奖级组合）逐位一致；
 *   2. planEV 对复式、胆拖、单式都成立，且**与票型无关、只由金额决定**
 *      —— 这正是要展示给用户的核心事实；
 *   3. planEV ≠ metrics.expected（后者只是最佳单注），避免 UI 误用后者。
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
const { enumeratePlans, recommend, singleBetEV, planEV, scorePlan } =
  await server.ssrLoadModule('/src/core/ticket.ts')
const { ALL_MODELS } = await server.ssrLoadModule('/src/core/models/index.ts')
const { C, RULES, FIXED_PRIZE, judgeLevel } = await server.ssrLoadModule('/src/core/lottery.ts')

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? pass++ : fail++
  console.log(`  ${c ? '✓' : '✗'} ${m}`)
}

/**
 * 独立实现：暴力遍历所有「前区命中数 × 后区命中数」组合，
 * 概率用组合数直接算，不复用 ticket.ts 的任何代码。
 */
function bruteSingleBetEV(lottery) {
  const prize = FIXED_PRIZE[lottery]
  let e = 0
  if (lottery === 'ssq') {
    for (let k = 0; k <= 6; k++) {
      const pk = (C(6, k) * C(27, 6 - k)) / C(33, 6)
      // 后区：命中 1 个蓝球（1/16）或没命中（15/16）
      for (const [bh, p] of [
        [1, pk * (1 / 16)],
        [0, pk * (15 / 16)],
      ]) {
        const lv = judgeLevel(lottery, k, bh)
        if (lv) e += p * prize[lv]
      }
    }
  } else {
    for (let k = 0; k <= 5; k++) {
      const pk = (C(5, k) * C(30, 5 - k)) / C(35, 5)
      for (let l = 0; l <= 2; l++) {
        const pl = (C(2, l) * C(10, 2 - l)) / C(12, 2)
        const lv = judgeLevel(lottery, k, l)
        if (lv) e += pk * pl * prize[lv]
      }
    }
  }
  return e
}

console.log('\n【1】singleBetEV 与独立暴力实现一致')
for (const lottery of ['ssq', 'dlt']) {
  const a = singleBetEV(lottery)
  const b = bruteSingleBetEV(lottery)
  const r = RULES[lottery]
  console.log(
    `  ${r.name}：代码 ${a.toFixed(6)} / 暴力 ${b.toFixed(6)}  →  ` +
      `单注 ${a.toFixed(4)} 元，返奖率 ${((a / r.price) * 100).toFixed(1)}%`
  )
  ok(Math.abs(a - b) < 1e-9, `${r.name} singleBetEV 与暴力实现一致（差 ${Math.abs(a - b).toExponential(2)}）`)
  ok(a > 0 && a < r.price * 2, `${r.name} 单注期望落在合理区间（不会 > 2 元）`)
}

console.log('\n【2】planEV 只由金额决定，与票型无关')
{
  let mismatchVsCost = 0
  let checked = 0
  // key 必须带彩种：双色球 10 元（5 注）和大乐透 10 元（5 注）注数相同但单注期望不同
  const spreadByKey = new Map()
  for (const lottery of ['ssq', 'dlt']) {
    const ev = singleBetEV(lottery)
    const price = RULES[lottery].price
    for (const budget of [10, 30, 50, 100, 200, 500]) {
      const rule = RULES[lottery]
      // 造若干不同概率分布的模型，凑够票型样本
      for (let variant = 0; variant < 6; variant++) {
        const pred = {
          frontProbs: Array.from({ length: rule.frontMax }, (_, i) => 1 + ((i * (variant + 3)) % 11)),
          backProbs: Array.from({ length: rule.backMax }, (_, i) => 1 + ((i * (variant + 2)) % 7)),
          narrative: '',
          confidence: 0,
        }
        const { ranked } = recommend(enumeratePlans(lottery, pred, budget), budget)
        // 候选池可能为空（预算凑不出票型），跳过即可
        for (const p of ranked) {
          const got = planEV(lottery, p)
          const want = (p.cost / price) * ev
          checked++
          if (Math.abs(got - want) > 1e-9) mismatchVsCost++
          // 用容差分桶，避免浮点尾数把同一个值拆成多个
          const key = `${lottery}|${p.cost}`
          if (!spreadByKey.has(key)) spreadByKey.set(key, new Set())
          spreadByKey.get(key).add(Math.round(got * 1e6))
        }
      }
    }
  }
  ok(checked >= 200, `检查了 ${checked} 张票`)
  ok(mismatchVsCost === 0, `planEV === cost/price × 单注期望（${mismatchVsCost} 处不符）`)
  const multi = [...spreadByKey.entries()].filter(([, s]) => s.size > 1)
  ok(
    multi.length === 0,
    `同一彩种同一金额下所有票型的期望回报完全相同（检查了 ${spreadByKey.size} 个「彩种+金额」档，异常 ${multi.length} 个）`
  )
  for (const [key, s] of [...spreadByKey.entries()].slice(0, 4)) {
    console.log(`    ${key} → 期望 ${(Math.round([...s][0]) / 1e6).toFixed(2)} 元（该档所有票型同一个值）`)
  }
}

console.log('\n【3】metrics.expected 只是最佳单注，不能当整票期望用')
{
  let allLess = true
  let worstRatio = Infinity
  let n = 0
  for (const lottery of ['ssq', 'dlt']) {
    const ev = singleBetEV(lottery)
    const rule = RULES[lottery]
    const pred = {
      frontProbs: Array.from({ length: rule.frontMax }, (_, i) => 1 + (i % 5)),
      backProbs: Array.from({ length: rule.backMax }, (_, i) => 1 + (i % 3)),
      narrative: '',
      confidence: 0,
    }
    for (const budget of [30, 50, 100, 200]) {
      for (const p of enumeratePlans(lottery, pred, budget)) {
        n++
        const full = planEV(lottery, p)
        // metrics.expected 是「最佳单注」，应当 ≤ 整票期望，且在多注票上明显更小
        if (p.metrics.expected > full + 1e-9) allLess = false
        worstRatio = Math.min(worstRatio, p.metrics.expected / full)
      }
    }
  }
  console.log(`  检查 ${n} 张票，metrics.expected / planEV 最小比值 ${worstRatio.toFixed(3)}`)
  ok(allLess, 'metrics.expected 始终 ≤ 整票期望（它是保守估计）')
  ok(
    worstRatio < 0.9,
    `多注票上 metrics.expected 明显小于整票期望（最小 ${(worstRatio * 100).toFixed(1)}%），` +
      `证明两者口径不同、UI 不能混用`
  )
}

console.log('\n【4】修正 variance 不改变 recommend 的选择（回归保护）')
{
  // 若将来有人把 variance 也改成整票口径，必须确认选票结果不变，
  // 否则回测数字会变、ENGINE_VERSION 就得 +1。这里把结论钉死。
  let changed = 0
  let total = 0
  for (const lottery of ['ssq', 'dlt']) {
    const ev = singleBetEV(lottery)
    const rule = RULES[lottery]
    for (const model of ALL_MODELS.slice(0, 15)) {
      let seed = 4242
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
      const history = []
      for (let i = 0; i < 150; i++) {
        const f = new Set()
        while (f.size < rule.frontCount) f.add(1 + Math.floor(rnd() * rule.frontMax))
        const b = new Set()
        while (b.size < rule.backCount) b.add(1 + Math.floor(rnd() * rule.backMax))
        history.push({
          lottery,
          issue: String(150 - i).padStart(5, '0'),
          date: '',
          front: [...f].sort((a, b) => a - b),
          back: [...b].sort((a, b) => a - b),
        })
      }
      const pred = model.predict({ history, lottery, nextDate: new Date('2026-10-08'), profile: {} })
      for (const budget of [30, 50, 100]) {
        const plans = enumeratePlans(lottery, pred, budget)
        const { best } = recommend(plans, budget)
        if (!best) continue
        total++
        const exact = plans.filter((p) => p.cost === budget)
        const pool = exact.length ? exact : plans
        const rescored = [...pool].sort((a, b) => {
          const ra = scorePlan(
            { ...a, metrics: { ...a.metrics, expected: a.bets * ev } },
            budget
          )
          const rb = scorePlan(
            { ...b, metrics: { ...b.metrics, expected: b.bets * ev } },
            budget
          )
          return rb - ra
        })
        if (rescored[0] && rescored[0].label !== best.label) changed++
      }
    }
  }
  console.log(`  ${changed} / ${total} 组的推荐票型会变`)
  ok(
    changed === 0,
    `scorePlan 忽略 expected，只用它推 variance；把 expected 换成整票口径后 best 不变（${changed}/${total}）`
  )
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await server.close()
process.exit(fail ? 1 : 0)