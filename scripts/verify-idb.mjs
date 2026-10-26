/**
 * IndexedDB 后端的专项验证。
 *
 * idb.ts 是网页端的主力实现，只用内存适配器验契约是不够的——
 * 那测的是接口语义，测不到 IndexedDB 本身的 API 误用（事务生命周期、
 * onupgradeneeded 里建 store、keyPath 冲突等）。
 *
 * 这里用 fake-indexeddb 在 Node 里模拟浏览器环境，跑同一组断言。
 *   node scripts/verify-idb.mjs
 */
import 'fake-indexeddb/auto'
import { createServer } from 'vite'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}  ${extra}`)
  }
}

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

try {
  const { idbAdapter } = await server.ssrLoadModule('/src/adapters/storage/idb.ts')
  const STT = await server.ssrLoadModule('/src/adapters/storage/types.ts')
  const { readFileSync } = await import('node:fs')

  console.log('[idb] IndexedDB 后端真实')
  console.log('  明细见 memory 版同套断言，此处只验证 IndexedDB 特有行为\n')

  const raw = JSON.parse(readFileSync('src/assets/lottery-data.json', 'utf-8'))
  const ssq = raw.draws
    .filter((d) => d.lottery === 'ssq')
    .sort((a, b) => a.issue.localeCompare(b.issue))

  // 空库起点
  ok('空库 countDraws = 0', (await idbAdapter.countDraws('ssq')) === 0)

  // 首次灌库 500 期
  const seed = ssq.slice(0, 500)
  const t0 = performance.now()
  const added = await idbAdapter.upsertDraws(seed)
  const ms = performance.now() - t0
  ok('灌库 500 期', added === 500, `新增 ${added} 条，${ms.toFixed(0)} ms`)
  ok('countDraws 反映写入', (await idbAdapter.countDraws('ssq')) === 500)

  // 重复写入应当全部被去重
  const t1 = performance.now()
  const again = await idbAdapter.upsertDraws(seed)
  ok('重复灌库被去重', again === 0, `${(performance.now() - t1).toFixed(0)} ms`)

  // 增量追加（模拟拉到新一期）
  const more = ssq.slice(500, 505)
  const inc = await idbAdapter.upsertDraws(more)
  ok('增量追加 5 期', inc === 5 && (await idbAdapter.countDraws('ssq')) === 505)

  // 读取并校验内容无损
  const got = await idbAdapter.getDraws('ssq')
  ok('读出条数正确', got.length === 505, `${got.length} 条`)
  ok('按期号升序', got.every((d, i) => i === 0 || got[i - 1].issue.localeCompare(d.issue) <= 0))
  const sampleDraw = got.find((d) => d.issue === seed[42].issue)
  ok(
    '号码数组往返无损',
    sampleDraw &&
      JSON.stringify(sampleDraw.front) === JSON.stringify(seed[42].front) &&
      JSON.stringify(sampleDraw.back) === JSON.stringify(seed[42].back),
    `${sampleDraw?.front.join(',')} + ${sampleDraw?.back.join(',')}`
  )

  // 只按彩种过滤
  const dltOnly = raw.draws.filter((d) => d.lottery === 'dlt').slice(0, 10)
  await idbAdapter.upsertDraws(dltOnly)
  ok('彩种隔离', (await idbAdapter.getDraws('dlt')).length === 10 &&
     (await idbAdapter.getDraws('ssq')).length === 505)

  // 回测汇总
  const runKey = STT.makeRunKey({ lottery: 'ssq', budget: 30, sample: 1000 })
  const rows = [
    { runKey, modelId: 'S01', modelName: '热号追踪', category: 'stat', trials: 100,
      totalCost: 3000, totalPrize: 800, roi: -0.73, winRate: 0.2, bestLevel: 3,
      hits: { 3: 1, 6: 18 }, equity: [-30, -60, -20] },
    { runKey, modelId: 'B01', modelName: '真随机基线', category: 'baseline', trials: 100,
      totalCost: 3000, totalPrize: 900, roi: -0.7, winRate: 0.21, bestLevel: 3,
      hits: { 6: 20 }, equity: [-30, -50, 0] },
  ]
  await idbAdapter.putSummary(rows)
  await idbAdapter.putRun({ runKey, lottery: 'ssq', budget: 30,
    sample: 1000, periods: 505, modelCount: 2, createdAt: Date.now() })

  const back = await idbAdapter.getSummary(runKey)
  ok('汇总往返一致', back.length === 2, `${back.length} 条`)
  const a01 = back.find((r) => r.modelId === 'S01')
  ok('equity 往返无损', JSON.stringify(a01?.equity) === JSON.stringify([-30, -60, -20]))
  ok('hits 往返无损', JSON.stringify(a01?.hits) === JSON.stringify({ 3: 1, 6: 18 }))
  ok('按 ROI 降序', back[0].roi >= back[1].roi, `${back[0].modelId} → ${back[1].modelId}`)

  // 重跑同名 runKey 不残留
  await idbAdapter.putSummary([rows[0]])
  ok('重跑不残留旧模型', (await idbAdapter.getSummary(runKey)).length === 1)

  await idbAdapter.deleteRun(runKey)
  ok('删批次连带清汇总',
    (await idbAdapter.getSummary(runKey)).length === 0 && !(await idbAdapter.getRun(runKey)))

  // 用户状态
  ok('默认用户状态', (await idbAdapter.getUserState()).budget === 30)
  await idbAdapter.putUserState({ ...STT.DEFAULT_USER_STATE, budget: 200, favorites: ['M01', 'X04'] })
  const u = await idbAdapter.getUserState()
  ok('用户状态往返', u.budget === 200 && u.favorites.length === 2)

  // Vue 响应式代理：IndexedDB 写入走结构化克隆，**克隆不了 Proxy**。
  // store 里的 profile / favorites / boardInfo 全是代理，调用方不可能每次都记得 toRaw，
  // 所以净化必须做在落库这一层。这条守着「保存成功但刷新就没了」那个 bug。
  const { reactive } = await import('vue')
  await idbAdapter.putUserState({
    ...STT.DEFAULT_USER_STATE,
    profile: reactive({ name: '王小明', birthDate: '1990-05-06' }),
    favorites: reactive(['M01', 'X04']),
  })
  const pu = await idbAdapter.getUserState()
  ok('响应式代理也能落库（IDB 克隆不了 Proxy）',
     pu.profile?.name === '王小明' && pu.favorites.length === 2,
     `${JSON.stringify(pu.profile)} / ${pu.favorites.length} 个收藏`)

  // 汇总里的 equity 是数组，同样可能带着代理进来
  await idbAdapter.putSummary([{ ...rows[0], equity: reactive([-30, -60]) }])
  ok('汇总里的代理数组也能落库',
     JSON.stringify((await idbAdapter.getSummary(runKey))[0]?.equity) === JSON.stringify([-30, -60]))

  await idbAdapter.clearAll()
  ok('清空全部', (await idbAdapter.countDraws('ssq')) === 0 &&
     (await idbAdapter.getUserState()).budget === 30)

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail ? 1 : 0
} finally {
  await server.close()
}
