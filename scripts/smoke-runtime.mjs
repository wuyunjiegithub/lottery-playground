/**
 * 运行时冒烟：在 Node 里用 fake-indexeddb 模拟浏览器，
 * 真跑一遍 store 的 loadData / 回测缓存往返，抓运行期异常。
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

let pass = 0
let fail = 0
const t0All = performance.now()

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  [OK]   ${name}${detail ? '  ' + detail : ''}`)
  } else {
    fail++
    console.log(`  [FAIL] ${name}${detail ? '  ' + detail : ''}`)
  }
}

// 提供最低限度的 window / localStorage 语义，store 会用到
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
globalThis.indexedDB = globalThis.indexedDB

const { useMainStore } = await server.ssrLoadModule('/src/stores/main.ts')
const { getStorage, resetStorageCache } = await server.ssrLoadModule(
  '/src/adapters/storage/index.ts'
)

setActivePinia(createPinia())
const store = useMainStore()

console.log('\n── 1. 存储后端探测 ──')
const st = await getStorage()
console.log(`  后端：${st.kind}`)
ok('浏览器环境应选中 IndexedDB', st.kind === 'idb', `实得 ${st.kind}`)

console.log('\n── 2. 首次 loadData（灌库 6438 期）──')
const t1 = performance.now()
try {
  await store.loadData()
  const ms = performance.now() - t1
  ok('loadData 无异常', store.error === '', store.error || `耗时 ${ms.toFixed(0)}ms`)
  console.log(`  耗时 ${ms.toFixed(0)}ms，载入 ${store.draws.length} 期`)
  ok('数据非空', store.draws.length > 6000, `${store.draws.length} 期`)
  ok('loading 已复位', store.loading === false)
} catch (e) {
  ok('loadData 无异常', false, String(e))
}

console.log('\n── 3. 期号顺序（回测正确性前提）──')
const ssq = store.history.filter((d) => d.lottery === 'ssq')
const dlt = store.history.filter((d) => d.lottery === 'dlt')
function ascending(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (Number(rows[i].issue) <= Number(rows[i - 1].issue)) return false
  }
  return true
}
ok('双色球按期号升序', ascending(ssq), `${ssq.length} 期`)
ok('大乐透按期号升序', ascending(dlt), `${dlt.length} 期`)
ok(
  '最新一期取到正确值',
  ssq.length > 0 && Number(ssq[ssq.length - 1].issue) === 2026112,
  `末期 ${ssq[ssq.length - 1]?.issue}`
)

console.log('\n── 4. 二次打开（应命中库，走增量路径）──')
resetStorageCache()
setActivePinia(createPinia())
const store2 = useMainStore()
const t2 = performance.now()
await store2.loadData()
const ms2 = performance.now() - t2
console.log(`  二次打开耗时 ${ms2.toFixed(0)}ms，载入 ${store2.draws.length} 期`)
ok('二次打开数据一致', store2.draws.length === store.draws.length)
ok('二次打开应更快（无全量写入）', ms2 < 3000, `${ms2.toFixed(0)}ms`)

console.log('\n── 5. 用户状态持久化往返 ──')
const st2 = await getStorage()
await st2.putUserState({ budget: 100, favorites: ['S01', 'X04'] })
const back = await st2.getUserState()
ok('预算写回', back.budget === 100, `实得 ${back.budget}`)
ok('收藏写回', Array.isArray(back.favorites) && back.favorites.includes('S01'), `实得 ${JSON.stringify(back.favorites)}`)
ok('无偏好字段残留', !('prefer' in back), `含 ${Object.keys(back).join(',')}`)

console.log('\n── 6. 小样本回测 + 落库 ──')
const t3 = performance.now()
const r1 = await store2.runLeaderboard(30)
const ms3 = performance.now() - t3
console.log(`  30 期 × 64 模型，耗时 ${ms3.toFixed(0)}ms，缓存=${r1.cached}`)
ok('排行榜有结果', store2.board.length > 0, `${store2.board.length} 行`)
ok('首次运行非缓存', r1.cached === false)

const t4 = performance.now()
const r2 = await store2.runLeaderboard(30)
const ms4 = performance.now() - t4
console.log(`  二次调用耗时 ${ms4.toFixed(0)}ms，缓存=${r2.cached}`)
ok('二次命中缓存', r2.cached === true)
ok('缓存读取更快', ms4 < ms3, `${ms4.toFixed(0)}ms vs ${ms3.toFixed(0)}ms`)
ok(
  '缓存后行数一致',
  store2.board.length === r1.count,
  `${store2.board.length} vs ${r1.count}`
)

console.log('\n── 7. 换预算应触发重算（不能误命中）──')
store2.budget = 50
const r3 = await store2.runLeaderboard(30)
console.log(`  预算改为 50 后：缓存=${r3.cached}`)
ok('改预算后未命中旧缓存', r3.cached === false)

console.log(
  `\n通过 ${pass} 项，失败 ${fail} 项，总耗时 ${((performance.now() - t0All) / 1000).toFixed(1)}s`
)
await server.close()
process.exit(fail ? 1 : 0)
