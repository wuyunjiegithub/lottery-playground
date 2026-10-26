/**
 * 回测耗时的估算模型。
 *
 * 为什么要单独一个文件：**预估公式必须只有一个版本。**
 * 之前公式写在 Backtest.vue 里，用户报「样本 1000，预估十几分钟，实际 81 分钟」，
 * 差 6 倍。两个原因：
 *
 *   1. **结构性错误**：拿训练集的**起点**长度去乘期数。但回测是从第 start 期
 *      一路跑到最新一期，训练集一期一期变长、成本跟着涨，正确做法是**逐期求和**。
 *      样本 1000 ⇒ 训练集从 1929 涨到 2929，用 1929 那个便宜的点去乘全程，必然低估。
 *   2. **系数是从短历史外推的**，而成本对训练长度明显非线性（见 probe:perf 的残差表）。
 *
 * 现在服务的还有第二个用途：**本机校准**。同样一幅牌，不同机器能差好几倍，
 * 再准的公式也估不出用户到底跑在哪台机器、有没有被后台标签页降频。
 * store 在每次实跑后记下「实测 ÷ 预估」，得到 factor 库起来，
 * 下次预估乘上它 —— 公式负责形状，实测负责绝对高度。
 *
 * 校准 `npm run probe:perf`（scripts/probe-perf-curve.mjs）。
 * 改了模型实现或回测引擎，系数就得重测。
 */

/**
 * 每期成本模型（毫秒/期），三个分量：
 *   fixed     —— 78 个模型各自 predict 一次的固有成本，与历史长度无关
 *   perTrain  —— 每多一期训练历史，全部模型要多花的时间
 *
 * 本机实测（`npm run probe:perf`，dlt 2929 期 / 78 模型，两次独立运行各点取中）：
 *   train= 300 → 406    train=1000 → 436    train=2000 → 517    train=2900 → 586
 *
 * 斜率**不要用单次测量**：两次跑出来的斜率是 0.060 / 0.078，差 30%，
 * 取一次就会在长训练段系统性偏高（旧值 0.1026 就是这样高估了 13%）。
 * 现在取两次的中位数，两端残差都在 ±3% 内。
 */
export const COST = { fixed: 385, perTrain: 0.069 }

/** 某一期的成本：第 t 期要吃 history[0..t) 这么长的训练历史 */
export function perPeriodMs(train: number): number {
  return COST.fixed + COST.perTrain * train
}

/**
 * 基准预估（毫秒）：结算区间 [startTrain, endTrain)，每期成本随训练长度上升。
 *
 * 用闭式不求 Σ Σ 的循环：Σ_{t=s}^{e-1} (a + b·t) = n·a + b·n·(s + e − 1) / 2
 * 期数动辄几千，循环也无所谓，但闭式在 computed 里更省心。
 *
 * @param startTrain 结算起点（训练长度，含）
 * @param endTrain   结算终点（不含），通常是历史总长度
 */
export function estRawMs(startTrain: number, endTrain: number): number {
  const n = endTrain - startTrain
  if (!Number.isFinite(n) || n <= 0) return 0
  return n * COST.fixed + (COST.perTrain * n * (startTrain + endTrain - 1)) / 2
}

/**
 * 校准后的预估。`factor` 来自本机历史实测（见 store 的 perf.calib），
 * 缺省 1 = 只信公式。
 *
 * factor 之所以要夹上限：后台标签页会被浏览器降频到 1/10 甚至更低，
 * 那种情况下的「实测」是环境噪声，不该把它当成机器本来的速度永久记住。
 */
export function estMs(startTrain: number, endTrain: number, factor = 1): number {
  return estRawMs(startTrain, endTrain) * factor
}

/**
 * 由实测耗时反推本机系数。
 *
 * 只看**实跑**的那一段：增量补算时 durationMs 只覆盖 upTo..total，
 * 对应的预估也必须是同一段，否则会把「补 2 期很快」误读成「机器很快」。
 */
export function solveFactor(actualMs: number, startTrain: number, endTrain: number): number | null {
  const base = estRawMs(startTrain, endTrain)
  if (!(base > 0) || !(actualMs > 0)) return null
  const f = actualMs / base
  if (!Number.isFinite(f) || f <= 0) return null
  // 0.25 ~ 8：低于 0.25 说明这段区间几乎没干活（比如缓存直出），纯噪声；
  // 高于 8 基本是后台降频或笔记本省电模式，不值得当常态记住。
  return Math.min(8, Math.max(0.25, f))
}

/** 校准结构的最小契约。store 里的 PerfCalib 多几个字段，这里只取用得到的 */
export interface CalibLike {
  factor: number
  samples: number
  periods: number
  updatedAt: number
}

/**
 * 旧观测权重的上限。
 * 用户换机器、或者开了省电/被降频之后，旧观测再重也不该把新观测压到看不见 ——
 * 封顶之后新观测至少能占到 `w / (MAX_WEIGHT + w)` 的份额，还改得动。
 */
export const MAX_WEIGHT = 4000

/**
 * 把一次新观测合并进累积校准（按**期数加权**的指数滑动平均）。
 *
 * 抽成纯函数是为了能单测：`npm run probe:perf` 第 2 节会验证
 * 「第一次实时观测就能把 factor 从 1 拉到 4.5」——
 * 这正是「参数区写 18 分钟、进度条说 80 分钟」那个矛盾的解药。
 *
 * @param countAsRun 是否算作「一次完整实跑」。回测**进行中**的实时观测会来几十次
 *   （每期一次），若都 +1，界面上就会写出「已按本机 59 次实跑校准」这种鬼话——
 *   用户明明只跑了一次。只有跑完那一次才计数。
 */
export function mergeCalib(
  cur: CalibLike,
  f: number,
  weight: number,
  now: number,
  countAsRun = true
): CalibLike {
  const w = Math.max(1, weight)
  const wOld = Math.min(cur.periods, MAX_WEIGHT)
  return {
    factor: (cur.factor * wOld + f * w) / (wOld + w),
    samples: cur.samples + (countAsRun ? 1 : 0),
    periods: cur.periods + w,
    updatedAt: now,
  }
}

/** 毫秒 -> 人类可读。分两级：不足 1 分只给秒，超过 1 小时给小时，避免「4823 秒」 */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return m >= 10 ? `${m} 分钟` : `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}
