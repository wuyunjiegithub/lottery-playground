// 浏览器冒烟测试：用本机 Chrome 无头模式真实加载页面，检查应用是否渲染成功、有无控制台报错。
//
// 为什么需要它：Vite 的 typecheck/build 只能保证「能编译」，保证不了「能跑起来」。
// 之前就踩过——单文件页面里 IndexedDB 相关逻辑一旦抛错，主内容区会一直停在
// 「正在载入历史数据…」，而 build 依然是绿的。
//
// 用法：
//   node scripts/smoke-browser.mjs                       # 默认测 dist-single/index.html
//   node scripts/smoke-browser.mjs <url>                 # 测任意地址（含 http://）
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
  console.error('未找到 Chrome / Edge，跳过浏览器冒烟')
  process.exit(0)
}

const arg = process.argv[2]
const target =
  arg ||
  pathToFileURL(resolve('dist-single/index.html')).href
if (!arg && !existsSync(resolve('dist-single/index.html'))) {
  console.error('dist-single/index.html 不存在，请先 npm run build:single')
  process.exit(1)
}

const PORT = 9336
const profile = mkdtempSync(join(tmpdir(), 'wb-smoke-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1280,900',
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

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.navigate', { url: target })
await sleep(7000)

const res = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    mounted: !!(document.querySelector('#app')||{}).firstElementChild,
    mainLen: ((document.querySelector('main')||{}).innerText||'').length,
    stuck: ((document.querySelector('main')||{}).innerText||'').includes('正在载入历史数据'),
    head: ((document.querySelector('main')||{}).innerText||'').slice(0, 80)
  })`,
  returnByValue: true,
})
const o = JSON.parse(res.result.result.value)

console.log(`目标: ${target}`)
console.log(`  应用已挂载: ${o.mounted ? '✓' : '✗'}`)
console.log(`  主内容字数: ${o.mainLen}`)
console.log(`  卡在加载页: ${o.stuck ? '✗ 是' : '✓ 否'}`)
console.log(`  首屏摘要: ${o.head.replace(/\n/g, ' ⏎ ')}`)
console.log(`  控制台错误: ${errors.length ? '✗\n    ' + errors.join('\n    ') : '✓ 无'}`)

const ok = o.mounted && o.mainLen > 50 && !o.stuck && errors.length === 0
console.log(ok ? '\n浏览器冒烟通过' : '\n浏览器冒烟失败')

ws.close()
chrome.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* ignore */
}
process.exit(ok ? 0 : 1)
