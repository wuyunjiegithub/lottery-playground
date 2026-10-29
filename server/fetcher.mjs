/**
 * 官方开奖接口抓取。
 *
 * 这件事只有服务端能做，不是「网页版配置没配对」的问题：
 *   · 福彩 cwl.gov.cn 完全不返回 CORS 头，浏览器直接被同源策略拦死；
 *   · 体彩 sporttery.cn 虽有 `Access-Control-Allow-Origin: *`，但请求一旦带
 *     `Origin` 头就被 WAF 打回 567（实测：curl 不带 Origin 200，带上就 567）；
 *   · 两边都要求带 `Referer`，而 Referer 是浏览器禁止脚本改写的请求头。
 *
 * Node 这一侧三个限制全不存在，直接发就是了。
 */

const DLT_API = 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
const SSQ_API = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice'
const REF_DLT = 'https://www.lottery.gov.cn/kj/kjlb.html?dlt'
const REF_SSQ = 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/'

// 体彩 WAF 会按 UA 判机器人：实测 HeadlessChrome 这种 UA 直接吃 567。
// 装成一台普通桌面 Chrome。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

async function get(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
  return res.text()
}

export async function fetchDlt(count = 60) {
  const url = `${DLT_API}?gameNo=85&provinceId=0&pageSize=${count}&pageNo=1&isVerify=1`
  const json = JSON.parse(await get(url, REF_DLT))
  const list = json?.value?.list || []
  const out = []
  for (const r of list) {
    const nums = String(r.lotteryDrawResult || '')
      .split(/\s+/)
      .filter(Boolean)
    if (nums.length < 7) continue
    out.push({
      lottery: 'dlt',
      issue: String(r.lotteryDrawNum),
      date: String(r.lotteryDrawTime || '').slice(0, 10),
      front: nums.slice(0, 5).map(Number),
      back: nums.slice(5, 7).map(Number),
      // 接口带千分位逗号。不剥掉的话 Number("289,057,331") 是 NaN，
      // 前端 yi() 里 `if (!n) return '—'` 会让销售额永远显示成横杠（已修，这里也别再喂脏数据）
      pool: String(r.poolBalanceAfterdraw ?? '').replace(/,/g, '') || null,
      sales: r.totalSaleAmount != null ? String(r.totalSaleAmount).replace(/,/g, '') : null,
      prizes: {},
      source: 'official',
    })
  }
  return out
}

export async function fetchSsq(count = 60) {
  const url = `${SSQ_API}?name=ssq&pageNo=1&pageSize=${count}&systemType=PC`
  const json = JSON.parse(await get(url, REF_SSQ))
  const list = json?.result || []
  const out = []
  for (const r of list) {
    const red = String(r.red || '')
      .split(',')
      .filter(Boolean)
      .map(Number)
    const blue = String(r.blue || '')
      .split(',')
      .filter(Boolean)
      .map(Number)
    if (red.length < 6 || blue.length < 1) continue
    const prizes = {}
    for (const p of r.prizegrades || []) if (p?.type) prizes[String(p.type)] = String(p.typemoney ?? '')
    out.push({
      lottery: 'ssq',
      issue: String(r.code),
      date: String(r.date || '').slice(0, 10),
      front: red,
      back: blue,
      pool: r.poolmoney != null ? String(r.poolmoney).replace(/,/g, '') : null,
      sales: r.sales != null ? String(r.sales).replace(/,/g, '') : null,
      prizes,
      source: 'official',
    })
  }
  return out
}

export async function fetchLatest(lottery, count = 60) {
  return lottery === 'ssq' ? fetchSsq(count) : fetchDlt(count)
}
