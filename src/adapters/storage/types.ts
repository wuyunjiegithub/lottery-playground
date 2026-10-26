/**
 * 存储层的统一契约（三端共用）。
 *
 * 设计原则对齐设计文档 5.3：业务层只认这个接口，不关心底下是 SQLite 还是 IndexedDB。
 *
 * 分工（2026-10-06 与用户确认）：
 *   - SQLite 装【原始事实】开奖历史 + 【派生产物】回测汇总，合计约 2.6 MB
 *   - 回测逐期明细（20 万条 / 21.5 MB）默认不落盘，通过导出走文件
 *
 * 之所以不让明细进库：它是完全可再生的——改预算重跑一遍就有；
 * 而开奖数据丢了要重新爬，两者不该享受同一级别的持久化待遇。
 */
import type { Draw, LotteryType } from '../../types'

/** 回测批次元信息。runKey 唯一标识一次「设置组合」下的全模型回测。 */
export interface RunMeta {
  runKey: string
  lottery: LotteryType
  /** 每期预算上限（元）。票面金额离散，实际花费可能略低 */
  budget: number
  /** 训练集期数：前 sample 期只喂给模型，不参与结算 */
  sample: number
  /** 回测窗口期数 */
  periods: number
  modelCount: number
  createdAt: number
}

/** 回测汇总：每模型一行 + 净值序列。这是「规律校验」最常 Query 的东西。 */
export interface SummaryRow {
  runKey: string
  modelId: string
  modelName: string
  category: string
  trials: number
  totalCost: number
  totalPrize: number
  roi: number
  winRate: number
  bestLevel: number
  /** 奖级 -> 命中次数 */
  hits: Record<number, number>
  /**
   * 逐期累计净盈亏。UI 不再画曲线，但置换检验依赖它做逐期差值配对，
   * 所以落库时必须保留（它也是「增量补算 vs 全量重算逐位一致」的校验对象）。
   */
  equity: number[]
}

export interface UserState {
  profile: {
    birthDate?: string
    gender?: 'm' | 'f'
    name?: string
    dreamNumbers?: number[]
  }
  /** @deprecated 系统不再记录用户投注操作，仅保留字段以便旧数据兼容 */
  bets?: unknown[]
  budget: number
  favorites: string[]
}

export type StorageKind = 'sqlite' | 'idb' | 'memory'

export interface StorageAdapter {
  readonly kind: StorageKind

  // ------------------------------------------------------------ 开奖历史
  /** 取某个彩种的全部历史，按期号升序 */
  getDraws(lottery: LotteryType): Promise<Draw[]>
  /** 落库并按主键去重，返回真正新增的期数 */
  upsertDraws(draws: Draw[]): Promise<number>
  countDraws(lottery: LotteryType): Promise<number>

  // ------------------------------------------------------------ 回测批次
  putRun(meta: RunMeta): Promise<void>
  getRun(runKey: string): Promise<RunMeta | null>
  listRuns(lottery?: LotteryType): Promise<RunMeta[]>
  deleteRun(runKey: string): Promise<void>

  // ------------------------------------------------------------ 回测汇总
  putSummary(rows: SummaryRow[]): Promise<void>
  getSummary(runKey: string): Promise<SummaryRow[]>

  // ------------------------------------------------------------ 用户数据
  getUserState(): Promise<UserState>
  putUserState(state: UserState): Promise<void>

  // ------------------------------------------------------------ 通用键值
  /**
   * 存回测的「锚点」等零散元信息。
   *
   * 为什么不塞进 RunMeta：SQLite 端加字段要改 CREATE TABLE 并对老库做 ALTER，
   * 而 kv 表本来就在（用户状态也走它），复用它零迁移成本、五端实现都只有两行。
   */
  getKV<T = unknown>(k: string): Promise<T | null>
  putKV<T = unknown>(k: string, v: T): Promise<void>

  /** 清空全部本地数据（设置页的「清空」按钮） */
  clearAll(): Promise<void>
}

/**
 * 回测锚点：记录「这次回测到底覆盖了哪一段历史」。
 *
 * 有了它才能安全地做增量补算——新增开奖后，只算 upTo 之后的新期，
 * 结果与重跑全量**严格一致**（第 i 期只依赖 history[0..i)）。
 *
 * anchorIssue / upToIssue 是防篡改校验：如果有人回填或改写了老的开奖数据，
 * 前序就变了，此时增量结果不可信，必须整体重算。
 */
export interface RunAnchor {
  runKey: string
  /** 产出这份账本的回测引擎版本。与当前引擎不符即作废（见 backtestRunner.ENGINE_VERSION） */
  engine: number
  /** 结算起点（历史下标，含） */
  start: number
  /** 已结算到的历史长度（不含），即"缓存覆盖到第 upTo 期" */
  upTo: number
  /** history[start - 1] 的期号，用于校验训练段没变 */
  anchorIssue: string
  /** history[upTo - 1] 的期号，用于校验已结算段没变 */
  upToIssue: string
  /**
   * 模型数。**模型集合变了就不能沿用旧账本**。
   *
   * 原先这里还有个 includeHeavy 布尔（区分 64 轻量 / 78 全量），
   * 现已按产品决策移除勾选、恒定跑全部 78 个，字段随之删除。
   * 老库里残留的 includeHeavy 会被 JSON 解析成无人读取的多余属性，无害；
   * 而老锚点（modelCount = 64）会被下面这条 modelCount 校验拦下、整体重算，
   * 所以删字段不会让「64 个模型的旧结果」被当成 78 个的结果继续用。
   */
  modelCount: number
  updatedAt: number
}

/** 「上次回测」摘要，开机自动恢复榜面用 */
export interface LastBoard {
  runKey: string
  lottery: LotteryType
  budget: number
  sample: number
  periods: number
  /** 已结算到的历史长度（不含）。用于算「距上次回测又新增了几期」 */
  upTo: number
  /** 模型数。恒为全部 78 个；仍要存，因为老库里存在 64 模型的旧记录，需据此拒收 */
  modelCount: number
  createdAt: number
  /**
   * 本次回测实跑耗时（毫秒）。
   * 存它而不是做公式估算：实测耗时对训练长度极不线性
   * （训练 1000~1500 期约 54ms/期，3429 期骤增到 405ms/期），
   * 任何简单公式都会在某个区间低估好几倍。报「上次真跑了多久」永远不会骗人。
   */
  durationMs?: number
}

export const KV_RUN_ANCHOR = (runKey: string) => `run_anchor:${runKey}`
export const KV_LAST_BOARD = 'last_board'

/**
 * 本机性能校准。存预估耗时与实际耗时的比值，让下一次预估能对得上这台机器的真实速度。
 *
 * 为什么必须校正：Machine A 上 18 分钟的活，换台机器能用 81 分钟，而写死的公式
 * 只能给出研发机上的数字。公式负责形状（成本怎么随训练长度涨），factor 负责高度。
 */
export interface PerfCalib {
  /** 实测 ÷ 基准预估。1 表示与撰公式时那台机器同速 */
  factor: number
  /** 已经攒了几次实跑。一次都没攒过时 UI 要说清楚「这是粗估」 */
  samples: number
  /**
   * 累计观测过的期数，当作加权权重。
   * 全量跑 1929 期的观测量远大于「补 2 期」，两者的可信度不该相同。
   */
  periods: number
  updatedAt: number
}

export const KV_PERF = 'perf_calib'

/**
 * 回测结果的缓存键。
 *
 * 预算会改变票型（见 ticket.ts 的 recommend），进而改变中奖与成本，
 * 所以它必须进 key——否则用户把预算从 30 改成 50，读到的还是旧结果。
 */
export function makeRunKey(o: {
  lottery: LotteryType
  budget: number
  sample: number
}): string {
  return `${o.lottery}-${o.budget}-${o.sample}`
}

export type RunKeyParts = Pick<RunMeta, 'lottery' | 'budget' | 'sample'>

export function parseRunKey(key: string): RunKeyParts | null {
  const m = /^(\w+)-(\d+)-(\d+)$/.exec(key)
  if (!m) return null
  return {
    lottery: m[1] as LotteryType,
    budget: Number(m[2]),
    sample: Number(m[3]),
  }
}

export const DEFAULT_USER_STATE: UserState = {
  profile: {},
  bets: [],
  budget: 30,
  favorites: [],
}
