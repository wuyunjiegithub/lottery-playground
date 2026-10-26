import { MATH_MODELS } from './math'
import { MATH_EXT_MODELS } from './mathExt'
import { MATH_ML_MODELS } from './mathML'
import { META_MODELS } from './meta'
import { META_EXT_MODELS } from './metaExt'
import { BASELINE_MODELS } from './baseline'
import type { Model } from './types'
import type { ModelMeta } from '../../types'

export const ALL_MODELS: Model[] = [
  ...MATH_MODELS,
  ...MATH_EXT_MODELS,
  ...MATH_ML_MODELS,
  ...META_MODELS,
  ...META_EXT_MODELS,
  ...BASELINE_MODELS,
]

/**
 * 轻量模型子集：**回测已不再使用它**（默认跑全部 78 个，见 backtest.leaderboard）。
 *
 * 保留给耗时标定脚本（probe-*.mjs）与「轻重对比」用。实测 14 个重型模型的
 * predict 合计约 723ms，是这 64 个（约 130ms）的 5.6 倍——想知道某段代码
 * 慢在哪，这个划分是最快的归因手段。
 */
export const LIGHT_MODELS: Model[] = ALL_MODELS.filter((m) => !m.heavy)

/** 重量模型：搜索类与机器学习类。回测**默认包含**，它们是结论的反例（证伪）来源 */
export const HEAVY_MODELS: Model[] = ALL_MODELS.filter((m) => m.heavy)

export function getModel(id: string): Model | undefined {
  return ALL_MODELS.find((m) => m.meta.id === id)
}

export function modelsByCategory(cat: ModelMeta['category']): Model[] {
  return ALL_MODELS.filter((m) => m.meta.category === cat)
}

export const MODEL_COUNT = {
  math: ALL_MODELS.filter((m) => m.meta.category === 'math').length,
  stat: ALL_MODELS.filter((m) => m.meta.category === 'stat').length,
  meta: ALL_MODELS.filter((m) => m.meta.category === 'meta').length,
  fun: ALL_MODELS.filter((m) => m.meta.category === 'fun').length,
  baseline: ALL_MODELS.filter((m) => m.meta.category === 'baseline').length,
  total: ALL_MODELS.length,
}

export * from './types'
