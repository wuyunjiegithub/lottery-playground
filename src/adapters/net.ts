import type { Draw, LotteryType } from '../types'

/**
 * 网络适配层：一套前端代码，三种运行环境。
 *
 * | 环境                | 通道             | 能否直连官方接口 |
 * |---------------------|------------------|------------------|
 * | 桌面 (Tauri)        | Rust 原生层      | 能（无同源策略） |
 * | Android (Capacitor) | OkHttp 原生层    | 能               |
 * | 纯浏览器网页        | 数据包           | 不能（CORS 硬限制）|
 *
 * 上层业务只调用 fetchLatest / loadPacket，不关心自己跑在哪里。
 */

export type NetMode = 'tauri' | 'capacitor' | 'packet'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const REF_DLT = 'https://www.lottery.gov.cn/kj/kjlb.html?dlt'
const REF_SSQ = 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/'

const DLT_API = 'https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry'
const SSQ_API = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice'

/** 探测当前运行环境 */
export function detectNetMode(): NetMode {
  if (typeof window === 'undefined') return 'packet'
  const w = window as any
  if (w.__TAURI_INTERNALS__ || w.__TAURI__) return 'tauri'
  if (w.Capacitor?.isNativePlatform?.()) return 'capacitor'
  return 'packet'
}

/** 当前环境是否支持直连官方接口（决定能否自动更新） */
export function canFetchLive(): boolean {
  return detectNetMode() !== 'packet'
}

export function modeLabel(): string {
  const m = detectNetMode()
  return m === 'tauri'
    ? '桌面端 · 可自动更新'
    : m === 'capacitor'
      ? '移动端 · 可自动更新'
      : '网页版 · 数据包模式'
}

/** 原生层 GET：不受同源策略限制，Referer 可自定义 */
async function nativeGet(url: string, referer: string): Promise<string> {
  const mode = detectNetMode()
  if (mode === 'tauri') {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<string>('http_get', { url, referer })
  }
  if (mode === 'capacitor') {
    const { CapacitorHttp } = await import('@capacitor/core')
    const res = await CapacitorHttp.get({
      url,
      headers: { Referer: referer, 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
    })
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  }
  throw new Error('当前环境无法直连官方接口，请使用数据包导入')
}

// 内联数据包：随 JS 一起打包。
// 必要性：以 file:// 直接双击打开 index.html 时，浏览器会拦截 fetch 本地 JSON，
// 有了内联兜底，网页版才能真正做到「打开就能用」。
import inlinePacket from '../assets/lottery-data.json'

/**
 * 载入离线数据包（所有环境都支持）。
 * 优先 fetch 独立 JSON（http 环境），失败则回退内联数据（file:// 环境）。
 */
export async function loadPacket(url = './data/lottery-data.json'): Promise<Draw[]> {
  // file:// 协议下浏览器会直接拦截对本地 JSON 的 fetch，不必尝试，直接用内联数据
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    return (inlinePacket as any).draws as Draw[]
  }
  try {
    const res = await fetch(url)
    if (res.ok) {
      const json = await res.json()
      const draws = (json.draws || []) as Draw[]
      if (draws.length) return draws
    }
  } catch {
    /* file:// 或离线场景，回退内联数据 */
  }
  const draws = (inlinePacket as any).draws as Draw[]
  if (!draws?.length) throw new Error('数据包为空')
  return draws
}

// ---------------------------------------------------------------- 抓取与解析

/** 抓取大乐透最新若干期 */
export async function fetchDltLatest(count = 30): Promise<Draw[]> {
  const url = `${DLT_API}?gameNo=85&provinceId=0&pageSize=${count}&pageNo=1&isVerify=1`
  const body = await nativeGet(url, REF_DLT)
  const json = JSON.parse(body)
  const list = json?.value?.list || []
  const out: Draw[] = []
  for (const r of list) {
    const nums = String(r.lotteryDrawResult || '').split(/\s+/).filter(Boolean)
    if (nums.length < 7) continue
    out.push({
      lottery: 'dlt',
      issue: String(r.lotteryDrawNum),
      date: String(r.lotteryDrawTime || '').slice(0, 10),
      front: nums.slice(0, 5).map(Number),
      back: nums.slice(5, 7).map(Number),
      pool: String(r.poolBalanceAfterdraw || '').replace(/,/g, ''),
      sales: r.totalSaleAmount != null ? String(r.totalSaleAmount) : null,
      source: 'official',
    })
  }
  return out
}

/** 抓取双色球最新若干期 */
export async function fetchSsqLatest(count = 30): Promise<Draw[]> {
  const url = `${SSQ_API}?name=ssq&pageNo=1&pageSize=${count}&systemType=PC`
  const body = await nativeGet(url, REF_SSQ)
  const json = JSON.parse(body)
  const list = json?.result || []
  const out: Draw[] = []
  for (const r of list) {
    const red = String(r.red || '').split(',').filter(Boolean).map(Number)
    const blue = String(r.blue || '').split(',').filter(Boolean).map(Number)
    if (red.length < 6 || blue.length < 1) continue
    const prizes: Record<string, string> = {}
    for (const p of r.prizegrades || []) if (p?.type) prizes[String(p.type)] = String(p.typemoney ?? '')
    out.push({
      lottery: 'ssq',
      issue: String(r.code),
      date: String(r.date || '').slice(0, 10),
      front: red,
      back: blue,
      pool: r.poolmoney != null ? String(r.poolmoney) : null,
      sales: r.sales != null ? String(r.sales) : null,
      prizes,
      source: 'official',
    })
  }
  return out
}

/** 抓取指定彩种的最新数据 */
export async function fetchLatest(lottery: LotteryType, count = 30): Promise<Draw[]> {
  return lottery === 'ssq' ? fetchSsqLatest(count) : fetchDltLatest(count)
}

/** 把新抓到的期合并进已有数据（按期号去重） */
export function mergeDraws(base: Draw[], incoming: Draw[]): { draws: Draw[]; added: number } {
  const map = new Map<string, Draw>()
  for (const d of base) map.set(`${d.lottery}:${d.issue}`, d)
  let added = 0
  for (const d of incoming) {
    const k = `${d.lottery}:${d.issue}`
    if (!map.has(k)) {
      map.set(k, d)
      added++
    }
  }
  const draws = [...map.values()].sort((a, b) =>
    a.lottery === b.lottery ? a.issue.localeCompare(b.issue) : a.lottery.localeCompare(b.lottery)
  )
  return { draws, added }
}
