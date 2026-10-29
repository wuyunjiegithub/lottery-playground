/**
 * 把排行榜回测挪到本地后端去跑。
 *
 * 原来这一整个计算都在浏览器主线程上：78 个模型 × 上千期，实测主线程单帧峰值
 * 169ms（全来自 S36/MLP 的单次 predict），而且标签页一被切到后台就被降频，
 * 跑一次全量得守着页面十几分钟。
 *
 * 挪到服务端之后：浏览器只负责发起 + 轮询进度，切后台、甚至关掉标签页都不影响
 * （结果已经落在 SQLite 里，下次进来直接读）。
 */
import type { BacktestResult } from './backtest'
import type { RunProgress } from './backtestRunner'
import type { Profile } from './models/types'
import { serverGet, serverPost } from '../adapters/storage/http'

export interface ServerRunArgs {
  lottery: string
  budget: number
  sample: number
  periods: number
  profile: Profile
  runKey: string
  onProgress: (p: RunProgress) => void
  shouldCancel?: () => boolean
}

export interface ServerRunResult {
  results: BacktestResult[]
  cached: boolean
  durationMs: number
}

const POLL_MS = 900

export async function runLeaderboardOnServer(args: ServerRunArgs): Promise<ServerRunResult> {
  const started = await serverPost<{ jobId: string; cached: boolean; durationMs?: number }>(
    '/api/backtest',
    {
      lottery: args.lottery,
      budget: args.budget,
      sample: args.sample,
      periods: args.periods,
      profile: args.profile,
      runKey: args.runKey,
    }
  )

  const id = started.jobId
  try {
    for (;;) {
      const s = await serverGet<{
        status: string
        progress: RunProgress
        results: BacktestResult[] | null
        durationMs: number
        error: string | null
      }>(`/api/backtest/${id}`)

      if (args.shouldCancel?.()) {
        void serverPost(`/api/backtest/${id}/cancel`, {}).catch(() => {})
        throw Object.assign(new Error('回测已取消'), { name: 'BacktestCancelled' })
      }

      if (s.progress) args.onProgress(s.progress)

      if (s.status === 'done' && s.results) {
        return {
          results: s.results,
          cached: !!started.cached,
          durationMs: s.durationMs || started.durationMs || 0,
        }
      }
      if (s.status === 'error') throw new Error(s.error || '服务端回测失败')
      if (s.status === 'cancelled') {
        throw Object.assign(new Error('回测已取消'), { name: 'BacktestCancelled' })
      }

      await new Promise((r) => setTimeout(r, POLL_MS))
    }
  } finally {
    /* 取消由上面的 shouldCancel 分支负责，这里无需额外清理 */
  }
}

export async function cancelServerRun(): Promise<void> {
  // 当前设计里取消是通过 shouldCancel 轮询时下发，不需要 jobId；
  // 保留此函数以便将来做「按 jobId 直接取消」时不用改调用方。
}
