/**
 * 浏览器探针：信息质量审计的几处改动。
 *
 * 背景：用户连续指出两处「数字摆着但没意义」的地方（组合统计缺遗漏、票型评估不给号码）。
 * 顺着同一把尺子审其余页面又找出几条，本探针把它们钉住：
 *
 *   1. 今日页：期望回报必须等于「页面显示的注数 × 单注期望」（Node 侧独立算 singleBetEV）；
 *      「中奖概率」必须写明是「至少中任意一个奖级」，且最低奖级名/奖金从 RULES 取、不写死。
 *   2. 档案页：清空动作必须拆成两个（只清档案 vs 连回测一起清），
 *      旧文案「清空全部本地数据」不能再单独出现（它骗人：实际把回测账本也删了）；
 *      单注票价从 RULES 取，不写死 2。
 *   3. 回测页：排行榜每行必须有「投入 → 回收」，且与同一行的 ROI 自洽
 *      （这条能抓出 cost/prize 接反、格式化写错单位之类的错）；
 *      真相卡片必须写明多重比较的假阳性个数。
 *   4. 明细：净盈亏必须带单位「元」，并给出「回收 − 投入」的算式。
 *
 * 手法沿用 probe-detail-plans-ui.mjs：Node 侧用 core 独立算真值，CDP 读真实页面逐项比对。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find(existsSync)
if (!CHROME) {
  console.error('找不到 Chrome/Edge，跳过')
  process.exit(0)
}

let pass = 0
let fail = 0
const ok = (c, m) => {
  c ? pass++ : fail++
  console.log(`  ${c ? '✓' : '✗'} ${m}`)
}

// ---------------------------------------------------------------- Node 侧真值
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
const { singleBetEV } = await vite.ssrLoadModule('/src/core/ticket.ts')
const { RULES, FIXED_PRIZE } = await vite.ssrLoadModule('/src/core/lottery.ts')
await vite.close()

/** 默认彩种是大乐透（store 里的初值），探针按它算真值 */
const LOT = 'dlt'
const rule = RULES[LOT]
const evPerBet = singleBetEV(LOT)
const lowestLevel = rule.levelNames[Math.max(...Object.keys(rule.levelNames).map(Number))]
const lowestPrize = FIXED_PRIZE[LOT][Math.max(...Object.keys(FIXED_PRIZE[LOT]).map(Number))]
console.log(
  `  Node 侧真值：${rule.name} 单注期望 ${evPerBet.toFixed(4)} 元 / 最低奖 ${lowestLevel} ${lowestPrize} 元 / 单价 ${rule.price} 元`
)

// ---------------------------------------------------------------- 浏览器
const PORT = 9373
const profile = mkdtempSync(join(tmpdir(), 'wb-info-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1500,1200',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
)

let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(200)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl
  } catch {
    /* 还没起来 */
  }
}
if (!wsUrl) {
  console.error('Chrome 启动失败')
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
const pageErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(
      m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text
    )
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++idc
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

/** 在页面里跑一段函数体，返回 JSON。异常带回来而不是静默丢失。 */
async function evalJson(body) {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => { try { ${body} } catch (e) { return { __err: String((e && e.stack) || e) } } })())`,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.result.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
    )
  }
  const v = r.result.result.value
  if (typeof v !== 'string') throw new Error('表达式没有返回可序列化结果：' + JSON.stringify(r.result))
  const parsed = JSON.parse(v)
  if (parsed && parsed.__err) throw new Error('页面内异常: ' + parsed.__err)
  return parsed
}

/** 点导航项。导航文本可能带图标节点，用 startsWith 而不是全等。 */
async function go(name) {
  return evalJson(`
    const t = [...document.querySelectorAll('a,button,nav *')].find(
      e => (e.textContent || '').trim().startsWith(${JSON.stringify(name)})
    );
    if (!t) return false;
    t.click();
    return true;
  `)
}

/** 点页面上第一个文本含 keyword 的按钮 */
async function clickButton(contains) {
  return evalJson(`
    const b = [...document.querySelectorAll('button')].find(
      x => (x.textContent || '').includes(${JSON.stringify(contains)})
    );
    if (!b) return null;
    b.click();
    return (b.textContent || '').trim();
  `)
}

/**
 * 取字符串里的**第一个**数。
 * 必须「只取第一个」：整段文本里往往还有第二个数字（「同时做 77 组比较，按 5% … 约 4 个」），
 * 把非数字字符全剔掉再 parseFloat 会得到 7754 这种拼接出来的假值。
 * 正则里用 [.] 而不是 \. —— 省得一不留神被转义成两层反斜杠。
 */
function firstNum(s) {
  const m = String(s == null ? '' : s).match(/[-+]?[0-9]+[.]?[0-9]*/)
  return m ? parseFloat(m[0]) : NaN
}

/** 取「xx 元」/「xx 万」里的数值。万要还原成元。 */
function toYuan(s) {
  const t = String(s == null ? '' : s)
  const n = firstNum(t)
  if (!Number.isFinite(n)) return NaN
  return t.includes('万') ? n * 10000 : n
}

/** 从一段文本里取出 keyword 之后的第一个数值 */
function numAfter(text, keyword) {
  const i = String(text).indexOf(keyword)
  if (i < 0) return NaN
  return firstNum(String(text).slice(i + keyword.length))
}

await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
await send('Page.navigate', { url: pathToFileURL(resolve('dist-single/index.html')).href })
await sleep(9000)

// ================================================================ 1. 今日页
console.log('\n[1] 今日页：中奖概率口径 + 期望回报')
const today = await evalJson(`
  const kpis = [...document.querySelectorAll('.kpi')].map(k => [
    (k.querySelector('p')?.textContent || '').trim(),
    (k.querySelector('b')?.textContent || '').trim(),
  ]);
  return { kpis, body: document.body.innerText };
`)
const kpiOf = (label) => (today.kpis.find((k) => k[0] === label) || ['', ''])[1]
const bets = parseInt(kpiOf('注数'), 10)
const cost = toYuan(kpiOf('金额'))
const pWin = kpiOf('中奖概率')

ok(Number.isFinite(bets) && bets > 0, `页面读到了注数：${bets}`)
ok(Number.isFinite(cost) && cost === bets * rule.price, `金额 ${cost} 元 == ${bets} 注 × ${rule.price} 元`)
ok(/%$/.test(pWin), `中奖概率显示为百分比：${pWin}`)
ok(
  today.body.includes('任意一个奖级'),
  '「中奖概率」写明了是「至少中任意一个奖级」（否则会被读成中大奖）'
)
ok(
  today.body.includes(`最低的 ${lowestLevel} 只有 ${lowestPrize} 元`),
  `最低奖级名/金额从规则取：最低的 ${lowestLevel} 只有 ${lowestPrize} 元`
)

const evShown = numAfter(today.body, '期望回报约')
const evTruth = bets * evPerBet
ok(
  Math.abs(evShown - evTruth) <= 0.02,
  `期望回报 ${evShown} 元 == ${bets} 注 × 单注期望 ${evPerBet.toFixed(4)} = ${evTruth.toFixed(2)} 元`
)
const backShown = numAfter(today.body, '平均收回')
const backTruth = (evTruth / cost) * 100
ok(
  Math.abs(backShown - backTruth) <= 0.15,
  `平均收回 ${backShown}% == 期望/投入 = ${backTruth.toFixed(1)}%`
)
ok(evShown < cost, `期望回报 ${evShown} 元 < 投入 ${cost} 元（这才是这一页要说的话）`)

// ================================================================ 2. 档案页
console.log('\n[2] 档案页：清空动作拆分 + 票价口径')
ok(await go('档案'), '导航到档案页')
await sleep(1500)
const settings = await evalJson(`
  return {
    btns: [...document.querySelectorAll('button')].map(b => (b.textContent || '').trim()),
    body: document.body.innerText,
  };
`)
ok(
  settings.btns.includes('清空全部本地数据（含回测结果）'),
  '有「清空全部本地数据（含回测结果）」——把代价写进按钮文案'
)
ok(
  !settings.btns.includes('只清空玄学档案与收藏'),
  '不再有细分的清空按钮：只留一个「全部清空」（用户明确要过）'
)
ok(
  !settings.btns.includes('清空全部本地数据'),
  '旧的「清空全部本地数据」已不存在（它只说清档案，实际连回测一起删）'
)
ok(settings.body.includes('回测结果只能重跑'), '页面写明「回测结果只能重跑」')
ok(
  settings.body.includes(`注数 × ${rule.price} 元`),
  `票价从 RULES 取而非写死：注数 × ${rule.price} 元`
)
ok(
  settings.body.includes(`${rule.price} 的整数倍`),
  `「能正好花满」的条件跟着票价走：${rule.price} 的整数倍`
)

// ================================================================ 3. 回测页
console.log('\n[3] 回测页：排行榜投入/回收 + 多重比较说明')
ok(await go('回测'), '导航到回测页')
await sleep(2000)
// 默认样本 1000 → 全量 78 模型要十几分钟。探针只验展示，用「全部历史」（只结算 60 期）
const hitAll = await clickButton('全部历史')
ok(!!hitAll, `点到「全部历史」档（${hitAll}）`)
await sleep(1200)
const hitRun = await evalJson(`
  const b = [...document.querySelectorAll('button')].find(x => {
    const t = (x.textContent || '').trim();
    return t.startsWith('开始回测') || t.startsWith('增量补算') || t.startsWith('读取缓存');
  });
  if (!b) return null;
  b.click();
  return (b.textContent || '').trim();
`)
ok(!!hitRun, `开始回测（${hitRun}）`)

let rows = []
for (let i = 0; i < 200 && !rows.length; i++) {
  await sleep(1500)
  rows = await evalJson(`
    return [...document.querySelectorAll('[data-board-row]')].map(el => ({
      id: el.getAttribute('data-board-row'),
      roi: (el.querySelector('[data-roi]')?.textContent || '').trim(),
      io: (el.querySelector('[data-io]')?.textContent || '').trim(),
    }));
  `)
}
ok(rows.length > 0, `排行榜出来了：${rows.length} 行`)

let ioBad = 0
let ioMissing = 0
let roiBad = 0
let costBad = 0
const PERIODS = 60
const BUDGET = 30
let sample = null
for (const r of rows) {
  if (!r.io || !r.io.includes('投入') || !r.io.includes('回收')) {
    ioMissing++
    continue
  }
  const parts = r.io.split('→')
  if (parts.length !== 2) {
    ioBad++
    continue
  }
  const c = toYuan(parts[0])
  const p = toYuan(parts[1])
  if (!Number.isFinite(c) || !Number.isFinite(p) || c <= 0) {
    ioBad++
    continue
  }
  sample = sample || `${c} 元 → ${p} 元`
  // 预算 30 元 × 60 期：投出去的必须接近 1800，且绝不能超预算
  if (c > PERIODS * BUDGET || c < PERIODS * BUDGET * 0.9) costBad++
  const roi = parseFloat(r.roi.replace('%', '')) / 100
  // 展示成「万」时精度只有 0.1 万，容差要放宽；展示成元时按分位对齐
  const tol = r.io.includes('万') ? 0.02 : 0.003
  if (Math.abs((p - c) / c - roi) > tol) roiBad++
}
ok(ioMissing === 0, `每行都有「投入 → 回收」${sample ? `（样例：${sample}）` : ''}`)
ok(ioBad === 0, '投入/回收都能解析成有效金额')
ok(costBad === 0, `投入不超过预算 × 期数（${PERIODS} × ${BUDGET} = ${PERIODS * BUDGET} 元）`)
ok(roiBad === 0, '每行的 (回收 − 投入) / 投入 与同一行的 ROI 一致（能抓出 cost/prize 接反）')

const multi = await evalJson(`
  const el = document.querySelector('[data-multiple]');
  return el ? (el.textContent || '').trim() : '';
`)
ok(!!multi, '真相卡片有「多重比较」那一段')
const cmpN = numAfter(multi, '同时做')
ok(cmpN === rows.length - 1, `比较次数 ${cmpN} == 模型数 − 1 = ${rows.length - 1}`)
ok(multi.includes('看起来显著'), '写明「看起来显著」的是假阳性，不是本事')
const fp = numAfter(multi, '本就会撞出约')
ok(
  Math.abs(fp - Math.round(cmpN * 0.05)) <= 1,
  `假阳性期望个数 ${fp} ≈ ${cmpN} × 5% = ${(cmpN * 0.05).toFixed(2)}`
)

// ================================================================ 3b. 精简文案
// 用户明确要求删掉两块：重型模型「为什么要全跑」的说明、进度条上的「界面不会卡住」。
// 删了就得盯住别被后来的改动塞回来（这类"顺手加回去"最容易复发）。
const shell = await evalJson(`
  const t = document.body.innerText;
  return {
    noHeavyBlurb: !t.includes('连它们都赢不了纯随机') && !t.includes('过拟合'),
    noBusyHint: !t.includes('可随时停止，界面不会卡住'),
    estNote: (document.querySelector('[data-est-note]')?.textContent || '').trim(),
    planFull: (document.querySelector('[data-plan-full]')?.textContent || '').trim(),
  }
`)
ok(shell.noHeavyBlurb, '「为什么要跑重型模型」那整块说明已删掉')
ok(shell.noBusyHint, '「可随时停止，界面不会卡住」这句已删掉')
ok(shell.estNote.includes('实时速率'), '预估下面写明「开跑后按实时速率」', shell.estNote.slice(0, 30))
ok(shell.planFull.includes('约需'), '全量分支给出预估耗时', shell.planFull.slice(0, 40))

// ================================================================ 4. 明细
console.log('\n[4] 明细：净盈亏带单位 + 回收 − 投入 的算式')
const clicked = await evalJson(`
  const el = [...document.querySelectorAll('[data-board-row]')].find(
    e => e.getAttribute('data-board-row') !== 'B01'
  );
  if (!el) return null;
  const b = [...el.querySelectorAll('button')].find(x => (x.textContent || '').trim() === '明细');
  if (!b) return null;
  b.click();
  return el.getAttribute('data-board-row');
`)
ok(!!clicked, `点了 ${clicked} 的明细`)
let detail = null
for (let i = 0; i < 60 && !detail; i++) {
  await sleep(1000)
  const d = await evalJson(`
    const note = document.querySelector('[data-net-note]');
    if (!note) return null;
    const kpis = [...document.querySelectorAll('.kpi')].map(k => [
      (k.querySelector('p')?.textContent || '').trim(),
      (k.querySelector('b')?.textContent || '').trim(),
    ]);
    return { note: (note.textContent || '').trim(), kpis };
  `)
  if (d) detail = d
}
ok(!!detail, '明细汇总出来了')
if (detail) {
  const netKpi = (detail.kpis.find((k) => k[0] === '净盈亏') || ['', ''])[1]
  ok(netKpi.includes('元'), `净盈亏带了单位：${netKpi}`)
  const prize = toYuan(detail.note.split('−')[0] || '')
  const cost2 = numAfter(detail.note, '投入')
  const net = firstNum(netKpi)
  ok(
    Number.isFinite(prize) && Number.isFinite(cost2) && Math.abs(net - (prize - cost2)) <= 1,
    `净盈亏 ${net} == 回收 ${prize} − 投入 ${cost2}`
  )
  ok(detail.note.includes(`${PERIODS} 期累计`), `算式里写了期数（${PERIODS} 期累计）`)
}

// ================================================================ 收尾
ok(pageErrors.length === 0, `页面控制台无报错${pageErrors.length ? '：' + pageErrors[0] : ''}`)

ws.close()
chrome.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉就算了 */
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
