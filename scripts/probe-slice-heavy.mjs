/**
 * 测「默认配置」（全部 78 个模型）下单次占用主线程的峰值。
 *
 * 为什么要单独测：分片的SLICE_MS 是 24ms，但一个工作单元 = 一个模型的
 * 一次 predict，**它本身是原子的、切不开**。重型模型里最贵的 S36（MLP）
 * 单次 predict 实测 192ms，远超一片的预算。
 * 于是「每片 ≤ 24ms」这个设计目标在重型模型上根本达不到——
 * 不是分片写错了，是单个单元太重。
 *
 * 这个脚本量出真实峰值，用来回答两个问题：
 *   1) 峰值到底是多少，界面会不会卡到用户以为死了；
 *   2) 要不要/能不能把重型模型的工作单元再拆细。
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const M = await server.ssrLoadModule('/src/core/models/index.ts')
const RT = await server.ssrLoadModule('/src/core/backtestRunner.ts')
const { loadPacket } = await server.ssrLoadModule('/src/adapters/net.ts')

const packet = await loadPacket()
const ssq = packet.filter((d) => d.lottery === 'ssq').sort((a, b) => a.issue.localeCompare(b.issue))

// 模拟真实回测：训练历史 = 前 1000 期（页面默认样本），回测 8 期
const TRAIN = 1000
const history = ssq.slice(0, TRAIN + 8)
const from = TRAIN
const to = history.length

console.log(`训练 ${TRAIN} 期、回测 ${to - from} 期 × ${M.ALL_MODELS.length} 模型\n`)

const gaps = []
const t0 = Date.now()
await RT.runLeaderboardAsync(
  { lottery: 'ssq', history, budget: 30, profile: {}, models: M.ALL_MODELS, from, to },
  { onProgress: () => gaps.push(Date.now()) }
)
const total = Date.now() - t0

let maxGap = 0
for (let i = 1; i < gaps.length; i++) maxGap = Math.max(maxGap, gaps[i] - gaps[i - 1])

console.log(`总耗时 ${(total / 1000).toFixed(1)}s｜切了 ${gaps.length} 片`)
console.log(`最长单片 ${maxGap} ms`)
console.log(`平均每片 ${(total / Math.max(1, gaps.length)).toFixed(1)} ms`)

// 逐个模型量单次 predict 在这个训练长度下的耗时，找出真正的元凶
console.log('\n── 训练 1000 期时，各模型单次 predict ──')
const per = []
for (const m of M.ALL_MODELS) {
  const t = performance.now()
  m.predict({ history: history.slice(0, from), lottery: 'ssq', nextDate: new Date(2026, 0, 1), profile: {} })
  per.push({ id: m.meta.id, name: m.meta.name, ms: performance.now() - t, heavy: !!m.heavy })
}
per.sort((a, b) => b.ms - a.ms)
for (const p of per.slice(0, 8)) {
  console.log(`  ${p.id} ${p.heavy ? '[重]' : '[轻]'} ${p.ms.toFixed(1).padStart(6)} ms  ${p.name}`)
}
const over = per.filter((p) => p.ms > 100)
console.log(`\n单次 > 100ms 的模型：${over.length} 个${over.length ? '（' + over.map((p) => p.id).join(' ') + '）' : ''}`)
console.log(`最贵的单个：${per[0].id} ${per[0].ms.toFixed(0)}ms —— 这是分片切不开的下界`)

await server.close()