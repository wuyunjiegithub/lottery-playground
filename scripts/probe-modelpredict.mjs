import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const M = await server.ssrLoadModule('/src/core/models/index.ts')

const raw = JSON.parse(readFileSync('src/assets/lottery-data.json', 'utf-8'))
const byLot = (l) => raw.draws.filter((d) => d.lottery === l).sort((a, b) => a.issue.localeCompare(b.issue))

for (const lot of ['dlt', 'ssq']) {
  const history = byLot(lot)
  console.log(`\n=== ${lot} 共 ${history.length} 期，逐模型单次 predict ===`)
  let total = 0
  const per = []
  for (const m of M.ALL_MODELS) {
    const t0 = performance.now()
    try {
      m.predict({ history, lottery: lot, nextDate: new Date(), profile: {} })
    } catch (e) {
      console.log(`  ${m.meta.id} 报错: ${e.message}`)
    }
    const ms = performance.now() - t0
    total += ms
    per.push({ id: m.meta.id, ms, heavy: !!m.heavy })
  }
  per.sort((a, b) => b.ms - a.ms)
  console.log(`  合计 ${M.ALL_MODELS.length} 模型 = ${total.toFixed(0)} ms`)
  console.log(`  最慢 5 个：`)
  for (const p of per.slice(0, 5)) console.log(`    ${p.id} ${p.heavy ? '[重]' : '[轻]'} ${p.ms.toFixed(0)} ms`)
  const lightOnly = per.filter((p) => !p.heavy).reduce((a, b) => a + b.ms, 0)
  console.log(`  仅轻模型 ${per.filter((p) => !p.heavy).length} 个 = ${lightOnly.toFixed(0)} ms`)
}

await server.close()
