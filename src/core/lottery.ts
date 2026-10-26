import type { Draw, LotteryType } from '../types'

/** 组合数 C(n,k)。n 最大 35，普通浮点足够精确。 */
export function C(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return Math.round(r)
}

export interface Rule {
  name: string
  frontMax: number
  frontCount: number
  backMax: number
  backCount: number
  price: number
  /** 开奖星期：0=周日 */
  drawWeekdays: number[]
  /** 开奖时刻（24 小时制）。用来判断「今天这场开没开」 */
  drawTime: { h: number; m: number }
  levelNames: Record<number, string>
}

export const RULES: Record<LotteryType, Rule> = {
  ssq: {
    name: '双色球',
    frontMax: 33,
    frontCount: 6,
    backMax: 16,
    backCount: 1,
    price: 2,
    drawWeekdays: [2, 4, 0], // 周二、周四、周日
    drawTime: { h: 21, m: 15 },
    levelNames: {
      1: '一等奖', 2: '二等奖', 3: '三等奖',
      4: '四等奖', 5: '五等奖', 6: '六等奖',
    },
  },
  dlt: {
    name: '大乐透',
    frontMax: 35,
    frontCount: 5,
    backMax: 12,
    backCount: 2,
    price: 2,
    drawWeekdays: [1, 3, 6], // 周一、周三、周六
    drawTime: { h: 21, m: 25 },
    levelNames: {
      1: '一等奖', 2: '二等奖', 3: '三等奖', 4: '四等奖', 5: '五等奖',
      6: '六等奖', 7: '七等奖', 8: '八等奖', 9: '九等奖',
    },
  },
}

/** 固定奖金额。1、2 等为浮动奖，用历史均值估算，仅用于期望计算。 */
export const FIXED_PRIZE: Record<LotteryType, Record<number, number>> = {
  ssq: {
    1: 5_000_000, // 浮动奖估算值
    2: 200_000, // 浮动奖估算值
    3: 3000, 4: 200, 5: 10, 6: 5,
  },
  dlt: {
    1: 8_000_000, // 浮动奖估算值
    2: 300_000, // 浮动奖估算值
    3: 10000, 4: 3000, 5: 300, 6: 200, 7: 100, 8: 15, 9: 5,
  },
}

/** 判定奖级，0 表示未中奖 */
export function judgeLevel(
  lottery: LotteryType,
  frontHit: number,
  backHit: number
): number {
  if (lottery === 'ssq') {
    if (frontHit === 6 && backHit === 1) return 1
    if (frontHit === 6) return 2
    if (frontHit === 5 && backHit === 1) return 3
    if (frontHit === 5 || (frontHit === 4 && backHit === 1)) return 4
    if (frontHit === 4 || (frontHit === 3 && backHit === 1)) return 5
    if (backHit === 1 && frontHit <= 2) return 6
    return 0
  }
  // 大乐透
  if (frontHit === 5 && backHit === 2) return 1
  if (frontHit === 5 && backHit === 1) return 2
  if (frontHit === 5) return 3
  if (frontHit === 4 && backHit === 2) return 4
  if (frontHit === 4 && backHit === 1) return 5
  if (frontHit === 3 && backHit === 2) return 6
  if (frontHit === 4) return 7
  if (frontHit === 3 && backHit === 1) return 8
  if (frontHit === 2 && backHit === 2) return 8
  if (frontHit === 3) return 9
  if (backHit === 2) return 9
  if (frontHit === 2 && backHit === 1) return 9
  return 0
}

/** 计算某一注相对开奖结果的命中数 */
export function countHit(draw: Draw, front: number[], back: number[]) {
  const fh = front.filter((n) => draw.front.includes(n)).length
  const bh = back.filter((n) => draw.back.includes(n)).length
  return { frontHit: fh, backHit: bh }
}

/** 推算下一期开奖日期 */
export function nextDrawDate(lottery: LotteryType, from = new Date()): Date {
  const { drawWeekdays, drawTime } = RULES[lottery]
  for (let i = 0; i <= 7; i++) {
    const d = new Date(
      from.getFullYear(),
      from.getMonth(),
      from.getDate() + i,
      drawTime.h,
      drawTime.m,
      0,
      0
    )
    if (!drawWeekdays.includes(d.getDay())) continue
    // 今天是开奖日且还没到点 → 就是今晚；已经开过了才顺延到下一场
    if (d.getTime() <= from.getTime()) continue
    return d
  }
  // drawWeekdays 非空时，7 天内必定命中，下面的兜底只为满足类型推断
  const d = new Date(from.getTime() + 86400000)
  return d
}
