import { judgeLevel, FIXED_PRIZE, RULES } from './lottery'
import { enumeratePlans, recommend } from './ticket'
import { ALL_MODELS } from './models'
import type { Draw, LotteryType, PlanKind, TicketPlan } from '../types'
import type { Model, Profile } from './models/types'

export interface BacktestResult {
  modelId: string
  modelName: string
  category: string
  trials: number
  totalCost: number
  totalPrize: number
  roi: number
  hits: Record<number, number>
  bestLevel: number
  winRate: number
  equity: number[]
}

export interface BacktestOptions {
  lottery: LotteryType
  history: Draw[]
  periods: number
  /** 每期预算上限（元）。票面金额离散，实际每期花费可能略低于它 */
  budget: number
  profile: Profile
  /** 结算区间起点（历史下标，含）。默认 max(60, history.length - periods) */
  startAt?: number
  /** 结算区间终点（历史下标，不含）。默认 history.length */
  endAt?: number
}

/** 计算票面相对某期开奖的最佳命中数 */
export function bestHit(lottery: LotteryType, plan: TicketPlan, draw: Draw) {
  const rule = RULES[lottery]
  let f: number
  if (plan.kind === 'dantuo' && plan.dans && plan.dans.length) {
    const dh = plan.dans.filter((n) => draw.front.includes(n)).length
    const th = (plan.tuos || []).filter((n) => draw.front.includes(n)).length
    const need = rule.frontCount - plan.dans.length
    f = dh + Math.min(th, need)
  } else {
    f = plan.frontNums.filter((n) => draw.front.includes(n)).length
  }
  const b = Math.min(
    plan.backNums.filter((n) => draw.back.includes(n)).length,
    rule.backCount
  )
  return { f, b }
}

/**
 * 单注票面相对某期开奖的完整命中情况。
 *
 * 汇总回测只需要 (f, b) 两个数字，但要让用户「直观看出哪个号中了、哪个没中」，
 * 就必须把这一注**具体由哪些号码组成**、其中哪些落在开奖号里说清楚。
 *
 * 复式 / 胆拖票买的是「一堆号码」，真正对奖的是其中**某一注**，
 * 所以这里区分三层：
 *   picked* 买下的全部号码
 *   bet*    构成最佳单注的号码（胆拖时 = 胆码 + 拖码里挑出的 need 个）
 *   hit*    bet* ∩ 开奖号，也就是计分的那几个
 */
export interface TicketHit {
  pickedFront: number[]
  pickedBack: number[]
  betFront: number[]
  betBack: number[]
  hitFront: number[]
  hitBack: number[]
  f: number
  b: number
}

/**
 * 计算票面相对某期开奖的最佳命中数，并给出可展示的号码明细。
 *
 * 胆拖的处理是这里的关键：一注胆 a 拖 b 的票实际买的是 C(b, frontCount−a) 注，
 * 对奖时取**对Model最有利的那个组合**。所以拖码命中很多时，也只能按
 * 「胆码命中 + min(拖码命中, frontCount−a)」计分，多出来的拖码命中不额外加分。
 */
export function describeHit(lottery: LotteryType, plan: TicketPlan, draw: Draw): TicketHit {
  const rule = RULES[lottery]
  const inDrawF = (n: number) => draw.front.includes(n)
  const inDrawB = (n: number) => draw.back.includes(n)

  let betFront: number[]
  let f: number
  if (plan.kind === 'dantuo' && plan.dans && plan.dans.length) {
    const dans = plan.dans.slice()
    const tuos = (plan.tuos || []).slice()
    const need = rule.frontCount - dans.length
    // 先取命中的拖码（最多 need 个），不够再用没命中的补齐，凑出一注
    const hitTuos = tuos.filter(inDrawF).slice(0, Math.max(0, need))
    const rest = tuos.filter((n) => !hitTuos.includes(n))
    betFront = [...dans, ...hitTuos, ...rest.slice(0, Math.max(0, need - hitTuos.length))]
    f = dans.filter(inDrawF).length + hitTuos.length
  } else {
    betFront = plan.frontNums.slice()
    f = betFront.filter(inDrawF).length
  }

  // 后区同理：票面可能买了 m 个后区，一注只取 backCount 个
  const hitBackAll = plan.backNums.filter(inDrawB)
  const betBack = [...hitBackAll.slice(0, rule.backCount), ...plan.backNums.filter((n) => !inDrawB(n))]
    .slice(0, Math.max(rule.backCount, hitBackAll.length))
  const hitBack = hitBackAll.slice(0, rule.backCount)
  const b = hitBack.length

  return {
    pickedFront: plan.frontNums.slice(),
    pickedBack: plan.backNums.slice(),
    betFront,
    betBack,
    hitFront: betFront.filter(inDrawF),
    hitBack,
    f,
    b,
  }
}

/**
 * 单期结算结果。这是回测全部数值的唯一来源——同步的 backtest()、
 * 分片异步的 runner、以及将来任何分析都只能通过它拿到每期结果，
 * 避免"两个实现算出两套数"。
 */
export interface PeriodStep {
  /** 本期票面花费（元） */
  cost: number
  /** 本期奖金（元） */
  prize: number
  /** 奖级，0 表示未中奖 */
  level: number
}

/**
 * 逐期明细：在 PeriodStep 之上补齐「买了什么号码、命中哪几个」。
 * 只在用户主动查看某个模型的逐期表现时按需生成，不进主回测的内存账本
 * （78 模型 × 数千期全量留存会吃掉几十 MB，而汇总数字一个都看不出来）。
 */
export interface PeriodDetail extends PeriodStep {
  /** 历史下标，用于与 draws 对齐 */
  index: number
  issue: string
  date: string
  kind: PlanKind
  bets: number
  dans: number[]
  tuos: number[]
  hit: TicketHit
}

/**
 * 解析每期的开奖日期，供依赖日期的模型使用。
 *
 * 离线数据包里有 1439 期（最早的一批）date 字段是空串。原先这类期会用
 * `new Date(Date.now())` 兜底 —— 等于把"你此刻几点跑的"混进了回测结果：
 * 同一套设置今天跑和明天跑数值不一样，回测因此**不可复现、也不可续算**。
 *
 * 改成"沿用上一期已知日期"，只依赖历史前缀本身，于是：
 *   · 同参数任何时刻重跑，结果完全一致；
 *   · 增量补算时第 i 期拿到的日期与全量重算时完全相同。
 * 极端情况（前 1439 期之前那段完全没有日期）退化为纪元起点，仍是确定的。
 */
export function resolveDrawDates(history: Draw[]): Date[] {
  const out: Date[] = []
  let last = 0
  for (let i = 0; i < history.length; i++) {
    const raw = history[i]?.date
    const t = raw ? Date.parse(raw) : NaN
    if (Number.isFinite(t)) last = t
    out.push(new Date(last))
  }
  return out
}

/** 累计量。增量补算时以它为底账续算，所以每个字段都必须可累加 */
export interface RunningTotals {
  trials: number
  totalCost: number
  totalPrize: number
  hits: Record<number, number>
  /** 最好的奖级（数字越小越好，0 表示还没中过） */
  bestLevel: number
}

export function emptyTotals(): RunningTotals {
  return { trials: 0, totalCost: 0, totalPrize: 0, hits: {}, bestLevel: 0 }
}

/**
 * 算某一期：喂 history[0..i) 给模型，对 history[i] 结算。
 * 返回 null 表示该期被跳过（模型抛错，或预算下无可行票面）。
 *
 * 注意：第 i 期的结果**只依赖 history[0..i)**。这正是不需要记住逐期明细
 * 就能做增量补算的原因——新开奖只影响它之后的期，不影响它之前的期。
 */
export function stepPeriod(
  model: Model,
  lottery: LotteryType,
  train: Draw[],
  target: Draw,
  nextDate: Date,
  budget: number,
  profile: Profile
): PeriodStep | null {
  const plan = pickPlan(model, lottery, train, nextDate, budget, profile)
  if (!plan) return null
  const { f, b } = bestHit(lottery, plan, target)
  const level = judgeLevel(lottery, f, b)
  return { cost: plan.cost, prize: prizeOf(lottery, level), level }
}

/** 奖级 -> 奖金。未中奖为 0 */
function prizeOf(lottery: LotteryType, level: number): number {
  return level ? FIXED_PRIZE[lottery][level] || 0 : 0
}

/**
 * 让模型出票：预测 -> 枚举预算内票型 -> 取最优。
 * 抽出来是为了让 stepPeriod 与 stepPeriodDetail 共用同一条决策链：
 * 明细里展示的号码必须与汇总数字来自同一次选票，否则「看到的」和「算出来的」会打架。
 */
function pickPlan(
  model: Model,
  lottery: LotteryType,
  train: Draw[],
  nextDate: Date,
  budget: number,
  profile: Profile
): TicketPlan | null {
  try {
    const pred = model.predict({ history: train, lottery, nextDate, profile })
    const plans = enumeratePlans(lottery, pred, budget)
    return recommend(plans, budget).best
  } catch {
    return null
  }
}

/**
 * 逐期明细版 stepPeriod。数值口径与 stepPeriod **逐位一致**（同一 predict、同一票型、
 * 同一奖级，两边只共用 pickPlan / bestHit），只是额外把号码摊开给 UI 看。
 * 这条一致性由 verify.mjs 第 10 节守着：明细逐期累加必须等于排行榜那一行的汇总。
 */
export function stepPeriodDetail(
  model: Model,
  lottery: LotteryType,
  train: Draw[],
  target: Draw,
  index: number,
  nextDate: Date,
  budget: number,
  profile: Profile
): PeriodDetail | null {
  const plan = pickPlan(model, lottery, train, nextDate, budget, profile)
  if (!plan) return null
  const hit = describeHit(lottery, plan, target)
  const level = judgeLevel(lottery, hit.f, hit.b)
  return {
    index,
    issue: target.issue,
    date: target.date || '',
    kind: plan.kind,
    bets: plan.bets,
    dans: plan.dans ? plan.dans.slice() : [],
    tuos: plan.tuos ? plan.tuos.slice() : [],
    cost: plan.cost,
    prize: prizeOf(lottery, level),
    level,
    hit,
  }
}

/** 只累加账本。逐期明细用它——明细只关心投入/奖金/奖级，不必每期分配一个净值元素 */
export function addTotals(t: RunningTotals, s: PeriodStep): void {
  t.trials++
  t.totalCost += s.cost
  t.totalPrize += s.prize
  if (s.level) {
    t.hits[s.level] = (t.hits[s.level] || 0) + 1
    if (!t.bestLevel || s.level < t.bestLevel) t.bestLevel = s.level
  }
}

/**
 * 累加账本，并往净值序列推一个点（累计净盈亏）。
 *
 * 净值序列本身**不再画曲线**（长期向下是数学必然，一张必亏的图没有信息量），
 * 但它必须留着：置换检验 `permutationTest` 要靠逐期净收益的差值分布来判断
 * 模型相对随机基线的领先是否显著。删掉曲线 ≠ 可以删掉这条序列。
 */
export function applyStep(t: RunningTotals, s: PeriodStep, equity: number[]): void {
  addTotals(t, s)
  equity.push(Math.round(t.totalPrize - t.totalCost))
}

/** 账本 + 净值序列 -> 排行榜的一行 */
export function toResult(
  meta: { id: string; name: string; category: string },
  t: RunningTotals,
  equity: number[]
): BacktestResult {
  const winTimes = Object.values(t.hits).reduce((a, b) => a + b, 0)
  return {
    modelId: meta.id,
    modelName: meta.name,
    category: meta.category,
    trials: t.trials,
    totalCost: t.totalCost,
    totalPrize: t.totalPrize,
    roi: t.totalCost ? (t.totalPrize - t.totalCost) / t.totalCost : 0,
    hits: t.hits,
    bestLevel: t.bestLevel,
    winRate: t.trials ? winTimes / t.trials : 0,
    equity,
  }
}

/** 单模型回测（同步版，脚本与单模型推演用） */
export function backtest(model: Model, opts: BacktestOptions): BacktestResult {
  const { lottery, history, periods, budget, profile } = opts
  const start = opts.startAt ?? Math.max(60, history.length - periods)
  const end = opts.endAt ?? history.length

  const dates = resolveDrawDates(history)
  const totals = emptyTotals()
  const equity: number[] = []
  for (let i = start; i < end; i++) {
    const s = stepPeriod(model, lottery, history.slice(0, i), history[i], dates[i], budget, profile)
    if (!s) continue
    applyStep(totals, s, equity)
  }
  return toResult(model.meta, totals, equity)
}

/**
 * 单模型逐期明细（同步版）。
 *
 * 汇总数字由 backtest() 负责，这里只回答「每一期具体买了什么、命中哪几个」。
 * 两者跑的是同一套选票逻辑，所以把明细里的 cost/prize/level 加起来必然等于汇总值——
 * 这条等式已写进 verify.mjs，防止以后有人只改一边。
 */
export function backtestDetail(
  model: Model,
  opts: BacktestOptions
): { rows: PeriodDetail[]; totals: RunningTotals } {
  const { lottery, history, periods, budget, profile } = opts
  const start = opts.startAt ?? Math.max(60, history.length - periods)
  const end = opts.endAt ?? history.length

  const dates = resolveDrawDates(history)
  const totals = emptyTotals()
  const rows: PeriodDetail[] = []
  for (let i = start; i < end; i++) {
    const s = stepPeriodDetail(
      model, lottery, history.slice(0, i), history[i], i, dates[i], budget, profile
    )
    if (!s) continue
    const step: PeriodStep = { cost: s.cost, prize: s.prize, level: s.level }
    addTotals(totals, step)
    rows.push(s)
  }
  return { rows, totals }
}

/**
 * 全模型排行榜（同步版）。**默认跑全部 78 个模型，没有开关。**
 *
 * 曾有过includeHeavy 开关让用户自己勾选重型模型，已按产品决策移除：
 * 排行榜的价值恰恰在于「连最会过拟合的那批都赢不了随机基线」这个结论成立，
 * 让人手动挑掉几个反例，等于把证伪的前提交给用户去破坏。
 * 重型模型很慢，但这正是 UI 要如实展示 ETA 与进度的理由，不是藏起来的理由。
 */
export function leaderboard(opts: BacktestOptions): BacktestResult[] {
  return ALL_MODELS.map((m) => backtest(m, opts)).sort((a, b) => b.roi - a.roi)
}

/**
 * 置换检验：某模型相对随机基线的领先是否显著。
 * 做法：把两者的每期净收益配对齐，随机翻转符号做 N 次置换，看观测差值落在哪。
 */
export function permutationTest(
  a: BacktestResult,
  b: BacktestResult,
  times = 2000
): number {
  const n = Math.min(a.equity.length, b.equity.length)
  if (n < 5) return 1
  const da: number[] = []
  for (let i = 1; i < n; i++) {
    da.push(
      (a.equity[i] - a.equity[i - 1]) - (b.equity[i] - b.equity[i - 1])
    )
  }
  const obs = Math.abs(da.reduce((x, y) => x + y, 0))
  const m = da.length
  const mean = da.reduce((x, y) => x + y, 0) / m
  const sd = Math.sqrt(da.reduce((s, x) => s + (x - mean) ** 2, 0) / m) || 1
  // 正态近似，避免 2000 次置换的开销
  const z = Math.abs(mean * m) / (sd * Math.sqrt(m))
  return Math.min(1, Math.exp(-0.717 * z - 0.416 * z * z))
}
