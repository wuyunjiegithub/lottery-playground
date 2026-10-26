/**
 * 探针：验证「新增开奖后只补算新期」在真实 store 里的端到端行为与收益。
 *
 * 要证明三件事：
 *   1. 首次是全量重算；数据新增后再次点击，走的是「增量补算」而不是全量重算；
 *   2. 增量补算耗时 ≈ (新增期数 / 总期数) × 全量耗时，而不是又一次全量；
 *   3. 增量补算出来的排行榜，与「清缓存后完全重算」的结果逐位相同。
 *
 *   node scripts/probe-incremental.mjs
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

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  [OK]   ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`)
  }
}

const { useMainStore } = await server.ssrLoadModule('/src/stores/main.ts')
const { getStorage, resetStorageCache } = await server.ssrLoadModule(
  '/src/adapters/storage/index.ts'
)

setActivePinia(createPinia())
const store = useMainStore()
await store.loadData()

// 用大乐透（默认彩种），窗口取 12 期，让全量重算在十几秒内跑完
const total0 = store.history.length
const WINDOW = 12
const SAMPLE = total0 - WINDOW
console.log(`\n── 环境 ──`)
console.log(`  ${store.lottery} 共 ${total0} 期，训练集 ${SAMPLE} 期，回测窗口 ${WINDOW} 期`)

const boardSignature = (b) =>
  b.map((r) => `${r.modelId}:${r.trials}:${r.totalCost}:${r.totalPrize}:${JSON.stringify(r.hits)}:${r.equity.join(',')}`).join('|')

// ---------------------------------------------------------------- 1. 全量
console.log('\n── 1. 首次回测（应为全量重算）──')
const t1 = performance.now()
const r1 = await store.runLeaderboard(WINDOW)
const ms1 = performance.now() - t1
console.log(`  cached=${r1.cached} extended=${r1.extended} count=${r1.count}，耗时 ${Math.round(ms1)}ms`)
ok('首次不是缓存命中', r1.cached === false)
ok('首次 extended = 0（没有可续算的账本）', r1.extended === 0)
ok('排行榜有结果', store.board.length > 0, `${store.board.length} 行`)
console.log(`  上次回测落盘信息：upTo=${store.boardInfo?.upTo} periods=${store.boardInfo?.periods} duration=${store.boardInfo?.durationMs}ms`)
ok('落盘记录了锚点 upTo', store.boardInfo?.upTo === total0, `upTo=${store.boardInfo?.upTo}`)

const fullBoard = boardSignature(store.board)

// ---------------------------------------------------------------- 2. 模拟新增 2 期
console.log('\n── 2. 模拟官方又开了 2 期 ──')
const NEW = 2
const lastIssue = Number(store.history[store.history.length - 1].issue)
const synth = []
for (let k = 1; k <= NEW; k++) {
  synth.push({
    lottery: store.lottery,
    issue: String(lastIssue + k).padStart(String(lastIssue).length, '0'),
    date: '2026-10-10',
    front: [1, 2, 3, 4, 5].slice(0, store.rule.frontCount),
    back: [1, 2].slice(0, store.rule.backCount),
    prizes: {},
    source: 'probe',
  })
}
await (await getStorage()).upsertDraws(synth)
store.draws = [...store.draws, ...synth]
const total1 = store.history.length
console.log(`  历史 ${total0} → ${total1} 期`)

// ---------------------------------------------------------------- 3. 增量补算
console.log('\n── 3. 再次点击（应为增量补算）──')
const t2 = performance.now()
const r2 = await store.runLeaderboard(total1 - SAMPLE)
const ms2 = performance.now() - t2
console.log(`  cached=${r2.cached} extended=${r2.extended} count=${r2.count}，耗时 ${Math.round(ms2)}ms`)
ok('走了增量补算路径', r2.cached === false && r2.extended === NEW, `extended=${r2.extended}`)
ok('增量明显快于全量', ms2 < ms1 / 3, `${Math.round(ms2)}ms vs ${Math.round(ms1)}ms`)
console.log(`  加速比约 ${(ms1 / ms2).toFixed(1)}×`)

const incBoard = boardSignature(store.board)
const incRows = new Map(store.board.map((r) => [r.modelId, r]))

// ---------------------------------------------------------------- 4. 清缓存重算对照
console.log('\n── 4. 清缓存后完全重算（对照组）──')
const t3 = performance.now()
await store.runLeaderboard(total1 - SAMPLE, { force: true })
const ms3 = performance.now() - t3
const forcedBoard = boardSignature(store.board)
console.log(`  耗时 ${Math.round(ms3)}ms`)
console.log(`  行数：增量 ${incRows.size}，全量 ${store.board.length}`)
if (incBoard !== forcedBoard) {
  let shown = 0
  for (const b of store.board) {
    const a = incRows.get(b.modelId)
    if (!a) {
      console.log(`    ✗ ${b.modelId} 只存在于全量结果里`)
      continue
    }
    // 注意：这里按 modelId 对齐。之前按数组下标对齐会错位——
    // 榜面按 ROI 排序，任何一个模型的数字变了都会让整列错位，看着像"全员都变"。
    const bad = []
    if (a.trials !== b.trials) bad.push(`trials ${a.trials}→${b.trials}`)
    if (a.totalCost !== b.totalCost) bad.push(`cost ${a.totalCost}→${b.totalCost}`)
    if (a.totalPrize !== b.totalPrize) bad.push(`prize ${a.totalPrize}→${b.totalPrize}`)
    if (JSON.stringify(a.hits) !== JSON.stringify(b.hits)) bad.push(`hits ${JSON.stringify(a.hits)}→${JSON.stringify(b.hits)}`)
    if (a.equity.length !== b.equity.length) bad.push(`equityLen ${a.equity.length}→${b.equity.length}`)
    else if (a.equity.join() !== b.equity.join()) {
      const k = a.equity.findIndex((v, j) => v !== b.equity[j])
      bad.push(`equity[${k}] ${a.equity[k]}→${b.equity[k]}`)
    }
    if (bad.length && shown++ < 8) console.log(`    ✗ ${b.modelId} ${b.modelName}: ${bad.join(' | ')}`)
  }
}
ok('增量结果 == 全量重算结果（逐位相同）', incBoard === forcedBoard)

// ---------------------------------------------------------------- 5. 再次点击应秒开
console.log('\n── 5. 数据没变，再点一次 ──')
const t4 = performance.now()
const r4 = await store.runLeaderboard(total1 - SAMPLE)
const ms4 = performance.now() - t4
console.log(`  cached=${r4.cached}，耗时 ${Math.round(ms4)}ms`)
ok('缓存覆盖全部历史时直接秒开', r4.cached === true)
ok('秒开耗时在毫秒级', ms4 < 500, `${Math.round(ms4)}ms`)

// ---------------------------------------------------------------- 6. 改预算必须重算
console.log('\n── 6. 改预算（票型变了，不能复用账本）──')
store.budget = 50
const t5 = performance.now()
const r5 = await store.runLeaderboard(total1 - SAMPLE)
const ms5 = performance.now() - t5
console.log(`  cached=${r5.cached} extended=${r5.extended}，耗时 ${Math.round(ms5)}ms`)
ok('换预算触发全量重算', r5.cached === false && r5.extended === 0)
ok('换预算结果与旧账本不同', boardSignature(store.board) !== forcedBoard)

// ---------------------------------------------------------------- 7. 进度状态收尾
console.log('\n── 7. 进度状态 ──')
ok('进度收敛到 done', store.progress.phase === 'done', store.progress.phase)
ok('进度比例到 100%', store.progress.ratio === 1)

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exitCode = fail ? 1 : 0
