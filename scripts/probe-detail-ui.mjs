/**
 * 逐期明细的真实浏览器验证（临时脚本，验证完可删除）。
 *
 * 为什么必须真跑浏览器：明细是**异步分片**算的，还要靠 IndexedDB 恢复榜面、
 * 靠点击触发按需重算。这些在 typecheck / build / SSR 验证里全都看不出来——
 * 编译绿灯不等于点得动。这里开真 Chrome 点一遍。
 *
 *   node scripts/probe-detail-ui.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
if (!existsSync(resolve('dist-single/index.html'))) {
  console.error('dist-single/index.html 不存在，请先 npm run build:single')
  process.exit(1)
}

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用 http 而不是 file://：file:// 下 IndexedDB 行为不稳，会误判成"卡加载"
const PORT = 4183
const html = readFileSync(resolve('dist-single/index.html'), 'utf8')
const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CDP = 9337
const profile = mkdtempSync(join(tmpdir(), 'wb-detail-'))
const proc = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1280,900',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank',
  ],
  { stdio: 'ignore' }
)

let wsUrl = null
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200)
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/version`)
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
}
if (!wsUrl) {
  console.error('无法连接浏览器 DevTools')
  proc.kill()
  process.exit(1)
}

const tab = await fetch(`http://127.0.0.1:${CDP}/json/new?about:blank`, { method: 'PUT' })
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

/** 在页面里求值。返回 Promise 时自动 await，并序列化成可比较的值 */
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    // 用 Function 构造器绕开模板字符串的转义地狱：
    // 页面里那些含 \d \n 的正则直接写在反引号里会被外层提前吃掉，
    // 表现为莫名其妙的 "Uncaught"。字符串参数则完整保留。
    //
    // 注意只能包成 `(expr)`、**不能再补 ()()**：调用方传进来的往往已经是
    // 调好的 IIFE（`() => {...})()`），多补一次会变成"把返回值当函数再调"，
    // 报 is not a function。
    expression: `(async () => {
      try {
        const v = await (new Function('return (' + ${JSON.stringify(expr)} + ')'))()
        return typeof v === 'string' ? v : JSON.stringify(v)
      } catch (err) {
        return 'ERR:' + (err && err.message)
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const raw = r.result?.result?.value
  if (typeof raw === 'string' && raw.startsWith('ERR:')) {
    // 让失败显形：直接返回 undefined 的话，下游 d.summary 会静默变成 undefined，
    // 报出来的是「功能没做」而不是「我的查询写错了」，排查方向会被带偏。
    throw new Error(`页面求值失败: ${raw.slice(0, 200)}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** 数一数有多少个文字等于 target 的可见按钮。空/隐藏的一律不算 */
const countBtns = (target) =>
  evalJs(
    `[...document.querySelectorAll('button')]
       .filter(b => b.offsetParent !== null && b.textContent.trim() === ${JSON.stringify(target)})
       .length`
  )

/** 点第一个文字等于 target 的可见按钮，返回是否点到 */
/** 点第一个可见且 textContent **以** target 开头（忽略尾随）的按钮 */
const clickBtn = (target) =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent !== null && x.textContent.trim().startsWith(${JSON.stringify(target)}))
    if (!b) return false
    if (b.disabled) return 'disabled'
    b.click()
    return true
  })()`)

/** 点第一个文字包含 part 的可见按钮 */
const clickBtnContains = (part) =>
  evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent !== null && x.textContent.includes(${JSON.stringify(part)}))
    if (!b) return false
    if (b.disabled) return 'disabled'
    b.click()
    return true
  })()`)

try {
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await sleep(6000)

  ok('应用已挂载', await evalJs(`!!document.querySelector('#app').firstElementChild`))

  ok('切到回测页', (await clickBtn('回测')) === true)
  await sleep(1500)
  // 判据用「回测参数」：排行榜卡片是 v-if="board.length"，
  // 首次启动还没跑过时压根不渲染，用它判断会把"还没回测"误报成"页面没打开"
  ok('回测页已渲染', await evalJs(`document.body.innerText.includes('回测参数')`))

  // 榜面来自本地缓存；没有就先跑一次回测。
  // 必须先切到「全部历史」档：回测已改成固定跑全部 78 个模型（含重型）。
  // 快捷档里样本 500/1000/2000 分别要 16/17/15 分钟（**样本越小反而越慢**，
  // 因为 periods = total − sample，样本小 ⇒ 结算期数多）；
  // 「全部历史」只结算最后 60 期，约 1.5 分钟。
  let rows = Number(await countBtns('明细'))
  if (!rows) {
    console.log('榜面为空，先跑一次回测（78 个模型 × 60 期，约 1.5 分钟）…')
    const started = await clickBtn('全部历史')
    ok('切到「全部历史」档', started === true, String(started))
    await sleep(800)
    ok('点了「开始回测」', (await clickBtnContains('开始回测')) === true)
    // 跑的过程中顺带盯着「实时速率」那一行：用户报的问题正是
    // 「进度条说 80 分钟、参数区还印着 18 分钟」两个数字打架
    let sawLiveTotal = false
    let liveSample = ''
    const timeline = []
    // 300ms 一采：先用 2s 的粒度，结果第一轮就 rows=78，完全看不清回测到底跑了多久
    for (let i = 0; i < 300 && !rows; i++) {
      await sleep(300)
      const snap = await evalJs(`(() => {
        const t = (document.querySelector('[data-live-total]')?.innerText || '').trim()
        const eta = (document.querySelector('[data-eta]')?.innerText || '').trim()
        return { t, eta }
      })()`)
      rows = Number(await countBtns('明细'))
      if (i < 4 || i % 25 === 0) timeline.push(`${(i * 0.3).toFixed(1)}s:rows=${rows},live=${snap?.t ? 'Y' : 'n'},eta=${snap?.eta || '-'}`)
      if (snap?.t && !sawLiveTotal) {
        sawLiveTotal = true
        liveSample = String(snap.t).slice(0, 60)
      }
    }
    console.log('    时间线：' + timeline.join(' | '))
    // 真实耗时必须读出来：COST 系数是在 Node 里测的，浏览器更快的话就得按这儿校准
    const spent = await evalJs(`(document.body.innerText.match(/实跑用了\\s*([^\\n。]+)/) || [])[1] || ''`)
    console.log(`    本次实跑：${spent}`)
    ok('回测中出现「按当前速率全程约 X」', sawLiveTotal === true, liveSample)

    // 实时速率必须被写回本机校准：下次开跑前参数区就能报出这台机器的真实量级
    const note = await evalJs(
      `(document.querySelector('[data-est-note]')?.innerText || '').trim()`
    )
    ok(
      '跑完把实测速率写回本机校准',
      String(note).includes('已按本机') && String(note).includes('实跑校准'),
      String(note).slice(0, 46)
    )
  }
  ok('排行榜每行都有「明细」按钮', rows > 0, `${rows} 行`)
  ok('跑的是全部 78 个模型', rows === 78, `${rows} 行`)

  ok('点开了某个模型的明细', (await clickBtn('明细')) === true)

  let ready = false
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    // 判据：面板里既不在重算、又已经画出了号码球。
    // 面板标题「逐期明细」是常在的，只看它会把"还没算完"误判成"好了"。
    ready = await evalJs(`(() => {
      const P = document.querySelector('[data-detail-panel]')
      if (!P) return false
      if (P.innerText.includes('正在逐期重算')) return false
      return P.querySelectorAll('.pick-hit, .pick-miss').length > 0
    })()`)
    if (ready) break
  }
  ok('明细面板加载完成', ready === true)

  // —— 弹框形态：明细以前是页面底部内联的一段，几千期要一路滑到底才看得见
  const modal = await evalJs(`(() => {
    const P = document.querySelector('[data-detail-panel]')
    if (!P) return null
    const sc = [...P.querySelectorAll('*')].find(e => getComputedStyle(e).overflowY === 'auto')
    const r = P.getBoundingClientRect()
    return {
      mask: !!document.querySelector('[data-detail-mask]'),
      teleported: !P.closest('.card'),
      scrollBox: !!sc,
      // 内容超高时内部容器必须真的能滚，否则弹框会被撑出屏幕
      scrollH: sc ? sc.scrollHeight : 0,
      clientH: sc ? sc.clientHeight : 0,
      closeBtn: !!P.querySelector('[aria-label="关闭"]'),
      top: Math.round(r.top),
      heightVsViewport: Math.round((r.height / window.innerHeight) * 100),
      header: (P.innerText.split(String.fromCharCode(10))[0] || '').trim(),
    }
  })()`)
  ok('明细以弹框呈现（有遮罩）', modal?.mask === true)
  ok('弹框已 teleport 到 body，不会被卡片裁掉', modal?.teleported === true)
  ok('弹框内容区可内部滚动', modal?.scrollBox === true)
  ok('弹框高度不超过视口', modal?.heightVsViewport <= 92, `占视口 ${modal?.heightVsViewport}%`)
  ok('弹框落在可视区域内', modal?.top >= 0 && modal.top < 300, `top=${modal?.top}`)
  ok('有关闭按钮', modal?.closeBtn === true)
  ok('弹框标题是「逐期明细」', modal?.header === '逐期明细', modal?.header)

  // 全部查询都限定在明细面板内。
  // 之前用 document.body.innerText + indexOf('开奖') 定位，抓到的是页首
  // 「历史数据无法预测未来开奖」那句——两次快照取的是同一处，于是永远"内容相同"。
  const inPanel = 'const P = document.querySelector(\'[data-detail-panel]\')'
  const d = await evalJs(`(() => {
    ${inPanel}
    if (!P) return { missing: true }
    const txt = P.innerText
    const list = P.querySelector('[data-detail-list]')
    const rows = P.querySelectorAll('[data-detail-row]')
    const row0 = rows[0]
    return {
      missing: false,
      summary: txt.includes('已结算') && txt.includes('中奖期数') && txt.includes('最高奖级'),
      draw: !!row0 && row0.innerText.includes('开奖'),
      pick: !!row0 && row0.innerText.includes('选号'),
      rowCount: rows.length,
      hit: P.querySelectorAll('.pick-hit').length,
      miss: P.querySelectorAll('.pick-miss').length,
      extra: P.querySelectorAll('.pick-extra').length,
      chips: txt.split(String.fromCharCode(10)).filter(l => /等 奖|等奖/.test(l) && l.includes('×')).slice(0, 6),
      sample: row0 ? row0.innerText.split(String.fromCharCode(10)).filter(Boolean).join(' ') : '',
      hasList: !!list,
    }
  })()`)

  ok('明细面板已渲染', d.missing !== true)
  ok('有汇总条（已结算/中奖期数/最高奖级）', d.summary)
  ok('每期都画出开奖号码与选号', d.draw && d.pick)
  ok('逐期列表有内容', d.rowCount > 0, `${d.rowCount} 行`)
  ok('命中号码高亮成金色', d.hit > 0, `${d.hit} 个`)
  ok('未中号码也画出来（灰球）', d.miss > 0, `${d.miss} 个`)
  ok('奖级分布有内容', d.chips.length > 0, d.chips.join(' / '))
  console.log('    首行样例：' + String(d.sample).slice(0, 200))

  // 「只看得奖」筛选：面板内不该再出现「未中奖」字样
  await clickBtn('只看得奖')
  await sleep(800)
  ok('「只看得奖」筛选生效', await evalJs(`(() => {
    const P = document.querySelector('[data-detail-panel]')
    if (!P) return false
    const rows = P.querySelectorAll('[data-detail-row]')
    return P.innerText.includes('只看得奖') && rows.length > 0 &&
      ![...rows].some(r => r.innerText.includes('未中奖'))
  })()`))

  // 切另一个模型，验证重新按需计算
  const firstRowText = () =>
    evalJs(`(() => {
      const P = document.querySelector('[data-detail-panel]')
      const r = P && P.querySelector('[data-detail-row]')
      return r ? r.innerText : ''
    })()`)
  const before = await firstRowText()
  // 第一个按钮此时已变成「明细中」，所以直接点剩下的那个
  const switched = await evalJs(`(() => {
    const bs = [...document.querySelectorAll('button')]
      .filter(x => x.offsetParent !== null && x.textContent.trim() === '明细')
    if (!bs.length) return false
    bs[0].click()
    return true
  })()`)
  ok('点开了另一个模型', switched === true)
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    if (await evalJs(
      `!document.querySelector('[data-detail-panel]').innerText.includes('正在逐期重算') &&
       document.querySelectorAll('.pick-hit').length > 0`
    )) break
  }
  const after = await firstRowText()
  ok('切换模型会重新加载明细', before !== after && after.length > 0,
    after === before ? '内容相同' : '内容已更新')

  // —— 关闭路径：ESC 与 ✕ 都要能退出来，退完还能再打开
  for (const key of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type: key, key: 'Escape', code: 'Escape',
      windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
    })
  }
  await sleep(600)
  ok('按 ESC 能关掉弹框', await evalJs(`!document.querySelector('[data-detail-panel]')`))

  const reopened = await evalJs(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => x.offsetParent !== null && x.textContent.trim() === '明细')
    if (!b) return false
    b.click()
    return true
  })()`)
  ok('关掉之后还能再打开', reopened === true)
  await sleep(1500)
  ok('重新打开的弹框有内容', await evalJs(`(document.querySelectorAll('[data-detail-row]').length > 0)`))

  const closed = await evalJs(`(() => {
    const b = document.querySelector('[data-detail-panel] [aria-label="关闭"]')
    if (!b) return false
    b.click()
    return true
  })()`)
  await sleep(600)
  ok('点 ✕ 能关掉弹框', closed === true && (await evalJs(`!document.querySelector('[data-detail-panel]')`)))

  ok('全程无控制台错误', errors.length === 0, errors.slice(0, 2).join(' | '))

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
  process.exitCode = fail ? 1 : 0
} catch (e) {
  console.error('脚本异常：', e)
  process.exitCode = 1
} finally {
  ws.close()
  proc.kill()
  server.close()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
}