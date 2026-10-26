/**
 * store 层明细逻辑的 Node 端验证（临时脚本）。
 *
 * 为什么要单独搞一个：浏览器里点按钮点了半天没反应，而生产构建把
 * setupState / pinia 内部结构都裁掉了，想看状态都看不着。
 * 这里直接在 Node 里 createPinia + setActivePinia，把 store 跑起来，
 * 几秒钟就能定位是 store 逻辑的问题还是模板绑定的问题。
 *
 *   node scripts/probe-detail-store.mjs
 */
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
})

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

try {
  // pinia 必须和 store 走**同一个模块实例**：`ssrLoadModule` 每次会建独立的
  // 模块图，从外面 import 到的 pinia 与 store 内部用的不是同一个，
  // setActivePinia 会被 store 看不见（报 "no active Pinia"）。
  // 解法：用 Vite 的 ssrLoadModule 处理一个虚拟模块，让 pinia 也在同一张图里。
  const { createPinia, setActivePinia, watch } = await server.ssrLoadModule(
  '/scripts/probe/pinia-shim.ts'
)
  const pinia = createPinia()
  setActivePinia(pinia)

  const { useMainStore } = await server.ssrLoadModule('/src/stores/main.ts')
  const { ALL_MODELS, getModel } = await server.ssrLoadModule('/src/core/models/index.ts')
  const { runLeaderboardAsync } = await server.ssrLoadModule('/src/core/backtestRunner.ts')
  const packet = JSON.parse(
    (await import('node:fs')).readFileSync(
      new URL('../src/assets/lottery-data.json', import.meta.url), 'utf8'
    )
  )

  const store = useMainStore()
  console.log('\n[1] 灌历史')
  store.draws = packet.draws
  store.lottery = 'ssq'
  ok('历史已就绪', store.history.length > 0, `${store.history.length} 期`)

  // 跑一次短回测，让 boardInfo / board 落地（明细要对齐它）
  console.log('\n[2] 走真实的 runLeaderboard（不能用手动赋值绕开发布顺序）')
  // 手动给 board / boardInfo 赋值会绕过 saveBoard，正好漏掉这次要验的东西：
  // boardInfo 必须**先于** board 发布。曾经它排在四个 await putKV 之后，
  // 于是回测刚结束那几百毫秒里 board 有值、boardInfo 还是 null，
  // 依赖它的 loadDetail 直接静默失败。这里用 watch 抓发布瞬间的状态。
  const total = store.history.length
  let gap = null
  let sawBoard = false
  const stop = watch(
    () => (store.board.length ? 1 : 0) + (store.boardInfo ? 10 : 0),
    () => {
      if (store.board.length && !store.boardInfo) gap = 'board 有值但 boardInfo 为空'
      if (store.board.length) sawBoard = true
    },
    { flush: 'sync' }
  )
  // 缩短窗口：预算与样本都取小的，跑得快
  store.budget = 10
  const r = await store.runLeaderboard(20, { force: true })
  stop()
  ok('回测跑完', r.count > 0, `${r.count} 个模型`)
  ok('榜面已就绪（全部 78 个模型）', store.board.length === ALL_MODELS.length, `${store.board.length} 行`)
  ok('boardInfo 与 board 同步发布（无中间窗口）', gap === null, gap || '两者同拍')
  ok('board 确实发布过（否则上面那条是空跑）', sawBoard)

  console.log('\n[3] loadDetail')
  const target = store.board[0].modelId
  const before = store.board.find((b) => b.modelId === target)
  let done = false
  const p = store.loadDetail(target).then((v) => { done = true; return v })
  // 同步检查此刻的状态：loadDetail 里 detailLoading=true 是同步设的，
  // 而让出 20ms 之后才开始算。之前用 sleep 再看，短窗口下加载早就跑完了。
  const midLoading = store.detailLoading
  await p

  ok('调用期间 detailLoading=true', midLoading === true, String(midLoading))
  ok('返回后 detailLoading 已复位', store.detailLoading === false && done === true)
  ok('返回后 detailModelId 已设', store.detailModelId === target, store.detailModelId)
  ok('明细有行', store.detailRows.length > 0, `${store.detailRows.length} 行`)
  ok('结算期数与榜面一致', store.detailRows.length === before.trials,
    `明细 ${store.detailRows.length} / 榜面 ${before.trials}`)

  const cost = store.detailRows.reduce((a, r) => a + r.cost, 0)
  const prize = store.detailRows.reduce((a, r) => a + r.prize, 0)
  ok('投入与榜面逐位相等', cost === before.totalCost, `${cost} vs ${before.totalCost}`)
  ok('奖金与榜面逐位相等', prize === before.totalPrize, `${prize} vs ${before.totalPrize}`)

  const r0 = store.detailRows[0]
  ok('首行结构完整',
    !!r0.issue && Array.isArray(r0.hit.pickedFront) && Array.isArray(r0.hit.hitFront),
    `${r0.issue} 选 ${r0.hit.pickedFront.join('/')} 命中 ${r0.hit.hitFront.join('/') || '无'} → ${r0.level} 等奖`)

  console.log('\n[4] 缓存与清理')
  await store.loadDetail(target)
  ok('二次加载命中缓存', store.detailLoading === false && store.detailRows.length > 0)
  store.clearDetail()
  ok('clearDetail 清空', store.detailRows.length === 0 && store.detailModelId === '')
  ok('clearDetail 也清缓存',
    (await store.loadDetail(target), store.detailRows.length > 0))

  console.log('\n[5] clearDetail 不能打断正在进行的加载')
  // 这条是真实踩过的坑：回测一完成 board 就有值，boardInfo 还要等几个 putKV，
  // 用户在这几百毫秒里点「明细」，加载途中又有个 watch 调 clearDetail()，
  // 把 detailModelId 抹了而 rows 稍后才写回 —— UI 停在占位文案上，看起来像"点了没反应"。
  // 现在 clearDetail 见到 detailLoading=true 就改为 cancel，交给这一轮自己收尾，
  // 且取消只清数据、保留已选中的模型（否则用户看不出刚才选的是谁）。
  const p2 = store.loadDetail(store.board[1].modelId)
  // 同步清：此刻 detailLoading 已是 true，clearDetail 应改为 cancel 而非抹掉模型
  store.clearDetail()
  await p2
  ok('加载中被 clearDetail 打断：保留模型、清空数据、无半成品',
    store.detailModelId === store.board[1].modelId &&
    store.detailRows.length === 0 &&
    store.detailError === '已停止',
    `modelId=${store.detailModelId} rows=${store.detailRows.length} err=${store.detailError}`)

  console.log('\n[6] boardInfo 必须与 board 同步可见')
  // loadDetail 靠 boardInfo 决定用哪份模型数组、哪个结算区间。
  // 曾经 boardInfo 被放在四个 await 之后赋值，回测刚结束那几百毫秒里它是 null，
  // 此时点「明细」会静默失败。现在要求：board 非空时 boardInfo 必须已就绪。
  store.board = []
  store.boardInfo = null
  const noBoard = await store.loadDetail(target)
  ok('没有榜面时明确报错而不是静默返回',
    noBoard === false && !!store.detailError, store.detailError)

  console.log('\n[7] 明细的 modelIndex 必须取自当次那份模型数组')
  // 用错位下标重算，结果应当不同——这正是 store 必须按 ALL_MODELS
  // 取下标、而不能随手 findIndex 的原因。
  // 必须挑一个**用到随机数**的模型（玄学抽签/机选…）：确定性模型对种子不敏感，
  // 换下标也照样同号码，拿它去证伪会得到假的"通过"。
  const { runDetailAsync: rd } = await server.ssrLoadModule('/src/core/backtestRunner.ts')
  const seedModel = 'Q06'
  // 区间必须与上面那次真实回测一致，否则比的不是同一批期
  const start = Math.max(60, total - 20)
  const mi = ALL_MODELS.findIndex((m) => m.meta.id === seedModel)
  const good = await rd({
    lottery: 'ssq', history: store.history, budget: store.budget, profile: store.profile,
    model: getModel(seedModel), modelIndex: mi, from: start, to: total,
  })
  const bad = await rd({
    lottery: 'ssq', history: store.history, budget: store.budget, profile: store.profile,
    model: getModel(seedModel), modelIndex: mi + 1, from: start, to: total,
  })
  ok('错位下标会算出不同号码（用随机模型才证伪得动）',
    bad.some((r, i) => JSON.stringify(r.hit.pickedFront) !== JSON.stringify(good[i].hit.pickedFront)),
    `${seedModel}：${good.length} 期里有 ${bad.filter((r, i) => JSON.stringify(r.hit.pickedFront) !== JSON.stringify(good[i].hit.pickedFront)).length} 期不同`)

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail ? 1 : 0
} finally {
  await server.close()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}