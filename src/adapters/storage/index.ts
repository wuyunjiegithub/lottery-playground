/**
 * 存储层运行时探测与会话级单例。
 *
 * 与 net.ts 的 detectNetMode 对称：
 *   | 环境                | 后端       | 说明                         |
 *   |---------------------|------------|------------------------------|
 *   | 桌面 (Tauri)        | SQLite     | Rust rusqlite，原生文件      |
 *   | Android (Capacitor) | SQLite     | capacitor community sqlite   |
 *   | 纯浏览器网页        | IndexedDB  | 配额数百 MB，足够装汇总      |
 *   | Node / 隐私模式     | 内存       | 进程内兜底，脚本验证用       |
 *
 * SQLite 端涉及原生编译，任何异常都降级到 IndexedDB / 内存，绝不让存储层把应用拖死。
 */
import { idbAdapter } from './idb'
import { createMemoryAdapter } from './memory'
import { migrateLegacy } from './legacy'
import type { StorageAdapter } from './types'

export type { StorageAdapter } from './types'
export * from './types'

let adapter: StorageAdapter | null = null
let bootstrapping: Promise<StorageAdapter> | null = null

function hasIndexedDB(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

/**
 * 选后端。原生 SQLite 暂未接入（见 task：原生端桥接），
 * 探测分支先写好，接上后无需改动调用方。
 */
async function pick(): Promise<StorageAdapter> {
  if (typeof window === 'undefined') return createMemoryAdapter()

  const w = window as any

  if (w.__TAURI_INTERNALS__ || w.__TAURI__) {
    try {
      const mod = await import('./tauri')
      if (await mod.isAvailable()) return mod.adapter
    } catch {
      /* 原生桥不可用，落到浏览器后端 */
    }
  }

  if (w.Capacitor?.isNativePlatform?.()) {
    try {
      const mod = await import('./capacitor')
      if (await mod.isAvailable()) return mod.capacitorAdapter as unknown as StorageAdapter
    } catch {
      /* 同上 */
    }
  }

  if (hasIndexedDB()) {
    try {
      // 建一次连接，确认真的能打开（隐私模式会在这里抛错）
      await idbAdapter.getUserState()
      return idbAdapter
    } catch {
      /* 落 aria 到内存 */
    }
  }

  return createMemoryAdapter()
}

/** 取得当前存储后端。会话内只初始化一次。 */
export async function getStorage(): Promise<StorageAdapter> {
  if (adapter) return adapter
  if (!bootstrapping) {
    bootstrapping = pick()
      .then(async (a) => {
        // 旧版数据仍在浏览器键值对里时，先搬过来再清掉，避免用户升级丢战绩
        try {
          await migrateLegacy(a)
        } catch {
          /* 迁移失败不影响正常使用 */
        }
        adapter = a
        return a
      })
      .catch(() => {
        adapter = createMemoryAdapter()
        return adapter
      })
  }
  return bootstrapping
}

/** 给测试与热重载用：丢弃已有实例 */
export function resetStorageCache(): void {
  adapter = null
  bootstrapping = null
}
