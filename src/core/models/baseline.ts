import type { Prediction } from '../../types'
import { RULES } from '../lottery'
import { normalize, rndInt, type Model, type ModelCtx } from './types'

const M = (id: string, name: string, desc: string, predict: (c: ModelCtx) => Prediction): Model => ({
  meta: { id, name, category: 'baseline', desc },
  predict,
})

function boost(size: number, nums: number[], weight = 1000): number[] {
  const arr = new Array(size).fill(1)
  for (const n of nums) if (n >= 1 && n <= size) arr[n - 1] = weight
  return normalize(arr)
}

/** B01 真随机均匀：科学的黄金基线，所有模型的照妖镜 */
export const B01 = M(
  'B01', '真随机均匀',
  '密码学安全随机数。所有模型的黄金基线——排行榜上它才是主角。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const rnd = (n: number) =>
      Array.from({ length: n }, () => 0.5 + Math.random())
    return {
      frontProbs: normalize(rnd(F)),
      backProbs: normalize(rnd(B)),
      narrative: '纯随机器。如果其他模型长期打不过它，那它们就没有价值。',
      confidence: 0,
    }
  }
)

/** B02 恒定号码：反直觉对照 */
export const B02 = M(
  'B02', '恒定号码',
  '每期固定最小的一组号码。检验「坚持」是否有意义。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B, frontCount, backCount } = RULES[lottery]
    const fixed = Array.from({ length: frontCount }, (_, i) => i + 1)
    const fixedBack = Array.from({ length: backCount }, (_, i) => i + 1)
    return {
      frontProbs: boost(F, fixed),
      backProbs: boost(B, fixedBack),
      narrative: `每期固定 ${fixed.join(' ')} + ${fixedBack.join(' ')}，永不变动。`,
      confidence: 0,
    }
  }
)

/** B03 机选模拟 */
export const B03 = M(
  'B03', '机选模拟',
  '模拟彩票投注机随机选号，与人工选号对照。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B, frontCount, backCount } = RULES[lottery]
    const pick = (max: number, cnt: number) => {
      const s = new Set<number>()
      while (s.size < cnt) s.add(rndInt(max) + 1)
      return [...s]
    }
    const f = pick(F, frontCount)
    const b = pick(B, backCount)
    return {
      frontProbs: boost(F, f),
      backProbs: boost(B, b),
      narrative: `机选一注：${f.sort((x, y) => x - y).join(' ')} + ${b.sort((x, y) => x - y).join(' ')}。`,
      confidence: 0,
    }
  }
)

export const BASELINE_MODELS: Model[] = [B01, B02, B03]
