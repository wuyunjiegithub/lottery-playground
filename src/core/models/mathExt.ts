import type { Draw, LotteryType, Prediction } from '../../types'
import { RULES } from '../lottery'
import { normalize, freq, omission, rndInt, type Model, type ModelCtx } from './types'

const M = (
  id: string, name: string, desc: string,
  predict: (c: ModelCtx) => Prediction, cat: 'math' | 'stat' = 'math'
): Model => ({ meta: { id, name, category: cat, desc }, predict })

const RECENT = 300 // 序列类模型只看最近若干期，控制计算量

/** 取最近 n 期 */
function recent(history: Draw[], n = RECENT): Draw[] {
  return history.length > n ? history.slice(-n) : history
}

/** 出现指示矩阵：[期][号码] = 0/1 */
function presence(history: Draw[], size: number, field: 'front' | 'back' = 'front'): number[][] {
  return history.map((d) => {
    const row = new Array(size).fill(0)
    for (const x of d[field]) if (x >= 1 && x <= size) row[x - 1] = 1
    return row
  })
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
const std = (a: number[]) => {
  const m = mean(a)
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)))
}

// ---------------------------------------------------------------- S07 均值回归
export const S07 = M(
  'S07', '均值回归 MA',
  '计算每个号码出现间隔的移动平均，当前遗漏远超平均间隔者权重更高。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const om = omission(history, size, field)
      const f = freq(history, size, field)
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const avgGap = f[i] > 0 ? history.length / f[i] : history.length
          return 1 / (1 + Math.abs(om[i] - avgGap) / Math.max(1, avgGap))
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '当前遗漏与平均间隔的偏离度越低，越「该回归」。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S08 指数平滑 EWMA
export const S08 = M(
  'S08', '指数平滑 EWMA',
  '对每个号码的出现序列做指数加权移动平均（α=0.25），用平滑值外推。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const alpha = 0.25
    const calc = (size: number, field: 'front' | 'back') => {
      const m = presence(recent(history), size, field)
      const ew = new Array(size).fill(0)
      for (const row of m) for (let i = 0; i < size; i++) ew[i] = alpha * row[i] + (1 - alpha) * ew[i]
      return normalize(ew.map((x) => x + 1e-6))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'EWMA 让近期出现占据更高权重，α=0.25。', confidence: 0.55,
    }
  }
)

// ---------------------------------------------------------------- M05 马尔可夫二阶
export const M05 = M(
  'M05', '马尔可夫链 · 二阶',
  '状态取前两期是否出现（4 种组合），估计二阶转移概率。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const hs = recent(history)
      const m = presence(hs, size, field)
      const base = RULES[lottery].frontCount / size
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const cnt = [0, 0, 0, 0], hit = [0, 0, 0, 0]
          for (let t = 2; t < m.length; t++) {
            const s = (m[t - 2][i] << 1) | m[t - 1][i]
            cnt[s]++
            if (m[t][i]) hit[s]++
          }
          const last = (m[m.length - 2]?.[i] ?? 0) << 1 | (m[m.length - 1]?.[i] ?? 0)
          return cnt[last] ? hit[last] / cnt[last] : base
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '二阶马尔可夫：用前两期的出现状态预测本期。', confidence: 0.6,
    }
  }
)

// ---------------------------------------------------------------- S09 号码对共现
export const S09 = M(
  'S09', '马尔可夫 · 号码对共现',
  '统计两两号码的共现次数，取参与高频共现对的号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const hs = recent(history)
      const score = new Array(size).fill(0)
      for (const d of hs) {
        const nums = d[field]
        for (let i = 0; i < nums.length; i++)
          for (let j = i + 1; j < nums.length; j++) {
            score[nums[i] - 1]++
            score[nums[j] - 1]++
          }
      }
      return normalize(score.map((x) => x + 1))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '共现网络中的「枢纽号码」。共现强度不等于预测力。', confidence: 0.55,
    }
  }
)

// ---------------------------------------------------------------- M06 泊松回归
export const M06 = M(
  'M06', '泊松分布拟合',
  '假设每号出现次数服从泊松分布，取实际频次最接近理论期望者。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const f = freq(history, size, field)
      const lambda = (history.length * RULES[lottery].frontCount) / size
      return normalize(f.map((c) => 1 / (1 + Math.abs(c - lambda))))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '越贴近泊松期望的号码权重越高——典型的「回归均值」思路。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S10 二项检验
export const S10 = M(
  'S10', '二项分布显著性检验',
  '计算每号出现频次的 z 分数，取统计上显著偏离期望者。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const n = history.length
      const p = RULES[lottery].frontCount / size
      const f = freq(history, size, field)
      return normalize(
        f.map((c) => {
          const z = (c - n * p) / Math.sqrt(Math.max(1, n * p * (1 - p)))
          return 1 + Math.abs(z)
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'z 分数越大越「异常」。但独立随机事件里的异常只是噪声。', confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- M07 拉普拉斯平滑
export const M07 = M(
  'M07', '贝叶斯 · 拉普拉斯平滑',
  '后验 = (count + 1) / (N + M)，α=1 的平滑估计。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const f = freq(history, size, field)
      const total = f.reduce((a, b) => a + b, 0)
      return normalize(f.map((c) => (c + 1) / (total + size)))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'α=1 的平滑，比 M02 更接近均匀分布。', confidence: 0.58,
    }
  }
)

// ---------------------------------------------------------------- S11 跨度分析
export const S11 = M(
  'S11', '跨度极值分析',
  '统计历史跨度（最大号−最小号）分布，围绕典型跨度构造号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const spans = history.map((d) => Math.max(...d.front) - Math.min(...d.front))
    const avgSpan = mean(spans)
    const lo = Math.max(1, Math.round((F - avgSpan) / 2))
    const hi = Math.min(F, lo + Math.round(avgSpan))
    return {
      frontProbs: normalize(
        Array.from({ length: F }, (_, i) => (i + 1 >= lo && i + 1 <= hi ? 3 : 1))
      ),
      backProbs: normalize(freq(history, B, 'back')),
      narrative: `历史平均跨度 ${avgSpan.toFixed(1)}，聚焦区间 ${lo}-${hi}。`, confidence: 0.52,
    }
  }
)

// ---------------------------------------------------------------- S12 AC 值
export const S12 = M(
  'S12', 'AC 值（数字复杂度）',
  '筛选历史上 AC 值（差值种类数）偏高的期，取其中的高频号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const acOf = (nums: number[]) => {
      const diffs = new Set<number>()
      const s = [...nums].sort((a, b) => a - b)
      for (let i = 0; i < s.length; i++)
        for (let j = i + 1; j < s.length; j++) diffs.add(s[j] - s[i])
      return diffs.size - (s.length - 1)
    }
    const acs = history.map((d) => acOf(d.front))
    const thr = mean(acs)
    const picked = history.filter((_, i) => acs[i] >= thr)
    return {
      frontProbs: normalize(freq(picked.length ? picked : history, F).map((x) => x + 1)),
      backProbs: normalize(freq(picked.length ? picked : history, B, 'back').map((x) => x + 1)),
      narrative: `历史平均 AC 值 ${thr.toFixed(2)}，取高 AC 期（${picked.length} 期）的偏好号码。`,
      confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S13 三区比
export const S13 = M(
  'S13', '三区比分布',
  '把号码池三等分，按历史各区的平均出号个数配比加权。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const cnt = RULES[lottery].frontCount
    const zone = new Array(3).fill(0)
    for (const d of history) for (const x of d.front) zone[Math.min(2, Math.floor(((x - 1) / F) * 3))]++
    const tot = zone.reduce((a, b) => a + b, 0) || 1
    const share = zone.map((z) => (z / tot) * cnt) // 各区平均出号数
    return {
      frontProbs: normalize(
        Array.from({ length: F }, (_, i) => {
          const z = Math.min(2, Math.floor((i / F) * 3))
          return share[z] / (F / 3)
        })
      ),
      backProbs: normalize(freq(history, B, 'back')),
      narrative: `三区平均出号 ${share.map((s) => s.toFixed(2)).join(' / ')}。`, confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S14 连号模式
export const S14 = M(
  'S14', '连号模式',
  '统计历史出现连号的比例，给易与热号构成连号的号码加权。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const f = freq(history, F)
    const hot = f.map((c, i) => ({ n: i + 1, c })).sort((a, b) => b.c - a.c).slice(0, 8).map((x) => x.n)
    let withSeq = 0
    for (const d of history) {
      const s = [...d.front].sort((a, b) => a - b)
      if (s.some((x, i) => i > 0 && s[i - 1] === x - 1)) withSeq++
    }
    const rate = withSeq / Math.max(1, history.length)
    const w = new Array(F).fill(1)
    for (const h of hot) {
      if (h - 1 >= 1) w[h - 2] += rate * 2
      if (h + 1 <= F) w[h] += rate * 2
    }
    return {
      frontProbs: normalize(w), backProbs: normalize(freq(history, B, 'back')),
      narrative: `历史 ${(rate * 100).toFixed(1)}% 的期含连号，围绕热号铺相邻号。`, confidence: 0.48,
    }
  }
)

// ---------------------------------------------------------------- S15 重号概率
export const S15 = M(
  'S15', '重号（上期重复）',
  '统计上期号码在下期重复出现的概率，给上期号码加权。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const last = history[history.length - 1]
    let rep = 0, tot = 0
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1].front
      for (const x of history[i].front) { tot++; if (prev.includes(x)) rep++ }
    }
    const rate = tot ? rep / tot : 0.2
    const w = new Array(F).fill(1)
    for (const x of last.front) w[x - 1] = 1 + rate * 10
    const wb = new Array(B).fill(1)
    for (const x of last.back) wb[x - 1] = 1 + rate * 10
    return {
      frontProbs: normalize(w), backProbs: normalize(wb),
      narrative: `历史重号率 ${(rate * 100).toFixed(1)}%，据此给上期号码加权。`, confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S16 尾数分布
export const S16 = M(
  'S16', '尾数分布',
  '统计个位数字 0-9 的出现频次，按尾数给号码加权。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const tail = new Array(10).fill(0)
      for (const d of history) for (const x of d[field]) tail[x % 10]++
      return normalize(Array.from({ length: size }, (_, i) => tail[(i + 1) % 10] + 1))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '同尾号现象在视觉上很显眼，但统计上不构成规律。', confidence: 0.46,
    }
  }
)

// ---------------------------------------------------------------- S17 同尾号
export const S17 = M(
  'S17', '同尾号共现',
  '统计相同尾数号码在同一期共同出现的强度。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const w = new Array(size).fill(1)
      for (const d of history) {
        const byTail: Record<number, number> = {}
        for (const x of d[field]) byTail[x % 10] = (byTail[x % 10] || 0) + 1
        for (const x of d[field]) if (byTail[x % 10] > 1) w[x - 1] += 1
      }
      return normalize(w)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '偏好历史上「成双成对」出现过的尾数组。', confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- S18 关联规则
export const S18 = M(
  'S18', '关联规则 Apriori',
  '挖掘频繁 2 项集，取支持度最高的号码组合成员。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const hs = recent(history)
      const pair = new Map<string, number>()
      for (const d of hs) {
        const s = [...d[field]].sort((a, b) => a - b)
        for (let i = 0; i < s.length; i++)
          for (let j = i + 1; j < s.length; j++) {
            const k = s[i] + '-' + s[j]
            pair.set(k, (pair.get(k) || 0) + 1)
          }
      }
      const w = new Array(size).fill(1)
      for (const [k, c] of pair) {
        if (c < 3) continue
        const [a, b] = k.split('-').map(Number)
        w[a - 1] += c; w[b - 1] += c
      }
      return normalize(w)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '支持度 ≥3 的频繁二项集成员。购物篮分析搬到彩票上。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S19 互信息 PMI
export const S19 = M(
  'S19', '互信息 PMI',
  '计算号码两两共现的点互信息，取互信息总量最高的号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const n = history.length
      const f = freq(history, size, field)
      const co = new Map<string, number>()
      for (const d of history) {
        const s = [...d[field]].sort((a, b) => a - b)
        for (let i = 0; i < s.length; i++)
          for (let j = i + 1; j < s.length; j++) {
            const k = s[i] + '-' + s[j]
            co.set(k, (co.get(k) || 0) + 1)
          }
      }
      const w = new Array(size).fill(0)
      for (const [k, c] of co) {
        const [a, b] = k.split('-').map(Number)
        const pxy = c / n
        const px = f[a - 1] / n, py = f[b - 1] / n
        if (px <= 0 || py <= 0) continue
        const pmi = Math.log(pxy / (px * py))
        w[a - 1] += Math.max(0, pmi); w[b - 1] += Math.max(0, pmi)
      }
      return normalize(w.map((x) => x + 1e-3))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '正互信息越强的号码对权重越高。', confidence: 0.48,
    }
  }
)

// ---------------------------------------------------------------- S20 卡方检验
export const S20 = M(
  'S20', '卡方独立性检验',
  '检验每个号码的出现是否独立于期次，取卡方统计量最大的号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const n = history.length
      const f = freq(history, size, field)
      const exp = (n * RULES[lottery].frontCount) / size
      return normalize(f.map((c) => ((c - exp) ** 2) / Math.max(1, exp) + 0.1))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '卡方统计量衡量偏离均匀的程度——彩票本就该是均匀的。', confidence: 0.44,
    }
  }
)

// ---------------------------------------------------------------- S21 游程检验
export const S21 = M(
  'S21', '游程检验 Runs Test',
  '对每期的奇偶序列做游程检验，偏离随机期望的期次权重更高。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const w = new Array(F).fill(1)
    for (const d of history) {
      const seq = [...d.front].sort((a, b) => a - b).map((x) => x % 2)
      let runs = 1
      for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) runs++
      const odd = seq.filter((x) => x === 1).length
      const even = seq.length - odd
      const expRuns = 1 + (2 * odd * even) / Math.max(1, seq.length)
      if (Math.abs(runs - expRuns) > 0.5) for (const x of d.front) w[x - 1] += 1
    }
    return {
      frontProbs: normalize(w), backProbs: normalize(freq(history, B, 'back')),
      narrative: '游程检验找「不随机」的期，可惜彩票本来就是随机的。', confidence: 0.42,
    }
  }
)

// ---------------------------------------------------------------- S22 Bootstrap
export const S22 = M(
  'S22', 'Bootstrap 重采样',
  '对历史期次做有放回重采样 500 次，取稳定高频的号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const acc = new Array(size).fill(0)
      for (let t = 0; t < 500; t++) {
        const d = history[rndInt(history.length)]
        for (const x of d[field]) acc[x - 1]++
      }
      return normalize(acc)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'Bootstrap 估计的是抽样误差，不是未来的开奖号。', confidence: 0.52,
    }
  }
)

// ---------------------------------------------------------------- M08 最大熵
export const M08 = M(
  'M08', '最大熵 MaxEnt',
  '在均值和方差约束下取熵最大的分布（即高斯），据此给号码加权。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const all: number[] = []
      for (const d of history) all.push(...d[field])
      const m = mean(all), s = std(all) || 1
      return normalize(Array.from({ length: size }, (_, i) => Math.exp(-((i + 1 - m) ** 2) / (2 * s * s)) + 1e-6))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '最大熵解在给定矩约束下就是正态分布——一个漂亮的数学结论。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S23 自回归 AR
export const S23 = M(
  'S23', '时间序列 AR / ARIMA',
  '对每个号码的出现序列拟合 AR(1) 模型，用滞后项外推下一期。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const m = presence(recent(history), size, field)
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const xs = m.map((row) => row[i])
          const mu = mean(xs)
          let num = 0, den = 0
          for (let t = 1; t < xs.length; t++) {
            num += (xs[t - 1] - mu) * (xs[t] - mu)
            den += (xs[t - 1] - mu) ** 2
          }
          const phi = den > 0 ? num / den : 0
          return mu + phi * (xs[xs.length - 1] - mu) + 1e-6
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'AR(1) 外推。对独立随机序列，φ 应当接近 0。', confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- S24 傅里叶
export const S24 = M(
  'S24', '傅里叶频谱分析',
  '对每个号码的出现序列做 DFT，检测周期性并外推主频分量。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const m = presence(recent(history, 256), size, field)
      const T = m.length
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const xs = m.map((row) => row[i])
          let bestAmp = 0, bestPhase = 0, bestK = 0
          for (let k = 1; k <= 8; k++) {
            let re = 0, im = 0
            for (let t = 0; t < T; t++) {
              const ang = (-2 * Math.PI * k * t) / T
              re += xs[t] * Math.cos(ang)
              im += xs[t] * Math.sin(ang)
            }
            const amp = Math.sqrt(re * re + im * im) / T
            if (amp > bestAmp) { bestAmp = amp; bestPhase = Math.atan2(im, re); bestK = k }
          }
          const next = bestAmp * Math.cos((2 * Math.PI * bestK * T) / T + bestPhase)
          return Math.abs(next) + 1e-6
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '如果真有周期，频谱会告诉你；如果没有，它也照样给你一个答案。', confidence: 0.4,
    }
  }
)

// ---------------------------------------------------------------- S25 Hurst
export const S25 = M(
  'S25', 'Hurst 指数 / R-S 分析',
  '用重标极差法估计长期记忆性，H>0.5 则按趋势外推。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const m = presence(recent(history), size, field)
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const xs = m.map((row) => row[i])
          const mu = mean(xs)
          const dev: number[] = []
          let acc = 0
          for (const x of xs) { acc += x - mu; dev.push(acc) }
          const R = Math.max(...dev) - Math.min(...dev)
          const S = std(xs) || 1
          const H = Math.log(Math.max(1, R / S)) / Math.log(Math.max(2, xs.length))
          return xs[xs.length - 1] + H + 1e-6
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'H≈0.5 意味着无记忆。彩票应当稳定地给出 0.5。', confidence: 0.42,
    }
  }
)

// ---------------------------------------------------------------- S26 PCA
export const S26 = M(
  'S26', 'PCA 形态降维',
  '对期次向量做协方差分析，取第一主成分载荷最大的号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const m = presence(recent(history, 200), size, field)
      const mu = new Array(size).fill(0)
      for (const row of m) for (let i = 0; i < size; i++) mu[i] += row[i] / m.length
      // 幂迭代求第一主成分
      let v = new Array(size).fill(0).map((_, i) => Math.sin(i + 1))
      for (let it = 0; it < 30; it++) {
        const nv = new Array(size).fill(0)
        for (const row of m) {
          let dot = 0
          for (let i = 0; i < size; i++) dot += (row[i] - mu[i]) * v[i]
          for (let i = 0; i < size; i++) nv[i] += dot * (row[i] - mu[i])
        }
        const norm = Math.sqrt(nv.reduce((s, x) => s + x * x, 0)) || 1
        v = nv.map((x) => x / norm)
      }
      return normalize(v.map((x) => Math.abs(x) + 1e-6))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '主成分找的是历史方差最大的方向，不是未来的开奖号。', confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- S27 K-Means
export const S27 = M(
  'S27', '聚类 K-Means',
  '把历史期次聚成 4 簇，取最大簇的质心对应号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const m = presence(recent(history, 200), size, field)
      const K = 4
      let cent = Array.from({ length: K }, () => new Array(size).fill(0).map(() => Math.random()))
      let assign = new Array(m.length).fill(0)
      for (let it = 0; it < 12; it++) {
        assign = m.map((row) => {
          let bi = 0, bd = Infinity
          for (let k = 0; k < K; k++) {
            let d = 0
            for (let i = 0; i < size; i++) d += (row[i] - cent[k][i]) ** 2
            if (d < bd) { bd = d; bi = k }
          }
          return bi
        })
        for (let k = 0; k < K; k++) {
          const members = m.filter((_, i) => assign[i] === k)
          if (!members.length) continue
          cent[k] = new Array(size).fill(0).map((_, i) => mean(members.map((r) => r[i])))
        }
      }
      const counts = new Array(K).fill(0)
      for (const a of assign) counts[a]++
      const big = counts.indexOf(Math.max(...counts))
      return normalize(cent[big].map((x) => x + 1e-6))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '取最大簇的质心。聚类能发现模式，但彩票没有模式可发现。', confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- S28 PageRank
export const S28 = M(
  'S28', '图模型 PageRank',
  '号码为节点、共现为边，迭代计算 PageRank 取权威号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const hs = recent(history)
      const w: number[][] = Array.from({ length: size }, () => new Array(size).fill(0))
      for (const d of hs) {
        const s = d[field]
        for (let i = 0; i < s.length; i++)
          for (let j = 0; j < s.length; j++) if (i !== j) w[s[i] - 1][s[j] - 1]++
      }
      let pr = new Array(size).fill(1 / size)
      const d0 = 0.85
      for (let it = 0; it < 20; it++) {
        const next = new Array(size).fill((1 - d0) / size)
        for (let j = 0; j < size; j++) {
          const out = w[j].reduce((a, b) => a + b, 0)
          if (out <= 0) continue
          for (let i = 0; i < size; i++) next[i] += d0 * pr[j] * (w[j][i] / out)
        }
        pr = next
      }
      return normalize(pr)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'PageRank 找的是共现网络里的权威节点。', confidence: 0.5,
    }
  }
)

export const MATH_EXT_MODELS: Model[] = [
  S07, S08, M05, S09, M06, S10, M07, S11, S12, S13,
  S14, S15, S16, S17, S18, S19, S20, S21, S22, M08,
  S23, S24, S25, S26, S27, S28,
]

// 经验统计 / 机器学习类归为「统计」，概率解析 / 组合数学类保留「数学」。
const STAT_EXT = new Set([
  'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16',
  'S17', 'S18', 'S19', 'S20', 'S21', 'S22', 'S23', 'S24', 'S25', 'S26',
  'S27', 'S28',
])
for (const m of MATH_EXT_MODELS) if (STAT_EXT.has(m.meta.id)) m.meta.category = 'stat'
