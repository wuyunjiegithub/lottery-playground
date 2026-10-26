import { C, RULES, FIXED_PRIZE, judgeLevel } from './lottery'
import type { LotteryType, Prediction, TicketPlan, PlanMetrics, PlanKind } from '../types'

/** 按概率降序取前 n 个号码 */
export function topNumbers(probs: number[], n: number): number[] {
  return probs
    .map((p, i) => ({ num: i + 1, p }))
    .sort((a, b) => b.p - a.p || a.num - b.num)
    .slice(0, n)
    .map((x) => x.num)
    .sort((a, b) => a - b)
}

function emptyMetrics(): PlanMetrics {
  return { pWin: 0, coverage: 0, probMass: 0, variance: 0, expected: 0, levelProbs: {} }
}

/** 票面号码在模型概率分布下覆盖的质量，用于区分「有效覆盖」与「凑数覆盖」 */
function massOf(pred: Prediction, nums: number[], field: 'front' | 'back'): number {
  const src = field === 'front' ? pred.frontProbs : pred.backProbs
  return nums.reduce((s, n) => s + (src[n - 1] || 0), 0)
}

// ---------------------------------------------------------------- 概率评估

/**
 * 票型结构到达指标映射 [n, m] 的缓存。
 *
 * evalComplex / evalDantuo 的结果只取决于票型结构与彩种，与模型给出的号码无关。
 * 回测时「N 个模型 × M 期」会重复调用上百万次，缓存后即可砍掉绝大部分开销。
 * 注意：取用时必须返回副本 —— 调用方会写入 coverage / probMass 这两个依赖具体号码的字段。
 */
const complexCache = new Map<string, PlanMetrics>()
const dantuoCache = new Map<string, PlanMetrics>()

function cloneMetrics(mt: PlanMetrics): PlanMetrics {
  return { ...mt, levelProbs: { ...mt.levelProbs } }
}

/** 概率按理在 [0,1]，但浮点累加会溢出一点点，统一夹回去 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 单注的期望奖金（精确值，按 FIXED_PRIZE 里的浮动奖估算值计算）。
 *
 * 用途：让「票型不改变期望回报」这句话能被页面上的数字验证，而不是只是一句文案。
 *
 * 一张票面是 bets 注，但**每注的边际分布完全相同** —— 复式的每注是「6 个前区号 + 1 个后区号」，
 * 胆拖的每注是「a 个胆 + (6−a) 个拖 + 1 个后区号」，两者都等价于一张普通单注。
 * 由期望的线性性 E[Σ Xᵢ] = Σ E[Xᵢ]（**不需要各注相互独立**）：
 *
 *     整张票的期望回报 = bets × 单注期望 = cost / price × 单注期望
 *
 * 与票型无关。所以同样是 30 元（15 注），买 6+15 复式还是 5胆5拖+5后，期望回报完全相同。
 * 票型真正改变的是**奖金分布的形状**（中奖率、方差），不是期望值。
 *
 * ⚠️ 口径提醒：**不要拿 metrics.expected 当整张票的期望**。
 * evalComplex / evalDantuo 累加的是「从票里挑出最佳一注」的奖金（见其注释
 * 「按最佳单注计算，属保守估计」），比整票期望少 bets 倍。要显示整票期望请用本函数。
 */
const betEvCache = new Map<LotteryType, number>()

export function singleBetEV(lottery: LotteryType): number {
  const cached = betEvCache.get(lottery)
  if (cached !== undefined) return cached
  const rule = RULES[lottery]
  const prize = FIXED_PRIZE[lottery]
  let e1 = 0
  if (lottery === 'ssq') {
    for (let k = 0; k <= 6; k++) {
      const pk = (C(6, k) * C(27, 6 - k)) / C(33, 6)
      for (const [hitBack, p] of [
        [1, pk / rule.backMax],
        [0, (pk * (rule.backMax - 1)) / rule.backMax],
      ] as [number, number][]) {
        const lv = judgeLevel(lottery, k, hitBack)
        if (!lv) continue
        e1 += p * prize[lv]
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
      }
    }
  }
  betEvCache.set(lottery, e1)
  return e1
}

/** 整张票的期望回报。= 注数 × 单注期望，与票型无关。见 singleBetEV 的推导。 */
export function planEV(lottery: LotteryType, p: TicketPlan): number {
  return p.bets * singleBetEV(lottery)
}

/**
 * 复式票精确概率。
 * 双色球：P(命中 k 个红球) = C(6,k)·C(27,n−k) / C(33,n)
 * 大乐透：P(命中 k 个前区)  = C(5,k)·C(30,n−k) / C(35,n)
 */
function evalComplex(lottery: LotteryType, n: number, m: number): PlanMetrics {
  const key = `${lottery}|${n}|${m}`
  const cached = complexCache.get(key)
  if (cached) return cloneMetrics(cached)

  const rule = RULES[lottery]
  const mt = emptyMetrics()
  const prize = FIXED_PRIZE[lottery]
  let e2 = 0

  if (lottery === 'ssq') {
    const pb = m / rule.backMax
    for (let k = 0; k <= 6; k++) {
      const pk = (C(6, k) * C(27, n - k)) / C(33, n)
      if (pk <= 0) continue
      for (const [hit, p] of [
        [1, pk * pb],
        [0, pk * (1 - pb)],
      ] as [number, number][]) {
        const lv = judgeLevel(lottery, k, hit)
        if (!lv) continue
        mt.levelProbs[lv] = (mt.levelProbs[lv] || 0) + p
        mt.pWin += p
        mt.expected += p * prize[lv]
        e2 += p * prize[lv] * prize[lv]
      }
    }
  } else {
    for (let k = 0; k <= 5; k++) {
      const pk = (C(5, k) * C(30, n - k)) / C(35, n)
      if (pk <= 0) continue
      for (let l = 0; l <= 2; l++) {
        const pl = (C(2, l) * C(10, m - l)) / C(12, m)
        if (pl <= 0) continue
        const p = pk * pl
        const lv = judgeLevel(lottery, k, l)
        if (!lv) continue
        mt.levelProbs[lv] = (mt.levelProbs[lv] || 0) + p
        mt.pWin += p
        mt.expected += p * prize[lv]
        e2 += p * prize[lv] * prize[lv]
      }
    }
  }
  mt.variance = Math.max(0, e2 - mt.expected * mt.expected)
  // 浮点累加会溢出一点点：后区全包 16 个时必然中奖，理论值恰好 1，
  // 逐项相加却得到 1.0000000000000002。夹回 [0,1]，避免 1 - pWin 算出负数。
  mt.pWin = clamp01(mt.pWin)
  complexCache.set(key, mt)
  return cloneMetrics(mt)
}

/**
 * 胆拖票精确概率。
 * P(胆码命中 i、拖码命中 j) = C(a,i)·C(b,j)·C(M−a−b, N−i−j) / C(M, N)
 * 最佳单注命中数 = i + min(j, N−a)
 *
 * 注：多注同时中奖时奖金会叠加，此处按最佳单注计算，属保守估计。
 */
function evalDantuo(lottery: LotteryType, a: number, b: number, m: number): PlanMetrics {
  const key = `${lottery}|${a}|${b}|${m}`
  const cached = dantuoCache.get(key)
  if (cached) return cloneMetrics(cached)

  const rule = RULES[lottery]
  const mt = emptyMetrics()
  const prize = FIXED_PRIZE[lottery]
  let e2 = 0

  if (lottery === 'ssq') {
    const rest = 33 - a - b
    const pb = m / rule.backMax
    for (let i = 0; i <= a; i++) {
      for (let j = 0; j <= b; j++) {
        if (i + j > 6) continue
        const p = (C(a, i) * C(b, j) * C(rest, 6 - i - j)) / C(33, 6)
        if (p <= 0) continue
        const hit = i + Math.min(j, 6 - a)
        for (const [bh, pp] of [
          [1, p * pb],
          [0, p * (1 - pb)],
        ] as [number, number][]) {
          const lv = judgeLevel(lottery, hit, bh)
          if (!lv) continue
          mt.levelProbs[lv] = (mt.levelProbs[lv] || 0) + pp
          mt.pWin += pp
          mt.expected += pp * prize[lv]
          e2 += pp * prize[lv] * prize[lv]
        }
      }
    }
  } else {
    const rest = 35 - a - b
    for (let i = 0; i <= a; i++) {
      for (let j = 0; j <= b; j++) {
        if (i + j > 5) continue
        const pf = (C(a, i) * C(b, j) * C(rest, 5 - i - j)) / C(35, 5)
        if (pf <= 0) continue
        const hit = i + Math.min(j, 5 - a)
        for (let l = 0; l <= 2; l++) {
          const pl = (C(2, l) * C(10, m - l)) / C(12, m)
          if (pl <= 0) continue
          const p = pf * pl
          const lv = judgeLevel(lottery, hit, l)
          if (!lv) continue
          mt.levelProbs[lv] = (mt.levelProbs[lv] || 0) + p
          mt.pWin += p
          mt.expected += p * prize[lv]
          e2 += p * prize[lv] * prize[lv]
        }
      }
    }
  }
  mt.variance = Math.max(0, e2 - mt.expected * mt.expected)
  mt.pWin = clamp01(mt.pWin)
  dantuoCache.set(key, mt)
  return cloneMetrics(mt)
}

// ---------------------------------------------------------------- 票型构造

function makeComplex(
  lottery: LotteryType,
  pred: Prediction,
  n: number,
  m: number,
  withMetrics = true
): TicketPlan {
  const rule = RULES[lottery]
  const frontNums = topNumbers(pred.frontProbs, n)
  const backNums = topNumbers(pred.backProbs, m)
  const bets =
    lottery === 'ssq' ? C(n, 6) * m : C(n, 5) * C(m, 2)
  const cost = bets * rule.price
  const formula =
    lottery === 'ssq'
      ? `C(${n},6) × ${m} = ${bets} 注 × ${rule.price} 元`
      : `C(${n},5) × C(${m},2) = ${bets} 注 × ${rule.price} 元`
  const label =
    n === rule.frontCount && m === rule.backCount
      ? '单式'
      : `${n}+${m} 复式`
  const metrics = withMetrics ? evalComplex(lottery, n, m) : emptyMetrics()
  metrics.coverage = frontNums.length + backNums.length
  metrics.probMass = massOf(pred, frontNums, 'front') + massOf(pred, backNums, 'back')
  return {
    kind: n === rule.frontCount && m === rule.backCount ? 'single' : 'complex',
    label,
    frontNums,
    backNums,
    bets,
    cost,
    formula,
    metrics,
  }
}

function makeDantuo(
  lottery: LotteryType,
  pred: Prediction,
  a: number,
  b: number,
  m: number,
  withMetrics = true
): TicketPlan {
  const rule = RULES[lottery]
  const all = topNumbers(pred.frontProbs, a + b)
  const dans = all.slice(0, a)
  const tuos = all.slice(a)
  const backNums = topNumbers(pred.backProbs, m)
  const bets =
    lottery === 'ssq' ? C(b, 6 - a) * m : C(b, 5 - a) * C(m, 2)
  const cost = bets * rule.price
  const formula =
    lottery === 'ssq'
      ? `C(${b},${6 - a}) × ${m} = ${bets} 注 × ${rule.price} 元`
      : `C(${b},${5 - a}) × C(${m},2) = ${bets} 注 × ${rule.price} 元`
  const metrics = withMetrics ? evalDantuo(lottery, a, b, m) : emptyMetrics()
  metrics.coverage = all.length + backNums.length
  metrics.probMass = massOf(pred, all, 'front') + massOf(pred, backNums, 'back')
  return {
    kind: 'dantuo',
    label: `${a}胆${b}拖 + ${m}后`,
    frontNums: all,
    backNums,
    dans,
    tuos,
    bets,
    cost,
    formula,
    metrics,
  }
}

// ---------------------------------------------------------------- 枚举

/**
 * 枚举所有落在预算内的合法票型。
 *
 * 预算是**上限**：票面金额由「注数 × 单价」决定，取值离散，很多数字根本凑不出来
 * （例如双色球凑不出正好 50 元的票型）。所以这里取「不超过预算」的全部票型，
 * 再由打分函数挑选贴近预算的那个。
 */
export function enumeratePlans(
  lottery: LotteryType,
  pred: Prediction,
  maxCost: number,
  withMetrics = true
): TicketPlan[] {
  const rule = RULES[lottery]
  const price = rule.price
  const out: TicketPlan[] = []
  const seen = new Set<string>()
  const MAX_BETS = 3000

  const push = (p: TicketPlan) => {
    const key = `${p.kind}|${p.bets}|${p.frontNums.join(',')}|${p.backNums.join(',')}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(p)
  }

  if (lottery === 'ssq') {
    for (let n = 6; n <= 14; n++) {
      for (let m = 1; m <= 16; m++) {
        const bets = C(n, 6) * m
        const cost = bets * price
        if (cost < price || cost > maxCost || bets > MAX_BETS) continue
        push(makeComplex(lottery, pred, n, m, withMetrics))
      }
    }
    // 拖码个数只受「号码池还剩多少」约束：胆 a 个后，拖码最多 frontCount - a 个。
    // 早年这里被写死成 16，导致「胆5拖25」这类完全合法的票型从未被枚举到，
    // 直接后果就是 50 元凑不出 25 注、100 元凑不出 50 注。
    for (let a = 1; a <= 5; a++) {
      for (let b = 6 - a; b <= rule.frontMax - a; b++) {
        // 前区胆拖可以配后区复式，后区个数同样只受号码池限制
        for (let m = 1; m <= rule.backMax; m++) {
          const bets = C(b, 6 - a) * m
          const cost = bets * price
          if (cost > maxCost || bets > MAX_BETS) continue
          push(makeDantuo(lottery, pred, a, b, m, withMetrics))
        }
      }
    }
  } else {
    for (let n = 5; n <= 14; n++) {
      for (let m = 2; m <= 12; m++) {
        const bets = C(n, 5) * C(m, 2)
        const cost = bets * price
        // 只需卡上限：最便宜的票天然是 price，不会再往下筛
        if (cost > maxCost || bets > MAX_BETS) continue
        push(makeComplex(lottery, pred, n, m, withMetrics))
      }
    }
    // 同上：拖码上限应为「号码池减胆码」，后区复式上限为后区号码总数
    for (let a = 1; a <= 4; a++) {
      for (let b = 5 - a; b <= rule.frontMax - a; b++) {
        for (let m = 2; m <= rule.backMax; m++) {
          const bets = C(b, 5 - a) * C(m, 2)
          const cost = bets * price
          if (cost > maxCost || bets > MAX_BETS) continue
          push(makeDantuo(lottery, pred, a, b, m, withMetrics))
        }
      }
    }
  }
  return out
}

/**
 * 预算约束下的票型优选。
 * 注意：期望奖金与票型无关（每注期望相同），故不参与打分，
 * 真正区分票型的是 pWin（中奖率）、coverage（覆盖广度）、variance（风险）。
 *
 * 旧的「稳健 / 均衡 / 激进」三档在固定预算下几乎总是挑出同一张票（见对话记录），
 * 已于 2026-10-06 移除，统一用下面的均衡打分：中奖率与「单位成本买到的概率质量」
 * 并重，适度避险。
 *
 * budget 参与打分是必要的：票面金额离散，同价位往往有十几种合法组合，
 * 而「充分利用预算」本身就是用户的意图——给 50 元就想买 50 元的票，
 * 而不是被算法自作主张退成一注 2 元的单式。
 */
export function scorePlan(p: TicketPlan, budget = 0): number {
  const { pWin, coverage, probMass, variance } = p.metrics
  const cost = Math.max(1, p.cost)
  const sd = Math.sqrt(variance) / cost

  // 预算利用率 ∈ [0,1]：票面越贴近预算越高
  const usage = budget > 0 ? 1 - Math.min(1, (budget - p.cost) / budget) : 0
  const spend = usage * 800

  // 均衡：中奖率与「单位成本买到的概率质量」并重，适度避险
  return pWin * 300 + (probMass / cost) * 400 - sd * 0.05 + spend
}

/**
 * 落在预算上限附近的候选比例——兜底用。
 * 只有当「正好等于预算」的票型不存在时才走到这里（例如预算奇数）。
 * 前者优先，见 recommend 内部。留余量是为了给偏好留出挑选空间。
 */
const BudgetBand = 0.9

export function recommend(
  plans: TicketPlan[],
  budget = 0
): { best: TicketPlan | null; ranked: TicketPlan[] } {
  if (!plans.length) return { best: null, ranked: [] }

  // 用户的心智是「给了 100 元就买 100 元的票」，所以先把预算用足。
  // 正好花得满时只在金额恰好相等的票型里挑。
  const exact = budget > 0 ? plans.filter((p) => p.cost === budget) : []
  let pool = exact

  if (!pool.length) {
    const cap = plans.reduce((m, p) => Math.max(m, p.cost), 0)
    const near = plans.filter((p) => p.cost >= cap * BudgetBand)
    pool = near.length ? near : plans
  }

  const ranked = [...pool].sort((a, b) => scorePlan(b, budget) - scorePlan(a, budget))
  return { best: ranked[0] || null, ranked }
}

const fitCache = new Map<string, { cost: number; bets: number; exact: boolean }>()

/**
 * 预算内「花得掉」的最大票面。
 *
 * 票型能不能成立只取决于形态组合（比如 C(7,6)×7=49 注），
 * 与模型给哪个号码无关，所以这里拿均匀概率兜底，只为把可选形态枚举出来。
 * UI 用它回答「50 元是不是真能买 50 元的票」——多数情况下不能。
 */
export function budgetFit(
  lottery: LotteryType,
  budget: number
): { cost: number; bets: number; exact: boolean } {
  const key = `${lottery}|${budget}`
  const hit = fitCache.get(key)
  if (hit) return hit

  const rule = RULES[lottery]
  const uniform: Prediction = {
    frontProbs: new Array(rule.frontMax).fill(1 / rule.frontMax),
    backProbs: new Array(rule.backMax).fill(1 / rule.backMax),
    narrative: '',
    confidence: 0,
  }
  let bets = 0
  for (const p of enumeratePlans(lottery, uniform, budget, false)) {
    if (p.bets > bets) bets = p.bets
  }
  const cost = bets * rule.price
  const out = { cost, bets, exact: cost === budget }
  fitCache.set(key, out)
  return out
}
