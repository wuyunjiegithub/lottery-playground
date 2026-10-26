export type LotteryType = 'ssq' | 'dlt'

export interface Draw {
  lottery: LotteryType
  issue: string
  date: string
  front: number[] // 双色球红球 / 大乐透前区
  back: number[] // 双色球蓝球 / 大乐透后区
  pool?: string | null
  sales?: string | null
  prizes?: Record<string, string>
  source?: string
}

/** 统一模型输出：号码概率分布。数学与玄学模型格式完全一致。 */
export interface Prediction {
  frontProbs: number[] // index i -> 号码 i+1
  backProbs: number[]
  narrative: string
  confidence: number
}

export type PlanKind = 'single' | 'complex' | 'dantuo'

export interface PlanMetrics {
  pWin: number // 至少中奖概率
  coverage: number // 覆盖号码数
  probMass: number // 票面覆盖的概率质量（按模型权重加权）
  variance: number // 奖金方差
  expected: number // 期望奖金
  levelProbs: Record<number, number> // 奖级 -> 概率
}

export interface TicketPlan {
  kind: PlanKind
  label: string
  frontNums: number[]
  backNums: number[]
  dans?: number[]
  tuos?: number[]
  bets: number
  cost: number
  formula: string
  metrics: PlanMetrics
}

export interface BetRecord {
  id: string
  lottery: LotteryType
  issue: string
  modelId: string
  label: string
  frontNums: number[]
  backNums: number[]
  /** 胆拖票的胆码 / 拖码。结算时必须用它还原「最佳单注命中」，
   *  否则会把拖码命中数直接当成总命中数，高估奖级。 */
  dans?: number[]
  tuos?: number[]
  cost: number
  createdAt: string
  settled: boolean
  hitLevel: number
  prize: number
}

export interface ModelMeta {
  id: string
  name: string
  category: 'math' | 'stat' | 'meta' | 'fun' | 'baseline'
  desc: string
  needsProfile?: boolean
  /** 计算昂贵（搜索类 / 神经网络类），回测时可跳过 */
  heavy?: boolean
}

export interface ModelStat {
  modelId: string
  roi: number
  hits: number
  trials: number
  bestLevel: number
}
