// 真实浏览器验证「号码组合统计」的遗漏列。
//
// 为什么必须真浏览器：遗漏值要么渲染成数字、要么渲染成「—」，typecheck 和 build
// 都发现不了「整列渲染成空」这类问题；而三三档有 5456 行、切换档位涉及全量重算，
// 也只有真跑才能确认没卡死、没报错。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!CHROME) {
  console.error('未找到 Chrome / Edge，跳过')
  process.exit(0)
}

const target = process.argv[2] || pathToFileURL(resolve('dist-single/index.html')).href
if (!process.argv[2] && !existsSync(resolve('dist-single/index.html'))) {
  console.error('dist-single/index.html 不存在，请先 npm run build:single')
  process.exit(1)
}

const PORT = 9348
const profile = mkdtempSync(join(tmpdir(), 'wb-combo-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1400,1000',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
  ],
  { stdio: 'ignore' }
)

let wsUrl = null
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl
  } catch {
    /* 还没起来 */
  }
}
if (!wsUrl) {
  console.error('无法连接浏览器 DevTools')
  chrome.kill()
  process.exit(1)
}

const tab = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
const ws = new WebSocket((await tab.json()).webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})

let idc = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
    return
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(`${m.params.entry.source}: ${m.params.entry.text}`)
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++idc
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
/**
 * 在页面里跑一段**函数体**（可含多条语句），返回其返回值。
 * 表达式内部抛错时把错误带回来，别静默丢失。
 */
async function evalJson(body) {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => { try { ${body} } catch (e) { return { __err: String((e && e.stack) || e) }; } })())`,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.result.exceptionDetails) {
    throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
  }
  const v = r.result.result.value
  if (typeof v !== 'string') throw new Error('表达式没有返回可序列化结果：' + JSON.stringify(r.result))
  const parsed = JSON.parse(v)
  if (parsed && parsed.__err) throw new Error('页面内异常: ' + parsed.__err)
  return parsed
}

let pass = 0
let fail = 0
function ok(cond, msg) {
  if (cond) {
    pass++
    console.log('  ✓ ' + msg)
  } else {
    fail++
    console.log('  ✗ ' + msg)
  }
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: target })
await sleep(8000)

// 切到「历史开奖」页
const nav = await evalJson(`
  const items = [...document.querySelectorAll('a,button,nav *')];
  const t = items.find(e => (e.textContent||'').trim().startsWith('历史'));
  if (t) { t.click(); return { clicked: true }; }
  return { clicked: false };
`)
ok(nav.clicked, '切到历史开奖页')
await sleep(2500)

const base = await evalJson(`
  const heads = [...document.querySelectorAll('th')].map(t => (t.textContent||'').trim());
  return {
    hasOmHead: heads.includes('遗漏'),
    hasLastHead: heads.includes('上次开出'),
    hint: (document.body.innerText||'').includes('距上一次开出的期数'),
    rows: document.querySelectorAll('tbody tr').length,
  };
`)
ok(base.hasOmHead, '表头存在「遗漏」列且可排序')
ok(base.hasLastHead, '表头存在「上次开出」列')
ok(base.hint, '面板上说明了遗漏口径（按完整历史计算）')
ok(base.rows > 0, `组合表有数据行（${base.rows} 行）`)

// 单个档位：读第一页的行，核对列结构与数值合理性
const single = await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  if (!card) return { found: false };
  // 表头文字里混着排序箭头（'次数 ▼'），只能用 startsWith 定位列号
  const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
  const colOf = (label) => heads.findIndex(h => h === label || h.startsWith(label));
  const iOm = colOf('遗漏');
  const iLast = colOf('上次开出');
  const iCount = colOf('次数');
  const rows = [...card.querySelectorAll('tbody tr')].slice(0, 12).map(tr => {
    const td = [...tr.querySelectorAll('td')];
    return {
      nums: (td[0].innerText||'').trim().replace(/\\s+/g, ' '),
      count: (td[iCount].innerText||'').trim(),
      om: (td[iOm].innerText||'').trim(),
      last: (td[iLast].innerText||'').trim(),
    };
  });
  return { found: true, heads, cols: heads.length, iOm, iLast, iCount, rows };
`)
ok(single.found, '找到组合统计卡片')
ok(single.cols === 5, `表格共 5 列（实际 ${single.cols}：${single.heads.join(' | ')}）`)
ok(single.iOm >= 0 && single.iLast >= 0 && single.iCount >= 0, '遗漏 / 上次开出 / 次数三列都能定位到')
ok(single.rows.length > 0, `单个档位读到 ${single.rows.length} 行`)
console.log('    样例：')
for (const r of single.rows.slice(0, 4)) {
  console.log(`      ${r.nums}  次数 ${r.count}  遗漏 ${r.om}  上次 ${r.last}`)
}
ok(single.rows.every((r) => /^[0-9]+$/.test(r.om) || r.om === '—'), '遗漏列是数字或「—」，没有空白/NaN')
ok(single.rows.every((r) => r.om !== 'NaN' && r.om !== 'undefined'), '没有 NaN / undefined 渗进界面')
ok(single.rows.every((r) => /^[0-9]+$/.test(r.count)), '次数列都是数字')

// 校验：最新一期开出的号，遗漏必须是 0
const zeroCheck = await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
  const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
  const zero = [...card.querySelectorAll('tbody tr')]
    .filter(tr => (tr.querySelectorAll('td')[iOm].innerText||'').trim() === '0').length;
  return { zero };
`)
ok(zeroCheck.zero > 0, `页面上有 ${zeroCheck.zero} 行遗漏=0（最新一期开出的号）`)

// 点「遗漏」表头排序：▼ = 遗漏从大到小，且箭头方向必须与实际顺序一致
await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const th = [...card.querySelectorAll('th')].find(t => (t.textContent||'').trim().startsWith('遗漏'));
  th.click(); return 1;
`)
await sleep(1200)
const afterDesc = await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
  const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
  const th = [...card.querySelectorAll('th')][iOm];
  const vals = [...card.querySelectorAll('tbody tr')].slice(0, 8)
    .map(tr => (tr.querySelectorAll('td')[iOm].innerText||'').trim());
  const nums = [...card.querySelectorAll('tbody tr')].slice(0, 3)
    .map(tr => (tr.querySelectorAll('td')[0].innerText||'').trim().replace(/\\s+/g,' '));
  return { vals, nums, arrow: (th.textContent||'').trim() };
`)
console.log('    点「遗漏」后前 3 行：', afterDesc.nums.join(' / '), '→ 遗漏', afterDesc.vals.join(', '))
ok(afterDesc.arrow.includes('▼'), `表头显示 ▼（实际 ${afterDesc.arrow}）`)
const numVals = afterDesc.vals.filter((v) => /^[0-9]+$/.test(v)).map(Number)
ok(numVals.length >= 4, `读到 ${numVals.length} 个遗漏值`)
ok(numVals.every((v, i) => i === 0 || numVals[i - 1] >= v), '▼ 对应实际顺序：遗漏从大到小')

// 再点一次应反向（▲）
await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const th = [...card.querySelectorAll('th')].find(t => (t.textContent||'').trim().startsWith('遗漏'));
  th.click(); return 1;
`)
await sleep(1200)
const afterAsc = await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
  const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
  const th = [...card.querySelectorAll('th')][iOm];
  const vals = [...card.querySelectorAll('tbody tr')].slice(0, 8)
    .map(tr => (tr.querySelectorAll('td')[iOm].innerText||'').trim());
  return { vals, arrow: (th.textContent||'').trim() };
`)
ok(afterAsc.arrow.includes('▲'), `再点一次表头变 ▲（实际 ${afterAsc.arrow}）`)
const ascNums = afterAsc.vals.filter((v) => /^[0-9]+$/.test(v)).map(Number)
ok(ascNums.every((v, i) => i === 0 || ascNums[i - 1] <= v), '▲ 对应实际顺序：遗漏从小到大')

/** 把遗漏列切成降序（▼），返回确认后的箭头。表头自带箭头，据此判断当前方向，别猜 */
async function sortOmissionDesc() {
  for (let i = 0; i < 3; i++) {
    const arrow = await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
      const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
      const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
      return { arrow: (heads[iOm]||''), iOm };
    `)
    if (arrow.arrow.includes('▼')) return arrow.arrow
    await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
      const th = [...card.querySelectorAll('th')].find(t => (t.textContent||'').trim().startsWith('遗漏'));
      th.click(); return 1;
    `)
    await sleep(1100)
  }
  return '未知'
}

// 切到两两 / 三三档，确认也能出数（切到遗漏降序，才看得到最长的那些遗漏）
for (const label of ['两两组合', '三三组合']) {
  const t0 = Date.now()
  const clicked = await evalJson(`
    const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
    const b = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '${label}');
    if (!b) return { clicked: false };
    b.click(); return { clicked: true };
  `)
  await sleep(1800)
  const ms = Date.now() - t0
  if (!clicked.clicked) {
    ok(true, `当前彩种没有「${label}」档位（后区每期出号太少），跳过`)
    continue
  }
  await sortOmissionDesc()
  const st = await evalJson(`
    const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
    const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
    const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
    const rows = [...card.querySelectorAll('tbody tr')].slice(0, 5).map(tr => {
      const td = [...tr.querySelectorAll('td')];
      return { nums: (td[0].innerText||'').trim().replace(/\\s+/g,' '), om: (td[iOm].innerText||'').trim() };
    });
    const total = (card.innerText.match(/共 (\\d+) 条/)||[])[1];
    return { rows, total };
  `)
  ok(st.rows.length > 0, `${label} 渲染出 ${st.rows.length} 行（共 ${st.total} 条，${ms}ms）`)
  ok(st.rows.every((r) => /^[0-9]+$/.test(r.om) || r.om === '—'), `${label} 遗漏列正常：${st.rows.map((r) => r.om).join(', ')}`)
  console.log(`    ${label} 最久未出：${st.rows.map((r) => r.nums + '(' + r.om + ')').join('  ')}`)
}

// 切后区
await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const b = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '后区');
  if (b) b.click(); return 1;
`)
await sleep(1500)
const backZone = await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
  const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
  const rows = [...card.querySelectorAll('tbody tr')].slice(0, 3)
    .map(tr => [...tr.querySelectorAll('td')].map(td => (td.innerText||'').trim()));
  return { rows, om: rows.map(r => r[iOm]) };
`)
ok(backZone.rows.length > 0, `切到后区也能渲染，遗漏值 ${backZone.om.join(' / ')}`)

/**
 * 关键设计断言：遗漏列按**完整历史**算，不随筛选区间变化。
 *
 * 怎么才算真的验证过？光比「筛选前后最大值一样」不够 —— 筛到 30 期后，
 * 区间内没出现过的组合根本不会进表（表 = 区间内出现过的组合），
 * 于是「最长的那些遗漏」天然消失，怎么实现都能通过这条断言。
 *
 * 所以改成：Node 侧独立用 core 模块 + 内联开奖数据算出真值，
 * 再跟页面上**同一批行**的显示值逐一比对 —— 页面算错一个数就会被抓住。
 */
await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const zf = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '前区');
  if (zf) zf.click(); return 1;
`)
await sleep(600)
const toPair = await evalJson(`
  const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
  const b = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '两两组合');
  if (!b) return { clicked: false };
  b.click(); return { clicked: true };
`)

if (!toPair.clicked) {
  ok(true, '当前档位没有「两两组合」，跳过筛选口径检查')
} else {
  await sleep(2000)
  // Node 侧独立算真值（不复用页面里的任何东西）
  const { createServer } = await import('vite')
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'error',
  })
  const { lastSeen } = await vite.ssrLoadModule('/src/core/comboStats.ts')
  const { RULES } = await vite.ssrLoadModule('/src/core/lottery.ts')
  const data = (await vite.ssrLoadModule('/src/assets/lottery-data.json')).default
  const draws = data.draws || data
  const truth = new Map()
  for (const lottery of ['ssq', 'dlt']) {
    const r = RULES[lottery]
    const h = draws.filter((d) => d.lottery === lottery)
    if (h.length < 100) continue
    for (const [k, v] of lastSeen(h, 'front', 'pair', r.frontMax)) {
      truth.set(`${lottery}|${k}`, v)
    }
  }
  await vite.close()

  // 读**整页**（默认 50 行/页）。翻遍所有页才能覆盖全量行集 —— 否则筛选前后
  // 两页的行集不同，交集会是 0，断言变成空跑。
  const readPage = () => evalJson(`
    const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
    const heads = [...card.querySelectorAll('th')].map(t => (t.textContent||'').trim());
    const iOm = heads.findIndex(h => h === '遗漏' || h.startsWith('遗漏'));
    const iLast = heads.findIndex(h => h === '上次开出');
    const m = (card.innerText.match(/(\\d+) \\/ (\\d+)/) || []);
    return {
      page: m[1], pages: m[2],
      rows: [...card.querySelectorAll('tbody tr')].map(tr => {
        const td = [...tr.querySelectorAll('td')];
        const nums = (td[0].innerText||'').trim().split(/\\s+/).map(s => parseInt(s, 10)).filter(Number.isFinite).sort((a,b)=>a-b);
        return { key: nums.join('-'), om: (td[iOm].innerText||'').trim(), last: (td[iLast].innerText||'').trim() };
      }),
    };
  `)
  /** 翻到第 1 页，然后逐页往后收集所有行 */
  const readAllRows = async (maxPages = 14) => {
    await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
      const bs = [...card.querySelectorAll('button.pager')];
      const first = bs.find(b => (b.textContent||'').trim() === '«');
      if (first) first.click();
      return 1;
    `)
    await sleep(700)
    const all = []
    let pages = 1
    for (let p = 1; p <= maxPages; p++) {
      const cur = await readPage()
      all.push(...cur.rows)
      pages = cur.pages
      if (p >= Number(cur.pages)) break
      await evalJson(`
        const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
        const bs = [...card.querySelectorAll('button.pager')];
        const next = bs.find(b => (b.textContent||'').trim() === '›');
        if (next && !next.disabled) next.click();
        return 1;
      `)
      await sleep(600)
    }
    return { rows: all, pages }
  }

  for (const lottery of ['ssq', 'dlt']) {
    const cn = lottery === 'ssq' ? '双色球' : '大乐透'
    const switched = await evalJson(`
      const items = [...document.querySelectorAll('a,button,nav *')];
      const t = items.find(e => (e.textContent||'').trim() === '${cn}');
      if (!t) return { switched: false };
      t.click(); return { switched: true };
    `)
    if (!switched.switched) {
      ok(true, `页面里找不到「${cn}」入口，跳过`)
      continue
    }
    await sleep(2500)
    await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
      const zf = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '前区');
      if (zf) zf.click(); return 1;
    `)
    await sleep(500)
    const backToPair = await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('号码组合统计'));
      const b = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '两两组合');
      if (!b) return { clicked: false };
      b.click(); return { clicked: true };
    `)
    if (!backToPair.clicked) continue
    await sleep(2200)

    // 无筛选：与真值逐行比对（翻遍全部分页）
    const noFilter = await readAllRows()
    let mismatch = 0
    let checkedTruth = 0
    const badSamples = []
    for (const r of noFilter.rows) {
      const t = truth.get(`${lottery}|${r.key}`)
      if (!t) {
        mismatch++
        continue
      }
      checkedTruth++
      if (Number(r.om) !== t.omission || r.last !== t.issue) {
        mismatch++
        if (badSamples.length < 3) badSamples.push(`${r.key} 页面${r.om}/${r.last} vs 真值${t.omission}/${t.issue}`)
      }
    }
    ok(checkedTruth >= 100, `${cn} 无筛选时读到 ${checkedTruth} 行（${noFilter.pages} 页），全部能在 Node 侧真值表里找到`)
    ok(
      mismatch === 0,
      `${cn} 无筛选时页面遗漏 / 上次期号与独立算出的真值逐行一致（${checkedTruth} 行，${mismatch} 处不符）` +
        (badSamples.length ? '：' + badSamples.join('; ') : '')
    )

    // 加「近 30 期」筛选：同一批 key 的遗漏不该被改写
    const fc = await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('筛选'));
      const b = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '30 期');
      if (!b) return { clicked: false };
      b.click(); return { clicked: true };
    `)
    await sleep(2200)
    const withFilter = await readAllRows()
    const beforeMap = new Map(noFilter.rows.map((r) => [r.key, r]))
    const common = withFilter.rows.filter((r) => beforeMap.has(r.key))
    ok(fc.clicked, `${cn} 切到「近 30 期」筛选`)
    ok(withFilter.rows.length > 0, `${cn} 筛选后表里还有 ${withFilter.rows.length} 行（${withFilter.pages} 页）`)
    ok(common.length > 0, `${cn} 筛选前后有 ${common.length} 行交集（断言非空跑）`)
    const changed = common.filter((r) => r.om !== beforeMap.get(r.key).om)
    ok(
      common.length > 0 && changed.length === 0,
      `${cn} 交集的 ${common.length} 行遗漏值一个都没变`
    )
    // 注意：这里**不能**再要求交集里有「遗漏 > 30」的行。
    // 表的行集来自筛选区间内出现过的组合，而交集里的行既然在近 30 期出现过，
    // 它的真实遗漏就必然 ≤ 30 —— 交集里不存在长遗漏是数据决定的，不是 bug。
    // 「不被截断」这一点由下面两条覆盖：① 无筛选时 528/595 行全覆盖且含长遗漏；
    // ② 筛选后每一行仍等于全历史真值（若按区间重算，值会全部 ≤30，与真值不符）。
    const longOmAll = noFilter.rows.filter((r) => Number(r.om) > 30)
    ok(
      longOmAll.length > 100,
      `${cn} 无筛选的全量行集里有 ${longOmAll.length} 行遗漏 > 30 期（口径够长的样本）`
    )
    let fMismatch = 0
    let fChecked = 0
    for (const r of withFilter.rows) {
      const t = truth.get(`${lottery}|${r.key}`)
      if (!t) {
        fMismatch++
        continue
      }
      fChecked++
      if (Number(r.om) !== t.omission) fMismatch++
    }
    ok(
      fChecked > 0 && fMismatch === 0,
      `${cn} 筛选后全部 ${fChecked} 行的遗漏仍等于全历史真值（${fMismatch} 处不符）`
    )
    if (longOmAll.length > 0) {
      const s = longOmAll.slice(0, 3).map((r) => `${r.key} 漏 ${r.om} 期`)
      console.log('    ' + cn + ' 全量长遗漏抽样：' + s.join('  '))
    }

    // 复位筛选
    await evalJson(`
      const card = [...document.querySelectorAll('.card')].find(c => (c.textContent||'').includes('筛选'));
      const b = [...card.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '全部');
      if (b) b.click(); return 1;
    `)
    await sleep(1500)
  }
}

console.log('\n控制台错误: ' + (errors.length ? '✗\n    ' + errors.join('\n    ') : '✓ 无'))
ok(errors.length === 0, '全程无控制台错误')

console.log(`\n通过 ${pass} / 失败 ${fail}`)
ws.close()
chrome.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(fail > 0 ? 1 : 0)
