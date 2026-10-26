/**
 * 诊断：第 i 期的结果，真的只依赖 history[0..i) 吗？
 *
 * 这是增量补算成立的全部理由。如果给它一段更长的历史（尾部多了两期），
 * 前面那些期的结果居然变了，那就说明有模型在偷看它不该看的数据——
 * 增量补算、以及"回测可复现"都会随之失效。
 *
 *   node scripts/diag-prefix.mjs
 */
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
})

const packet = JSON.parse(
  readFileSync(new URL('../src/assets/lottery-data.json', import.meta.url), 'utf8')
)
const RT = await server.ssrLoadModule('/src/core/backtestRunner.ts')
const M = await server.ssrLoadModule('/src/core/models/index.ts')

const dlt = packet.draws
  .filter((d) => d.lottery === 'dlt')
  .sort((a, b) => a.issue.localeCompare(b.issue))

const SHORT = 2929 // 「当时」的历史长度
const FROM = 2917
const TO = 2929
const h0 = dlt.slice(0, SHORT)
const hFull = [
  ...dlt.slice(0, SHORT),
  { lottery: 'dlt', issue: '26112', date: '2026-09-30', front: [1, 2, 3, 4, 5], back: [1, 2] },
  { lottery: 'dlt', issue: '26113', date: '2026-10-03', front: [6, 7, 8, 9, 10], back: [3, 4] },
]

console.log(`短历史 ${h0.length} 期，长历史 ${hFull.length} 期，比较区间 [${FROM}, ${TO})`)
console.log(`h0[FROM] = ${h0[FROM].issue}   hFull[FROM] = ${hFull[FROM].issue}`)
console.log(`h0[TO-1] = ${h0[TO - 1].issue}   hFull[TO-1] = ${hFull[TO - 1].issue}`)

const MODELS = M.ALL_MODELS

async function run(history) {
  const acc = await RT.runLeaderboardAsync({
    lottery: 'dlt', history, budget: 30, profile: {}, models: MODELS, from: FROM, to: TO,
  })
  return acc
}

const A = await run(h0)
const B = await run(hFull)

let bad = 0
MODELS.forEach((m, i) => {
  const a = A[i]
  const b = B[i]
  const diff =
    a.totals.totalPrize !== b.totals.totalPrize ||
    JSON.stringify(a.totals.hits) !== JSON.stringify(b.totals.hits) ||
    a.equity.join() !== b.equity.join()
  if (diff) {
    bad++
    console.log(`  ✗ ${m.meta.id} ${m.meta.name}`)
    console.log(`     短历史 hits=${JSON.stringify(a.totals.hits)} equity=${a.equity.join(',')}`)
    console.log(`     长历史 hits=${JSON.stringify(b.totals.hits)} equity=${b.equity.join(',')}`)
  }
})
console.log(`\n受影响模型 ${bad} / ${MODELS.length}`)

// 再单独跑一次同样的输入，确认运行本身是确定的
const C = await run(hFull)
const stable = C.every((c, i) => c.equity.join() === B[i].equity.join())
console.log(`同一输入连跑两次是否一致：${stable ? '是' : '否'}`)
process.exitCode = bad ? 1 : 0
