/**
 * 用项目内联的真实开奖数据跑一遍组合统计，重点看两件事：
 * 1. 真实数据下遗漏口径与既有 omission() 是否一致（不是假数据自洽）
 * 2. 三三组合在 6000+ 期上会不会卡（lastSeen 每次都全量重算，需确认耗时）
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const { lastSeen, comboCounts } = await server.ssrLoadModule('/src/core/comboStats.ts')
const { omission } = await server.ssrLoadModule('/src/core/models/types.ts')
const { RULES } = await server.ssrLoadModule('/src/core/lottery.ts')
const data = (await server.ssrLoadModule('/src/assets/lottery-data.json')).default

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) pass++
  else {
    fail++
    console.log('  [FAIL] ' + msg)
  }
}

const pad = (v, n) => String(v).padStart(n)

for (const lottery of ['ssq', 'dlt']) {
  const rule = RULES[lottery]
  const hist = (data.draws || data).filter((d) => d.lottery === lottery)
  console.log(`\n=== ${rule.name} 真实数据 ${hist.length} 期 ===`)
  if (hist.length < 100) {
    console.log('  (内联数据里该彩种期数不足，跳过)')
    continue
  }

  // 单号遗漏必须与既有 omission() 一致
  for (const field of ['front', 'back']) {
    const size = field === 'front' ? rule.frontMax : rule.backMax
    const mine = lastSeen(hist, field, 'single', size)
    const legacy = omission(hist, size, field)
    let bad = 0
    for (let x = 1; x <= size; x++) {
      const got = mine.get(String(x))
      if (!got || got.omission !== legacy[x - 1]) bad++
    }
    ok(bad === 0, `${field} 真实数据上遗漏与 omission() 有 ${bad} 处不一致`)
    const last = hist[hist.length - 1]
    let zero = 0
    for (const x of last[field]) {
      const g = mine.get(String(x))
      if (g && g.omission === 0) zero++
    }
    ok(zero === last[field].length, `${field} 最新一期(${last.issue})出的 ${last[field].length} 个号里只有 ${zero} 个遗漏=0`)
  }

  // 组合统计：性能 + 概率特征
  for (const level of ['single', 'pair', 'triple']) {
    const size = rule.frontMax
    const k = level === 'single' ? 1 : level === 'pair' ? 2 : 3
    if (rule.frontCount < k) continue
    const t0 = performance.now()
    const cnt = comboCounts(hist, 'front', level, size)
    const t1 = performance.now()
    const last = lastSeen(hist, 'front', level, size)
    const t2 = performance.now()
    const vals = [...last.values()]
    const avg = vals.reduce((a, b) => a + b.omission, 0) / vals.length
    const maxOm = Math.max(...vals.map((v) => v.omission))
    console.log(
      `  前区 ${level.padEnd(6)} 组合数 ${pad(cnt.size, 5)}  ` +
        `计数 ${(t1 - t0).toFixed(0)}ms / 遗漏 ${(t2 - t1).toFixed(0)}ms  ` +
        `平均遗漏 ${avg.toFixed(1)} 期，最大 ${maxOm} 期`
    )
    ok(cnt.size > 0 && vals.length > 0, `${level} 统计结果为空`)
    ok(t2 - t1 < 400, `${level} 遗漏计算耗时 ${(t2 - t1).toFixed(0)}ms，可能拖慢页面`)
    // 组合越罕见，平均遗漏应越长
    if (level === 'pair') {
      const sVals = [...lastSeen(hist, 'front', 'single', size).values()]
      const sAvg = sVals.reduce((a, b) => a + b.omission, 0) / sVals.length
      ok(avg > sAvg, `两两平均遗漏(${avg.toFixed(1)}) 应大于单号(${sAvg.toFixed(1)})`)
      console.log(`    单号平均遗漏 ${sAvg.toFixed(1)} 期 → 两两 ${avg.toFixed(1)} 期`)
    }
    if (level === 'triple') {
      const pVals = [...lastSeen(hist, 'front', 'pair', size).values()]
      const pAvg = pVals.reduce((a, b) => a + b.omission, 0) / pVals.length
      ok(avg > pAvg, `三三平均遗漏(${avg.toFixed(1)}) 应大于两两(${pAvg.toFixed(1)})`)
      console.log(`    两两平均遗漏 ${pAvg.toFixed(1)} 期 → 三三 ${avg.toFixed(1)} 期`)
    }
  }

  // 抽样看看「最久没出的两两组合」
  const pairLast = lastSeen(hist, 'front', 'pair', rule.frontMax)
  const top = [...pairLast.entries()].sort((a, b) => b[1].omission - a[1].omission).slice(0, 5)
  for (const [k, v] of top) {
    console.log(`  最久未出两两 ${k.replace(/-/g, ' + ').padEnd(10)} 漏 ${pad(v.omission, 4)} 期（上次 ${v.issue}）`)
  }
  // 组合遗漏不可能超过历史总期数
  ok(top.every(([, v]) => v.omission < hist.length), '组合遗漏超过了历史总期数')
  // 从没出现过的组合在 lastSeen 里不应存在（只收录出现过的）
  const pairCnt = comboCounts(hist, 'front', 'pair', rule.frontMax)
  ok([...pairCnt.keys()].every((k) => pairLast.has(k)), '计数表里有的组合，遗漏表里必须有')
}

await server.close()
console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
