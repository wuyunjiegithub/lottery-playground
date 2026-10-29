/**
 * 分片式回测执行器。
 *
 * 为什么需要它：全模型回测动辄几分钟（实测 2509 期 × 78 模型约 2.6 分钟），
 * 如果一口气跑完，主线程被占死，界面全程假死——按钮点不动、进度条不刷新，
 * 用户只能瞪着一个静止的「回测中…」等。
 *
 * 做法是**协作式分片**：把「模型 × 期」拆成极小的工作单元，每片最多占用主线程
 * SLICE_MS 毫秒，然后主动把控制权交还给事件循环。浏览器得以在这条缝隙里
 * 重绘进度条、处理点击。总耗时只增加个位数百分比的调度开销，换来全程可交互。
 *
 * 另一个副作用（被刻意利用）：切分后天然支持**取消**与**断点续算**——
 * 只要给出 base 账本，就能从任意历史下标接着往下算，这正是「新增开奖后
 * 只补算新几期」的实现基础。
 */
import {
  addTotals,
  applyStep,
  emptyTotals,
  isStopPrize,
  resolveDrawDates,
  stepPeriod,
  stepPeriodDetail,
  toResult,
  type BacktestResult,
  type PeriodDetail,
  type RunningTotals,
} from './backtest'
import type { Draw, LotteryType } from '../types'
import type { Model, Profile } from './models/types'

/**
 * 回测引擎版本。**任何会改变数值结果的改动都必须 +1。**
 *
 * 缓存里存的是"这个引擎算出来的数"。引擎一改，老缓存的数字就跟新算法对不上，
 * 而 runKey 只看 (彩种, 预算, 训练集)，根本察觉不到。所以把版本写进锚点，
 * 版本不符即视为无缓存、整体重算。
 *
 *   1  初版
 *   2  两个"不可复现"的根因被修掉：
 *        · 缺 date 的期次不再用 Date.now()，改成沿用上一期日期（resolveDrawDates）
 *        · 随机数统一由 Math.random 提供并按 (期, 模型) 定种（withUnitRandom）
 *      这两条都会让同一套设置的数字与 v1 不同，因此必须让旧缓存失效。
 *   3  「中二等奖及以上即收手」改为常算变体：SummaryRow 新增 trialsStop / totalCostStop /
 *      totalPrizeStop / roiStop / winRateStop / bestLevelStop / hitsStop 等列，旧缓存缺这些列，
 *      且 runKey 不再带 #S 维度，必须让旧缓存整体失效重算。
 *   4  收手变体真正落库（summary.stop_data）。v3 只把两套账本算在内存里，落库时丢掉了收手那一套，
 *      于是从缓存/服务端读回来的榜面一开收手开关全是 0 元。算法没有变，但 v3 写下的缓存里
 *      没有可用的收手数据，且无法从已有列反推，因此必须让旧缓存失效重算一次。
 */
export const ENGINE_VERSION = 4

/** 单模型在某个区间内的累计账本 */
export interface ModelAccum {
  modelId: string
  modelName: string
  category: string
  totals: RunningTotals
  equity: number[]
  /** 收手变体的累计账本（只算到第一次中二等奖及以上那期） */
  stopTotals: RunningTotals
  /** 是否触发「中二等奖及以上即收手」 */
  stopped: boolean
  /** 收手时所在期号（中奖那一期） */
  stopIssue: string | null
  /** 收手时的历史下标 */
  stopIndex: number | null
  /** 触发收手的奖级（1=一等奖，2=二等奖） */
  stopLevel: number | null
}

export interface RunProgress {
  /** 已完成的「模型 × 期」单元数 */
  done: number
  total: number
  /** 0~1 */
  ratio: number
  modelCount: number
  periodCount: number
  /** 已算完的期数 */
  periodsDone: number
  /** 正在算的模型（用于让用户看到"确实在动"） */
  currentModelId: string
  currentModelName: string
  elapsedMs: number
  /** 剩余毫秒。取样不足时为 0，UI 应显示「估算中…」 */
  etaMs: number
}

export class BacktestCancelled extends Error {
  constructor() {
    super('回测已取消')
    this.name = 'BacktestCancelled'
  }
}

export interface RunnerArgs {
  lottery: LotteryType
  history: Draw[]
  budget: number
  profile: Profile
  /** 参与回测的模型集合，顺序决定 base 账本的对应关系 */
  models: Model[]
  /** 结算起点（历史下标，含） */
  from: number
  /** 结算终点（历史下标，不含） */
  to: number
  /**
   * 续算底账：长度与顺序必须与 models 完全一致，
   * 代表 [start, from) 这段区间已经算出的累计量。不传则视为全新开跑。
   */
  base?: ModelAccum[]
  /**
   * 顺手把逐期明细一并产出（服务端用）。
   *
   * 开着它时主循环改用 stepPeriodDetail：predict 次数完全相同，
   * 只是多摊开一下号码，所以「回测 + 明细」只花一遍时间，
   * 不像事后重放那样把 78 个模型的 predict 再跑一次。
   *
   * 明细不留在内存里：每期立刻序列化成 JSON 片段攒着（约 50 MB 字符串），
   * 循环结束再通过 onModelDetails 交给调用方落库。
   */
  collectDetail?: boolean
}

/**
 * 每片**目标**占用主线程多久。24ms ≈ 一帧 16.7ms 的 1.4 倍：
 * 既能塞进足够多的工作单元，又保证浏览器每两片之间必有一次完整的渲染机会。
 *
 * 注意是「目标」而不是「上限」：一个工作单元 = 一个模型对一期做一次 predict，
 * **这个单元是原子的、切不开**（要切就得把模型内部的训练循环改成可中断的异步形式，
 * 那是另一个量级的改动，且会动到模型实现的正确性）。
 * 所以真实峰值 = 最慢那个模型的单次耗时。回测改成默认跑全部 78 个模型之后
 * （含重型），实测峰值从 52ms 涨到 **169ms**，全部来自 S36（MLP）单次 152ms。
 * 换句话说：卡顿的下界是模型本身太重，不是分片参数写错了。
 * 真要再降，只能去改那个模型的实现（降迭代轮数或拆训练），别来调这个常数。
 * 实测：npm run probe:slice:heavy
 */
const SLICE_MS = 24

const now = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

/**
 * 把控制权交还事件循环，让 UI 有机会重绘。
 * 优先用 scheduler.yield（Chrome 129+，能让出到队首，不会被长任务饿死），
 * 否则退回 setTimeout(0)。
 */
async function yieldToUI(): Promise<void> {
  const sched = (globalThis as any).scheduler
  if (sched && typeof sched.yield === 'function') {
    try {
      await sched.yield()
      return
    } catch {
      /* 退回 timer */
    }
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** mulberry32：32 位、单状态、够快够均匀的伪随机数发生器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 由「期序号 + 模型序号」定位的固定种子。与"前面算过多少"完全无关 */
function unitSeed(period: number, modelIndex: number): number {
  return ((Math.imul(period, 73856093) ^ Math.imul(modelIndex + 1, 19349663)) ^ 0x9e3779b9) >>> 0
}

/**
 * 在固定的伪随机序列里跑一个工作单元。
 *
 * 有模型用到 Math.random（加权抽样、K-Means 初始化、GA/PSO/神经网络初始化等）。
 * 直接放任它意味着两件事会同时出问题：
 *   1. **不可复现**：同一套设置重跑一次，排行榜的数字就变了。"规律校验"
 *      这种要看趋势的工具，结果每次都不一样等于没法用。
 *   2. **不可续算**：增量补算时该单元消耗的是"第几个随机数"取决于前面算过多少，
 *      于是补算出来的第 i 期必然和全量重算的第 i 期不同。
 *
 * 所以每个单元都用 `(期序号, 模型序号)` 派生出的固定种子。种子与执行顺序、
 * 与"从哪一期开始补算"都无关，上面两个问题一并消失。
 * 副作用是「同一模型在同一期」永远看到同一串随机数，跨设置做配对比较也更干净。
 */
function withUnitRandom<T>(period: number, modelIndex: number, fn: () => T): T {
  const original = Math.random
  Math.random = mulberry32(unitSeed(period, modelIndex))
  try {
    return fn()
  } finally {
    Math.random = original
  }
}

function cloneTotals(t: RunningTotals): RunningTotals {
  return {
    trials: t.trials,
    totalCost: t.totalCost,
    totalPrize: t.totalPrize,
    bestLevel: t.bestLevel,
    hits: { ...t.hits },
  }
}

export function makeAccums(models: Model[]): ModelAccum[] {
  return models.map((m) => ({
    modelId: m.meta.id,
    modelName: m.meta.name,
    category: m.meta.category,
    totals: emptyTotals(),
    equity: [],
    stopTotals: emptyTotals(),
    stopped: false,
    stopIssue: null,
    stopIndex: null,
    stopLevel: null,
  }))
}

/** 账本 -> 排行榜（按收益率降序） */
export function accumsToResults(accums: ModelAccum[]): BacktestResult[] {
  return accums
    .map((a) =>
      toResult(
        { id: a.modelId, name: a.modelName, category: a.category },
        a.totals,
        a.equity,
        a.stopTotals,
        { stopped: a.stopped, stopIssue: a.stopIssue, stopIndex: a.stopIndex, stopLevel: a.stopLevel }
      )
    )
    .sort((x, y) => y.roi - x.roi)
}

/** 估算总工作单元数，供 UI 在开跑前展示规模 */
export function countUnits(modelCount: number, from: number, to: number): number {
  return modelCount * Math.max(0, to - from)
}

/**
 * 分片执行全模型回测。
 *
 * 循环顺序刻意是「外层期、内层模型」：history.slice(0, i) 每期只切一次，
 * 而不是每个模型切一次（78 个模型就是 78 倍的无谓拷贝）。
 * 已验证 78 个模型都不修改传入的 history（grep 过 sort/reverse/push/splice），
 * 所以同一期的 train 数组可以安全共享给所有模型。
 */
export async function runLeaderboardAsync(
  args: RunnerArgs,
  hooks: {
    onProgress?: (p: RunProgress) => void
    shouldCancel?: () => boolean
    /** 收集明细时才会调用：rowsJson 是一整段可直接写库的 JSON 数组文本 */
    onModelDetails?: (modelId: string, rowsJson: string) => void
  } = {}
): Promise<ModelAccum[]> {
  const { models, history, lottery, budget, profile, from, to } = args
  const start = Math.max(0, from)
  const end = Math.min(history.length, to)

  const accums: ModelAccum[] =
    args.base && args.base.length === models.length
      ? args.base.map((b) => ({
          modelId: b.modelId,
          modelName: b.modelName,
          category: b.category,
          totals: cloneTotals(b.totals),
          equity: b.equity.slice(),
          stopTotals: cloneTotals(b.stopTotals),
          stopped: b.stopped,
          stopIssue: b.stopIssue,
          stopIndex: b.stopIndex,
          stopLevel: b.stopLevel,
        }))
      : makeAccums(models)

  const span = Math.max(0, end - start)
  const total = models.length * span
  let done = 0
  let rate = 0 // 单元/毫秒，指数滑动平均，用来算 ETA
  const t0 = now()
  let sliceStart = t0

  // 顺手收明细时，每期算完立刻序列化，避免 15 万个对象同时挂在堆上。
  // 段与段之间用逗号拼，最后包一层中括号即是一条完整的 JSON 数组。
  const collect = !!args.collectDetail
  const chunks: string[][] = collect ? models.map(() => []) : []

  const report = (mi: number) => {
    const el = now() - t0
    const inst = done / Math.max(1, el)
    rate = rate ? rate * 0.7 + inst * 0.3 : inst
    hooks.onProgress?.({
      done,
      total,
      ratio: total ? done / total : 1,
      modelCount: models.length,
      periodCount: span,
      periodsDone: Math.floor(done / Math.max(1, models.length)),
      currentModelId: models[mi]?.meta.id ?? '',
      currentModelName: models[mi]?.meta.name ?? '',
      elapsedMs: el,
      etaMs: rate > 0 ? Math.max(0, (total - done) / rate) : 0,
    })
  }

  const dates = resolveDrawDates(history)

  for (let i = start; i < end; i++) {
    const train = history.slice(0, i)
    const target = history[i]
    const nextDate = dates[i]
    for (let mi = 0; mi < models.length; mi++) {
      if (hooks.shouldCancel?.()) throw new BacktestCancelled()
      const s = withUnitRandom(i, mi, () =>
        collect
          ? stepPeriodDetail(models[mi], lottery, train, target, i, nextDate, budget, profile)
          : stepPeriod(models[mi], lottery, train, target, nextDate, budget, profile)
      )
      if (s) {
        applyStep(accums[mi].totals, s, accums[mi].equity)
        // 收手变体：常规版照常累加，收手版只在还没收手时累加，命中二等奖及以上即锁定。
        if (!accums[mi].stopped) {
          addTotals(accums[mi].stopTotals, s)
          if (isStopPrize(s.level)) {
            accums[mi].stopped = true
            accums[mi].stopIssue = target.issue
            accums[mi].stopIndex = i
            accums[mi].stopLevel = s.level
          }
        }
        if (collect) chunks[mi].push(JSON.stringify(s))
      }
      done++
      const t = now()
      if (t - sliceStart >= SLICE_MS) {
        report(mi)
        await yieldToUI()
        sliceStart = now()
      }
    }
  }

  // 明细攒完了，一次性交给调用方落库（顺序与 models 一致，模型下标不变）
  if (collect) {
    for (let mi = 0; mi < models.length; mi++) {
      hooks.onModelDetails?.(models[mi].meta.id, `[${chunks[mi].join(',')}]`)
      chunks[mi] = []
    }
  }

  hooks.onProgress?.({
    done: total,
    total,
    ratio: 1,
    modelCount: models.length,
    periodCount: span,
    periodsDone: span,
    currentModelId: '',
    currentModelName: '',
    elapsedMs: now() - t0,
    etaMs: 0,
  })
  return accums
}

export interface DetailRunArgs {
  lottery: LotteryType
  history: Draw[]
  budget: number
  profile: Profile
  model: Model
  /**
   * 该模型在**当次排行榜所用模型数组**里的下标。
   *
   * 必须传，且必须是同一个值：随机种子由 (期序号, 模型序号) 派生，
   * 序号一变，重算出的号码就跟排行榜里那次不是同一注，明细就成了假数据。
   */
  modelIndex: number
  from: number
  to: number
}

export interface DetailRunProgress {
  done: number
  total: number
  ratio: number
}

/**
 * 逐期明细的分片执行器（单模型）。
 *
 * 为什么不把明细一起塞进 runLeaderboardAsync：78 模型 × 数千期 × 每期几十个号码，
 * 内存直接上 GB，而且用户一次只会看一个模型。改成**按需单模型重算**后：
 *   · 峰值内存只有一期数据 + 结果行数组；
 *   · 种子与主回测同源，重算出的号码与排行榜数字天然对得上；
 *   · 顺带天然支持「换个模型看看」，不需要为每个模型都留一份。
 */
export async function runDetailAsync(
  args: DetailRunArgs,
  hooks: {
    onProgress?: (p: DetailRunProgress) => void
    shouldCancel?: () => boolean
  } = {}
): Promise<PeriodDetail[]> {
  const { model, history, lottery, budget, profile, from, to, modelIndex } = args
  const start = Math.max(0, from)
  const end = Math.min(history.length, to)
  const dates = resolveDrawDates(history)
  const span = Math.max(0, end - start)
  const rows: PeriodDetail[] = []

  let done = 0
  const t0 = now()
  let sliceStart = t0

  for (let i = start; i < end; i++) {
    if (hooks.shouldCancel?.()) throw new BacktestCancelled()
    const s = withUnitRandom(i, modelIndex, () =>
      stepPeriodDetail(
        model, lottery, history.slice(0, i), history[i], i, dates[i], budget, profile
      )
    )
    if (s) rows.push(s)
    done++
    const t = now()
    if (t - sliceStart >= SLICE_MS) {
      hooks.onProgress?.({
        done,
        total: span,
        ratio: span ? done / span : 1,
      })
      await yieldToUI()
      sliceStart = now()
    }
  }
  hooks.onProgress?.({ done: span, total: span, ratio: 1 })
  return rows
}
