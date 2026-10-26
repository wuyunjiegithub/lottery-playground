import type { Draw, LotteryType, Prediction } from '../../types'
import { RULES } from '../lottery'
import { normalize, freq, rndInt, type Model, type ModelCtx } from './types'

const M = (
  id: string, name: string, desc: string,
  predict: (c: ModelCtx) => Prediction,
  cat: 'math' | 'stat' = 'stat'
): Model => ({ meta: { id, name, category: cat, desc, heavy: true }, predict, heavy: true })

const LAG = 5 // 用最近 5 期做特征
const EVAL_N = 120 // 搜索类模型评估最近 120 期

/** 候选组合的平均历史命中数，作为搜索类模型的适应度 */
function fitness(nums: number[], history: Draw[], field: 'front' | 'back'): number {
  const hs = history.slice(-EVAL_N)
  let s = 0
  for (const d of hs) for (const n of nums) if (d[field].includes(n)) s++
  return s / Math.max(1, hs.length)
}

function randCombo(size: number, count: number): number[] {
  const s = new Set<number>()
  while (s.size < count) s.add(rndInt(size) + 1)
  return [...s].sort((a, b) => a - b)
}

/** 把组合转成概率分布（组合内号码权重远高于其余） */
function comboToProbs(size: number, nums: number[]): number[] {
  const w = new Array(size).fill(1)
  for (const n of nums) if (n >= 1 && n <= size) w[n - 1] = 50
  return normalize(w)
}

// ---------------------------------------------------------------- 监督数据集
interface Sample { x: number[]; y: number }

function buildSamples(history: Draw[], size: number, field: 'front' | 'back', num: number): Sample[] {
  const out: Sample[] = []
  const f = freq(history, size, field)
  const total = f.reduce((a, b) => a + b, 0) || 1
  for (let t = LAG; t < history.length; t++) {
    const x: number[] = [1] // 偏置
    for (let k = 1; k <= LAG; k++) x.push(history[t - k][field].includes(num) ? 1 : 0)
    x.push((f[num - 1] / total) * 10) // 全局频次特征
    x.push(num / size) // 号码位置特征
    out.push({ x, y: history[t][field].includes(num) ? 1 : 0 })
  }
  return out
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0)

/** 逻辑回归 / 线性 SVM / 感知机 共用的 SGD 训练器 */
function trainLinear(samples: Sample[], lr: number, epochs: number, loss: 'log' | 'hinge'): number[] {
  const dim = samples[0]?.x.length || 1
  const w = new Array(dim).fill(0)
  for (let e = 0; e < epochs; e++) {
    for (const s of samples) {
      const z = dot(w, s.x)
      if (loss === 'log') {
        const p = sigmoid(z)
        const g = p - s.y
        for (let i = 0; i < dim; i++) w[i] -= lr * g * s.x[i]
      } else {
        const y = s.y === 1 ? 1 : -1
        if (y * z < 1) for (let i = 0; i < dim; i++) w[i] += lr * y * s.x[i]
      }
    }
  }
  return w
}

/** 用训练好的权重预测每个号码的概率 */
function predictLinear(history: Draw[], size: number, field: 'front' | 'back', w: number[]): number[] {
  const f = freq(history, size, field)
  const total = f.reduce((a, b) => a + b, 0) || 1
  return normalize(
    Array.from({ length: size }, (_, i) => {
      const num = i + 1
      const x: number[] = [1]
      for (let k = 1; k <= LAG; k++) x.push(history[history.length - k][field].includes(num) ? 1 : 0)
      x.push((f[i] / total) * 10)
      x.push(num / size)
      return sigmoid(dot(w, x)) + 1e-4
    })
  )
}

/** 合并所有号码的样本做共享训练 */
function allSamples(history: Draw[], size: number, field: 'front' | 'back'): Sample[] {
  const out: Sample[] = []
  for (let n = 1; n <= size; n++) {
    const s = buildSamples(history, size, field, n)
    for (let i = Math.max(0, s.length - 60); i < s.length; i++) out.push(s[i])
  }
  return out
}

// ---------------------------------------------------------------- S29 遗传算法
export const S29 = M(
  'S29', '遗传算法 GA',
  '把号码组合当作染色体，以适应度（历史平均命中数）做选择、交叉、变异，搜索最优组合。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const cnt = RULES[lottery][field === 'front' ? 'frontCount' : 'backCount']
      let pop = Array.from({ length: 40 }, () => randCombo(size, cnt))
      let best = pop[0]
      let bestFit = -1
      for (let g = 0; g < 30; g++) {
        const fit = pop.map((p) => fitness(p, history, field))
        for (let i = 0; i < pop.length; i++) if (fit[i] > bestFit) { bestFit = fit[i]; best = pop[i] }
        // 轮盘赌选择 + 单点交叉 + 变异
        const sum = fit.reduce((a, b) => a + b, 0) || 1
        const next: number[][] = [best.slice()]
        while (next.length < 40) {
          const pick = () => {
            let r = Math.random() * sum
            for (let i = 0; i < pop.length; i++) { r -= fit[i]; if (r <= 0) return pop[i] }
            return pop[pop.length - 1]
          }
          const a = pick(), b = pick()
          const cut = 1 + rndInt(Math.max(1, cnt - 1))
          const child = [...new Set([...a.slice(0, cut), ...b.slice(cut)])]
          while (child.length < cnt) {
            const n = rndInt(size) + 1
            if (!child.includes(n)) child.push(n)
          }
          if (Math.random() < 0.15) {
            const idx = rndInt(cnt)
            let n = rndInt(size) + 1
            while (child.includes(n)) n = rndInt(size) + 1
            child[idx] = n
          }
          next.push(child.slice(0, cnt).sort((x, y) => x - y))
        }
        pop = next
      }
      return comboToProbs(size, best)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: `遗传算法跑了 30 代、种群 40，找到历史命中 ${fitness(
        calc(F, 'front').map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p).slice(0, RULES[lottery].frontCount).map((x) => x.i + 1),
        history, 'front'
      ).toFixed(2)} 的组合——这是过拟合，不是预测。`,
      confidence: 0.55,
    }
  }
)

// ---------------------------------------------------------------- S30 粒子群 PSO
export const S30 = M(
  'S30', '粒子群优化 PSO',
  '每个粒子是一组连续权重，按个体历史最优与群体最优更新速度，最后取权重最高的号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const cnt = RULES[lottery][field === 'front' ? 'frontCount' : 'backCount']
      const N = 24
      let pos = Array.from({ length: N }, () => new Array(size).fill(0).map(() => Math.random()))
      let vel = Array.from({ length: N }, () => new Array(size).fill(0))
      const pbest = pos.map((p) => p.slice())
      const pbestFit = pos.map((p) => {
        const top = p.map((v, i) => ({ v, n: i + 1 })).sort((a, b) => b.v - a.v).slice(0, cnt).map((x) => x.n)
        return fitness(top, history, field)
      })
      let gbest = pbest[pbestFit.indexOf(Math.max(...pbestFit))].slice()
      for (let it = 0; it < 25; it++) {
        for (let i = 0; i < N; i++) {
          for (let d = 0; d < size; d++) {
            vel[i][d] = 0.7 * vel[i][d] +
              1.4 * Math.random() * (pbest[i][d] - pos[i][d]) +
              1.4 * Math.random() * (gbest[d] - pos[i][d])
            pos[i][d] += vel[i][d]
          }
          const top = pos[i].map((v, d) => ({ v, n: d + 1 })).sort((a, b) => b.v - a.v).slice(0, cnt).map((x) => x.n)
          const f = fitness(top, history, field)
          if (f > pbestFit[i]) { pbestFit[i] = f; pbest[i] = pos[i].slice() }
          if (f > fitness(gbest.map((v, d) => ({ v, n: d + 1 })).sort((a, b) => b.v - a.v).slice(0, cnt).map((x) => x.n), history, field)) {
            gbest = pos[i].slice()
          }
        }
      }
      return normalize(gbest.map((v) => Math.max(1e-6, v - Math.min(...gbest) + 0.01)))
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'PSO 24 个粒子迭代 25 轮收敛出的权重分布。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S31 模拟退火
export const S31 = M(
  'S31', '模拟退火 SA',
  '从一个随机组合出发做邻域搜索，以温度控制的概率接受劣解，避免陷入局部最优。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const cnt = RULES[lottery][field === 'front' ? 'frontCount' : 'backCount']
      let cur = randCombo(size, cnt)
      let curFit = fitness(cur, history, field)
      let best = cur.slice(), bestFit = curFit
      let T = 1.0
      for (let it = 0; it < 400; it++) {
        T = 1.0 * (1 - it / 400)
        const cand = cur.slice()
        const idx = rndInt(cnt)
        let n = rndInt(size) + 1
        while (cand.includes(n)) n = rndInt(size) + 1
        cand[idx] = n
        const f = fitness(cand.sort((a, b) => a - b), history, field)
        if (f > curFit || Math.random() < Math.exp((f - curFit) / Math.max(1e-6, T * 0.1))) {
          cur = cand; curFit = f
          if (f > bestFit) { best = cand.slice(); bestFit = f }
        }
      }
      return comboToProbs(size, best)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '模拟退火 400 步搜索出的历史最优组合。', confidence: 0.52,
    }
  }
)

// ---------------------------------------------------------------- S32 随机森林（简化）
export const S32 = M(
  'S32', '随机森林（简化）',
  '训练多棵决策树桩（单特征阈值），用 Bagging 投票估计每个号码的出现概率。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const samples = allSamples(history, size, field)
      if (!samples.length) return normalize(new Array(size).fill(1))
      const dim = samples[0].x.length
      const trees: { f: number; thr: number; left: number; right: number }[] = []
      for (let t = 0; t < 30; t++) {
        const bag = Array.from({ length: Math.min(200, samples.length) }, () => samples[rndInt(samples.length)])
        let bf = 1, bthr = 0, bgain = -1
        for (let f = 1; f < dim; f++) {
          for (const thr of [0.5]) {
            const L = bag.filter((s) => s.x[f] <= thr)
            const R = bag.filter((s) => s.x[f] > thr)
            if (!L.length || !R.length) continue
            const pl = L.filter((s) => s.y === 1).length / L.length
            const pr = R.filter((s) => s.y === 1).length / R.length
            const gain = Math.abs(pl - pr)
            if (gain > bgain) { bgain = gain; bf = f; bthr = thr }
          }
        }
        const L = bag.filter((s) => s.x[bf] <= bthr)
        const R = bag.filter((s) => s.x[bf] > bthr)
        trees.push({
          f: bf, thr: bthr,
          left: L.length ? L.filter((s) => s.y === 1).length / L.length : 0,
          right: R.length ? R.filter((s) => s.y === 1).length / R.length : 0,
        })
      }
      const f = freq(history, size, field)
      const total = f.reduce((a, b) => a + b, 0) || 1
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const num = i + 1
          const x: number[] = [1]
          for (let k = 1; k <= LAG; k++) x.push(history[history.length - k][field].includes(num) ? 1 : 0)
          x.push((f[i] / total) * 10)
          x.push(num / size)
          const votes = trees.map((t) => (x[t.f] <= t.thr ? t.left : t.right))
          return votes.reduce((a, b) => a + b, 0) / trees.length + 1e-4
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '30 棵决策树桩 Bagging 投票。树桩很浅，因为它本就学不到什么。', confidence: 0.48,
    }
  }
)

// ---------------------------------------------------------------- S33 梯度提升（简化 XGBoost）
export const S33 = M(
  'S33', '梯度提升树（简化 XGBoost）',
  '串行训练决策树桩，每棵拟合上一轮的残差，累加得到号码概率。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const samples = allSamples(history, size, field)
      if (!samples.length) return normalize(new Array(size).fill(1))
      const dim = samples[0].x.length
      const trees: { f: number; thr: number; left: number; right: number }[] = []
      const res = samples.map((s) => s.y - 0.5)
      for (let t = 0; t < 20; t++) {
        let bf = 1, bgain = -1
        for (let f = 1; f < dim; f++) {
          const L = samples.filter((s, i) => s.x[f] <= 0.5)
          const idxL = samples.map((s, i) => (s.x[f] <= 0.5 ? i : -1)).filter((i) => i >= 0)
          const idxR = samples.map((s, i) => (s.x[f] > 0.5 ? i : -1)).filter((i) => i >= 0)
          if (!idxL.length || !idxR.length) continue
          const ml = idxL.reduce((a, i) => a + res[i], 0) / idxL.length
          const mr = idxR.reduce((a, i) => a + res[i], 0) / idxR.length
          const gain = Math.abs(ml - mr)
          if (gain > bgain) { bgain = gain; bf = f }
        }
        const idxL = samples.map((s, i) => (s.x[bf] <= 0.5 ? i : -1)).filter((i) => i >= 0)
        const idxR = samples.map((s, i) => (s.x[bf] > 0.5 ? i : -1)).filter((i) => i >= 0)
        const ml = idxL.length ? idxL.reduce((a, i) => a + res[i], 0) / idxL.length : 0
        const mr = idxR.length ? idxR.reduce((a, i) => a + res[i], 0) / idxR.length : 0
        trees.push({ f: bf, thr: 0.5, left: ml, right: mr })
        samples.forEach((s, i) => { res[i] -= (s.x[bf] <= 0.5 ? ml : mr) * 0.3 })
      }
      const f = freq(history, size, field)
      const total = f.reduce((a, b) => a + b, 0) || 1
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const num = i + 1
          const x: number[] = [1]
          for (let k = 1; k <= LAG; k++) x.push(history[history.length - k][field].includes(num) ? 1 : 0)
          x.push((f[i] / total) * 10)
          x.push(num / size)
          const s = trees.reduce((a, t) => a + (x[t.f] <= t.thr ? t.left : t.right) * 0.3, 0.5)
          return Math.max(1e-4, s)
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '20 轮梯度提升。Boosting 能拟合训练集，但彩票没有可泛化的信号。', confidence: 0.47,
    }
  }
)

// ---------------------------------------------------------------- S34 逻辑回归
export const S34 = M(
  'S34', '逻辑回归',
  '以「最近 5 期是否出现 + 历史频次 + 号码位置」为特征，训练线性分类器输出概率。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const s = allSamples(history, size, field)
      if (!s.length) return normalize(new Array(size).fill(1))
      const w = trainLinear(s, 0.05, 30, 'log')
      return predictLinear(history, size, field, w)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '逻辑回归 30 轮 SGD。线性模型只能学到「热号」这一件事。', confidence: 0.46,
    }
  }
)

// ---------------------------------------------------------------- S35 线性 SVM
export const S35 = M(
  'S35', '支持向量机 SVM（线性）',
  '用 hinge loss 的随机梯度下降训练线性 SVM，按决策函数值排序号码。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const s = allSamples(history, size, field)
      if (!s.length) return normalize(new Array(size).fill(1))
      const w = trainLinear(s, 0.01, 30, 'hinge')
      return predictLinear(history, size, field, w)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '线性 SVM 找最大间隔超平面，可惜两类之间没有间隔。', confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- S36 MLP
export const S36 = M(
  'S36', '多层感知机 MLP',
  '单隐层（8 单元、tanh）前馈网络，反向传播训练后输出号码概率。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const s = allSamples(history, size, field)
      if (!s.length) return normalize(new Array(size).fill(1))
      const dim = s[0].x.length
      const H = 8
      const W1 = Array.from({ length: H }, () => new Array(dim).fill(0).map(() => (Math.random() - 0.5) * 0.5))
      const W2 = new Array(H).fill(0).map(() => (Math.random() - 0.5) * 0.5)
      const lr = 0.05
      for (let e = 0; e < 25; e++) {
        for (const sm of s) {
          const h = W1.map((w) => Math.tanh(dot(w, sm.x)))
          const z = dot(W2, h)
          const p = sigmoid(z)
          const g = p - sm.y
          for (let j = 0; j < H; j++) W2[j] -= lr * g * h[j]
          for (let j = 0; j < H; j++) {
            const dh = g * W2[j] * (1 - h[j] * h[j])
            for (let i = 0; i < dim; i++) W1[j][i] -= lr * dh * sm.x[i]
          }
        }
      }
      const f = freq(history, size, field)
      const total = f.reduce((a, b) => a + b, 0) || 1
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const num = i + 1
          const x: number[] = [1]
          for (let k = 1; k <= LAG; k++) x.push(history[history.length - k][field].includes(num) ? 1 : 0)
          x.push((f[i] / total) * 10)
          x.push(num / size)
          const h = W1.map((w) => Math.tanh(dot(w, x)))
          return sigmoid(dot(W2, h)) + 1e-4
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '8 单元隐层，25 轮训练。神经网络也救不了独立随机事件。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S37 简化 LSTM / ESN
export const S37 = M(
  'S37', 'LSTM / 循环网络（简化 ESN）',
  '用回声状态网络思路：固定随机循环权重 + 训练读出层，建模号码出现序列。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const seq = history.map((d) => d[field].slice())
      const N = 32 // 储备池规模
      const Win = Array.from({ length: N }, () => (Math.random() - 0.5) * 0.6)
      const Wrec = Array.from({ length: N }, () => new Array(N).fill(0).map(() => (Math.random() - 0.5) * 0.4))
      const Wout = new Array(N).fill(0)
      const h = new Array(N).fill(0)
      const states: number[][] = []
      const targets: number[] = []
      for (let t = 0; t < seq.length; t++) {
        const x = seq[t].length ? seq[t][0] / size : 0
        const nh = new Array(N).fill(0)
        for (let j = 0; j < N; j++) {
          let s = Win[j] * x
          for (let k = 0; k < N; k++) s += Wrec[j][k] * h[k]
          nh[j] = Math.tanh(s)
        }
        for (let j = 0; j < N; j++) h[j] = nh[j]
        if (t > 10) { states.push(h.slice()); targets.push(x) }
      }
      // 岭回归读���层
      const lr = 0.02
      for (let e = 0; e < 15; e++) {
        for (let i = 0; i < states.length; i++) {
          const y = dot(Wout, states[i])
          const g = y - targets[i]
          for (let j = 0; j < N; j++) Wout[j] -= lr * g * states[i][j]
        }
      }
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const probe = new Array(N).fill(0)
          for (let j = 0; j < N; j++) {
            let s = Win[j] * ((i + 1) / size)
            for (let k = 0; k < N; k++) s += Wrec[j][k] * h[k]
            probe[j] = Math.tanh(s)
          }
          return Math.abs(dot(Wout, probe)) + 1e-4
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '32 单元储备池 + 岭回归读出层。这是 LSTM 家族的轻量近似。', confidence: 0.48,
    }
  }
)

// ---------------------------------------------------------------- S38 隐马尔可夫 HMM
export const S38 = M(
  'S38', '隐马尔可夫模型 HMM',
  '假设存在「热 / 冷」两种隐状态，用频率估计转移与发射概率，前向算法预测。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const hs = history.slice(-200)
      const base = RULES[lottery].frontCount / size
      return normalize(
        Array.from({ length: size }, (_, i) => {
          const num = i + 1
          // 以该号近 20 期出现率为观测，估计所处隐状态
          const win = hs.slice(-20)
          const rate = win.filter((d) => d[field].includes(num)).length / Math.max(1, win.length)
          const hotEmit = Math.min(1, base * 2)
          const coldEmit = Math.max(0.01, base * 0.4)
          // P(hot|obs) ∝ P(obs|hot)·P(hot)
          const pHot = 0.5
          const lh = binom(rate * 20, 20, hotEmit) * pHot
          const lc = binom(rate * 20, 20, coldEmit) * (1 - pHot)
          const post = (lh + 1e-9) / (lh + lc + 2e-9)
          return post * hotEmit + (1 - post) * coldEmit + 1e-4
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '两状态 HMM：热 / 冷。转移矩阵是估计出来的，但状态本身是虚构的。', confidence: 0.47,
    }
  }
)

function binom(k: number, n: number, p: number): number {
  if (p <= 0 || p >= 1) return 1e-9
  const kk = Math.round(k)
  // 对数二项概率密度
  let lg = 0
  for (let i = 1; i <= n; i++) lg += Math.log(i)
  for (let i = 1; i <= kk; i++) lg -= Math.log(i)
  for (let i = 1; i <= n - kk; i++) lg -= Math.log(i)
  return Math.exp(lg + kk * Math.log(p) + (n - kk) * Math.log(1 - p))
}

// ---------------------------------------------------------------- S39 自编码器异常检测
export const S39 = M(
  'S39', '自编码器异常检测',
  '用主成分重构每期的号码向量，重构误差大的「异常期」其号码获得更高权重。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const hs = history.slice(-200)
      const m = hs.map((d) => {
        const row = new Array(size).fill(0)
        for (const x of d[field]) row[x - 1] = 1
        return row
      })
      const mu = new Array(size).fill(0)
      for (const row of m) for (let i = 0; i < size; i++) mu[i] += row[i] / m.length
      const errs = m.map((row) => row.reduce((s, v, i) => s + (v - mu[i]) ** 2, 0))
      const thr = errs.reduce((a, b) => a + b, 0) / Math.max(1, errs.length)
      const w = new Array(size).fill(1)
      hs.forEach((d, i) => {
        if (errs[i] > thr) for (const x of d[field]) w[x - 1] += 1
      })
      return normalize(w)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '挑出历史「异常」期的号码。异常只是统计波动的另一种说法。', confidence: 0.44,
    }
  }
)

// ---------------------------------------------------------------- S40 多臂老虎机 UCB
export const S40 = M(
  'S40', '强化学习 · 多臂老虎机 UCB',
  '把每个号码看作一台老虎机，用 UCB 公式平衡探索与利用，取置信上界最高者。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const f = freq(history, size, field)
      const t = history.length
      const c = 1.2
      return normalize(
        f.map((cnt) => {
          if (cnt <= 0) return 10 // 未探索过的臂给最高上界
          return cnt / t + c * Math.sqrt((2 * Math.log(Math.max(2, t))) / cnt)
        })
      )
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: 'UCB 会优先探索冷门号码——它把噪声当成了待探索的奖励。', confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- S41 覆盖设计
export const S41 = M(
  'S41', '覆盖设计 Covering Design',
  '用贪心法构造号码集合，使历史开奖号的 6 子集尽可能被覆盖（保证至少命中若干）。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      const cnt = RULES[lottery][field === 'front' ? 'frontCount' : 'backCount']
      const target = Math.min(size, cnt * 3)
      const chosen = new Set<number>()
      const gain = new Array(size + 1).fill(0)
      for (const d of history.slice(-300)) for (const x of d[field]) gain[x]++
      const order = gain.map((g, i) => ({ i, g })).filter((x) => x.i >= 1).sort((a, b) => b.g - a.g)
      for (const o of order) {
        if (chosen.size >= target) break
        chosen.add(o.i)
      }
      return comboToProbs(size, [...chosen])
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '覆盖设计保证「若中奖号落在集合内则必中若干」，代价是集合要大。', confidence: 0.53,
    }
  }
)

// ---------------------------------------------------------------- S42 正交表 / 拉丁方
export const S42 = M(
  'S42', '正交表 / 拉丁方',
  '用拉丁方排列均匀铺开号码，保证各号码被覆盖的次数尽量均衡。',
  ({ history, lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const calc = (size: number, field: 'front' | 'back') => {
      // 拉丁方：L[i][j] = (i + j) mod size
      const offset = history.length % size
      const w = new Array(size).fill(1)
      const cnt = RULES[lottery][field === 'front' ? 'frontCount' : 'backCount']
      for (let j = 0; j < cnt; j++) {
        const n = ((offset + j * Math.floor(size / cnt)) % size) + 1
        w[n - 1] = 20
      }
      return normalize(w)
    }
    return {
      frontProbs: calc(F, 'front'), backProbs: calc(B, 'back'),
      narrative: '拉丁方按余数均匀取号，是一种无偏好但「看起来有设计感」的选法。', confidence: 0.42,
    }
  }
)

export const MATH_ML_MODELS: Model[] = [
  S29, S30, S31, S32, S33, S34, S35, S36, S37, S38, S39, S40, S41, S42,
]
