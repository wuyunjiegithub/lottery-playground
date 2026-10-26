/**
 * 实测每期成本随「训练历史长度」变化的曲线。
 *
 * 为什么要实测：页面上的预估公式 `per = 239 + 0.177 × train` 是从短历史外推出来的，
 * 而用户报告「样本 1000，预估十几分钟，实际跑了 81 分钟」——差 6 倍。
 * 更要命的是原公式还有一个**结构性错误**：它用训练集的**起点**长度去乘期数，
 * 但回测过程中训练集是一期一期变长的，正确做法是逐期求和（积分）。
 *
 * 本脚本用真实内联数据，锁住若干「训练长度」点，直接跑全量 78 个模型若干期，
 * 得到该长度下的真实 ms/期，最后拟合 per(train) = a + b × train（并检查是否非线性）。
 *
 * 第 2 节是**校准逻辑**的单测：用户第二次报的问题不是公式错，而是
 * 「进度条按实时速率说 80 分钟、参数区还印着公式给的 18 分钟」两个数字打架。
 * 解法是回测进行中就把实时速率喂回校准，这里验证那条合并逻辑真的能一步拉到位。
 */
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const { backtest } = await server.ssrLoadModule('/src/core/backtest.ts')
const { ALL_MODELS } = await server.ssrLoadModule('/src/core/models/index.ts')
// 与页面、store 共用同一份公式：这样这里测出来的系数改一次就到处生效，
// 不会出现「脚本说 18 分钟、页面还在印旧公式的 13 分钟」
const {
  COST, estRawMs, solveFactor, mergeCalib, MAX_WEIGHT,
} = await server.ssrLoadModule('/src/core/perf.ts')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

const packet = JSON.parse(readFileSync(resolve('src/assets/lottery-data.json'), 'utf8'))
const all = Array.isArray(packet) ? packet : packet.draws

const LT = 'dlt'
const history = all
  .filter((d) => d.lottery === LT)
  .sort((a, b) => a.issue.localeCompare(b.issue))

console.log(`${LT} 历史共 ${history.length} 期，模型 ${ALL_MODELS.length} 个`)

/**
 * 测一个点：训练集长度固定为 train 期，结算 N 期，返回 ms/期。
 * 用 startAt/endAt 精确框住区间，history 传全量（取前缀用）。
 */
function measure(train, n) {
  const models = ALL_MODELS
  // 让被调用的模型始终看到 history[0..train) 这一段
  const opts = {
    lottery: LT,
    history: history.slice(0, train),
    budget: 30,
    profile: {},
    periods: n,
  }
  const t0 = performance.now()
  for (const m of models) backtest(m, opts)
  const ms = performance.now() - t0
  return { train, n, per: ms / n, total: ms }
}

const points = [
  { train: 300, n: 5 },
  { train: 600, n: 5 },
  { train: 1000, n: 5 },
  { train: 1500, n: 4 },
  { train: 2000, n: 3 },
  { train: 2500, n: 3 },
  { train: Math.min(2900, history.length - 10), n: 3 },
]

const rows = []
for (const p of points) {
  if (p.train + p.n > history.length) continue
  const r = measure(p.train, p.n)
  rows.push(r)
  console.log(
    `  train=${String(r.train).padStart(4)}  ${r.n} 期 / 78 模型  合计 ${(r.total / 1000).toFixed(1)}s  →  ${r.per.toFixed(0)} ms/期`
  )
}

// 线性拟合 per = a + b*train
const n = rows.length
const sx = rows.reduce((s, r) => s + r.train, 0)
const sy = rows.reduce((s, r) => s + r.per, 0)
const sxy = rows.reduce((s, r) => s + r.train * r.per, 0)
const sxx = rows.reduce((s, r) => s + r.train * r.train, 0)
const b = (n * sxy - sx * sy) / (n * sxx - sx * sx)
const a = (sy - b * sx) / n
console.log(`\n线性拟合：per(train) = ${a.toFixed(1)} + ${b.toFixed(4)} × train`)

// 残差检查：如果两端差很多，说明是非线性，线性拟合会低估长历史
console.log('残差检查（实测 vs 拟合）：')
for (const r of rows) {
  const fit = a + b * r.train
  const err = ((fit - r.per) / r.per) * 100
  console.log(
    `  train=${String(r.train).padStart(4)}  实测 ${r.per.toFixed(0)}  拟合 ${fit.toFixed(0)}  偏差 ${err > 0 ? '+' : ''}${err.toFixed(1)}%`
  )
}

// 用两种算法算「样本 1000」的总量，对比原来的估算
const total = history.length
const sample = 1000
const periods = Math.max(60, total - sample)
const start = Math.max(60, total - periods)
const oldPer = 239 + 0.177 * start
const oldMs = oldPer * periods
const newMs = estRawMs(start, total)
console.log(`\n样本 ${sample} ⇒ 回测 ${periods} 期（第 ${start + 1} ~ ${total} 期），训练集 ${start} → ${total}`)
console.log(`  旧公式( ${oldPer.toFixed(0)} ms/期 × ${periods} )：${(oldMs / 60000).toFixed(1)} 分钟`)
console.log(`  逐期积分：${(newMs / 60000).toFixed(1)} 分钟`)

// 现行公式与刚才实测点的对照：如果这里普遍偏差 >20%，就该把 COST 改掉重测
console.log('\n现行 perf.ts 公式与本次实测的对照（偏差 >20% 请更新 COST）：')
let worst = 0
for (const r of rows) {
  const fit = COST.fixed + COST.perTrain * r.train
  const err = ((fit - r.per) / r.per) * 100
  worst = Math.max(worst, Math.abs(err))
  console.log(
    `  train=${String(r.train).padStart(4)}  实测 ${r.per.toFixed(0)}  现行公式 ${fit.toFixed(0)}  偏差 ${err > 0 ? '+' : ''}${err.toFixed(1)}%`
  )
}
console.log(worst > 20 ? `  ⚠ 最大偏差 ${worst.toFixed(0)}%，建议更新 core/perf.ts 的 COST` : `  最大偏差 ${worst.toFixed(1)}%，公式仍可用`)

// ============================================================ 2. 校准逻辑
console.log('\n[2] 本机校准（实时速率必须能一步把 factor 拉到位）')
const fresh = { factor: 1, samples: 0, periods: 0, updatedAt: 0 }
const SLOW = 4.5 // 用户实测「预估 18 分钟、实跑 81 分钟」≈ 4.5 倍

const step1 = mergeCalib(fresh, SLOW, 1929, 1)
ok(
  '第一次观测就跳到实测值（旧权重不参与）',
  Math.abs(step1.factor - SLOW) < 0.01,
  `factor=${step1.factor.toFixed(2)}，期望 ${SLOW} —— 否则第一次跑的人看到的还是公式值`
)
ok(
  '计数与权重累加正确',
  step1.samples === 1 && step1.periods === 1929,
  `samples=${step1.samples} periods=${step1.periods}`
)
// 回测进行中会来几十次实时观测（每期一次），绝不能每次都算「一次实跑」，
// 否则界面会写出「已按本机 59 次实跑校准」这种鬼话
const live = mergeCalib(step1, SLOW, 1929, 2, false)
ok(
  '实时速率观测不增加「实跑次数」',
  live.samples === step1.samples && live.periods > step1.periods,
  `samples 保持 ${live.samples}，权重照常累加到 ${live.periods}`
)

// 同速再观测几次：不该漂移
let acc = step1
for (let i = 0; i < 5; i++) acc = mergeCalib(acc, SLOW, 1929, i)
ok('同速重复观测不漂移', Math.abs(acc.factor - SLOW) < 0.01, `factor=${acc.factor.toFixed(2)}`)

// 换到快机器（factor 应该向 1 收敛，而不是被旧观测锁死）
let fast = acc
for (let i = 0; i < 5; i++) fast = mergeCalib(fast, 1, 1929, i)
ok(
  '换快机器后仍能改得动',
  fast.factor < acc.factor - 0.5,
  `${acc.factor.toFixed(2)} → ${fast.factor.toFixed(2)}（旧权重封顶 ${MAX_WEIGHT}）`
)

// 极端值必须被夹住，否则一次后台降频就把预估永久拉爆
ok('离谱的慢观测被夹在上限 8 以内', (solveFactor(1, 1000, 2929) ?? 99) <= 8)
ok('零耗时（缓存直出）不产生观测', solveFactor(0, 1000, 2929) === null)
ok(
  '离谱的快观测被夹在下限 0.25 以上',
  (solveFactor(5e9, 1000, 2929) ?? -1) >= 0.25,
  `factor=${solveFactor(5e9, 1000, 2929)}`
)
ok('区间非法时返回 null', solveFactor(1000, 2000, 1000) === null)

// 端到端：外推出的全程时长必须等于真实耗时
const realMs = estRawMs(1000, 2929) * SLOW
const f2 = solveFactor(realMs, 1000, 2929) ?? 0
ok(
  '实跑时长 ⇒ factor ⇒ 再估回来是同一个数',
  Math.abs(estRawMs(1000, 2929) * f2 - realMs) < 1,
  `实跑 ${(realMs / 60000).toFixed(1)} 分钟 ⇒ factor=${f2.toFixed(2)}`
)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) process.exitCode = 1

await server.close()
