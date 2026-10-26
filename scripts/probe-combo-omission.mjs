/**
 * 组合统计「遗漏」口径验证。
 *
 * 核心断言：
 * 1. lastSeen('single') 与已有的 omission() 逐号一致（不能出现两套口径打架）
 * 2. 遗漏 = 全历史长度 - 1 - 最后一次出现的下标；0 表示上期刚出
 * 3. 多号档位的遗漏不得小于各成员号码的遗漏（组合出现必然三个号同时出现）
 * 4. comboCounts('single') 与 freq() 一致
 * 5. 遗漏**不受筛选区间影响**（这是刻意设计，不是 bug）
 */
import { createServer } from 'vite'

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})

const { lastSeen, comboCounts, NEVER, kCombos } = await server.ssrLoadModule('/src/core/comboStats.ts')
const { freq, omission } = await server.ssrLoadModule('/src/core/models/types.ts')
const { RULES } = await server.ssrLoadModule('/src/core/lottery.ts')

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) {
    pass++
  } else {
    fail++
    console.log('  [FAIL] ' + msg)
  }
}

function pad(v, n) {
  return String(v).padStart(n, '0')
}

function mulberry32(a) {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 造一段可控的假历史：每期 front 从 1..frontMax 里取 frontCount 个不重复号 */
function makeDraws(lottery, n, seed) {
  const r = RULES[lottery]
  const rnd = mulberry32(seed)
  const out = []
  for (let i = 0; i < n; i++) {
    const pick = (max, cnt) => {
      const pool = Array.from({ length: max }, (_, k) => k + 1)
      const res = []
      for (let c = 0; c < cnt; c++) {
        const j = c + Math.floor(rnd() * (pool.length - c))
        const t = pool[j]
        pool[j] = pool[c]
        pool[c] = t
        res.push(t)
      }
      return res.sort((x, y) => x - y)
    }
    out.push({
      lottery,
      issue: String(2000000 + i + 1),
      date: '2020-01-01',
      front: pick(r.frontMax, r.frontCount),
      back: pick(r.backMax, r.backCount),
    })
  }
  return out
}

for (const lottery of ['ssq', 'dlt']) {
  const rule = RULES[lottery]
  const N = 400
  const hist = makeDraws(lottery, N, lottery === 'ssq' ? 12345 : 67890)
  console.log(`\n=== ${rule.name}（${N} 期） ===`)

  // ---- 1. single 口径必须与既有 omission() 完全一致 ----
  for (const field of ['front', 'back']) {
    const size = field === 'front' ? rule.frontMax : rule.backMax
    const mine = lastSeen(hist, field, 'single', size)
    const legacy = omission(hist, size, field)
    let mismatch = 0
    for (let x = 1; x <= size; x++) {
      const got = mine.get(String(x))
      if (!got || got.omission !== legacy[x - 1]) mismatch++
    }
    ok(mismatch === 0, `${field} single 遗漏与 omission() 有 ${mismatch} 个号码不一致`)

    // 独立复算一遍：手写倒序扫描
    let hand = 0
    for (let x = 1; x <= size; x++) {
      for (let i = N - 1; i >= 0; i--) {
        if (hist[i][field].includes(x)) {
          if (N - 1 - i !== legacy[x - 1]) hand++
          break
        }
      }
    }
    ok(hand === 0, `${field} single 手算倒序与 omission() 不一致（${hand} 处）`)
  }

  // ---- 2. 上期出现过的号，遗漏必须是 0；且期号 == 最后一期 ----
  const lastDraw = hist[N - 1]
  for (const field of ['front', 'back']) {
    const size = field === 'front' ? rule.frontMax : rule.backMax
    const m = lastSeen(hist, field, 'single', size)
    let zeroOk = 0
    for (const x of lastDraw[field]) {
      const got = m.get(String(x))
      if (got && got.omission === 0 && got.issue === lastDraw.issue) zeroOk++
    }
    ok(zeroOk === lastDraw[field].length, `${field} 上期出的号里只有 ${zeroOk}/${lastDraw[field].length} 个遗漏=0`)
  }

  // ---- 3. 多号档位：组合遗漏 >= 每个成员号码的遗漏 ----
  const fSize = rule.frontMax
  const single = lastSeen(hist, 'front', 'single', fSize)
  for (const level of ['pair', 'triple']) {
    if (rule.frontCount < (level === 'pair' ? 2 : 3)) continue
    const m = lastSeen(hist, 'front', 'pair', fSize)
    const bad = []
    for (const [key, rec] of m) {
      const nums = key.split('-').map(Number)
      for (const x of nums) {
        const s = single.get(String(x))
        if (s && rec.omission < s.omission) bad.push(`${key}(${rec.omission}) < ${x}(${s.omission})`)
      }
    }
    ok(bad.length === 0, `${level} 有 ${bad.length} 处组合遗漏小于成员号码遗漏：${bad.slice(0, 3).join(', ')}`)
    ok(m.size > 0, `${level} 没有统计到任何组合`)

    // 防回归：曾经把 m.set 写成无条件覆盖，导致留下「最早一次出现」，遗漏整体倒挂成历史长度。
    // 真实数据上这个 bug 很显眼（高频号的组合会显示漏了 3000+ 期），但随机数据抓不到 ——
    // 随机段里同样的组合还会再出现，把差异淹掉。所以这里全部用受控数据：
    // 首期给 1..k+1，末 400 期固定 7..6+k 互不相交，末期再给一次 1,2,4,5,6,7。
    const kN = rule.frontCount
    const mk = (issue, front) => ({
      lottery,
      issue,
      date: '2020-01-01',
      front,
      back: Array.from({ length: rule.backCount }, (_, i) => i + 1),
    })
    const midFront = Array.from({ length: kN }, (_, i) => 7 + i)
    const hist2 = [
      mk('A0001', Array.from({ length: kN }, (_, i) => i + 1)), // 含 1,2,3(,4,5,6)
      ...Array.from({ length: 400 }, (_, i) => mk('M' + pad(i + 1, 4), midFront)),
      mk('Z9999', [1, 2, 4, 5, 6, 7].slice(0, kN)), // 再次含 1,2 但去掉 3
    ]
    const L = hist2.length
    const m2 = lastSeen(hist2, 'front', 'pair', fSize)
    ok(m2.get('1-2').omission === 0, `组合 1-2 在末期刚出，遗漏应为 0，实际 ${m2.get('1-2').omission}`)
    ok(m2.get('1-2').issue === 'Z9999', `组合 1-2 应记末期期号 Z9999，实际 ${m2.get('1-2').issue}`)
    // 1-3 只在首期 A0001 出现过（末段固定号不含 1，末期也不含 3）
    ok(m2.get('1-3').omission === L - 1, `组合 1-3 只在首期出现，遗漏应为 ${L - 1}，实际 ${m2.get('1-3').omission}`)
    ok(m2.get('1-3').issue === 'A0001', `组合 1-3 上次出现期号应为 A0001，实际 ${m2.get('1-3').issue}`)
    // 7+8 在中间 400 期每期都出，末期没出 ⇒ 遗漏 = 1
    ok(m2.get('7-8').omission === 1, `组合 7-8 应漏 1 期（末期未出），实际 ${m2.get('7-8').omission}`)
    ok(m2.get('7-8').issue === 'M0400', `组合 7-8 上次期号应为 M0400，实际 ${m2.get('7-8').issue}`)
    // 三三：1-2-4 只在末期出现
    const m2t = lastSeen(hist2, 'front', 'triple', fSize)
    if (kN >= 3) {
      ok(m2t.get('1-2-4').omission === 0, `组合 1-2-4 末期刚出，遗漏应为 0，实际 ${m2t.get('1-2-4').omission}`)
      ok(m2t.get('1-2-3').omission === L - 1, `组合 1-2-3 只在首期出现，遗漏应为 ${L - 1}，实际 ${m2t.get('1-2-3').omission}`)
    }
  }

  // ---- 4. comboCounts('single') 必须与 freq() 一致 ----
  const slice = hist.slice(-120)
  for (const field of ['front', 'back']) {
    const size = field === 'front' ? rule.frontMax : rule.backMax
    const mine = comboCounts(slice, field, 'single', size)
    const legacy = freq(slice, size, field)
    let bad = 0
    for (let x = 1; x <= size; x++) if ((mine.get(String(x)) || 0) !== legacy[x - 1]) bad++
    ok(bad === 0, `${field} comboCounts('single') 与 freq() 有 ${bad} 处不一致`)
    ok(mine.size === size, `${field} single 档位应覆盖全部 ${size} 个号码，实际 ${mine.size}`)
  }

  // ---- 5. 遗漏不受筛选区间影响（刻意设计） ----
  // 随机 400 期里 33 选 6 的最大遗漏本来就只有 ~20 期，造不出冷号，
  // 所以额外接一段「1 号连续 200 期没出」的尾段来做这个断言。
  const TAIL = 200
  const tailDraws = makeDraws(lottery, TAIL, 999 + (lottery === 'ssq' ? 1 : 2)).map((d) => ({
    ...d,
    issue: String(3000000 + Number(d.issue) - 2000000),
    front: d.front.filter((x) => x !== 1),
  }))
  const coldHist = [...hist, ...tailDraws]
  const coldLast = lastSeen(coldHist, 'front', 'single', rule.frontMax)
  const coldOne = coldLast.get('1')
  // 基准：原始 400 期里 1 号自己的遗漏 + 追加的 TAIL 期
  const baseOm = lastSeen(hist, 'front', 'single', rule.frontMax).get('1').omission
  const baseIssue = lastSeen(hist, 'front', 'single', rule.frontMax).get('1').issue
  ok(
    coldOne.omission === baseOm + TAIL,
    `1 号遗漏应为原 ${baseOm} + 追加 ${TAIL} = ${baseOm + TAIL}，实际 ${coldOne.omission}`
  )
  ok(coldOne.issue === baseIssue, `1 号上次出现期号应仍为 ${baseIssue}，实际 ${coldOne.issue}`)
  // 若按筛选区间（近 120 期）算会被截断成区间长度
  const recent = coldHist.slice(-120)
  const omRecent = omission(recent, rule.frontMax, 'front')
  ok(omRecent[0] === 120, `区间口径下 1 号遗漏应为区间长度 120，实际 ${omRecent[0]}`)
  ok(coldOne.omission !== omRecent[0], '全历史口径与区间口径结果相同，说明误用了筛选区间')
  console.log(`  冷号 01：全历史口径漏 ${coldOne.omission} 期（真值），近 120 期区间口径会截断成 ${omRecent[0]}`)
  // 区间里尾部出现过的号，两种口径应当一致
  let agree = 0
  let checked = 0
  for (const x of recent[recent.length - 1].front) {
    checked++
    if (coldLast.get(String(x)).omission === omRecent[x - 1]) agree++
  }
  ok(agree === checked, `最新一期出的号在两种口径下遗漏应一致，${agree}/${checked}`)

  // ---- 6. NEVER 常量与空历史 ----
  const empty = lastSeen([], 'front', 'single', rule.frontMax)
  ok(empty.size === 0, '空历史应返回空 Map')
  ok(NEVER.omission === -1 && NEVER.issue === '', 'NEVER 常量定义错误')
  const pairEmpty = comboCounts([], 'front', 'pair', rule.frontMax)
  ok(pairEmpty.size === 0, '空历史的 pair 档位应为空')

  // ---- 7. kCombos 基本正确性 ----
  const kc = kCombos([1, 2, 3, 4], 3)
  ok(kc.length === 4, `C(4,3) 应为 4，实际 ${kc.length}`)
  ok(kc.every((c) => c.length === 3 && c.every((v, i) => i === 0 || v > c[i - 1])), 'kCombos 输出未升序')

  // ---- 8. 概率直觉校验：组合遗漏应大于单号遗漏（组合更罕见） ----
  const pairM = lastSeen(hist, 'front', 'pair', rule.frontMax)
  const pairVals = [...pairM.values()]
  const singleVals = [...single.values()]
  const avg = (arr) => arr.reduce((a, b) => a + b.omission, 0) / arr.length
  const pairAvg = avg(pairVals)
  const singleAvg = avg(singleVals)
  ok(Number.isFinite(singleAvg) && Number.isFinite(pairAvg), `平均遗漏计算异常：${singleAvg} / ${pairAvg}`)
  ok(pairAvg > singleAvg, `两两组合平均遗漏(${pairAvg.toFixed(1)}) 应大于单号平均遗漏(${singleAvg.toFixed(1)})`)
  console.log(`  平均遗漏：单号 ${singleAvg.toFixed(1)} 期 / 两两 ${pairAvg.toFixed(1)} 期`)
}

await server.close()

console.log(`\n通过 ${pass} / 失败 ${fail}`)
if (fail > 0) process.exit(1)
