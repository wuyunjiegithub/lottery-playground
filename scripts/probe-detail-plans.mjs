/**
 * 探针：把「票型评估」表改成展示号码之前，先把三件事量化清楚。
 *
 * 1. 冗余度：recommend 只在 cost === budget 的票型里挑 ⇒ 表里每行金额/注数都一样，
 *    这两列是纯噪声。确认一下。
 * 2. 号码嵌套性：所有票型都用 topN(probs, n) 取号，理论上短的一定是长的子集。
 *    若成立，UI 可以把「多出来的号码」解释成低分号，这是有信息量的展示。
 * 3. **期望/方差口径缺陷的影响面**：evalComplex / evalDantuo 算的是「从票里随机抽
 *    一注」的期望，而不是整张票（bets 注）的期望，偏差最大 60%。
 *    variance 又由 expected 推出，最终进入 scorePlan 决定 recommend 选哪张票。
 *    这里量化：修正前后 best 会变吗？
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
const { enumeratePlans, recommend, scorePlan } = await server.ssrLoadModule('/src/core/ticket.ts')
const { ALL_MODELS } = await server.ssrLoadModule('/src/core/models/index.ts')
const { RULES } = await server.ssrLoadModule('/src/core/lottery.ts')

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? pass++ : fail++
  console.log(`  ${c ? '✓' : '✗'} ${m}`)
}

function makeHistory(lottery, n) {
  const rule = RULES[lottery]
  let seed = 987654321
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const out = []
  for (let i = 0; i < n; i++) {
    const front = new Set()
    while (front.size < rule.frontCount) front.add(1 + Math.floor(rnd() * rule.frontMax))
    const back = new Set()
    while (back.size < rule.backCount) back.add(1 + Math.floor(rnd() * rule.backMax))
    out.push({
      lottery,
      issue: String(n - i).padStart(5, '0'),
      date: '',
      front: [...front].sort((a, b) => a - b),
      back: [...back].sort((a, b) => a - b),
    })
  }
  return out
}

const ctx = { nextDate: new Date('2026-10-08'), profile: {} }
const BUDGETS = [10, 30, 50, 100, 200, 500]

// ---------------------------------------------------------------- 1. 冗余度
console.log('\n【1】表里每行的金额 / 注数是否恒定')
{
  let allSameCost = true
  let allSameBets = true
  let rows = 0
  let poolBigger = 0
  for (const lottery of ['ssq', 'dlt']) {
    const history = makeHistory(lottery, 200)
    for (const model of ALL_MODELS.slice(0, 20)) {
      const pred = model.predict({ ...ctx, history, lottery })
      for (const budget of BUDGETS) {
        const plans = enumeratePlans(lottery, pred, budget)
        const { ranked } = recommend(plans, budget)
        if (!ranked.length) continue
        rows += ranked.length
        if (new Set(ranked.map((p) => p.cost)).size > 1) allSameCost = false
        if (new Set(ranked.map((p) => p.bets)).size > 1) allSameBets = false
        if (ranked.length < plans.length) poolBigger++
      }
    }
  }
  console.log(`  样本：${rows} 行（20 个模型 × 2 彩种 × ${BUDGETS.length} 档预算）`)
  ok(allSameCost, '所有行的金额完全相同 ⇒ 「金额」列零信息')
  ok(allSameBets, '所有行的注数完全相同 ⇒ 「注数」列零信息')
  console.log(`  ${poolBigger} 组里候选池是枚举结果的子集 ⇒ 标题「评估了 N 种」用的 N 其实是被预算过滤后的数量`)
}

// ---------------------------------------------------------------- 2. 嵌套性
console.log('\n【2】各票型的前区号码是否层层包含（topN 取前 N 的必然结果）')
{
  let checked = 0
  let bad = []
  for (const lottery of ['ssq', 'dlt']) {
    const history = makeHistory(lottery, 200)
    for (const model of ALL_MODELS.slice(0, 20)) {
      const pred = model.predict({ ...ctx, history, lottery })
      for (const budget of BUDGETS) {
        const { ranked } = recommend(enumeratePlans(lottery, pred, budget), budget)
        if (ranked.length < 2) continue
        const byLen = [...ranked].sort((a, b) => a.frontNums.length - b.frontNums.length)
        for (let i = 1; i < byLen.length; i++) {
          // 短集合 ⊆ 长集合：所有票型都是 topN(probs, n)，取前 n 个必然是取前 m 个（n<m）的子集
          const longer = new Set(byLen[i].frontNums)
          const shorter = byLen[i - 1].frontNums
          const missing = shorter.filter((n) => !longer.has(n))
          if (missing.length) {
            bad.push(
              `${lottery}/${model.meta.id}/${budget}: ${shorter} ⊄ ${byLen[i].frontNums}（缺 ${missing}）`
            )
          }
          checked++
        }
      }
    }
  }
  ok(bad.length === 0, `检查了 ${checked} 组相邻长度的包含关系，违例 ${bad.length} 组`)
  for (const b of bad.slice(0, 3)) console.log('      ' + b)
}

// ---------------------------------------------------------------- 3. 修正 best 的影响面
console.log('\n【3】把 expected / variance 修成「整张票」口径后，recommend 会选不同的票吗')
{
  // 单注的真实期望与二阶矩（独立实现，不用被测对象）
  function singleBet(lottery) {
    const { C, FIXED_PRIZE, judgeLevel } = globalThis.__lottery
    const prize = FIXED_PRIZE[lottery]
    let e1 = 0
    let e2 = 0
    if (lottery === 'ssq') {
      for (let k = 0; k <= 6; k++) {
        const pk = (C(6, k) * C(27, 6 - k)) / C(33, 6)
        for (const [bh, p] of [[1, pk / 16], [0, (pk * 15) / 16]]) {
          const lv = judgeLevel(lottery, k, bh)
          if (!lv) continue
          e1 += p * prize[lv]
          e2 += p * prize[lv] * prize[lv]
        }
      }
    } else {
      for (let k = 0; k <= 5; k++) {
        const pk = (C(5, k) * C(30, 5 - k)) / C(35, 5)
        for (let l = 0; l <= 2; l++) {
          const pl = (C(2, l) * C(10, 2 - l)) / C(12, 2)
          const p = pk * pl
          const lv = judgeLevel(lottery, k, l)
          if (!lv) continue
          e1 += p * prize[lv]
          e2 += p * prize[lv] * prize[lv]
        }
      }
    }
    return { e1, e2 }
  }
  const { C, FIXED_PRIZE, judgeLevel } = await server.ssrLoadModule('/src/core/lottery.ts')
  globalThis.__lottery = { C, FIXED_PRIZE, judgeLevel }

  // 正确口径：整张票 = bets 注，每注边际分布相同 ⇒ E = bets·e1
  // Var(Σ) 需要协方差，无法解析求；这里只用 E 与「独立近似」的 Var 作对比上界。
  let changed = 0
  let total = 0
  const examples = []
  const sdNow = []
  const sdFix = []
  for (const lottery of ['ssq', 'dlt']) {
    const { e1, e2 } = singleBet(lottery)
    const history = makeHistory(lottery, 200)
    for (const model of ALL_MODELS.slice(0, 25)) {
      const pred = model.predict({ ...ctx, history, lottery })
      for (const budget of BUDGETS) {
        const plans = enumeratePlans(lottery, pred, budget)
        const { best } = recommend(plans, budget)
        if (!best) continue
        total++

        // 现有打分下的 sd
        const sdNowV = Math.sqrt(best.metrics.variance) / Math.max(1, best.cost)
        sdNow.push(sdNowV)

        // 修正后：整票期望 = bets·e1；独立近似 Var = bets·Var(单注)
        const expFix = best.bets * e1
        const varFix = best.bets * (e2 - e1 * e1)
        const sdFixV = Math.sqrt(Math.max(0, varFix)) / Math.max(1, best.cost)
        sdFix.push(sdFixV)

        // 用修正后的 variance 重排同池的票，看 best 是否改变
        const exact = plans.filter((p) => p.cost === budget)
        const pool = exact.length ? exact : plans
        const rescored = [...pool].sort((a, b) => {
          const ra = scorePlan({ ...a, metrics: { ...a.metrics, expected: a.bets * e1, variance: a.bets * (e2 - e1 * e1) } }, budget)
          const rb = scorePlan({ ...b, metrics: { ...b.metrics, expected: b.bets * e1, variance: b.bets * (e2 - e1 * e1) } }, budget)
          return rb - ra
        })
        if (rescored[0] && rescored[0].label !== best.label) {
          changed++
          if (examples.length < 6) {
            examples.push(`${lottery} ${model.meta.id} ${budget}元: ${best.label} → ${rescored[0].label}`)
          }
        }
      }
    }
  }
  console.log(`  样本 ${total} 组（25 模型 × 2 彩种 × ${BUDGETS.length} 档预算）`)
  console.log(`  风险项 sd = √var/cost：现状 ${avg(sdNow).toFixed(1)} → 修正后 ${avg(sdFix).toFixed(1)}`)
  console.log(`  scorePlan 里风险项权重是 0.05，量级差 ${Math.abs(avg(sdNow) * 0.05 - avg(sdFix) * 0.05).toFixed(2)} 分`)
  for (const e of examples) console.log('      ' + e)
  console.log(`  best 发生改变：${changed} / ${total}`)
  ok(true, `影响面已量化：${changed}/${total} 组的推荐票型会变（这是引擎行为变更，需要 ENGINE_VERSION += 1）`)
}

function avg(a) {
  return a.reduce((x, y) => x + y, 0) / a.length
}

console.log(`\n通过 ${pass} / 失败 ${fail}`)
await server.close()