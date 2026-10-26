import type { Draw, LotteryType, Prediction, ModelMeta } from '../../types'

/** 玄学档案：仅在本地内存参与计算，永不上送 */
export interface Profile {
  birthDate?: string // YYYY-MM-DD
  gender?: 'm' | 'f'
  name?: string
  dreamNumbers?: number[]
}

export interface ModelCtx {
  history: Draw[]
  lottery: LotteryType
  /** 下一期预计开奖日期，供日期驱动的玄学模型起局 */
  nextDate: Date
  profile: Profile
}

export interface Model {
  meta: ModelMeta
  predict(ctx: ModelCtx): Prediction
  /** 计算昂贵，回测时可跳过以保证速度 */
  heavy?: boolean
}

// ---------------------------------------------------------------- 通用工具

export function normalize(arr: number[]): number[] {
  const s = arr.reduce((a, b) => a + b, 0)
  if (s <= 0) return arr.map(() => 1 / arr.length)
  return arr.map((x) => x / s)
}

/** 统计号码出现频次 */
export function freq(history: Draw[], size: number, field: 'front' | 'back' = 'front', recent = 0): number[] {
  const arr = new Array(size).fill(0)
  const src = recent > 0 ? history.slice(-recent) : history
  for (const d of src) for (const x of d[field]) if (x >= 1 && x <= size) arr[x - 1]++
  return arr
}

/** 当前遗漏期数：距上次出现的间隔 */
export function omission(history: Draw[], size: number, field: 'front' | 'back' = 'front'): number[] {
  const arr = new Array(size).fill(history.length)
  for (let x = 1; x <= size; x++) {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i][field].includes(x)) {
        arr[x - 1] = history.length - 1 - i
        break
      }
    }
  }
  return arr
}

/**
 * 模型内取随机整数。**刻意只走 Math.random，不用 crypto.getRandomValues。**
 *
 * crypto 的随机数无法定种，一旦用它：同一套设置重跑一次回测，排行榜数字就变；
 * 增量补算时"第 i 期的结果"也会跟全量重算对不上（见 backtestRunner 的 withUnitRandom）。
 * 回测要的是**可复现的实验**，而这些模型（机选、抽签、塔罗、GA 初始种群…）本来就只是
 * 娱乐与证伪用，不涉及任何安全场景，因此这里不需要密码学强度的随机源。
 * 统一收口到 Math.random，就能被回测执行器整体定种。
 */
function rndInt(n: number): number {
  return Math.floor(Math.random() * n)
}

export { rndInt }
