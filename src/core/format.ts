/**
 * 展示层格式化工具。
 *
 * 涨跌配色遵循中国习惯：正收益（红）／负收益（绿）。
 * 本项目里收益率绝大多数为负，统一用动态着色，
 * 避免「侧栏显示红、首页显示绿」这类自相矛盾的呈现。
 */
export function roiClass(v: number): string {
  if (v > 0) return 'text-red-400'
  if (v < 0) return 'text-emerald-500'
  return 'text-slate-400'
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

/** 「10月8日 周四」——期号之外，用户也关心具体哪天开奖 */
export function formatDrawDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`
}

export function pct(v: number): string {
  return (v * 100).toFixed(1) + '%'
}
