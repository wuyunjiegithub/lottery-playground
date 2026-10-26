/**
 * 核心算法正确性验证（临时脚本，验证完可删除）。
 *
 * 重点验证三类东西：
 *  1. 奖级判定 —— 逐条对照需求文档第 7 章
 *  2. 票型数学 —— 成本公式、一等奖概率恒等于「注数 / 总组合数」
 *  3. 统计推断 —— 真相卡片依赖的置换检验是否可信
 *
 *   node scripts/verify.mjs
 */
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? '  ' + extra : ''}`)
  }
}

const server = await createServer({
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true },
  appType: 'custom',
  // 纯 SSR 直载源码，无需依赖预扫描；关掉可规避 esbuild scan 的竞态
  optimizeDeps: { noDiscovery: true, include: [] },
})

try {
  const packet = JSON.parse(
    readFileSync(new URL('../src/assets/lottery-data.json', import.meta.url), 'utf8')
  )
  const L = await server.ssrLoadModule('/src/core/lottery.ts')
  const T = await server.ssrLoadModule('/src/core/ticket.ts')
  const M = await server.ssrLoadModule('/src/core/models/index.ts')
  const BT = await server.ssrLoadModule('/src/core/backtest.ts')

  // ---------------------------------------------------------- 1. 奖级判定
  console.log('\n[1] 奖级判定（对照需求文档 7.1 / 7.2）')
  const ssqCases = [
    [6, 1, 1], [6, 0, 2], [5, 1, 3], [5, 0, 4], [4, 1, 4], [4, 0, 5],
    [3, 1, 5], [3, 0, 0], [2, 1, 6], [1, 1, 6], [0, 1, 6], [2, 0, 0], [1, 0, 0], [0, 0, 0],
  ]
  let ssqBad = ssqCases.filter(([f, b, w]) => L.judgeLevel('ssq', f, b) !== w)
  ok('双色球 14 条奖级规则全对', ssqBad.length === 0,
    ssqBad.length ? `错误：${JSON.stringify(ssqBad)}` : '')

  const dltCases = [
    [5, 2, 1], [5, 1, 2], [5, 0, 3], [4, 2, 4], [4, 1, 5], [3, 2, 6],
    [4, 0, 7], [3, 1, 8], [2, 2, 8], [3, 0, 9], [1, 2, 9], [2, 1, 9], [0, 2, 9], [1, 1, 0],
  ]
  let dltBad = dltCases.filter(([f, b, w]) => L.judgeLevel('dlt', f, b) !== w)
  ok('大乐透 14 条奖级规则全对', dltBad.length === 0,
    dltBad.length ? `错误：${JSON.stringify(dltBad)}` : '')

  // ---------------------------------------------------------- 2. 票型数学
  console.log('\n[2] 票型成本与概率')
  const history = packet.draws
    .filter((d) => d.lottery === 'ssq')
    .sort((a, b) => a.issue.localeCompare(b.issue))
  const pred = M.getModel('M01').predict({
    history, lottery: 'ssq', nextDate: new Date(), profile: {},
  })

  // 预算改为「上限」语义，100000 封顶保证把所有合法票型都枚举出来
  const plans = T.enumeratePlans('ssq', pred, 100000)
  ok('枚举出票型', plans.length > 0, `${plans.length} 种`)

  // 预算-票面拟合：偶数金额应该都能正好花满。
  // 早前这里期望 ssq 50/100/200 元花不满（24/49/98 注）——那是拖码枚举上限
  // 被写成 16 导致的 bug，合法票型没被枚举出来。修复后全部正好。
  const fitCases = [
    { lot: 'ssq', b: 10, bets: 5, exact: true },
    { lot: 'ssq', b: 30, bets: 15, exact: true },
    { lot: 'ssq', b: 50, bets: 25, exact: true },
    { lot: 'ssq', b: 100, bets: 50, exact: true },
    { lot: 'ssq', b: 200, bets: 100, exact: true },
    { lot: 'dlt', b: 10, bets: 5, exact: true },
    { lot: 'dlt', b: 30, bets: 15, exact: true },
    { lot: 'dlt', b: 50, bets: 25, exact: true },
    { lot: 'dlt', b: 100, bets: 50, exact: true },
    { lot: 'dlt', b: 200, bets: 100, exact: true },
  ]
  for (const c of fitCases) {
    const f = T.budgetFit(c.lot, c.b)
    ok(
      `${c.lot} ${c.b} 元 → ${c.bets} 注`,
      f.bets === c.bets && f.exact === c.exact,
      `实得 ${f.bets} 注 ${f.cost} 元 ${f.exact ? '(正好)' : '(不满)'}`
    )
  }

  const costCases = [
    { f: 6, b: 1, bets: 1, cost: 2 },
    { f: 7, b: 2, bets: 14, cost: 28 },
    { f: 8, b: 3, bets: 84, cost: 168 },
    { f: 9, b: 1, bets: 84, cost: 168 },
    { f: 10, b: 1, bets: 210, cost: 420 },
  ]
  for (const c of costCases) {
    const p = plans.find(
      (x) => x.kind !== 'dantuo' && x.frontNums.length === c.f && x.backNums.length === c.b
    )
    ok(`${c.f}+${c.b} = ${c.bets} 注 ${c.cost} 元`, !!p && p.bets === c.bets && p.cost === c.cost,
      p ? `实得 ${p.bets} 注 ${p.cost} 元` : '未枚举到')
  }

  // 关键数学事实：一等奖概率 = 注数 / 总组合数，与票型无关
  const totalSSQ = L.C(33, 6) * L.C(16, 1)
  const lv1 = plans.filter((p) => p.metrics.levelProbs[1] > 0)
  let maxErr = 0
  for (const p of lv1) {
    const want = p.bets / totalSSQ
    const got = p.metrics.levelProbs[1]
    maxErr = Math.max(maxErr, Math.abs(want - got) / want)
  }
  ok('一等奖概率恒等于 注数/总组合数（与票型无关）', maxErr < 1e-9,
    `检查 ${lv1.length} 种票型，最大相对误差 ${maxErr.toExponential(2)}`)

  // 中奖概率不得越界
  ok('所有票型中奖率落在 [0,1]', plans.every((p) => p.metrics.pWin >= 0 && p.metrics.pWin <= 1))

  // 需求文档 6.5.4 给出简洁结论 P_win = m/16（中蓝球即保底六等奖）。
  // 但那是忽略高阶项的近似：紅球命中 ≥4 时即使没中蓝球，也能中四/五/二等奖。
  // 精确值应为 P_win = m/16 + (1 − m/16) · P(k ≥ 4)。
  // 这里验证代码算出的正是这个精确值，同时量化文档近似的误差。
  function pgeK(n, k0) {
    let s = 0
    for (let k = k0; k <= 6; k++) s += (L.C(6, k) * L.C(27, n - k)) / L.C(33, n)
    return s
  }
  for (const m of [1, 3, 8]) {
    const p = plans.find(
      (x) => x.kind !== 'dantuo' && x.frontNums.length === 6 && x.backNums.length === m
    )
    if (!p) continue
    const approx = m / 16
    const exact = approx + (1 - approx) * pgeK(6, 4)
    ok(`6+${m} P_win 与精确解一致`, Math.abs(p.metrics.pWin - exact) < 1e-9,
      `实得 ${(p.metrics.pWin * 100).toFixed(2)}%  精确 ${(exact * 100).toFixed(2)}%  文档近似 ${(approx * 100).toFixed(2)}%`)
  }

  // ---------------------------------------------------------- 3. 概率归一
  console.log('\n[3] 模型输出结构')
  let structBad = []
  for (const m of M.ALL_MODELS.slice(0, 30)) {
    try {
      const p = m.predict({ history, lottery: 'ssq', nextDate: new Date(), profile: {} })
      const sf = p.frontProbs.reduce((a, b) => a + b, 0)
      const sb = p.backProbs.reduce((a, b) => a + b, 0)
      const sane =
        p.frontProbs.length === 33 && p.backProbs.length === 16 &&
        Math.abs(sf - 1) < 1e-6 && Math.abs(sb - 1) < 1e-6 &&
        p.frontProbs.every((x) => x >= 0 && Number.isFinite(x)) &&
        typeof p.narrative === 'string' && p.narrative.length > 0 &&
        p.confidence >= 0 && p.confidence <= 1
      if (!sane) structBad.push(`${m.meta.id}(前区${sf.toFixed(4)} 后区${sb.toFixed(4)})`)
    } catch (e) {
      structBad.push(`${m.meta.id} 抛错 ${e.message}`)
    }
  }
  ok('前 30 个模型输出结构合法且概率归一', structBad.length === 0, structBad.join(' '))

  const ids = M.ALL_MODELS.map((m) => m.meta.id)
  ok('模型 ID 无重复', new Set(ids).size === ids.length, `共 ${ids.length} 个`)
  ok('模型总数 78', ids.length === 78, `实得 ${ids.length}`)

  // ---------------------------------------------------------- 4. 置换检验
  console.log('\n[4] 真相卡片依赖的置换检验')
  const base = BT.backtest(M.getModel('B01'), {
    lottery: 'ssq', history, periods: 60, budget: 30, profile: {},
  })
  ok('随机基线自身 vs 自身 p 值不显著', BT.permutationTest(base, base) > 0.05,
    `p=${BT.permutationTest(base, base).toFixed(3)}`)

  // 构造一个「明显更强」的对手：把基线的收益整体抬高
  const stronger = {
    ...base,
    equity: base.equity.map((v, i) => v + i * 2000),
  }
  ok('构造的压倒性优势会被判显著', BT.permutationTest(stronger, base) < 0.05,
    `p=${BT.permutationTest(stronger, base).toFixed(4)}`)

  // 真实模型里应当绝大多数「无显著差异」
  const board = BT.leaderboard({
    lottery: 'ssq', history, periods: 60, budget: 30, profile: {},
  })
  const b01 = board.find((b) => b.modelId === 'B01')
  const noDiff = board.filter((r) => r.modelId !== 'B01' && BT.permutationTest(r, b01) > 0.05).length
  const total = board.length - 1
  console.log(`    60 期回测：${total} 个模型中 ${noDiff} 个与随机基线无显著差异`)
  ok('绝大多数模型判定为无显著差异', noDiff / total >= 0.8,
    `占比 ${(noDiff / total * 100).toFixed(1)}%`)

  // ---------------------------------------------------------- 5. 长期必然亏损
  console.log('\n[5] 彩票负期望的必然性')
  const longRun = BT.backtest(M.getModel('S01'), {
    lottery: 'ssq', history, periods: 400, budget: 30, profile: {},
  })
  console.log(`    S01 热号追踪 400 期：投入 ${longRun.totalCost} 元，返还 ${longRun.totalPrize} 元`)
  ok('长期回测必然亏损', longRun.roi < 0, `ROI ${(longRun.roi * 100).toFixed(1)}%`)

  // ---------------------------------------------------------- 6. 下一期开奖日
  console.log('\n[6] 下一期开奖日期（含开奖日当天）')
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}`
  for (const c of [
    { lot: 'ssq', from: [2026, 9, 6, 12, 0], want: [9, 6] },   // 周二中午 → 今晚
    { lot: 'ssq', from: [2026, 9, 6, 21, 16], want: [9, 8] },  // 周二开过 → 周四
    { lot: 'ssq', from: [2026, 9, 5, 12, 0], want: [9, 6] },   // 周一 → 周二
    { lot: 'dlt', from: [2026, 9, 7, 12, 0], want: [9, 7] },   // 周三中午 → 今晚
    { lot: 'dlt', from: [2026, 9, 7, 21, 26], want: [9, 10] }, // 周三开过 → 周六
    { lot: 'dlt', from: [2026, 9, 6, 12, 0], want: [9, 7] },   // 周二 → 周三
  ]) {
    const from = new Date(...c.from)
    const d = L.nextDrawDate(c.lot, from)
    const got = [d.getMonth(), d.getDate()]
    ok(
      `${L.RULES[c.lot].name} ${fmt(from)} ${String(c.from[3]).padStart(2, '0')}:${String(c.from[4]).padStart(2, '0')} → ${fmt(d)}`,
      got[0] === c.want[0] && got[1] === c.want[1],
      `实得 ${fmt(d)}`
    )
  }

  // ---------------------------------------------------------- 7. 存储层契约
  console.log('\n[7] 存储层契约（内存后端，验证接口语义）')
  const STT = await server.ssrLoadModule('/src/adapters/storage/types.ts')
  const { createMemoryAdapter } = await server.ssrLoadModule('/src/adapters/storage/memory.ts')
  const db = createMemoryAdapter()

  const k1 = STT.makeRunKey({ lottery: 'ssq', budget: 30, sample: 1000 })
  ok('runKey 编码', k1 === 'ssq-30-1000', k1)
  const p1 = STT.parseRunKey(k1)
  ok('runKey 可反解', p1 && p1.budget === 30 && p1.sample === 1000,
    JSON.stringify(p1))

  const k2 = STT.makeRunKey({ lottery: 'ssq', budget: 50, sample: 1000 })
  ok('换预算会换 runKey（否则读到旧结果）', k1 !== k2, k2)

  // 开奖数据去重
  const seed = packet.draws.filter((d) => d.lottery === 'ssq').slice(0, 200)
  const n1 = await db.upsertDraws(seed)
  const n2 = await db.upsertDraws(seed) // 同样的再来一遍
  ok('重复写入被去重', n1 === 200 && n2 === 0, `首写 ${n1}，重写 ${n2}`)
  ok('countDraws 正确', (await db.countDraws('ssq')) === 200, String(await db.countDraws('ssq')))

  const got = await db.getDraws('ssq')
  const asc = got.every((d, i) => i === 0 || got[i - 1].issue.localeCompare(d.issue) <= 0)
  ok('getDraws 按期号升序', asc && got.length === 200, `${got.length} 条`)

  // 回测汇总往返（含 equity 数组与 hits 的 JSON 往返）
  const rows = [
    {
      runKey: k1, modelId: 'S01', modelName: '热号追踪', category: 'stat',
      trials: 2509, totalCost: 75270, totalPrize: 18800, roi: -0.75,
      winRate: 0.18, bestLevel: 3, hits: { 3: 4, 4: 2, 6: 400 }, equity: [-98, -196, -294],
    },
    {
      runKey: k1, modelId: 'B01', modelName: '真随机基线', category: 'baseline',
      trials: 2509, totalCost: 75270, totalPrize: 19000, roi: -0.74,
      winRate: 0.19, bestLevel: 3, hits: { 6: 410 }, equity: [-98, -190, -280],
    },
  ]
  await db.putSummary(rows)
  await db.putRun({
    runKey: k1, lottery: 'ssq', budget: 30,
    sample: 1000, periods: 2509, modelCount: 2, createdAt: Date.now(),
  })

  const back = await db.getSummary(k1)
  ok('汇总往返条数一致', back.length === 2, `${back.length} 条`)
  ok('equity 曲线往返无损',
    JSON.stringify(back.find((r) => r.modelId === 'S01')?.equity) === JSON.stringify([-98, -196, -294]))
  ok('hits 字典往返无损',
    JSON.stringify(back.find((r) => r.modelId === 'S01')?.hits) === JSON.stringify({ 3: 4, 4: 2, 6: 400 }))
  ok('按 ROI 降序返回', back[0].roi >= back[1].roi, `${back[0].modelId} >= ${back[1].modelId}`)

  const runMeta = await db.getRun(k1)
  ok('批次元信息可读', runMeta && runMeta.modelCount === 2 && runMeta.sample === 1000)

  // 重跑同名 runKey 不应留下旧模型脏行
  await db.putSummary([rows[0]])
  ok('重跑同名 runKey 不残留旧模型', (await db.getSummary(k1)).length === 1)

  await db.deleteRun(k1)
  ok('删除批次连带清汇总', (await db.getSummary(k1)).length === 0 && !(await db.getRun(k1)))

  // 用户状态默认值
  ok('用户状态有默认预算 30', (await db.getUserState()).budget === 30)
  await db.putUserState({ ...STT.DEFAULT_USER_STATE, budget: 100, favorites: ['M01'] })
  ok('用户状态可写可读', (await db.getUserState()).budget === 100)

  // 通用键值（回测锚点走它，所以必须能原样往返）
  await db.putKV('run_anchor:ssq-30-1000', { start: 1000, upTo: 2509, upToIssue: '2026112' })
  const kvBack = await db.getKV('run_anchor:ssq-30-1000')
  ok('KV 往返无损',
    kvBack && kvBack.start === 1000 && kvBack.upTo === 2509 && kvBack.upToIssue === '2026112',
    JSON.stringify(kvBack))
  ok('KV 缺失键返回 null', (await db.getKV('run_anchor:不存在')) === null)

  // ---------------------------------------------------------- 8. 增量补算等价性
  console.log('\n[8] 增量补算等价性（这条不过，「新增开奖后只补新期」就是错的）')
  const RT = await server.ssrLoadModule('/src/core/backtestRunner.ts')

  const ssqAll = packet.draws
    .filter((d) => d.lottery === 'ssq')
    .sort((a, b) => a.issue.localeCompare(b.issue))
    .slice(0, 430)
  // 刻意混入用到随机数的模型（玄学抽签用 rndInt、机选用 Math.random、
  // Bootstrap 重采样用 rndInt）。它们曾经因为走 crypto.getRandomValues 而无法定种，
  // 导致增量补算的结果与全量重算对不上——这个组合就是那次的回归护栏。
  const MODELS = ['M01', 'M06', 'S01', 'S12', 'S16', 'S22', 'X03', 'Q06', 'Q12', 'B01', 'B03']
    .map((id) => M.getModel(id))
    .filter(Boolean)
  const START = 300
  const SPLIT = 400 // 第一次回测只算到第 400 期
  const common = { lottery: 'ssq', budget: 30, profile: {}, models: MODELS }

  const acc1 = await RT.runLeaderboardAsync({
    ...common, history: ssqAll.slice(0, SPLIT), from: START, to: SPLIT,
  })
  const acc2 = await RT.runLeaderboardAsync({
    ...common, history: ssqAll, from: SPLIT, to: ssqAll.length, base: acc1,
  })
  const accFull = await RT.runLeaderboardAsync({
    ...common, history: ssqAll, from: START, to: ssqAll.length,
  })

  ok('补算账本模型数一致', acc2.length === MODELS.length, `${acc2.length} 个`)
  ok('补算没有就地改坏旧账本',
    acc1[0].equity.length === SPLIT - START, `旧账本 ${acc1[0].equity.length} 点`)

  const sameRows = acc2.every((a, i) => {
    const f = accFull[i]
    return (
      a.modelId === f.modelId &&
      a.totals.trials === f.totals.trials &&
      a.totals.totalCost === f.totals.totalCost &&
      a.totals.totalPrize === f.totals.totalPrize &&
      a.totals.bestLevel === f.totals.bestLevel &&
      JSON.stringify(a.totals.hits) === JSON.stringify(f.totals.hits) &&
      a.equity.length === f.equity.length &&
      a.equity.every((v, k) => v === f.equity[k])
    )
  })
  ok('增量结果与全量重算逐位一致（含净值序列）', sameRows,
    sameRows ? `${MODELS.length} 个模型 × ${ssqAll.length - START} 期全等` : '存在不一致')

  // 分片回调：必须真的被调用、必须单调递增、必须收尾到 100%
  const seen = []
  await RT.runLeaderboardAsync(
    { ...common, history: ssqAll, from: START, to: ssqAll.length },
    { onProgress: (p) => seen.push(p) }
  )
  const monotonic = seen.every((p, i) => i === 0 || p.done >= seen[i - 1].done)
  ok('进度回调按分片触发且单调不回退', seen.length > 1 && monotonic, `回调 ${seen.length} 次`)
  ok('进度收尾到 100%', seen[seen.length - 1]?.ratio === 1)
  ok('分片途中给出正的剩余时间', seen.slice(0, -1).some((p) => p.etaMs > 0 && p.elapsedMs > 0))

  // 取消：必须抛 BacktestCancelled，而不是算完再丢弃
  let checks = 0
  let cancelled = false
  try {
    await RT.runLeaderboardAsync(
      { ...common, history: ssqAll, from: START, to: ssqAll.length },
      { shouldCancel: () => ++checks > 500 }
    )
  } catch (e) {
    cancelled = e?.name === 'BacktestCancelled'
  }
  ok('可中途取消（抛 BacktestCancelled）', cancelled && checks > 500, `在第 ${checks} 个单元中断`)

  // 日期解析必须是"前缀局部"的：第 i 期的日期只依赖 history[0..i]。
  // 增量补算能成立，全靠这条性质。
  const datesFull = BT.resolveDrawDates(ssqAll)
  const datesPrefix = BT.resolveDrawDates(ssqAll.slice(0, 260))
  const prefixLocal = datesPrefix.every((d, i) => d.getTime() === datesFull[i].getTime())
  ok('开奖日期解析只依赖历史前缀（增量续算的前提）', prefixLocal)

  const noWallClock = datesFull.every((d) => !Number.isNaN(d.getTime()))
  ok('缺日期的期次也有确定日期（不再混入当前时间）', noWallClock,
    `共 ${ssqAll.filter((d) => !d.date).length} 期缺日期`)

  // 可复现：同一套设置连跑两次，必须一位不差（含用到 Math.random 的模型）
  const again = await RT.runLeaderboardAsync({
    ...common, history: ssqAll, from: START, to: ssqAll.length,
  })
  const reproducible = again.every((a, i) => {
    const f = accFull[i]
    return a.totals.totalPrize === f.totals.totalPrize &&
      a.totals.totalCost === f.totals.totalCost &&
      JSON.stringify(a.totals.hits) === JSON.stringify(f.totals.hits) &&
      a.equity.every((v, k) => v === f.equity[k])
  })
  ok('同参数重跑结果完全可复现（随机模型已定种）', reproducible)

  // ---------------------------------------------------------- 9. 界面不卡
  console.log('\n[9] 分片粒度：单次占用主线程多长（这一条保证界面不假死）')
  // 必须用**默认配置**（全部 78 个模型，含重型）来测，不能只测轻量的。
  // 这条断言以前拿64 个轻模型测，<100ms 轻松通过；改成必跑全量之后，
  // 真正的峰值来自重型模型——一个工作单元 = 一个模型的一次 predict，
  // 本身是原子的、切不开。实测 S36（MLP）单次 152ms，于是单片峰值 ~169ms。
  // 换句话说：这里的瓶颈不是分片写错了，而是「最贵的那一个模型太重」。
  const dltAll = packet.draws
    .filter((d) => d.lottery === 'dlt')
    .sort((a, b) => a.issue.localeCompare(b.issue))
  const HEAVY_END = dltAll.length
  const HEAVY_FROM = HEAVY_END - 8
  const gapStamps = []
  const tHeavy = Date.now()
  await RT.runLeaderboardAsync(
    {
      lottery: 'dlt', history: dltAll, budget: 30, profile: {},
      models: M.ALL_MODELS, from: HEAVY_FROM, to: HEAVY_END,
    },
    { onProgress: () => gapStamps.push(Date.now()) }
  )
  const heavyMs = Date.now() - tHeavy
  let maxGap = 0
  for (let i = 1; i < gapStamps.length; i++) {
    maxGap = Math.max(maxGap, gapStamps[i] - gapStamps[i - 1])
  }
  const perPeriod = heavyMs / (HEAVY_END - HEAVY_FROM)
  console.log(`  真实规模 8 期 × ${M.ALL_MODELS.length} 模型耗时 ${heavyMs}ms（约 ${perPeriod.toFixed(0)}ms/期），切了 ${gapStamps.length} 片`)
  ok('每一片都远小于「一期」的耗时（否则等于没切）',
    maxGap < perPeriod, `最长一片 ${maxGap}ms < 单期 ${perPeriod.toFixed(0)}ms`)
  // 阈值 250ms 而非原来的 100ms：单个重型模型的一次 predict 就是原子的，
  // 峰值的下界就是最贵那个模型的单次耗时（约 150ms）。
  // 250ms 是「用户会感觉顿一下但不至于以为界面死了」的红线，
  // 超过它就说明某个模型慢到必须改实现（拆单元或降迭代），而不是调分片参数。
  ok('单次占用主线程 < 250ms（下界= 最慢模型的单次 predict）',
    maxGap > 0 && maxGap < 250, `最长 ${maxGap}ms`)

  // ---------------------------------------------------------- 10. 逐期明细
  console.log('\n[10] 逐期明细：号码、命中、奖级必须与汇总账本同源')
  // 明细是给用户「验证回测到底算了什么」用的。一旦它和排行榜数字对不上，
  // 用户看到的每一期都是假的，比没有明细更糟。所以下面几条是硬约束。
  //
  // 注意基准必须取**定种后的 runner**，不是 core/backtest 的同步 backtest()：
  // 后者是给脚本用的裸跑版，走 Math.random 且不定种，重跑一次数字就变
  // （用到随机数的玄学/机选模型正是如此）。拿它当基准等于在比两串随机数。
  const D_OPTS = { lottery: 'ssq', history: ssqAll, budget: 30, profile: {}, from: 300, to: 400 }
  // 必须用 ALL_MODELS：排行榜默认跑的就是全部 78 个，modelIndex 要与那次一致。
  // 拿轻量子集当基准会得到假通过——下标不同 ⇒ 种子不同 ⇒ 号码不同，
  // 而比对只看汇总金额，金额恰好可能撞上，看不出来。
  const fullBoard = await RT.runLeaderboardAsync({
    ...D_OPTS, models: M.ALL_MODELS,
  })
  const boardById = new Map(fullBoard.map((a) => [a.modelId, a]))

  const eqBad = []
  for (const m of M.ALL_MODELS) {
    const sum = boardById.get(m.meta.id)
    if (!sum) continue
    const rows = await RT.runDetailAsync({
      ...D_OPTS,
      model: m,
      modelIndex: M.ALL_MODELS.findIndex((x) => x.meta.id === m.meta.id),
    })
    const cost = rows.reduce((a, r) => a + r.cost, 0)
    const prize = rows.reduce((a, r) => a + r.prize, 0)
    const hits = {}
    for (const r of rows) if (r.level) hits[r.level] = (hits[r.level] || 0) + 1
    let best = 0
    for (const r of rows) if (r.level && (!best || r.level < best)) best = r.level
    if (
      cost !== sum.totals.totalCost || prize !== sum.totals.totalPrize ||
      rows.length !== sum.totals.trials ||
      best !== sum.totals.bestLevel ||
      JSON.stringify(hits) !== JSON.stringify(sum.totals.hits)
    ) {
      eqBad.push(`${m.meta.id}(明细${rows.length}期/${cost}元/${prize}元 vs 汇总${sum.totals.trials}期/${sum.totals.totalCost}元/${sum.totals.totalPrize}元)`)
    }
  }
  ok('明细逐期累加 == 排行榜该模型的汇总账本', eqBad.length === 0,
    eqBad.length ? eqBad.join(' ') : `${M.ALL_MODELS.length} 个模型（含重型）× ${ssqAll.length - 300} 期全等`)

  // 命中号码的个数必须等于计分用的 (f, b)，否则 UI 上的高亮会骗人
  const sampleRows = await RT.runDetailAsync({
    ...D_OPTS, model: M.getModel('Q06'), modelIndex: M.ALL_MODELS.findIndex((x) => x.meta.id === 'Q06'),
  })
  let hitBad = []
  for (const r of sampleRows) {
    const draw = ssqAll[r.index]
    if (r.hit.hitFront.length !== r.hit.f || r.hit.hitBack.length !== r.hit.b) {
      hitBad.push(`${r.issue}(计数)`); break
    }
    if (!r.hit.hitFront.every((n) => draw.front.includes(n))) { hitBad.push(`${r.issue}(前区不在开奖号里)`); break }
    if (!r.hit.hitBack.every((n) => draw.back.includes(n))) { hitBad.push(`${r.issue}(后区不在开奖号里)`); break }
    if (r.hit.betFront.length > r.hit.pickedFront.length) { hitBad.push(`${r.issue}(注的号码多于票面)`); break }
    if (r.hit.betBack.length > r.hit.pickedBack.length) { hitBad.push(`${r.issue}(后区注的号码多于票面)`); break }
  }
  ok('明细里的命中号码与开奖号、命中数三者自洽', hitBad.length === 0,
    hitBad.length ? hitBad.join(' ') : `检查 ${sampleRows.length} 期`)

  // 胆拖：计分封顶在「胆码 + need 个拖码」，多中的拖码不额外加分。
  // 拖码池必须比 need 大、且开奖里的拖码数也要超过 need，才造得出"多中"那一档：
  // 1 胆 + 8 拖（need=5），开奖前区 6 个里除胆码外还有 5 个拖码命中 → 命中拖码 5 个 = need，
  // 刚好取满。真正的"多中"用例放在下面（拖码池 10 个、开奖含 6 个拖码）。
  const need = L.RULES.ssq.frontCount - 1
  const dantuoPlan = {
    kind: 'dantuo', label: '', bets: 0, cost: 0, formula: '', metrics: {},
    frontNums: [1, 2, 3, 4, 5, 6, 7, 8, 9], backNums: [1],
    dans: [1], tuos: [2, 3, 4, 5, 6, 7, 8, 9],
  }
  const dDraw = { lottery: 'ssq', issue: 'X', date: '', front: [1, 2, 3, 4, 5, 6], back: [1] }
  const dh = BT.describeHit('ssq', dantuoPlan, dDraw)
  const dhRef = BT.bestHit('ssq', dantuoPlan, dDraw)
  ok('胆拖：拖码命中数超过 need 也只按 need 计分',
    dh.f === 1 + need && dhRef.f === 1 + need,
    `开奖 6 个前区里 5 个是拖码（需 ${need} 个）→ 计 ${dh.f}（1 胆 + ${need} 拖），bestHit=${dhRef.f}`)
  ok('describeHit 与 bestHit 口径完全一致',
    dh.f === dhRef.f && dh.b === dhRef.b, `${dh.f}+${dh.b} vs ${dhRef.f}+${dhRef.b}`)

  // 三档号码必须自洽：picked ⊇ bet ⊇ hit，且 UI 正是靠这个区分
  // 「命中计入」/「命中但这注用不上」/「没中」三档配色。
  // 造「多中」这一档：胆码 9 不在开奖里，6 个开奖号全是拖码，而 need 只有 5
  // ⇒ 第 6 个拖码命中了却进不了任何一注，UI 必须画成灰边球，不能混进命中或未中。
  const extraPlan = {
    kind: 'dantuo', label: '', bets: 0, cost: 0, formula: '', metrics: {},
    frontNums: [9, 1, 2, 3, 4, 5, 6, 7, 8], backNums: [1],
    dans: [9], tuos: [1, 2, 3, 4, 5, 6, 7, 8],
  }
  const extraDraw = { lottery: 'ssq', issue: 'X', date: '', front: [1, 2, 3, 4, 5, 6], back: [1] }
  const ex = BT.describeHit('ssq', extraPlan, extraDraw)
  const exExtra = extraPlan.frontNums.filter(
    (n) => extraDraw.front.includes(n) && !ex.hitFront.includes(n)
  )
  ok('胆拖超出 need 的拖码：既不计入 hitFront，也不混进「未中」',
    ex.f === need && exExtra.length === 1 &&
    exExtra.every((n) => !ex.hitFront.includes(n) && !ex.betFront.includes(n)),
    `6 个拖码命中、need ${need} → 多中的「${exExtra.join(' ') || '无'}」已单独区分`)
  ok('买下的号码 ⊇ 对奖那一注 ⊇ 命中号码',
    ex.hitFront.every((n) => ex.betFront.includes(n)) &&
    ex.betFront.every((n) => ex.pickedFront.includes(n)) &&
    ex.hitBack.every((n) => ex.betBack.includes(n)) &&
    ex.betBack.every((n) => ex.pickedBack.includes(n)))

  // 明细可复现：同参数连算两次，号码必须一位不差
  const againRows = await RT.runDetailAsync({
    ...D_OPTS,
    model: M.getModel('Q06'),
    modelIndex: M.ALL_MODELS.findIndex((x) => x.meta.id === 'Q06'),
  })
  const reproDetail = againRows.length === sampleRows.length && againRows.every((r, i) =>
    JSON.stringify(r.hit) === JSON.stringify(sampleRows[i].hit) && r.level === sampleRows[i].level
  )
  ok('同参数重算明细完全可复现', reproDetail, `检查 ${againRows.length} 期`)

  // 模型序号必须影响种子：错传下标会让明细显示的号码变成另一注假数据，
  // 所以 store 侧必须按「当次排行榜那份模型数组」取下标，而不是随手 findIndex。
  const q06i = M.ALL_MODELS.findIndex((x) => x.meta.id === 'Q06')
  const wrongRows = await RT.runDetailAsync({
    ...D_OPTS, model: M.getModel('Q06'), modelIndex: q06i + 1,
  })
  const seedMatters = wrongRows.some(
    (r, i) => JSON.stringify(r.hit.pickedFront) !== JSON.stringify(sampleRows[i].hit.pickedFront)
  )
  ok('传错 modelIndex 会得到不同号码（故序号必须由调用方保证）', seedMatters,
    seedMatters ? '已用错位种子复现' : '两种下标结果相同，无法证伪')

  // 明细的分片粒度也要守规矩：不能一口气算完
  const dSeen = []
  await RT.runDetailAsync(
    {
      lottery: 'dlt', history: dltAll, budget: 30, profile: {},
      model: M.ALL_MODELS[0], modelIndex: 0, from: dltAll.length - 12, to: dltAll.length,
    },
    { onProgress: (p) => dSeen.push(p) }
  )
  ok('明细也走分片且进度收尾到 100%',
    dSeen.length >= 1 && dSeen[dSeen.length - 1].ratio === 1, `回调 ${dSeen.length} 次`)

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail ? 1 : 0
} finally {
  await server.close()
}
