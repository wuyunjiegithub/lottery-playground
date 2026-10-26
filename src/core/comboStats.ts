import type { Draw } from '../types'

/** 组合档位：单个号码 / 两两 / 三三 */
export type ComboLevel = 'single' | 'pair' | 'triple'

/** 从已升序排列的数组里取全部 k 元组合（输出天然升序） */
export function kCombos(arr: number[], k: number): number[][] {
  const res: number[][] = []
  const cur: number[] = []
  const walk = (start: number) => {
    if (cur.length === k) {
      res.push(cur.slice())
      return
    }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i])
      walk(i + 1)
      cur.pop()
    }
  }
  walk(0)
  return res
}

/** 档位对应的元数 */
export function comboArity(level: ComboLevel): number {
  return level === 'single' ? 1 : level === 'pair' ? 2 : 3
}

/** 一次出现记录：距上次出现的期数 + 上次出现的期号 */
export interface LastSeen {
  /** 距上次出现的间隔期数；0 = 上一期刚出 */
  omission: number
  /** 上次出现的期号；全历史从未出现时为 '' */
  issue: string
}

export const NEVER: LastSeen = { omission: -1, issue: '' }

/**
 * 统计每个号码 / 组合在**完整历史**里的「上次出现」位置。
 *
 * 刻意不按筛选区间算：遗漏回答的是「距上一次开出过了几期」，属于当前状态的量。
 * 若按筛选区间算，筛成「近 30 期」会把所有组合的遗漏截断在 30 以内，统计量失去意义；
 * 而次数 / 占比按筛选区间统计才有意义。两者口径不同是有意为之。
 *
 * 遍历从最新一期往回走，**首次**命中即写入，因此留下的必然是最近一次出现。
 *
 * @param size 该区号码池上界（ssq 前区 33 / 后区 16，dlt 前区 35 / 后区 12）
 */
export function lastSeen(
  history: Draw[],
  field: 'front' | 'back',
  level: ComboLevel,
  size: number
): Map<string, LastSeen> {
  const m = new Map<string, LastSeen>()
  const n = history.length
  const k = comboArity(level)
  // 从最新一期往回走，**首次**命中才写入 —— 必须判 has，
  // 否则旧记录会把新记录覆盖掉，留下的变成「最早一次出现」，遗漏值整体倒挂成历史长度。
  const put = (key: string, i: number) => {
    if (!m.has(key)) m.set(key, { omission: n - 1 - i, issue: history[i].issue })
  }

  if (level === 'single') {
    for (let x = 1; x <= size; x++) {
      for (let i = n - 1; i >= 0; i--) {
        if (history[i][field].includes(x)) {
          put(String(x), i)
          break
        }
      }
    }
    return m
  }

  for (let i = n - 1; i >= 0; i--) {
    const a = [...history[i][field]].sort((x, y) => x - y)
    if (a.length < k) continue
    for (const c of kCombos(a, k)) put(c.join('-'), i)
  }
  return m
}

/**
 * 统计筛选区间内每个号码 / 组合的共同出现次数。
 *
 * `level === 'single'` 时返回长度为 `size` 的数组（index i -> 号码 i+1），
 * 与 `models/types.ts` 的 `freq()` 口径一致 —— 号码池里没出现过的号码也会给出 0。
 * 多号档位只返回区间内真实出现过的组合（没出现过的组合不在表里）。
 */
export function comboCounts(
  draws: Draw[],
  field: 'front' | 'back',
  level: ComboLevel,
  size: number
): Map<string, number> {
  const m = new Map<string, number>()
  if (level === 'single') {
    for (let x = 1; x <= size; x++) m.set(String(x), 0)
    for (const d of draws) for (const x of d[field]) if (x >= 1 && x <= size) m.set(String(x), (m.get(String(x)) || 0) + 1)
    return m
  }
  const k = comboArity(level)
  for (const d of draws) {
    const a = [...d[field]].sort((x, y) => x - y)
    if (a.length < k) continue
    for (const c of kCombos(a, k)) {
      const key = c.join('-')
      m.set(key, (m.get(key) || 0) + 1)
    }
  }
  return m
}
