/**
 * 从旧版「浏览器键值对」一次性迁移到新版存储层。
 *
 * 旧版本把用户数据放在 `lottery_playground_v1` 这个键里，
 * 新版落在 IndexedDB / SQLite。不做迁移的话，老用户升级后投注记录会人间蒸发，
 * 而这个 App 唯一有价值的用户数据就是长期战绩。
 *
 * 迁移成功后旧键即被清除，只跑一次。
 */
import { DEFAULT_USER_STATE, type StorageAdapter, type UserState } from './types'

const LEGACY_KEY = 'lottery_playground_v1'

/**
 * 旧版 budget 曾存在过 [min, max] 区间的写法（2026-10-05 改成单一金额），
 * 这里一并兼容，取上限，语义与预算作为「票面上限」一致。
 */
function coerceBudget(raw: unknown): number {
  if (Array.isArray(raw)) return Number(raw[1]) || DEFAULT_USER_STATE.budget
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_USER_STATE.budget
}

export async function migrateLegacy(st: StorageAdapter): Promise<boolean> {
  if (typeof localStorage === 'undefined') return false
  let raw: string | null = null
  try {
    raw = localStorage.getItem(LEGACY_KEY)
  } catch {
    return false
  }
  if (!raw) return false

  try {
    const old = JSON.parse(raw)
    const cur = await st.getUserState()
    const merged: UserState = {
      profile: old?.profile ?? cur.profile ?? {},
      bets: old?.bets ?? cur.bets ?? [],
      budget: coerceBudget(old?.budget ?? cur.budget),
      favorites: old?.favorites ?? cur.favorites ?? [],
    }
    await st.putUserState(merged)
    localStorage.removeItem(LEGACY_KEY)
    return true
  } catch {
    // 旧数据损坏也不能拖累新系统启动，保持原样即可
    return false
  }
}
