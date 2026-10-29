import { defineStore } from 'pinia'
import { ref, computed, watch, toRaw } from 'vue'
import type { Draw, LotteryType, Prediction } from '../types'
import {
  loadPacket,
  fetchLatest,
  mergeDraws,
  canFetchLive,
  detectNetMode,
  modeLabel,
  isServerLive,
  markServerLive,
  refreshViaServer,
} from '../adapters/net'
import { runLeaderboardOnServer } from '../core/serverBacktest'
import { getStorage, type StorageAdapter, type RunMeta, type SummaryRow } from '../adapters/storage'
import {
  DEFAULT_USER_STATE,
  makeRunKey,
  KV_LAST_BOARD,
  KV_PERF,
  KV_RUN_ANCHOR,
  type LastBoard,
  type PerfCalib,
  type RunAnchor,
} from '../adapters/storage/types'
import { ALL_MODELS, getModel } from '../core/models'
import type { Model, Profile } from '../core/models/types'
import { LEGACY_TO_NEW } from '../core/models/legacyIds'
import { enumeratePlans, recommend } from '../core/ticket'
import { nextDrawDate, RULES } from '../core/lottery'
import { backtest as backtestOne, emptyTotals, type BacktestResult } from '../core/backtest'
import {
  accumsToResults,
  countUnits,
  runLeaderboardAsync,
  runDetailAsync,
  BacktestCancelled,
  ENGINE_VERSION,
  type ModelAccum,
  type RunProgress,
} from '../core/backtestRunner'
import type { PeriodDetail } from '../core/backtest'
import { mergeCalib, solveFactor } from '../core/perf'

/** UI 用的进度快照：在 runner 的 RunProgress 之上补一层阶段语义 */
export interface RunProgressState extends RunProgress {
  phase: 'idle' | 'running' | 'saving' | 'done' | 'cancelled' | 'error'
  /** 本次是增量补算时，补算的期数；全量重算为 0 */
  incrementalPeriods: number
  message: string
}

function idleProgress(): RunProgressState {
  return {
    phase: 'idle',
    done: 0,
    total: 0,
    ratio: 0,
    modelCount: 0,
    periodCount: 0,
    periodsDone: 0,
    currentModelId: '',
    currentModelName: '',
    elapsedMs: 0,
    etaMs: 0,
    incrementalPeriods: 0,
    message: '',
  }
}

export const useMainStore = defineStore('main', () => {
  // 用户数据的初值先取默认值，loadData 阶段再从存储层覆盖。
  // 存储层是异步的（IndexedDB / SQLite IPC），没法在建 store 时同步拿到。
  const draws = ref<Draw[]>([])
  const lottery = ref<LotteryType>('dlt')
  const budget = ref<number>(DEFAULT_USER_STATE.budget)
  const profile = ref<Profile>(DEFAULT_USER_STATE.profile || {})
  const favorites = ref<string[]>(DEFAULT_USER_STATE.favorites || [])
  const selectedModelId = ref<string>('M01')
  const loading = ref(false)
  const error = ref('')
  const backtesting = ref(false)
  const board = ref<BacktestResult[]>([])
  const progress = ref<RunProgressState>(idleProgress())
  /** 上次回测的落盘信息，用于开机自动恢复榜面与判断能否增量补算 */
  const boardInfo = ref<LastBoard | null>(null)
  /** 本次启动自最新数据里新增的期数（桌面/安卓端才有） */
  const dataAdded = ref(0)

  /**
   * 本机性能校准：上次实跑耗时 ÷ 公式预估。
   *
   * 存在理由：同样的活，在撰公式那台机器上 18 分钟，换台机器能用 81 分钟
   * （用户实测：样本 1000 跑了 81 分钟，而当时的预估只有十几分钟）。
   * 公式给出的是**形状**（成本怎么随训练长度涨），factor 给出的是**高度**，
   * 两者相乘才是这台机器上的预期。缺了它，UI 上的「约 X 分钟」对多数人都是假的。
   */
  const perf = ref<PerfCalib>({ factor: 1, samples: 0, periods: 0, updatedAt: 0 })

  /** 取消请求标志。runner 每个工作单元检查一次，所以点「停止」几乎立刻生效 */
  let cancelFlag = false

  /** 已就绪的存储后端。首次 getStorage() 之后再取就是同步命中缓存 */
  let storage: StorageAdapter | null = null
  async function ensureStorage(): Promise<StorageAdapter> {
    if (!storage) {
      storage = await getStorage()
      // 后端选中之后顺手告诉网络层：有后端就等于有了可靠的更新通道
      markServerLive(storage.kind === 'server')
      // 探测完才能定下「能不能更新」和显示什么环境标签
      canLive.value = canFetchLive()
      modeText.value = modeLabel()
    }
    return storage
  }

  const history = computed(() =>
    draws.value
      .filter((d) => d.lottery === lottery.value)
      .sort((a, b) => a.issue.localeCompare(b.issue))
  )
  const latest = computed(() => history.value[history.value.length - 1] || null)
  const nextDate = computed(() => nextDrawDate(lottery.value))

  /**
   * 推算下一期期号。
   *
   * 期号是「年份 + 3 位年内序号」：双色球 7 位（2026151），大乐透 5 位（26151）。
   * 原先直接 Number(issue) + 1，跨年会算出一条根本不存在的期号 ——
   * 双色球年末最后一期 2026151 会被推成 2026152，而真实下一期是 2027001。
   *
   * 判断依据不用猜「这一年一共几期」，而是看下一场开奖日落在哪一年：
   * 日期和期号年份不一致，就说明新年第一期，序号从 001 起。
   */
  const nextIssue = computed(() => {
    const cur = latest.value
    if (!cur) return '—'
    const issue = cur.issue
    const yearLen = issue.length - 3
    if (yearLen <= 0) return String(Number(issue) + 1)
    const yearPrefix = issue.slice(0, yearLen)
    const seq = issue.slice(yearLen)

    const nd = nextDate.value
    const ndYear = yearLen === 4 ? nd.getFullYear() : nd.getFullYear() % 100
    const ndPrefix = String(ndYear).padStart(yearLen, '0')
    if (ndPrefix !== yearPrefix) return ndPrefix + '001'
    return yearPrefix + String(Number(seq) + 1).padStart(3, '0')
  })

  const rule = computed(() => RULES[lottery.value])

  const selectedModel = computed(() => getModel(selectedModelId.value) || ALL_MODELS[0])

  // 运行环境：桌面端 / 移动端可直连官方接口，网页版只能读数据包
  const netMode = detectNetMode()
  /**
   * 「能否更新」和「运行环境标签」都必须是 ref，不能是 setup 期算一次的常量。
   *
   * 后端是**异步**探测的：setup 阶段调 canFetchLive() 时它还不知道后端在不在，
   * 在 dev 下会侥幸因为 dev 代理返回 true，但生产构建里就是 false ——
   * 于是「更新数据」按钮直接被判不可用，服务端那条通路永远走不到。
   * 探测完成后在 ensureStorage 里刷新这两个值。
   */
  const canLive = ref(canFetchLive())
  const modeText = ref(modeLabel())
  const updating = ref(false)
  const updateMsg = ref('')

  /** 拉取最新一期数据（桌面端 / 安卓可用；网页版仅在 dev 代理下可用） */
  async function updateData(): Promise<{ ok: boolean; added: number; msg: string }> {
    if (!canLive) {
      const msg = '网页版无法直连官方接口（CORS + Referer 双重限制），只能使用内置数据包。桌面端、安卓或 npm run dev 可以更新'
      return { ok: false, added: 0, msg }
    }
    updating.value = true
    updateMsg.value = '正在拉取…'
    // 有本地后端时优先走它：浏览器直连官方接口这条路本来就是被 CORS 卡死的，
    // dev 代理只是权宜之计，服务端才是正解。
    if (isServerLive()) {
      try {
        const { added } = await refreshViaServer(lottery.value)
        // 新数据已由后端入库，这里重新拉一遍刷新内存视图。
        // 注意必须两个彩种都读：只回读当前彩种会把另一个从 draws 里冲掉
        // （历史页的「数据概况」就是直接数 draws 的，会瞬间变成 0）。
        const st = await ensureStorage()
        const merged: Draw[] = []
        for (const key of ['ssq', 'dlt'] as LotteryType[]) {
          merged.push(...(await st.getDraws(key)))
        }
        draws.value = merged
        updateMsg.value = added > 0 ? `新增 ${added} 期` : '已是最新'
        return { ok: true, added, msg: updateMsg.value }
      } catch (e: any) {
        updateMsg.value = e?.message || '后端更新失败'
        return { ok: false, added: 0, msg: updateMsg.value }
      } finally {
        updating.value = false
      }
    }
    try {
      const incoming = await fetchLatest(lottery.value, 30)
      const { draws: merged, added } = mergeDraws(draws.value, incoming)
      draws.value = merged
      // 关键：落盘。以前只写内存，刷新就丢，桌面端拉了等于白拉
      if (added > 0) {
        try {
          await (await ensureStorage()).upsertDraws(incoming)
        } catch {
          /* 写库失败不回滚内存视图，保证当期依然可用 */
        }
      }
      updateMsg.value = added > 0 ? `新增 ${added} 期` : '已是最新'
      return { ok: true, added, msg: updateMsg.value }
    } catch (e: any) {
      updateMsg.value = e?.message || '更新失败'
      return { ok: false, added: 0, msg: updateMsg.value }
    } finally {
      updating.value = false
    }
  }

  /**
   * 启动加载。
   *
   * 开奖数据以**本地库为准**，静态数据包只当作种子：首次启动灌进库，
   * 之后每次从库读。这样桌面/安卓端拉到的新期号才不会刷新即丢。
   *
   * 灌库前先比对数量，避免每期都对 6000 多条做一遍无谓的 upsert。
   */
  async function loadData() {
    loading.value = true
    error.value = ''
    try {
      const st = await ensureStorage()

      try {
        const c = await st.getKV<PerfCalib>(KV_PERF)
        if (c && Number.isFinite(c.factor) && c.factor > 0) perf.value = c
      } catch {
        /* 读不到就按因子 1 粗估 */
      }

      const u = await st.getUserState()
      profile.value = u.profile || {}
      budget.value = u.budget || DEFAULT_USER_STATE.budget
      // 模型编号重排后，把本地存储里的旧收藏编号迁移到新编号，并丢弃已失效的。
      favorites.value = ((u.favorites as string[]) || [])
        .map((id) => LEGACY_TO_NEW[id] ?? id)
        .filter((id) => getModel(id))

      const packet = await loadPacket()
      for (const key of ['ssq', 'dlt'] as LotteryType[]) {
        const want = packet.filter((d) => d.lottery === key)
        const have = await st.countDraws(key)
        if (want.length && have < want.length) await st.upsertDraws(want)
      }

      // 统一从库里读回来，保证三端同一份数据视图
      const merged: Draw[] = []
      for (const key of ['ssq', 'dlt'] as LotteryType[]) {
        merged.push(...(await st.getDraws(key)))
      }
      draws.value = merged.length ? merged : packet

      // 开机即恢复上次回测的榜面：回测一旦跑过就是永久记录，不该每次重算
      await restoreLastBoard()
    } catch (e: any) {
      error.value = e?.message || '数据加载失败'
    } finally {
      loading.value = false
    }

    // 桌面/安卓端：每次打开都去官方接口要一次最新数据，拉到就落盘
    if (canLive) {
      void updateData().then((r) => {
        if (r.ok && r.added > 0) dataAdded.value = r.added
      })
    }
  }

  /** 生成某模型对下一期的预测 */
  function predict(modelId: string): Prediction | null {
    if (!history.value.length) return null
    const m = getModel(modelId)
    if (!m) return null
    return m.predict({
      history: history.value,
      lottery: lottery.value,
      nextDate: nextDate.value,
      profile: profile.value,
    })
  }

  /** 预算约束下的推荐票面（预算 + 模型，统一出一种最优票型） */
  function recommendPlan(modelId: string) {
    const pred = predict(modelId)
    if (!pred) return { pred: null, best: null, ranked: [] }
    const plans = enumeratePlans(lottery.value, pred, budget.value)
    const { best, ranked } = recommend(plans, budget.value)
    return { pred, best, ranked }
  }

  /** SummaryRow -> BacktestResult。跨存储往返时奖级 key 可能被 JSON 转成字符串 */
  function fromSummary(r: SummaryRow): BacktestResult {
    const hits: Record<number, number> = {}
    for (const [k, v] of Object.entries(r.hits || {})) hits[Number(k)] = Number(v)
    const hitsStop: Record<number, number> = {}
    for (const [k, v] of Object.entries(r.hitsStop || {})) hitsStop[Number(k)] = Number(v)
    return {
      modelId: r.modelId,
      modelName: r.modelName,
      category: r.category,
      trials: r.trials,
      totalCost: r.totalCost,
      totalPrize: r.totalPrize,
      roi: r.roi,
      hits,
      bestLevel: r.bestLevel,
      winRate: r.winRate,
      equity: r.equity || [],
      stopped: !!r.stopped,
      stopIssue: r.stopIssue ?? null,
      stopIndex: r.stopIndex ?? null,
      stopLevel: r.stopLevel ?? null,
      trialsStop: r.trialsStop ?? 0,
      totalCostStop: r.totalCostStop ?? 0,
      totalPrizeStop: r.totalPrizeStop ?? 0,
      roiStop: r.roiStop ?? 0,
      winRateStop: r.winRateStop ?? 0,
      bestLevelStop: r.bestLevelStop ?? 0,
      hitsStop,
    }
  }

  /** 数据库里的一行汇总 -> 可继续累加的账本 */
  function rebuildAccums(models: Model[], rows: SummaryRow[]): ModelAccum[] {
    const byId = new Map(rows.map((r) => [r.modelId, r]))
    return models.map((m) => {
      const r = byId.get(m.meta.id)
      const hits: Record<number, number> = {}
      for (const [k, v] of Object.entries(r?.hits || {})) hits[Number(k)] = Number(v)
      const hitsStop: Record<number, number> = {}
      for (const [k, v] of Object.entries(r?.hitsStop || {})) hitsStop[Number(k)] = Number(v)
      return {
        modelId: m.meta.id,
        modelName: m.meta.name,
        category: m.meta.category,
        totals: r
          ? {
              trials: r.trials || 0,
              totalCost: r.totalCost || 0,
              totalPrize: r.totalPrize || 0,
              hits,
              bestLevel: r.bestLevel || 0,
            }
          : emptyTotals(),
        equity: Array.isArray(r?.equity) ? r!.equity.slice() : [],
        stopTotals: r
          ? {
              trials: r.trialsStop || 0,
              totalCost: r.totalCostStop || 0,
              totalPrize: r.totalPrizeStop || 0,
              hits: hitsStop,
              bestLevel: r.bestLevelStop || 0,
            }
          : emptyTotals(),
        stopped: !!r?.stopped,
        stopIssue: r?.stopIssue ?? null,
        stopIndex: r?.stopIndex ?? null,
        stopLevel: r?.stopLevel ?? null,
      }
    })
  }

  /**
   * 锚点可用性校验。任何一条不满足都必须整体重算——
   * 增量结果只有在「前序历史一字未改」时才与全量重算严格等价。
   *
   * 注意这里一律用**本次运行快照下来的 history**，而不是响应式的 history.value：
   * 回测要跑几分钟，期间用户完全可能去顶栏切彩种，那样 history.value 会换成另一份数据，
   * 拿它去校验锚点、写锚点期号，会把 A 彩种的账本挂到 B 彩种的历史上。
   */
  function anchorUsable(
    a: RunAnchor,
    ctx: { start: number; total: number; modelCount: number; history: Draw[] }
  ): boolean {
    const issueOf = (i: number) => ctx.history[i]?.issue ?? ''
    return (
      // 引擎版本不符的老账本一律作废：数字口径可能已经变了，
      // 而 runKey 只看 (彩种, 预算, 训练集)，察觉不到算法改动
      a.engine === ENGINE_VERSION &&
      a.start === ctx.start &&
      // 老锚点记的是 64 个轻模型，这里期望 78 ⇒ 不等即作废。
      // 模型集合变过之后绝不能混用旧账本：那会让排行榜一半是新算法、一半是旧的。
      a.modelCount === ctx.modelCount &&
      a.upTo >= a.start &&
      a.upTo <= ctx.total &&
      a.anchorIssue === issueOf(ctx.start - 1) &&
      a.upToIssue === issueOf(a.upTo - 1)
    )
  }

  async function restoreLastBoard() {
    try {
      const st = await ensureStorage()
      const last = await st.getKV<LastBoard>(KV_LAST_BOARD)
      if (!last || last.lottery !== lottery.value) return
      // 引擎升级过：老榜面缺字段（v3 的汇总没有收手变体），恢复出来只会是错的
      if (last.engine !== ENGINE_VERSION) return
      const expected = ALL_MODELS.length
      if (last.modelCount !== expected) return
      const rows = await st.getSummary(last.runKey)
      if (rows.length !== expected) return
      publishBoard(last, rows.map(fromSummary))
    } catch {
      /* 恢复失败就当没有历史，不影响使用 */
    }
  }

  /**
   * 记一次实跑，更新本机校准系数。
   *
   * @param actualMs 实跑墙钟耗时
   * @param from     这次**实际算过**的起点（增量为 anchor.upTo，全量为 start）
   * @param to       终点（历史长度）
   *
   * 为什么 from 必须由调用方给对：增量补算的 durationMs 只覆盖新增的几期，
   * 若拿全窗口的预估值去除它，会得出「这台机器快 300 倍」的荒唐系数。
   *
   * 合并规则（按**期数加权**、旧权重封顶）在 `core/perf.ts` 的 `mergeCalib` 里，
   * 那边有单测守着。
   *
   * **回测进行中也会调它**（见 recordPerfRate），所以加了节流：
   * 界面读的是内存里的 perf.value，立刻生效；库每 5 秒写一次就够，
   * 没必要每一期都去敲一次 IndexedDB。跑完那次必须 `flush = true`，
   * 否则最后一次更新可能正好落在节流窗口里被丢掉。
   */
  const PERF_SAVE_MS = 5000
  let perfSavedAt = 0
  async function recordPerf(
    actualMs: number,
    from: number,
    to: number,
    opts: { flush?: boolean; countAsRun?: boolean } = {}
  ): Promise<void> {
    const f = solveFactor(actualMs, from, to)
    if (f === null) return
    perf.value = mergeCalib(perf.value, f, to - from, Date.now(), opts.countAsRun !== false)
    const now = Date.now()
    if (!opts.flush && now - perfSavedAt < PERF_SAVE_MS) return
    perfSavedAt = now
    try {
      const st = await ensureStorage()
      await st.putKV<PerfCalib>(KV_PERF, perf.value)
    } catch {
      /* 校准值丢了无关紧要，下次实跑会重新攒 */
    }
  }

  /**
   * 用「实测到的每期成本」更新校准，**不等回测跑完**。
   *
   * 为什么必须有它：校准要是只在跑完才生效，用户第一次跑的时候就会看到
   * 「参数区写着 18 分钟、进度条按实时速率说要 80 分钟」两个打架的数字——
   * 这正是他报的问题。开跑几十秒内就把真实速率喂回来，两个数字才会收敛。
   *
   * @param perPeriodMs 实测的 ms/期
   * @param from        这次**实际算过**的起点（全量为 start，增量为 anchor.upTo）
   * @param to          终点（历史长度）
   */
  function recordPerfRate(perPeriodMs: number, from: number, to: number): void {
    if (!(perPeriodMs > 0) || to <= from) return
    void recordPerf(perPeriodMs * (to - from), from, to, { countAsRun: false })
  }

  /** 请求停止当前回测。runner 会在下一个工作单元立刻退出，不会写半成品 */
  function cancelRun() {
    if (backtesting.value) cancelFlag = true
  }

  /**
   * 发布一次回测结果到界面。
   *
   * **boardInfo 必须先于 board**，三处（saveBoard / restoreLastBoard / 读缓存）
   * 之前各写各的，结果漏了一处：只要 board 先落地、boardInfo 后到，
   * 中间那几百毫秒里用户就能点到「明细」，而 loadDetail 靠 boardInfo 才知道
   * 用哪份模型数组、哪个结算区间 —— 于是点了没反应。
   * 收敛成一个函数，才不会下次再加路径时又漏。
   */
  function publishBoard(info: LastBoard, results: BacktestResult[]) {
    boardInfo.value = info
    board.value = results
    // 榜面一换就去问一次「明细存到第几个模型了」，只为了那句提示文案
    void refreshArchiveInfo()
  }

  /**
   * 跑全模型排行榜。**固定跑全部 78 个模型，没有开关。**
   *
   * 曾有过 includeHeavy 让用户勾选，已移除：排行榜的结论是
   * 「78 个模型（含最会过拟合的遗传算法/神经网络）没有一个显著赢过随机基线」。
   * 让人自己剔掉几个反例，等于把证伪的前提交给用户去破坏。
   * 代价是慢——实测每期 416ms vs 轻量集的 80ms，页面默认窗口约 17 分钟。
   * 这个代价由 UI 如实告知（预估耗时 + 实时进度 + 随时可停），而不是藏起来。
   *
   * 三种路径：
   *   1) 缓存已覆盖当前全部历史  -> 直接读库，秒开
   *   2) 缓存只覆盖到 upTo，且历史只是在尾部新增  -> **增量补算**，只算 upTo..total
   *   3) 其余（换彩种/预算/训练集，或历史被改写） -> 全量重算
   *
   * 关于 (2) 为什么成立、且结果与全量重算**完全一致**：
   *   第 i 期的结果只依赖 history[0..i)，新增的第 i' > i 期改变不了第 i 期。
   *   所以只要训练起点 start 没变、前序历史没被改写，把新期接在旧账本后面
   *   就是精确等价，不存在"近似"或"误差累积"。
   */
  async function runLeaderboard(
    periods = 80,
    opts: { force?: boolean } = {}
  ): Promise<{ cached: boolean; count: number; extended: number }> {
    if (!history.value.length || backtesting.value) {
      return { cached: false, count: 0, extended: 0 }
    }

    const st = await ensureStorage()
    const total = history.value.length
    const sample = Math.max(0, total - periods)
    const start = Math.max(60, total - periods)
    const runKey = makeRunKey({ lottery: lottery.value, budget: budget.value, sample })
    const models = ALL_MODELS

    // 有本地后端就把重活交出去：浏览器只等进度，不占主线程
    if (isServerLive()) {
      backtesting.value = true
      progress.value = { ...idleProgress(), phase: 'running', periodCount: periods, modelCount: models.length }
      try {
        const r = await runLeaderboardOnServer({
          lottery: lottery.value,
          budget: budget.value,
          sample,
          periods,
          profile: profile.value,
          runKey,
          onProgress: (p) => {
            progress.value = { ...progress.value, ...p, phase: 'running' }
          },
          shouldCancel: () => cancelFlag,
        })
        const info: LastBoard = {
          runKey,
          lottery: lottery.value,
          budget: budget.value,
          sample,
          periods,
          upTo: total,
          modelCount: r.results.length,
          createdAt: Date.now(),
          durationMs: r.durationMs,
          engine: ENGINE_VERSION,
        }
        publishBoard(info, r.results)
        // 汇总行由后端自己写过了（它算的时候就直接落库），这里只补一个「上次榜面」指针，
        // 否则刷新页面就没有可恢复的榜面，用户只能再点一次「读取缓存」。
        void st.putKV(KV_LAST_BOARD, info).catch(() => {})
        progress.value = {
          ...progress.value,
          phase: 'done',
          ratio: 1,
          periodsDone: periods,
          periodCount: periods,
        }
        return { cached: r.cached, count: r.results.length, extended: 0 }
      } catch (e: any) {
        const cancelled = e?.name === 'BacktestCancelled'
        progress.value = {
          ...progress.value,
          phase: cancelled ? 'cancelled' : 'error',
          message: cancelled ? '已取消' : e?.message || '服务端回测失败',
        }
        return { cached: false, count: 0, extended: 0 }
      } finally {
        backtesting.value = false
        cancelFlag = false
      }
    }

    const snapshot = {
      lottery: lottery.value,
      history: history.value,
      budget: budget.value,
      profile: profile.value,
      models,
    }

    cancelFlag = false
    backtesting.value = true
    progress.value = {
      ...idleProgress(),
      phase: 'running',
      total: countUnits(models.length, start, total),
      modelCount: models.length,
      periodCount: Math.max(0, total - start),
    }
    // 让出主线程，先把进度条渲染出来再开算
    await new Promise((r) => setTimeout(r, 30))
    const runT0 = Date.now()

    const onProgress = (p: RunProgress, incrementalPeriods: number) => {
      progress.value = { ...progress.value, ...p, incrementalPeriods }
    }

    try {
      // ---------------------------------------------- 1) 缓存 / 增量
      const anchor0 = opts.force ? null : await st.getKV<RunAnchor>(KV_RUN_ANCHOR(runKey))
      const anchor =
        anchor0 &&
        anchorUsable(anchor0, {
          start,
          total,
          modelCount: models.length,
          history: snapshot.history,
        })
          ? anchor0
          : null

      if (anchor) {
        const rows = await st.getSummary(runKey)
        if (rows.length === models.length) {
          const need = total - anchor.upTo
          if (need <= 0) {
            publishBoard(
              makeLastBoard({
                runKey,
                lottery: snapshot.lottery,
                budget: snapshot.budget,
                sample,
                start,
                upTo: anchor.upTo,
                modelCount: rows.length,
                createdAt: Date.now(),
                durationMs: 0,
                history: snapshot.history,
              }),
              rows.map(fromSummary)
            )
            progress.value = {
              ...progress.value,
              phase: 'done',
              ratio: 1,
              periodsDone: 0,
              message: '已从本地缓存读取，未重新计算',
            }
            return { cached: true, count: rows.length, extended: 0 }
          }

          // 增量补算：旧账本 + 只算新增的 need 期
          progress.value = {
            ...progress.value,
            phase: 'running',
            total: countUnits(models.length, anchor.upTo, total),
            periodCount: need,
            incrementalPeriods: need,
            message: `本次只补算新增的 ${need} 期（前 ${anchor.upTo} 期沿用上次结果）`,
          }
          const accums = await runLeaderboardAsync(
            { ...snapshot, from: anchor.upTo, to: total, base: rebuildAccums(models, rows) },
            { onProgress: (p) => onProgress(p, need), shouldCancel: () => cancelFlag }
          )
          const results = accumsToResults(accums)
          progress.value = { ...progress.value, phase: 'saving', message: '正在写入本地库…' }
          // meta 构造一次，发布与落盘共用同一个对象：
          // 两边各写一遍的话，字段一旦不一致，界面显示的榜面就会和库里的对不上。
          const meta = {
            runKey,
            lottery: snapshot.lottery,
            budget: snapshot.budget,
            sample,
            start,
            upTo: total,
            modelCount: results.length,
            createdAt: Date.now(),
            durationMs: Date.now() - runT0,
            history: snapshot.history,
          }
          // 先发布再落库：界面不等磁盘
          publishBoard(makeLastBoard(meta), results)
          void recordPerf(meta.durationMs, anchor.upTo, total, { flush: true })
          await saveBoard(st, results, meta)
          progress.value = { ...progress.value, phase: 'done', ratio: 1, message: `增量补算完成，新增 ${need} 期` }
          return { cached: false, count: results.length, extended: need }
        }
      }

      // ---------------------------------------------- 2) 全量重算
      const accums = await runLeaderboardAsync(
        { ...snapshot, from: start, to: total },
        { onProgress: (p) => onProgress(p, 0), shouldCancel: () => cancelFlag }
      )
      const results = accumsToResults(accums)
      progress.value = { ...progress.value, phase: 'saving', message: '正在写入本地库…' }
      const meta = {
        runKey,
        lottery: snapshot.lottery,
        budget: snapshot.budget,
        sample,
        start,
        upTo: total,
        modelCount: results.length,
        createdAt: Date.now(),
        durationMs: Date.now() - runT0,
        history: snapshot.history,
      }
      // 先发布再落库：界面不等磁盘
      publishBoard(makeLastBoard(meta), results)
      void recordPerf(meta.durationMs, start, total, { flush: true })
      await saveBoard(st, results, meta)
      progress.value = { ...progress.value, phase: 'done', ratio: 1, message: '回测完成，结果已永久保存' }
      return { cached: false, count: results.length, extended: 0 }
    } catch (e: any) {
      if (e instanceof BacktestCancelled) {
        progress.value = { ...progress.value, phase: 'cancelled', message: '已停止，本次结果未保存' }
        return { cached: false, count: 0, extended: 0 }
      }
      progress.value = {
        ...progress.value,
        phase: 'error',
        message: e?.message || '回测失败，请重试',
      }
      return { cached: false, count: 0, extended: 0 }
    } finally {
      backtesting.value = false
      cancelFlag = false
    }
  }

  /** 一次回测的落盘/发布参数。构造一次，界面与磁盘共用，避免两边字段漂移 */
  interface RunBoardMeta {
    runKey: string
    lottery: LotteryType
    budget: number
    sample: number
    start: number
    upTo: number
    modelCount: number
    createdAt: number
    durationMs: number
    /** 本次运行快照下来的历史，用于记录锚点期号 */
    history: Draw[]
  }

  /** meta -> 「上次回测」摘要。界面与 KV 落盘共用，保证两边完全一致 */
  function makeLastBoard(meta: RunBoardMeta): LastBoard {
    return {
      runKey: meta.runKey,
      lottery: meta.lottery,
      budget: meta.budget,
      sample: meta.sample,
      periods: Math.max(0, meta.upTo - meta.start),
      upTo: meta.upTo,
      modelCount: meta.modelCount,
      createdAt: meta.createdAt,
      durationMs: meta.durationMs,
      engine: ENGINE_VERSION,
    }
  }

  /** 回测结果落盘：汇总 + 锚点 + 「上次回测」指针，一次写全 */
  async function saveBoard(st: StorageAdapter, results: BacktestResult[], meta: RunBoardMeta) {
    const runMeta: RunMeta = {
      runKey: meta.runKey,
      lottery: meta.lottery,
      budget: meta.budget,
      sample: meta.sample,
      periods: Math.max(0, meta.upTo - meta.start),
      modelCount: meta.modelCount,
      createdAt: meta.createdAt,
    }
    const rows: SummaryRow[] = results.map((r) => ({
      runKey: meta.runKey,
      modelId: r.modelId,
      modelName: r.modelName,
      category: r.category,
      trials: r.trials,
      totalCost: r.totalCost,
      totalPrize: r.totalPrize,
      roi: r.roi,
      winRate: r.winRate,
      bestLevel: r.bestLevel,
      hits: r.hits,
      equity: r.equity,
      stopped: r.stopped,
      stopIssue: r.stopIssue ?? null,
      stopIndex: r.stopIndex ?? null,
      stopLevel: r.stopLevel ?? null,
      trialsStop: r.trialsStop ?? 0,
      totalCostStop: r.totalCostStop ?? 0,
      totalPrizeStop: r.totalPrizeStop ?? 0,
      roiStop: r.roiStop ?? 0,
      winRateStop: r.winRateStop ?? 0,
      bestLevelStop: r.bestLevelStop ?? 0,
      hitsStop: r.hitsStop || {},
    }))
    const anchor: RunAnchor = {
      runKey: meta.runKey,
      engine: ENGINE_VERSION,
      start: meta.start,
      upTo: meta.upTo,
      anchorIssue: meta.history[meta.start - 1]?.issue ?? '',
      upToIssue: meta.history[meta.upTo - 1]?.issue ?? '',
      modelCount: meta.modelCount,
      updatedAt: meta.createdAt,
    }
    // 与界面发布的用同一个函数产出，保证「看到的」与「存下的」是同一份
    const last = makeLastBoard(meta)
    // 注意：**不要在这里发布到界面**。落库是 await 的，而界面必须立刻可用。
    // 由调用方先 publishBoard（boardInfo 与 board 同拍）再 await 落盘。
    try {
      await st.putRun(runMeta)
      await st.putSummary(rows)
      await st.putKV(KV_RUN_ANCHOR(meta.runKey), anchor)
      await st.putKV(KV_LAST_BOARD, last)
    } catch (e) {
      // 写缓存失败不影响本次结果展示，但**必须出声**：
      // 静默吞掉的结果就是「跑完了，刷新后榜面没了、下次还得重跑十几分钟」。
      console.warn('[回测] 结果落库失败，本次结果只存在于内存中：', e)
    }
    return last
  }

  /**
   * 服务端缓存探测。
   *
   * 浏览器直跑那条路会把锚点写进 kv（run_anchor:xxx），但服务端跑的时候是**后端自己**
   * 落库、只留了一个 server_board:xxx（含 engine/upTo/periods）。不读它的话，
   * 刷新一次页面后按钮永远显示「开始回测（约 1 小时）」，而实际上点下去秒开——
   * 用户会以为要重算，直接放弃。
   *
   * 判定条件与后端 tryCached 保持一致：期数必须正好覆盖到最新一期。
   * 后端不做增量（upTo 落后就全量重算），所以这里也只认「完全命中」。
   */
  async function serverBoardHit(
    st: StorageAdapter,
    runKey: string,
    total: number,
    periods: number
  ): Promise<boolean> {
    if (!isServerLive()) return false
    try {
      const meta = await st.getKV<{
        upTo?: number
        periods?: number
        modelCount?: number
        engine?: number
      }>(`server_board:${runKey}`)
      return (
        !!meta &&
        meta.engine === ENGINE_VERSION &&
        meta.modelCount === ALL_MODELS.length &&
        meta.upTo === total &&
        meta.periods === periods
      )
    } catch {
      return false
    }
  }

  /** 当前设置组合是否已有一条现成的缓存 */
  async function hasCachedBoard(periods = 80): Promise<boolean> {
    if (!history.value.length) return false
    const sample = Math.max(0, history.value.length - periods)
    const runKey = makeRunKey({
      lottery: lottery.value,
      budget: budget.value,
      sample,
    })
    try {
      const st = await ensureStorage()
      const rows = await st.getSummary(runKey)
      if (rows.length === ALL_MODELS.length) return true
      return await serverBoardHit(st, runKey, history.value.length, periods)
    } catch {
      return false
    }
  }

  /**
   * 探测当前设置下的缓存状态，供 UI 提前告诉用户「这次是秒开、补算还是全量重算」。
   * 与 runLeaderboard 内部走同一套判定（同源anchorUsable），不会出现"按钮说秒开、
   * 点下去却重算"的错位。
   */
  async function probeBoard(
    periods = 80
  ): Promise<{ has: boolean; upTo: number; extend: number; periods: number; stale?: boolean }> {
    const none = { has: false, upTo: 0, extend: 0, periods: 0 }
    if (!history.value.length) return none
    const total = history.value.length
    const sample = Math.max(0, total - periods)
    const start = Math.max(60, total - periods)
    const runKey = makeRunKey({ lottery: lottery.value, budget: budget.value, sample })
    const models = ALL_MODELS
    try {
      const st = await ensureStorage()
      const a = await st.getKV<RunAnchor>(KV_RUN_ANCHOR(runKey))
      if (
        !a ||
        !anchorUsable(a, {
          start,
          total,
          modelCount: models.length,
          history: history.value,
        })
      ) {
        // 浏览器里没锚点，但后端可能已经算过这套设置（它写的是自己的 server_board）
        if (await serverBoardHit(st, runKey, total, periods)) {
          return { has: true, upTo: total, extend: 0, periods: Math.max(0, total - start) }
        }
        // 后端算过、但历史又新增了开奖（server_board.upTo 落后于最新一期）：
        // 旧榜面已失效，需要重算。标记 stale，让 UI 自动触发一次重算把新期并入记录，
        // 不必等人手动点「开始回测」。
        if (isServerLive()) {
          const meta = await st.getKV<{ upTo?: number; periods?: number; engine?: number }>(
            `server_board:${runKey}`
          )
          if (
            meta &&
            meta.engine === ENGINE_VERSION &&
            meta.periods === periods &&
            typeof meta.upTo === 'number' &&
            meta.upTo < total
          ) {
            return {
              has: true,
              upTo: meta.upTo,
              extend: total - meta.upTo,
              periods: Math.max(0, total - start),
              stale: true,
            }
          }
        }
        return none
      }
      const rows = await st.getSummary(runKey)
      if (rows.length !== models.length) return none
      return {
        has: true,
        upTo: a.upTo,
        extend: Math.max(0, total - a.upTo),
        periods: Math.max(0, total - start),
      }
    } catch {
      return none
    }
  }

  /** 单模型回测（同步，走 core/backtest 的同一套期级实现） */
  function runSingle(modelId: string, periods = 80): BacktestResult | null {
    const m = getModel(modelId)
    if (!m || !history.value.length) return null
    return backtestOne(m, {
      lottery: lottery.value,
      history: history.value,
      periods,
      budget: budget.value,
      profile: profile.value,
    })
  }

  // ------------------------------------------------------------ 逐期明细

  /** 逐期明细的加载态。UI 用它显示进度条与取消按钮 */
  const detailRows = ref<PeriodDetail[]>([])
  const detailModelId = ref('')
  const detailLoading = ref(false)
  const detailProgress = ref(0)
  /** 这批明细是哪来的：内存 / 本地库 / 本地库+补新期 / 现算。UI 据此给不同提示 */
  const detailFrom = ref<'memory' | 'disk' | 'extend' | 'compute'>('compute')
  /** 明细加载失败的原因。**必须有**：静默失败只会让 UI 停在占位文案上，
   *  用户看到的是「点了没反应」，根本分不清是还在算、还是坏了 */
  const detailError = ref('')
  let detailCancel = false

  /**
   * 服务端的明细存档进度（回测跑完后后台补齐 78 个模型的逐期明细）。
   * 只影响一句提示文案，拿不到就当没有——不影响明细本身的读取与现算。
   */
  const archiveInfo = ref<{ status: string; done: number; total: number } | null>(null)
  let archiveTimer: ReturnType<typeof setTimeout> | null = null

  function stopArchivePoll() {
    if (archiveTimer) clearTimeout(archiveTimer)
    archiveTimer = null
  }

  async function refreshArchiveInfo(): Promise<void> {
    stopArchivePoll()
    const info = boardInfo.value
    if (!info) {
      archiveInfo.value = null
      return
    }
    try {
      const st = await ensureStorage()
      const v = await st.getKV<{ status: string; done: number; total: number }>(
        `detail_archive:${info.runKey}`
      )
      archiveInfo.value = v || null
      // 还在补就隔一会儿再看；done / error 之后不再打扰
      if (v && v.status === 'running') {
        archiveTimer = setTimeout(() => void refreshArchiveInfo(), 6000)
      }
    } catch {
      archiveInfo.value = null
    }
  }

  /** 明细按模型缓存：来回切模型不用重算。key 含全部影响结果的参数 */
  const detailCache = new Map<string, PeriodDetail[]>()
  /**
   * 明细的落库键。
   *
   * 除了模型本身，还要带上「哪个批次（runKey）+ 哪段区间（start~upTo）＋ 哪版引擎」：
   * 每多一期开奖窗口就整体后移，键里不带区间就会把上一轮的号码贴到新位置上。
   */
  function detailKey(modelId: string): string {
    return [
      boardInfo.value?.runKey ?? '-',
      modelId,
      detailStart.value,
      detailEnd.value,
    ].join('|')
  }

  /** 明细要对齐的结算区间。用 boardInfo 的 start/upTo，保证与排行榜那次同口径 */
  const detailSample = computed(() => boardInfo.value?.sample ?? Math.max(0, history.value.length - 80))
  const detailStart = computed(() =>
    boardInfo.value ? Math.max(60, history.value.length - boardInfo.value.periods) : 60
  )
  const detailEnd = computed(() => history.value.length)

  function cancelDetail() {
    if (detailLoading.value) detailCancel = true
  }

  function clearDetail() {
    // 正在重算时不清：否则会把 detailModelId 抹掉，而 runDetailAsync 稍后还会把
    // rows 写回来，于是留下「有数据但没有模型名」的半成品状态（UI 直接不显示）。
    // 该作废的用 cancelDetail()，让这一轮自己收尾。
    if (detailLoading.value) {
      cancelDetail()
      return
    }
    detailRows.value = []
    detailModelId.value = ''
    detailError.value = ''
    detailCache.clear()
  }

  /**
   * 按需重算某模型的逐期明细。
   *
   * 两个必须守住的点：
   *
   * 1. **必须带 modelIndex**，而且要用排行榜那份模型数组（ALL_MODELS）里的下标。
   *    种子由 (期序号, 模型序号) 派生，下标错位会让这里重算出的号码与排行榜那次
   *    不是同一注——数字对不上，用户点开明细看到的就成了编出来的。
   * 2. **boardInfo 必须已就绪**。它决定了结算区间。
   *    拿不到就明确失败，绝不静默 return：静默会让 UI 停在占位文案上，
   *    用户只看到「点了没反应」，完全无从判断是加载中还是出错了。
   */
  async function loadDetail(modelId: string, force = false): Promise<boolean> {
    const m = getModel(modelId)
    if (!m || !history.value.length) return false
    if (detailLoading.value) return false

    const info = boardInfo.value
    if (!info) {
      detailError.value = '还没有可对齐的回测结果，请先跑一次回测'
      return false
    }

    const key = detailKey(modelId)
    const cached = detailCache.get(key)
    if (cached && !force) {
      detailRows.value = cached
      detailModelId.value = modelId
      detailError.value = ''
      detailFrom.value = 'memory'
      return true
    }

    const modelIndex = ALL_MODELS.findIndex((x) => x.meta.id === modelId)
    if (modelIndex < 0) {
      detailError.value = `模型 ${modelId} 不在本次回测的模型集合里`
      return false
    }

    const start = detailStart.value
    const end = detailEnd.value

    // 落库的那一份：引擎版本一致、且覆盖本次要看的起点就认。
    //
    // 为什么不再要求「区间逐位相等」：开奖每多一期，窗口就整体后移一格，
    // 但**老的那几期的号码不会变**——种子只看 (期序号, 模型序号)，
    // 训练集是 history.slice(0, i)，前缀没动过。所以缓存只要起点不晚于本次、
    // 终点不超过本次，就能直接用，缺的只有末尾新开的那一两期。
    // 按老写法（start/upTo 必须相等）每来一期新开奖，78 个模型的明细全部作废，
    // 等于把几十 MB 的存档一次性扔掉。
    if (!force) {
      try {
        const st = await ensureStorage()
        const saved = await st.getDetail(info.runKey, modelId)
        if (
          saved &&
          saved.engine === ENGINE_VERSION &&
          saved.start <= start &&
          saved.upTo >= start &&
          saved.upTo <= end
        ) {
          const kept = saved.rows.filter((r) => r.index >= start)
          if (saved.upTo === end) {
            detailCache.set(key, kept)
            detailRows.value = kept
            detailModelId.value = modelId
            detailError.value = ''
            detailProgress.value = 1
            detailFrom.value = 'disk'
            return true
          }
          // 只补末尾新增的几期（通常就 1 期），补完合并回库
          detailCancel = false
          detailLoading.value = true
          detailProgress.value = 0
          detailModelId.value = modelId
          detailError.value = ''
          detailRows.value = kept
          detailFrom.value = 'extend'
          try {
            const tail = await runDetailAsync(
              {
                lottery: lottery.value,
                history: history.value,
                budget: budget.value,
                profile: profile.value,
                model: m,
                modelIndex,
                from: saved.upTo,
                to: end,
              },
              {
                onProgress: (p) => (detailProgress.value = p.ratio),
                shouldCancel: () => detailCancel,
              }
            )
            const rows = kept.concat(tail)
            detailCache.set(key, rows)
            detailRows.value = rows
            detailProgress.value = 1
            detailLoading.value = false
            void ensureStorage()
              .then((s2) =>
                s2.putDetail({
                  runKey: info.runKey,
                  modelId,
                  start,
                  upTo: end,
                  engine: ENGINE_VERSION,
                  rows: toRaw(rows),
                  createdAt: Date.now(),
                })
              )
              .catch(() => {
                /* 合并写回失败也不影响这次展示 */
              })
            return true
          } catch {
            // 补尾巴失败（被停掉 / 模型报错）就退回整体现算，别把 loading 卡住
            detailLoading.value = false
            detailRows.value = []
          }
        }
      } catch {
        /* 读缓存失败不致命，现算就是 */
      }
    }

    detailCancel = false
    detailLoading.value = true
    detailError.value = ''
    detailProgress.value = 0
    detailModelId.value = modelId
    detailRows.value = []
    detailFrom.value = 'compute'
    // 先让出一帧，把「正在重算」渲染出来再开算
    await new Promise((r) => setTimeout(r, 20))
    try {
      const rows = await runDetailAsync(
        {
          lottery: lottery.value,
          history: history.value,
          budget: budget.value,
          profile: profile.value,
          model: m,
          modelIndex,
          from: start,
          to: end,
        },
        {
          onProgress: (p) => (detailProgress.value = p.ratio),
          shouldCancel: () => detailCancel,
        }
      )
      detailCache.set(key, rows)
      detailRows.value = rows
      detailProgress.value = 1
      // 落库失败不影响本次显示，但下次还得再算一遍，所以要出声
      void ensureStorage()
        .then((st) =>
          st.putDetail({
            runKey: info.runKey,
            modelId,
            start,
            upTo: end,
            engine: ENGINE_VERSION,
            rows: toRaw(rows),
            createdAt: Date.now(),
          })
        )
        .catch((e) => console.warn('[明细] 落库失败，下次打开还要重算：', e))
      return true
    } catch (e: any) {
      if (e instanceof BacktestCancelled) {
        // 用户主动停的：数据作废，但**保留已选中的模型**——
        // 否则 UI 退回「点上面任意一行」的占位文案，看不出刚才选的是谁。
        detailRows.value = []
        detailError.value = '已停止'
      } else {
        detailError.value = e?.message || '明细加载失败'
        detailModelId.value = ''
      }
      return false
    } finally {
      detailLoading.value = false
    }
  }

  function toggleFav(id: string) {
    const i = favorites.value.indexOf(id)
    if (i >= 0) favorites.value.splice(i, 1)
    else favorites.value.push(id)
    persist()
  }

  /**
   * 落盘用户状态。对外保持同步调用签名（内部异步），
   * 这样 toggleFav 等既有调用点一行都不用改。
   */
  function persist() {
    ensureStorage()
      .then((st) =>
        st.putUserState({
          // toRaw：落库要的是纯数据。store 里的这些都是 reactive 代理，
          // IndexedDB 的结构化克隆见到 Proxy 会直接 DataCloneError，
          // 具体表现为「弹窗说保存成功、刷新就没了」。
          profile: toRaw(profile.value) as Profile,
          budget: budget.value,
          favorites: toRaw(favorites.value) as string[],
        })
      )
      .catch((e) => {
        // 存储不可用时降级为纯内存可以，但**不能无声**：
        // 静默吞错正是这个 bug 藏了这么久的原因。
        console.warn('[档案] 用户数据落库失败，本次改动只存在于内存中：', e)
      })
  }

  function resetAll() {
    favorites.value = []
    profile.value = {}
    board.value = []
    boardInfo.value = null
    progress.value = idleProgress()
    // 性能校准也是「本机观察数据」，跟着一起清，避免拿旧机器的速度去估新机器
    perf.value = { factor: 1, samples: 0, periods: 0, updatedAt: 0 }
    clearDetail()
    ensureStorage()
      .then((st) => st.clearAll())
      .catch(() => {
        /* ignore */
      })
  }

  watch(budget, () => persist())

  // 换彩种时榜面必须跟着换：留着上一个彩种的结果会张冠李戴
  watch(lottery, () => {
    board.value = []
    boardInfo.value = null
    progress.value = idleProgress()
    clearDetail()
    void restoreLastBoard()
  })

  // 预算一改，票型就变了，明细缓存全部作废
  watch(budget, () => clearDetail())

  return {
    draws, lottery, budget, profile, favorites,
    selectedModelId, loading, error, backtesting, board, progress, boardInfo, dataAdded, perf,
    history, latest, nextIssue, nextDate, rule, selectedModel,
    netMode, canLive, modeText, updating, updateMsg,
    loadData, predict, recommendPlan,
    runLeaderboard, hasCachedBoard, probeBoard, runSingle, cancelRun, restoreLastBoard,
    recordPerfRate,
    toggleFav, persist, resetAll, updateData,
    detailRows, detailModelId, detailLoading, detailProgress, detailError, detailFrom,
    detailStart, detailEnd, archiveInfo,
    loadDetail, cancelDetail, clearDetail,
  }
})
