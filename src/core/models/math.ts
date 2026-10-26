import type { Draw, LotteryType, Prediction } from '../../types'
import { RULES } from '../lottery'
import { normalize, freq, omission, rndInt, type Model, type ModelCtx } from './types'

const M = (id: string, name: string, desc: string, predict: (c: ModelCtx) => Prediction, cat: 'math' | 'stat' = 'math'): Model => ({
  meta: { id, name, category: cat, desc },
  predict,
})

function sizes(lottery: LotteryType) {
  const r = RULES[lottery]
  return { F: r.frontMax, B: r.backMax }
}

/** S01 频率·热号追踪 */
export const S01 = M(
  'S01',
  '频率 · 热号追踪',
  '统计历史总频次，取出现次数最多的号码。最经典也最徒劳。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    return {
      frontProbs: normalize(freq(history, F)),
      backProbs: normalize(freq(history, B, 'back')),
      narrative: `按全量 ${history.length} 期频次排序，取出现次数最多的号码。`,
      confidence: 0.82,
    }
  }, 'stat'
)

/** S02 频率·冷号回补 */
export const S02 = M(
  'S02',
  '频率 · 冷号回补',
  '反向操作，专挑长期未出的号码。赌徒谬误的教科书案例。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    const inv = (a: number[]) => a.map((x) => 1 / (1 + x))
    return {
      frontProbs: normalize(inv(freq(history, F))),
      backProbs: normalize(inv(freq(history, B, 'back'))),
      narrative: '赌徒谬误：认为冷号「该出了」。统计上并不成立。',
      confidence: 0.5,
    }
  }, 'stat'
)

/** S03 遗漏值回归 */
export const S03 = M(
  'S03',
  '遗漏值回归',
  '计算每个号码的当前遗漏期数，取远超理论均值者。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    return {
      frontProbs: normalize(omission(history, F)),
      backProbs: normalize(omission(history, B, 'back')),
      narrative: '遗漏越久权重越高。遗漏值本身不含预测信息，仅作娱乐。',
      confidence: 0.55,
    }
  }, 'stat'
)

/** M01 马尔可夫链·一阶转移 */
export const M01 = M(
  'M01',
  '马尔可夫链 · 一阶转移',
  '把号码建模为「出现/未出现」两状态，估计一阶转移矩阵后按当前状态外推。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    const trans = (field: 'front' | 'back', size: number) => {
      const base = RULES[lottery].frontCount / size
      const last = history[history.length - 1]
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const x = i + 1
          let c1 = 0, t1 = 0, c0 = 0, t0 = 0
          for (let i2 = 1; i2 < history.length; i2++) {
            const prev = history[i2 - 1][field].includes(x)
            const cur = history[i2][field].includes(x)
            if (prev) { t1++; if (cur) c1++ } else { t0++; if (cur) c0++ }
          }
          const p1 = t1 ? c1 / t1 : base
          const p0 = t0 ? c0 / t0 : base
          return last[field].includes(x) ? p1 : p0
        })
      )
    }
    const f = trans('front', F)
    const top = f
      .map((p, i) => ({ n: i + 1, p }))
      .sort((a, b) => b.p - a.p)
      .slice(0, 2)
      .map((x) => x.n)
    return {
      frontProbs: f,
      backProbs: trans('back', B),
      narrative: `马尔可夫说：${top.join(' 与 ')} 在转移矩阵中当前分支概率高于均值，故纳入。`,
      confidence: 0.7,
    }
  }
)

/** M02 贝叶斯 · 狄利克雷共轭（拉普拉斯平滑） */
export const M02 = M(
  'M02',
  '贝叶斯 · 狄利克雷共轭',
  '多项分布配狄利克雷先验，后验均值 = (count + α) / (N + M·α)。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    const post = (field: 'front' | 'back', size: number, alpha: number) => {
      const c = freq(history, size, field)
      const total = c.reduce((a, b) => a + b, 0)
      return normalize(c.map((x) => (x + alpha) / (total + size * alpha)))
    }
    return {
      frontProbs: post('front', F, 5),
      backProbs: post('back', B, 3),
      narrative: '在热号与均匀之间取平滑折中，先验越强越接近均匀分布。',
      confidence: 0.6,
    }
  }
)

/** M03 和值中心回归 */
export const M03 = M(
  'M03',
  '和值中心回归',
  '用历史和值的均值反推每个号码的「合理大小」，偏离越大权重越低。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    const cnt = RULES[lottery].frontCount
    const sums = history.map((d) => d.front.reduce((a, b) => a + b, 0))
    const avg = sums.reduce((a, b) => a + b, 0) / Math.max(1, sums.length)
    const target = avg / cnt
    const w = (size: number) =>
      normalize(Array.from({ length: size }, (_, i) => 1 / (1 + Math.abs(i + 1 - target))))
    return {
      frontProbs: w(F),
      backProbs: w(B),
      narrative: `历史和值均值 ${avg.toFixed(1)}，平均每号 ${target.toFixed(1)}，围绕该值加权。`,
      confidence: 0.58,
    }
  }
)

/** S04 奇偶 / 大小比 */
export const S04 = M(
  'S04',
  '奇偶 · 大小比匹配',
  '统计历史奇偶与大小号占比，按最频比例给号码加权。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    let odd = 0, big = 0, total = 0
    for (const d of history) {
      for (const x of d.front) {
        total++
        if (x % 2 === 1) odd++
        if (x > F / 2) big++
      }
    }
    const pOdd = total ? odd / total : 0.5
    const pBig = total ? big / total : 0.5
    return {
      frontProbs: normalize(
        Array.from({ length: F }, (_, i) => {
          const x = i + 1
          return (x % 2 === 1 ? pOdd : 1 - pOdd) * (x > F / 2 ? pBig : 1 - pBig)
        })
      ),
      backProbs: normalize(freq(history, B, 'back')),
      narrative: `历史奇数占比 ${(pOdd * 100).toFixed(1)}%，大号占比 ${(pBig * 100).toFixed(1)}%。`,
      confidence: 0.55,
    }
  }, 'stat'
)

/** S05 KNN 历史形态匹配（近 30 期局部热号） */
export const S05 = M(
  'S05',
  'KNN 局部形态匹配',
  '只取最近 30 期做频次统计，捕捉短期「形态」而非全量规律。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    return {
      frontProbs: normalize(freq(history, F, 'front', 30)),
      backProbs: normalize(freq(history, B, 'back', 30)),
      narrative: '只看最近 30 期。窗口越短噪声越大，这是它的全部「智能」所在。',
      confidence: 0.65,
    }
  }, 'stat'
)

/** M04 蒙特卡洛模拟 */
export const M04 = M(
  'M04',
  '蒙特卡洛模拟',
  '按历史频次做多项分布抽样，统计出现最多的号码。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    const sample = (field: 'front' | 'back', size: number, times: number) => {
      const w = freq(history, size, field)
      const total = w.reduce((a, b) => a + b, 0)
      const acc = new Array(size).fill(0)
      const cum: number[] = []
      let s = 0
      for (const x of w) { s += x; cum.push(s) }
      const cnt = RULES[lottery][field === 'front' ? 'frontCount' : 'backCount']
      for (let t = 0; t < times; t++) {
        const picked = new Set<number>()
        while (picked.size < cnt) {
          const r = Math.random() * (total || 1)
          let idx = cum.findIndex((c) => r <= c)
          if (idx < 0) idx = size - 1
          picked.add(idx)
        }
        for (const i of picked) acc[i]++
      }
      return normalize(acc)
    }
    return {
      frontProbs: sample('front', F, 2000),
      backProbs: sample('back', B, 2000),
      narrative: '抽样 2000 次。抽样只复现已知分布，不产生新信息。',
      confidence: 0.6,
    }
  }
)

/** S06 反向指标 */
export const S06 = M(
  'S06',
  '反向指标 Contrarian',
  '专挑历史表现最差的号码。若规律不存在，反向同样不存在。',
  ({ history, lottery }) => {
    const { F, B } = sizes(lottery)
    const sq = (a: number[]) => a.map((x) => 1 / (1 + x * x))
    return {
      frontProbs: normalize(sq(freq(history, F))),
      backProbs: normalize(sq(freq(history, B, 'back'))),
      narrative: '如果热号没用，冷号也不会有用——这个模型就是来证明这件事的。',
      confidence: 0.45,
    }
  }, 'stat'
)

export const MATH_MODELS: Model[] = [S01, S02, S03, M01, M02, M03, S04, S05, M04, S06]
