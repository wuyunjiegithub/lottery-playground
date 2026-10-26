<template>
  <div>
    <div class="flex gap-1.5 mb-3 overflow-x-auto no-scrollbar">
      <button
        v-for="t in TABS"
        :key="t.k"
        class="shrink-0 px-3 py-1.5 rounded-full text-[12px] border transition"
        :class="
          cat === t.k
            ? 'text-white font-semibold border-transparent'
            : 'border-ink-500 text-slate-400 bg-ink-700'
        "
        :style="cat === t.k ? 'background: linear-gradient(135deg,#ff5b5e,#e0313c)' : ''"
        @click="cat = t.k"
      >
        {{ t.t }}<i class="not-italic opacity-60 ml-1 text-[10px]">{{ countOf(t.k) }}</i>
      </button>
    </div>

    <p v-if="computing" class="-mt-2 mb-2 text-[10.5px] text-slate-500">
      正在后台补算推荐号码…（页面可正常操作；重型模型滚到可见时才计算）
    </p>

    <div class="md:grid md:grid-cols-2 md:gap-2.5">
      <div
        v-for="row in shown"
        :key="row.m.meta.id"
        v-obs
        :data-mid="row.m.meta.id"
        class="card-sm mb-2 md:mb-0 cursor-pointer transition hover:border-ink-500/80"
        :class="row.m.meta.category === 'baseline' ? 'border-amber-500/40' : ''"
        @click="pick(row.m.meta.id)"
      >
        <div class="flex items-start gap-2 mb-1.5">
          <span class="text-[9.5px] px-1.5 py-0.5 rounded bg-ink-600 text-slate-500 font-mono mt-0.5">
            {{ row.m.meta.id }}
          </span>
          <b class="text-[13px] leading-snug">{{ row.m.meta.name }}</b>
          <span
            class="ml-auto text-[15px] leading-none"
            :class="store.favorites.includes(row.m.meta.id) ? 'text-amber-400' : 'text-slate-600'"
            @click.stop="store.toggleFav(row.m.meta.id)"
          >
            {{ store.favorites.includes(row.m.meta.id) ? '★' : '☆' }}
          </span>
        </div>
        <p class="text-[11.5px] text-slate-400 leading-relaxed mb-2">{{ row.m.meta.desc }}</p>

        <!-- 该模型对下一期的推荐号码（后台算好后自动填入） -->
        <div class="mb-2">
          <div class="flex items-center gap-1 flex-wrap">
            <span class="text-[9px] text-slate-500 mr-0.5 shrink-0">下期推荐</span>
            <template v-if="row.rec">
              <span v-for="n in row.rec.front" :key="'f' + n" class="ball ball-r ball-sm">{{ pad(n) }}</span>
              <span class="w-px h-3.5 bg-ink-500 mx-0.5"></span>
              <span v-for="n in row.rec.back" :key="'b' + n" class="ball ball-b ball-sm">{{ pad(n) }}</span>
            </template>
            <span v-else-if="row.rec === null" class="text-[10px] text-slate-500">暂无可算数据</span>
            <span v-else class="text-[10px] text-slate-600">计算中…</span>
          </div>
        </div>

        <div class="flex gap-3 text-[10.5px] text-slate-500">
          <span v-if="row.m.meta.category === 'baseline'" class="text-amber-400">黄金基线</span>
          <span v-else>类型 {{ catName(row.m.meta.category) }}</span>
          <span v-if="row.m.meta.needsProfile" class="text-slate-500">需档案</span>
          <span class="ml-auto text-slate-500">查看 ›</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onUnmounted } from 'vue'
import { useMainStore } from '../stores/main'
import { ALL_MODELS, MODEL_COUNT, type Model } from '../core/models'

const emit = defineEmits(['go'])
const store = useMainStore()
type CatKey = 'math' | 'stat' | 'meta' | 'fun' | 'baseline' | 'fav'

const cat = ref<CatKey>('math')

const TABS: { k: CatKey; t: string }[] = [
  { k: 'math', t: '数学' },
  { k: 'stat', t: '统计' },
  { k: 'meta', t: '玄学' },
  { k: 'fun', t: '趣味' },
  { k: 'baseline', t: '对照组' },
  { k: 'fav', t: '已收藏' },
]

const list = computed(() => {
  if (cat.value === 'fav') return ALL_MODELS.filter((m) => store.favorites.includes(m.meta.id))
  return ALL_MODELS.filter((m) => m.meta.category === cat.value)
})

function countOf(k: string) {
  if (k === 'fav') return store.favorites.length
  return (MODEL_COUNT as any)[k] ?? 0
}

function catName(c: string) {
  return c === 'math' ? '数学'
    : c === 'stat' ? '统计'
    : c === 'meta' ? '玄学'
    : c === 'fun' ? '趣味'
    : '对照'
}

function pick(id: string) {
  store.selectedModelId = id
  emit('go', 'detail')
}

const pad = (n: number) => String(n).padStart(2, '0')

// ------------------------------------------------------------------ 推荐号码
// 每个模型对下一期的推荐号码。**不能在渲染时同步算**：统计类有 14 个重型模型
// （S29–S42，单次预测 70–180ms），同步算会让「切到统计」整段卡死（实测 616ms 纯计算）。
// 策略：先渲染卡片（占位「计算中…」），再在后台用「分片 + 空闲时间」逐步补齐；
// 重型模型额外要求「滚到可见」才算，避免一屏之外也白算几百毫秒。
type Rec = { front: number[]; back: number[] } | null

const recCache = new Map<string, Rec>() // key = 上下文|模型
const recVersion = ref(0) // 每补一个模型递增，驱动重渲染
const computing = ref(false)
const visible = new Set<string>() // 当前在视口内的模型编号

let disposed = false
let pumping = false

/** 计算上下文签名：彩种 / 历史长度 / 玄学档案任一变化，缓存的推荐号码都作废 */
function ctxKey() {
  const p = store.profile
  const sig = `${p.birthDate || ''}~${p.gender || ''}~${p.name || ''}~${(p.dreamNumbers || []).join(',')}`
  return `${store.lottery}|${store.history.length}|${sig}`
}
const keyOf = (id: string) => `${ctxKey()}|${id}`

function topK(probs: number[], k: number): number[] {
  return probs
    .map((p, i) => ({ p, n: i + 1 }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k)
    .map((x) => x.n)
    .sort((a, b) => a - b)
}

function compute(m: Model): Rec {
  if (!store.history.length) return null
  try {
    const pred = m.predict({
      history: store.history,
      lottery: store.lottery,
      nextDate: store.nextDate,
      profile: store.profile,
    })
    return {
      front: topK(pred.frontProbs, store.rule.frontCount),
      back: topK(pred.backProbs, store.rule.backCount),
    }
  } catch {
    return null
  }
}

// 可见性观测：重型模型只在卡片进入视口（含 240px 预取）后才纳入计算队列
const canObserve = typeof IntersectionObserver !== 'undefined'
const io = canObserve
  ? new IntersectionObserver(
      (entries) => {
        let changed = false
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.mid
          if (!id) continue
          if (e.isIntersecting) {
            if (!visible.has(id)) {
              visible.add(id)
              changed = true
            }
          } else if (visible.delete(id)) {
            changed = true
          }
        }
        if (changed) ensureScheduled()
      },
      { rootMargin: '240px 0px' }
    )
  : null

/** v-obs：把卡片登记进可见性观测 */
const vObs = {
  mounted: (el: HTMLElement) => io?.observe(el),
  unmounted: (el: HTMLElement) => io?.unobserve(el),
}

/** 下一个可以算的模型：轻模型随时可算；重型模型必须已滚到可见 */
function nextEligible(): Model | null {
  for (const m of list.value) {
    const k = keyOf(m.meta.id)
    if (recCache.has(k)) continue
    if (m.heavy && canObserve && !visible.has(m.meta.id)) continue
    return m
  }
  return null
}

/** 交还主线程，让浏览器有机会重绘 / 响应点击；下一片再继续 */
function scheduleIdle(fn: () => void) {
  setTimeout(fn, 0)
}

/** 每片最多占用主线程 8ms，然后交还浏览器，避免卡顿 */
function step() {
  if (disposed) return
  const t0 = performance.now()
  let m: Model | null
  while (performance.now() - t0 < 8 && (m = nextEligible())) {
    recCache.set(keyOf(m.meta.id), compute(m))
    recVersion.value++
  }
  if (nextEligible()) {
    scheduleIdle(step)
  } else {
    pumping = false
    ensureScheduled() // 收尾时再看一眼（观测器可能刚把重型模型变成可见）
  }
}

function ensureScheduled() {
  if (disposed) return
  if (!nextEligible()) {
    computing.value = false
    pumping = false
    return
  }
  if (pumping) return
  pumping = true
  computing.value = true
  scheduleIdle(step)
}

const shown = computed(() => {
  recVersion.value // 依赖：每补一个模型就重算一次
  return list.value.map((m) => ({ m, rec: recCache.get(keyOf(m.meta.id)) as Rec | undefined }))
})

// 切换分类：卡片会被整批替换，清空可见集合，等观测器对新卡片重新上报
watch(cat, () => visible.clear())

watch(
  [() => store.lottery, () => store.history.length, () => store.profile, cat],
  () => ensureScheduled(), // recCache 里已有的继续复用
  { immediate: true, deep: true }
)

onUnmounted(() => {
  disposed = true
  pumping = false
  io?.disconnect()
})
</script>
