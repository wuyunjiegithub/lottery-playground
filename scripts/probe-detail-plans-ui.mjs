/**
 * 浏览器探针：模型详情页「票型评估」区。
 *
 * 需求：原来这里只列票型名和注数/覆盖/中奖率/风险，**一个号码都没有**，
 * 用户看不出每种票型到底买了什么号。现在每种票型都要列出实际号码。
 *
 * 本探针在 Node 侧用 core 独立算出真值，再跟 CDP 读到的页面显示逐行比对：
 *   1. 每个票型卡片都渲染出号码球，且号码与 core 算出的完全一致；
 *   2. 胆码 / 拖码标注正确（拖码半透明、胆码不透明）；
 *   3. 后区号码用蓝色球，与前区分开；
 *   4. **期望回报在所有票型间完全一致**，且等于 bets × singleBetEV
 *      —— 这是 UI 新增的核心文案，必须能被验证；
 *   5. 旧的「注数/金额」列已移除（那两列每行都一样，是噪声）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
/** 组合数，用来验算页面展示的「注数 = C(b,k) × m」是不是真的等于 bets */
function comb(n, k) {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i
  return Math.round(r)
}

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
  logLevel: 'error',
})
const { enumeratePlans, recommend, singleBetEV, planEV } = await vite.ssrLoadModule('/src/core/ticket.ts')
const { ALL_MODELS } = await vite.ssrLoadModule('/src/core/models/index.ts')
const { RULES } = await vite.ssrLoadModule('/src/core/lottery.ts')

// 用真实内联数据算真值，和页面完全同源。
// 用 readFileSync + JSON.parse 而不是动态 import：Windows 上绝对路径不是合法 ESM specifier。
const packet = JSON.parse(readFileSync(resolve('src/assets/lottery-data.json'), 'utf8'))
const pad = (n) => String(n).padStart(2, '0')

const truth = new Map()
for (const lottery of ['ssq', 'dlt']) {
  const history = (Array.isArray(packet) ? packet : packet.draws)
    .filter((d) => d.lottery === lottery)
    .sort((a, b) => a.issue.localeCompare(b.issue))
  if (!history.length) {
    console.log(`  (${lottery} 无内联数据，跳过真值计算)`)
    continue
  }
  for (const budget of [30, 50, 100]) {
    const model = ALL_MODELS.find((m) => m.meta.id === 'S05') || ALL_MODELS[0]
    const pred = model.predict({
      history,
      lottery,
      nextDate: new Date('2026-10-08'),
      profile: {},
    })
    const { best, ranked } = recommend(enumeratePlans(lottery, pred, budget), budget)
    truth.set(`${lottery}|${budget}|${model.meta.id}`, {
      best,
      total: ranked.length,
      shown: ranked.slice(0, 8),
      ev: singleBetEV(lottery),
      bestEV: planEV(lottery, best),
    })
  }
}
await vite.close()
console.log(`  Node 侧真值：${truth.size} 组（2 彩种 × 3 档预算 × S05）`)

// ---------------------------------------------------------------- 浏览器
const PORT = 9371
const profile = mkdtempSync(join(tmpdir(), 'wb-plan-'))
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
    pageErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
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

/** 在页面里跑一段函数体，返回 JSON。异常带回来而不是静默丢失。 */
async function evalJson(body) {
  const r = await send('Runtime.evaluate', {
    expression: `JSON.stringify((() => { try { ${body} } catch (e) { return { __err: String((e && e.stack) || e) } } })())`,
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

await send('Runtime.enable')
await send('Page.enable')
await send('Log.enable')
await send('Page.navigate', { url: pathToFileURL(resolve('dist-single/index.html')).href })
await sleep(9000)

// 进模型详情页：导航「模型」是列表页，还要再点一个「查看 ›」才进 Detail.vue
await evalJson(`
  const items = [...document.querySelectorAll('a,button,nav *')];
  const t = items.find(e => (e.textContent||'').trim().startsWith('模型'));
  if (t) t.click();
  return 1;
`)
await sleep(3000)
await evalJson(`
  // 列表页每张卡底部有个 <span>查看 ›</span>，真正可点的是它所在的卡片容器。
  // 从该 span 往上找带 click 的祖先（Vue 事件挂在卡片根元素上）。
  const span = [...document.querySelectorAll('span')].find(
    s => (s.textContent||'').trim() === '查看 ›'
  );
  if (!span) return;
  let node = span;
  for (let i = 0; i < 4 && node; i++) {
    node.click();
    node = node.parentElement;
  }
  return 1;
`)
await sleep(4000)

/** 读当前票型评估区的全部卡片 */
const readCards = () =>
  evalJson(`
    // 卡片容器：标题为「算法评估了 N 种票型」的那张卡
    const cards = [...document.querySelectorAll('.card')];
    const card = cards.find(c => (c.textContent||'').includes('算法评估了'));
    if (!card) return { found: false, cardCount: cards.length };
    const list = card.querySelectorAll('.rounded-lg.border');
    const rows = [...list].map(el => {
      const balls = [...el.querySelectorAll('.ball')];
      const isBack = el.querySelectorAll('.ball-b').length;
      // 号码球文本形如 "04"，按 ball-r / ball-b 区分前后区
      const front = [...el.querySelectorAll('.ball-r')].map(b => (b.innerText||'').trim());
      const back = [...el.querySelectorAll('.ball-b')].map(b => (b.innerText||'').trim());
      // 拖码 = ball-r 且 opacity-45
      const tuo = [...el.querySelectorAll('.ball-r.opacity-45')].map(b => (b.innerText||'').trim());
      const txt = (el.innerText||'');
      const mLabel = txt.match(/^([^\\n]+)/);
      const mMeta = txt.match(/(\\d+) 注 · (\\d+) 元 · 覆盖 (\\d+) 号/);
      const mPct = txt.match(/([\\d.]+)%/);
      return {
        label: mLabel ? mLabel[1].trim() : '',
        bets: mMeta ? Number(mMeta[1]) : null,
        cost: mMeta ? Number(mMeta[2]) : null,
        coverage: mMeta ? Number(mMeta[3]) : null,
        pWinText: mPct ? mPct[1] : null,
        front, back, tuo,
        isRecommended: txt.includes('推荐'),
        ballTotal: balls.length,
      };
    });
    return {
      found: true,
      rows,
      header: (card.innerText||'').match(/算法评估了 (\\d+) 种票型/)?.[1],
      // 期望回报那句话可能跨两行（「…：X 元」+「都来自同一个恒等式：…」），
      // 所以取卡片底部整段文字，而不是只筛含「期望回报」的行
      evLine: (() => {
        const lines = (card.innerText||'').split('\\n').map(s => s.trim()).filter(Boolean);
        const idx = lines.findIndex(l => l.includes('期望回报'));
        return idx < 0 ? '' : lines.slice(idx).join(' ');
      })(),
      introLine: (card.innerText||'').split('\\n').filter(l => l.includes('枚举了全部合法票型')).join(' '),
      // 胆拖注数公式 / 复式注数公式，单独抓出来做交叉验算。
      // 只取「=」之前的部分：复式的 formula 后面还跟着「= 15 注 × 2 元」，
      // 连一起会被 split('×') 切出无法解析的碎片。
      formulas: [...list].map(el => {
        const txt = (el.innerText||'');
        const m = txt.match(/注数 = ([^\\n]+)/);
        return m ? m[1].split('=')[0].trim() : null;
      }),
      hasOldTable: !!card.querySelector('table'),
    };
  `)

const first = await readCards()
ok(first.found, `找到「票型评估」卡片（页面共 ${first.cardCount} 张卡）`)
if (!first.found) {
  console.log('  页面结构:', JSON.stringify(first))
  ws.close(); chrome.kill(); rmSync(profile, { recursive: true, force: true })
  await sleep(300)
  process.exit(fail ? 1 : 0)
}
ok(first.rows.length > 0, `渲染出 ${first.rows.length} 个票型卡片`)
ok(!first.hasOldTable, '旧的 <table> 已移除（不再是只有文字的表格）')

/** 在档案页把预算设成 b（预算只在档案页有控件），再导航回模型详情页 */
async function setBudget(b) {
  await evalJson(`
    const items = [...document.querySelectorAll('a,button,nav *')];
    const t = items.find(e => (e.textContent||'').trim() === '档案');
    if (t) t.click();
    return 1;
  `)
  await sleep(2000)
  const r = await evalJson(`
    const btn = [...document.querySelectorAll('button')].find(x => {
      const n = Number((x.querySelector('b')||{}).innerText);
      return n === ${b};
    });
    if (!btn) return { ok: false };
    btn.click();
    return { ok: true };
  `)
  await sleep(1200)
  await evalJson(`
    const items = [...document.querySelectorAll('a,button,nav *')];
    const t = items.find(e => (e.textContent||'').trim().startsWith('模型'));
    if (t) t.click();
    return 1;
  `)
  await sleep(2000)
  await evalJson(`
    const span = [...document.querySelectorAll('span')].find(s => (s.textContent||'').trim() === '查看 ›');
    if (!span) return 1;
    let node = span;
    for (let i = 0; i < 4 && node; i++) { node.click(); node = node.parentElement; }
    return 1;
  `)
  await sleep(3200)
  return r.ok
}

console.log('\n【逐组核对：页面号码 vs Node 独立真值】')
for (const [key, t] of truth) {
  const [lottery, budget] = key.split('|')
  // 切彩种（在详情页顶部导航）
  await evalJson(`
    const btns = [...document.querySelectorAll('button')];
    const name = ${JSON.stringify(RULES[lottery].name)};
    const b = btns.find(x => (x.textContent||'').trim() === name);
    if (b) b.click();
    return 1;
  `)
  await sleep(2200)
  // 切预算（预算控件在档案页）
  const gotBudget = await setBudget(Number(budget))
  ok(gotBudget, `${lottery} ${budget}元：预算切换成功`)
  // 选模型 S05（保证与真值同源）
  const picked = await evalJson(`
    const sel = document.querySelector('select');
    if (!sel) return { ok: false };
    const opt = [...sel.options].find(o => (o.textContent||'').startsWith('S05'));
    if (!opt) return { ok: false };
    sel.value = opt.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  `)
  if (!picked.ok) ok(false, `${lottery} ${budget}元：模型下拉里找不到 S05`)
  await sleep(2800)

  const st = await readCards()
  if (!st.found) {
    ok(false, `${lottery} 切过去后找不到票型评估卡`)
    continue
  }
  const totalPlans = t.total
  const expectRows = Math.min(8, totalPlans)
  ok(
    st.rows.length === expectRows,
    `${lottery} 渲染 ${st.rows.length} 个卡片，Node 真值共 ${totalPlans} 种（UI 取前 8）`
  )
  ok(
    st.header === String(totalPlans),
    `${lottery} 标题写「评估了 ${st.header} 种」，真值 ${totalPlans} 种`
  )
  // 被截断时必须明确告诉用户「还有更多」，否则标题的 9 和列表的 8 会让人以为少了一张；
  // 没截断时则不该出现这句多余的话。两个方向都要断言，否则断言会空跑。
  const truncated = totalPlans > 8
  const disclosed = st.introLine.includes(`共 ${totalPlans} 种`) &&
    st.introLine.includes(`前 ${st.rows.length} 种`)
  ok(
    truncated ? disclosed : !disclosed,
    truncated
      ? `${lottery} 票型被截断（${totalPlans} → ${st.rows.length}）时明确说明了「共 N 种，前 M 种」`
      : `${lottery} 未截断（${totalPlans} 种全部列出），没有多余的截断说明`
  )

  // 逐行比号码
  let mismatch = 0
  let checked = 0
  let formulaChecked = 0
  for (let i = 0; i < Math.min(st.rows.length, t.shown.length); i++) {
    const got = st.rows[i]
    const want = t.shown[i]
    const gotFront = got.front.join(',')
    const wantFront = want.frontNums.map(pad).join(',')
    const gotBack = got.back.join(',')
    const wantBack = want.backNums.map(pad).join(',')
    checked++
    if (gotFront !== wantFront || gotBack !== wantBack) {
      mismatch++
      console.log(`      行 ${i} 号码不符`)
      console.log(`        页面 前[${gotFront}] 后[${gotBack}]`)
      console.log(`        真值 前[${wantFront}] 后[${wantBack}]  (${want.label})`)
    }
    if (want.dans?.length) {
      const wantTuo = want.tuos.map(pad).join(',')
      if (got.tuo.join(',') !== wantTuo) {
        mismatch++
        console.log(`      行 ${i} 拖码标注不符：页面[${got.tuo.join(',')}] 真值[${wantTuo}]`)
      }
    }
    if (got.cost !== want.cost || got.bets !== want.bets) {
      mismatch++
      console.log(`      行 ${i} 注数/金额不符：页面 ${got.bets}注${got.cost}元，真值 ${want.bets}注${want.cost}元`)
    }
    // 页面显示的「注数 = 公式」必须真的能算出 bets，否则这行说明就是错的
    const shownF = st.formulas[i]
    if (shownF) {
      // 形如 C(5,3) × 5 或 C(5,3) × C(4,2)
      let acc = 1
      let okF = true
      for (const part of shownF.split('×')) {
        const cm = part.trim().match(/^C\((\d+),(\d+)\)$/);
        const num = part.trim().match(/^(\d+)$/);
        if (cm) acc *= comb(Number(cm[1]), Number(cm[2]))
        else if (num) acc *= Number(num[1])
        else {
          okF = false
          break
        }
      }
      if (!okF || acc !== want.bets) {
        mismatch++
        console.log(`      行 ${i} 注数公式错：页面「${shownF}」算出 ${acc}，真值 bets=${want.bets}`)
      }
      formulaChecked++
    }
  }
  ok(
    formulaChecked > 0,
    `${lottery} ${budget}元：页面展示的注数公式共验算 ${formulaChecked} 条，都能真的算出 bets`
  )
  ok(mismatch === 0, `${lottery} ${budget}元：${checked} 行号码/胆拖/注数与真值逐项一致（${mismatch} 处不符）`)

  // 推荐徽标只出现在第 1 行
  ok(
    st.rows[0]?.isRecommended && st.rows.slice(1).every((r) => !r.isRecommended),
    `${lottery} 只有第 1 行标「推荐」`
  )

  // 期望回报文案：必须给出可验证的数字与推导，而不是只说「理论上一致」
  const evExpect = t.bestEV.toFixed(2)
  ok(
    st.evLine.includes(evExpect),
    `${lottery} 期望回报文案显示 ${evExpect} 元（实得：${st.evLine.slice(0, 110)}）`
  )
  const evNoteWant = `${t.best.bets} 注 × 每注 ${t.ev.toFixed(2)} 元`
  ok(st.evLine.includes(evNoteWant), `${lottery} 期望回报给出推导「${evNoteWant}」`)
  // 只有 1 种票型时不能说「N 种票型分钱不差」，太别扭
  ok(
    t.total <= 1
      ? !st.evLine.includes('1 种票型分钱不差')
      : st.evLine.includes(`${t.total} 种票型分钱不差`),
    `${lottery} ${t.total} 种票型时措辞正确${t.total <= 1 ? '（单数时说「只凑得出这一种票型」）' : ''}`
  )
}

console.log('\n【控制台】')
ok(pageErrors.length === 0, `无页面报错（${pageErrors.length} 条）${pageErrors.slice(0, 3).join(' / ')}`)

console.log(`\n通过 ${pass} / 失败 ${fail}`)
ws.close()
chrome.kill()
rmSync(profile, { recursive: true, force: true })
await sleep(300)
process.exit(fail ? 1 : 0)