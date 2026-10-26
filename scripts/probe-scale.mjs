/**
 * 回测耗时缩放测量：判断慢的是「每期成本」还是「固定冷启动开销」。
 * 每轮用不同 prefer 构造不同 run_key，避免命中缓存。
 */
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) {
    return this._m.has(k) ? this._m.get(k) : null
  },
  setItem(k, v) {
    this._m.set(k, String(v))
  },
  removeItem(k) {
    this._m.delete(k)
  },
}
globalThis.window = globalThis

const { useMainStore } = await server.ssrLoadModule('/src/stores/main.ts')
setActivePinia(createPinia())
const store = useMainStore()
await store.loadData()
console.log(`数据就绪：${store.draws.length} 期\n`)

const results = []

console.log('  期数   模型数   耗时(ms)   每期成本(ms)')
console.log('  ----   ------   --------   -----------')
for (const [i, periods] of [20, 40, 80].entries()) {
  // 不同 periods -> 不同的 sample -> run_key 不同，必重算
  const t = performance.now()
  await store.runLeaderboard(periods)
  const ms = performance.now() - t
  const per = ms / periods
  results.push({ periods, ms, per })
  console.log(
    `  ${String(periods).padStart(4)}   ${String(store.board.length).padStart(6)}   ` +
      `${ms.toFixed(0).padStart(8)}   ${per.toFixed(1).padStart(11)}`
  )
}

console.log('\n── 解读 ──')
const [a, b, c] = results
const slopeBC = (c.ms - b.ms) / (c.periods - b.periods)
const slopeAB = (b.ms - a.ms) / (b.periods - a.periods)
console.log(`  20→40 期边际成本：${slopeAB.toFixed(1)} ms/期`)
console.log(`  40→80 期边际成本：${slopeBC.toFixed(1)} ms/期`)
const fixed = b.ms - slopeAB * b.periods
console.log(`  推算固定开销：约 ${fixed.toFixed(0)} ms`)
console.log(
  fixed > 5000
    ? `  → 冷启动占大头（${((fixed / b.ms) * 100).toFixed(0)}%），首屏首次回测慢，之后按 ${slopeAB.toFixed(1)} ms/期线性增长`
    : '  → 主要是每期成本，随期数线性增长'
)

// 再跑一次同参数，看预算筛选/枚举缓存的复用收益
const t2 = performance.now()
const r = await store.runLeaderboard(40)
console.log(`\n  同参数二次：${(performance.now() - t2).toFixed(0)}ms  缓存=${r.cached}`)

await server.close()
