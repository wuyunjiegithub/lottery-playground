/**
 * 浏览器探针：档案保存后刷新还在不在。
 *
 * 这个 bug 的厉害之处在于**界面上没有任何异常**：点保存 → 弹窗说「已保存到本机」→
 * 刷新 → 没了。原因是 IndexedDB 写入走结构化克隆，克隆不了 Vue 的响应式代理，
 * 每次 put 都抛 DataCloneError，而 persist() 把错误 catch 掉了。
 *
 * 所以验证必须是「真浏览器 + 真刷新」：
 *   1. 填档案 → 保存 → 直接读 IndexedDB，确认**真的落盘了**（这一步能抓出静默失败）；
 *   2. 刷新 → 回到档案页，确认输入框里还在。
 *
 * 注意：**不能用 file:// 跑这条**。file:// 是不透明源，Chrome 直接不给 IndexedDB，
 * 存储层会降级到内存 —— 那样刷新前后都读不到，测出来的是假象。
 * 所以这里起一个 vite preview 用 http 跑。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preview } from 'vite'

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

const PORT_HTTP = 5199
const server = await preview({ preview: { port: PORT_HTTP }, logLevel: 'error' })
const URL_APP = `http://localhost:${PORT_HTTP}/`

// ---------------------------------------------------------------- 浏览器
const PORT = 9375
const profileDir = mkdtempSync(join(tmpdir(), 'wb-persist-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1400,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
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
  server.httpServer.close()
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
const dialogs = []
const pageErrors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
  // alert() 会阻塞页面 JS，不接住的话 evaluate 会永久挂起
  if (m.method === 'Page.javascriptDialogOpening') {
    dialogs.push(m.params.message)
    send('Page.handleJavaScriptDialog', { accept: true })
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrors.push(
      m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text
    )
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    pageErrors.push(m.params.args.map((a) => a.value || a.description).join(' '))
  }
})
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++idc
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params }))
  })

async function ev(body) {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => { try { ${body} } catch (e) { return { __err: String((e && e.stack) || e) } } })())`,
    returnByValue: true,
    awaitPromise: true,
  })
  const v = r.result?.result?.value
  if (typeof v !== 'string') return { __raw: JSON.stringify(r.result) }
  const p = JSON.parse(v)
  if (p && p.__err) throw new Error('页面内异常: ' + p.__err)
  return p
}

/** 可返回 Promise 的表达式。别用 ev：JSON.stringify(promise) 恒为 '{}' */
async function evRaw(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (r.result?.exceptionDetails) {
    throw new Error(
      r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text
    )
  }
  return r.result?.result?.value
}

const readUserState = () =>
  evRaw(`
    new Promise((res) => {
      const req = indexedDB.open('lottery_playground', 1);
      req.onsuccess = () => {
        const g = req.result.transaction('kv', 'readonly').objectStore('kv').get('user_state');
        g.onsuccess = () => res(g.result ? g.result.v : 'no-record');
        g.onerror = () => res('read-error');
      };
      req.onerror = () => res('open-error');
    })
  `)

const goSettings = () =>
  ev(`
    const t = [...document.querySelectorAll('a,button,nav *')].find(
      e => (e.textContent || '').trim().startsWith('档案')
    );
    if (t) t.click();
    return !!t;
  `)

const readInputs = () =>
  ev(`
    return [...document.querySelectorAll('input')].map(i => [i.type, i.value]);
  `)

await send('Runtime.enable')
await send('Page.enable')
await send('Page.navigate', { url: URL_APP })
await sleep(12000)

console.log('[1] 填档案并保存')
ok(await goSettings(), '进到档案页')
await sleep(1200)
ok(JSON.stringify(await readInputs()).includes('[["date",""],["text",""'), '初始是空的')

await ev(`
  const set = (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const date = document.querySelector('input[type=date]');
  if (date) set(date, '1990-05-06');
  const text = document.querySelector('input[type=text]');
  if (text) set(text, '王小明');
  const male = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '男');
  if (male) male.click();
  const b50 = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim().startsWith('50'));
  if (b50) b50.click();
  return 1;
`)
await sleep(800)
console.log('  填完的输入框：', JSON.stringify(await readInputs()))

// 档案页已经没有「保存」按钮了：输入即双向绑定、即时落盘。
// 这里故意**不点任何按钮**，验证「改完就存」而不是「要记得点保存」。
const hasSaveBtn = await ev(`
  return [...document.querySelectorAll('button')].some(x => (x.textContent || '').includes('保存档案'));
`)
ok(!hasSaveBtn, '页面上没有「保存档案」按钮（改完即存，不用点）')
await sleep(1500)

console.log('\n[2] 不点保存，直接读库：到底落盘了没有')
const st = await readUserState()
ok(
  !!st && st !== 'no-record',
  `IndexedDB 里有 user_state${st && st !== 'no-record' ? '：' + JSON.stringify(st) : '（写库被静默吞掉了）'}`
)
ok(st?.profile?.name === '王小明', `姓名落盘：${st?.profile?.name}`)
ok(st?.profile?.birthDate === '1990-05-06', `出生日期落盘：${st?.profile?.birthDate}`)
ok(st?.profile?.gender === 'm', `性别落盘：${st?.profile?.gender}`)
ok(st?.budget === 50, `预算落盘：${st?.budget}`)

console.log('\n[3] 刷新')
await send('Page.navigate', { url: URL_APP })
await sleep(12000)
ok(await goSettings(), '刷新后回到档案页')
await sleep(1500)
const after = await readInputs()
const val = (t) => (after.find((a) => a[0] === t) || ['', ''])[1]
ok(val('date') === '1990-05-06', `刷新后出生日期还在：${val('date')}`)
ok(val('text') === '王小明', `刷新后姓名还在：${val('text')}`)
ok(val('number') === '50', `刷新后预算还在：${val('number')}`)
ok(pageErrors.length === 0, `控制台无报错${pageErrors.length ? '：' + pageErrors[0] : ''}`)

ws.close()
chrome.kill()
server.httpServer.close()
try {
  rmSync(profileDir, { recursive: true, force: true })
} catch {
  /* 临时目录清不掉就算了 */
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
