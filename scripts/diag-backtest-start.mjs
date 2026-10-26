/**
 * 临时诊断：点「开始回测」之后到底发生了什么。
 *
 * 现象：probe-detail-ui 里点完开始回测，0.3 秒后页面上就有 78 行「明细」按钮，
 * 但同一份页面又写着「上次实跑用了 5 分 31 秒」——两个数字对不上，
 * 必须查清楚是「回测秒开（走了缓存/空跑）」还是「rows 判据不可靠」。
 *
 *   node scripts/diag-backtest-start.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => existsSync(p))
if (!CHROME) process.exit(0)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = 4199
const html = readFileSync(resolve('dist-single/index.html'), 'utf8')
const server = createServer((_q, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const CDP = 9351
const profile = mkdtempSync(join(tmpdir(), 'wb-diag-'))
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--window-size=1280,900', `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

let wsUrl = null
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200)
  try {
    const r = await fetch(`http://127.0.0.1:${CDP}/json/version`)
    if (r.ok) wsUrl = (await r.json()).webSocketDebuggerUrl
  } catch { /* 还没起来 */ }
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
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++idc
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => {
      try {
        const v = await (new Function('return (' + ${JSON.stringify(expr)} + ')'))()
        return typeof v === 'string' ? v : JSON.stringify(v)
      } catch (err) { return 'ERR:' + (err && err.message) }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const raw = r.result?.result?.value
  if (typeof raw === 'string' && raw.startsWith('ERR:')) throw new Error(raw.slice(0, 200))
  try { return JSON.parse(raw) } catch { return raw }
}

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
await sleep(6000)

await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && x.textContent.trim().startsWith('回测'))
  if (b) b.click()
  return true
})()`)
await sleep(4000)

// 页面到底就绪没有？把关键状态一次读全
const state = () => evalJs(`(() => {
  const t = document.body.innerText
  return {
    rows: [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null && b.textContent.trim() === '明细').length,
    hasParams: t.includes('回测参数'),
    loading: t.includes('正在载入历史数据'),
    total: (t.match(/共 (\\d+) 期/) || [])[1] || '',
    btn: (() => {
      const b = [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && (x.textContent.includes('开始回测') || x.textContent.includes('增量补算') || x.textContent.includes('读取缓存')))
      return b ? b.textContent.trim() : ''
    })(),
    running: t.includes('回测中'),
    spent: (t.match(/实跑用了\\s*([^\\n。]+)/) || [])[1] || '',
    note: (document.querySelector('[data-est-note]')?.innerText || '').slice(0, 40),
    plan: (document.querySelector('[data-plan-full]')?.innerText || '').trim()
        || (document.querySelector('[data-plan-cache]')?.innerText || '').trim()
        || (document.querySelector('[data-plan-extend]')?.innerText || '').trim(),
  }
})()`)

console.log('点「全部历史」之前：', JSON.stringify(await state()))

await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && x.textContent.trim().startsWith('全部历史'))
  if (!b) return false
  b.click(); return true
})()`)
await sleep(1000)
console.log('点「全部历史」之后：', JSON.stringify(await state()))

const clicked = await evalJs(`(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.offsetParent !== null && x.textContent.includes('开始回测'))
  if (!b) return false
  b.click(); return true
})()`)
console.log('点「开始回测」：', clicked)

const t0 = Date.now()
for (let i = 0; i < 200; i++) {
  await sleep(2000)
  const s = await state()
  if (i < 3 || i % 10 === 0) {
    console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s rows=${s.rows} running=${s.running} btn="${s.btn}" spent="${s.spent}" note="${s.note}"`)
  }
  if (!s.running && s.rows > 0) {
    console.log(`  完成 @ ${((Date.now() - t0) / 1000).toFixed(0)}s  rows=${s.rows}  spent=${s.spent}`)
    break
  }
}
console.log('页面错误：', errors.slice(0, 3))
console.log('最终：', JSON.stringify(await state()))

ws.close()
proc.kill()
server.close()
try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
