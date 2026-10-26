<template>
  <div>
    <!-- 上期开奖 -->
    <div class="card mb-3 relative overflow-hidden" v-if="store.latest">
      <div class="flex items-center gap-2 text-[11px] text-slate-500 mb-2.5">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_7px] shadow-emerald-500"></span>
        第 <b class="text-slate-300">{{ store.latest.issue }}</b> 期 · 已开奖
        {{ store.latest.date }}
      </div>
      <div class="flex gap-1.5 items-center flex-wrap mb-3">
        <span v-for="n in store.latest.front" :key="'f' + n" class="ball ball-r">{{ pad(n) }}</span>
        <span class="w-px h-5 bg-ink-500 mx-1"></span>
        <span v-for="n in store.latest.back" :key="'b' + n" class="ball ball-b">{{ pad(n) }}</span>
      </div>
      <div class="flex gap-4 text-[11px] text-slate-400 flex-wrap">
        <span v-if="store.latest.sales">销售额 <b class="text-slate-200">{{ yi(store.latest.sales) }}</b></span>
        <span v-if="store.latest.pool">奖池 <b class="text-slate-200">{{ yi(store.latest.pool) }}</b></span>
        <span>共 <b class="text-slate-200">{{ store.history.length }}</b> 期在库</span>
      </div>
    </div>

    <!-- 下一期 -->
    <div class="card-sm mb-3 flex items-center justify-between">
      <div class="text-[11px] text-slate-500">
        下一期
        <b class="block text-[15px] text-slate-100 mt-0.5">{{ store.nextIssue }}</b>
        <span class="block text-[12px] text-amber-400 mt-0.5">{{ nextDrawAt }}</span>
      </div>
      <div class="text-right text-[11px] text-slate-500">
        距开奖<b class="block text-[15px] text-amber-400 mt-0.5">{{ cdText }}</b>
      </div>
    </div>

    <!-- 本期票面：进页面即自动生成，无需点击 -->
    <div class="card mb-3">
      <div class="ct">
        <h3>第 {{ store.nextIssue }} 期票面</h3>
        <span class="tag">{{ plan?.best?.label || '生成中' }}</span>
      </div>

      <!-- 内联模型选择：直接切换，不跳转到模型详情 -->
      <div class="relative mb-3">
        <button
          class="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-ink-600 border border-ink-500 text-left"
          @click="pickerOpen = !pickerOpen"
        >
          <span class="tag">{{ store.selectedModel.meta.id }}</span>
          <span class="text-[12.5px] text-slate-100 flex-1 truncate">{{ store.selectedModel.meta.name }}</span>
          <span class="text-[10px] text-slate-500 shrink-0">{{ catLabel(store.selectedModel.meta.category) }}</span>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2" class="text-slate-500 shrink-0"
          ><path d="M6 9l6 6 6-6" /></svg>
        </button>

        <div v-if="pickerOpen" class="fixed inset-0 z-10" @click="pickerOpen = false"></div>
        <div
          v-if="pickerOpen"
          class="absolute z-20 mt-1 left-0 right-0 card-sm p-2 max-h-[62vh] overflow-y-auto"
        >
          <div class="flex flex-wrap gap-1.5 mb-2 sticky top-0 bg-ink-700/95 backdrop-blur py-1 -mx-1 px-1">
            <button
              v-for="c in PICK"
              :key="c.k"
              class="px-2.5 py-1 rounded-full text-[11px] border transition"
              :class="pickCat === c.k ? 'border-red-500 text-red-400 bg-red-500/10' : 'border-ink-500 text-slate-400'"
              @click="pickCat = c.k"
            >{{ c.t }}</button>
          </div>

          <template v-for="grp in groupedModels" :key="grp.cat">
            <div v-if="grp.items.length" class="mb-2.5">
              <div class="text-[10px] text-slate-500 px-1 mb-1">{{ grp.label }}（{{ grp.items.length }}）</div>
              <button
                v-for="m in grp.items"
                :key="m.meta.id"
                class="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition"
                :class="m.meta.id === store.selectedModelId ? 'bg-red-500/15' : 'hover:bg-ink-600'"
                @click="pick(m.meta.id)"
              >
                <span class="text-[10px] text-slate-500 w-9 shrink-0">{{ m.meta.id }}</span>
                <span class="text-[12px] text-slate-200 flex-1 truncate">{{ m.meta.name }}</span>
                <span v-if="fav(m.meta.id)" class="text-[11px] text-amber-400 shrink-0">★</span>
                <span v-if="m.meta.id === store.selectedModelId" class="text-[11px] text-red-400 shrink-0">✓</span>
              </button>
            </div>
          </template>

          <p v-if="!groupedModels.some((g) => g.items.length)" class="text-[11px] text-slate-500 px-1 py-2">
            {{ pickCat === 'fav' ? '还没有收藏的模型，去「模型」页点星标' : '无模型' }}
          </p>
        </div>
      </div>

      <template v-if="plan?.best">
        <div class="flex gap-1.5 items-center flex-wrap mb-2">
          <template v-if="plan.best.dans?.length">
            <span class="text-[10px] text-slate-500 mr-0.5">胆</span>
            <span v-for="n in plan.best.dans" :key="'d' + n" class="ball ball-r">{{ pad(n) }}</span>
            <span class="w-px h-4 bg-ink-500 mx-1"></span>
            <span class="text-[10px] text-slate-500 mr-0.5">拖</span>
            <span v-for="n in plan.best.tuos" :key="'t' + n" class="ball ball-r opacity-45">{{ pad(n) }}</span>
          </template>
          <template v-else>
            <span v-for="n in plan.best.frontNums" :key="'f' + n" class="ball ball-r">{{ pad(n) }}</span>
          </template>
          <span class="w-px h-5 bg-ink-500 mx-1"></span>
          <span v-for="n in plan.best.backNums" :key="'b' + n" class="ball ball-b">{{ pad(n) }}</span>
        </div>

        <div class="grid grid-cols-3 gap-2 mb-2.5">
          <div class="kpi"><p>注数</p><b>{{ plan.best.bets }}</b></div>
          <div class="kpi"><p>金额</p><b>{{ plan.best.cost }} 元</b></div>
          <div class="kpi"><p>中奖概率</p><b>{{ pct(plan.best.metrics.pWin) }}</b></div>
        </div>

        <!--
          「中奖概率」不说清楚就一定会被读成「中大奖的概率」。
          它其实是「至少中任意一个奖级」，而最低奖只有 5 元。
          顺便把期望回报摆出来：花多少、平均收回多少，这是本页最有信息量的一句。
        -->
        <p class="text-[10px] text-slate-500 leading-relaxed mb-2.5">
          「中奖概率」= 这一票至少中<b class="text-slate-400">任意一个奖级</b>的概率，
          最低的 {{ lowestLevel }} 只有 {{ lowestPrize }} 元。按官方奖金表折算，这一票的期望回报约
          <b class="text-amber-400" :title="evTitle">{{ money(evAmount) }} 元</b>
          —— 花 {{ plan.best.cost }} 元，平均收回 {{ evBack }}%。
        </p>

        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] text-slate-500">
            按预算 <b class="text-slate-300">{{ store.budget }} 元</b>
          </span>
          <span class="text-[11px] text-red-400 cursor-pointer shrink-0" @click="emit('go', 'settings')">
            改预算 →
          </span>
        </div>
      </template>

      <p v-else class="text-[11px] text-slate-500 py-2">
        {{ store.error || '正在载入历史数据，稍候自动生成…' }}
      </p>
    </div>

    <p class="disc mt-3">
      本系统为概率与统计的实验性玩具，仅用于数据分析与娱乐。彩票开奖为独立随机事件，历史数据不能预测未来。系统内所有模型的长期表现与随机选号无统计显著差异。不涉及任何资金流转，请理性对待彩票。
    </p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useMainStore } from '../stores/main'
import { formatDrawDate } from '../core/format'
import { ALL_MODELS } from '../core/models'
import { RULES, FIXED_PRIZE } from '../core/lottery'
import { planEV } from '../core/ticket'

const emit = defineEmits(['go'])
const store = useMainStore()

/**
 * 本期票面——进页面就算好，不要求用户点任何按钮。
 * 依赖（彩票种类 / 预算 / 选中模型）变化时 Vue 会自动重算。
 */
const plan = computed(() => {
  if (!store.history.length) return null
  try {
    return store.recommendPlan(store.selectedModelId)
  } catch {
    return null
  }
})

// —— 内联模型选择器：直接切换模型并刷新票面，不跳转到详情页 ——
const CATS: Record<string, string> = {
  math: '数学',
  stat: '统计',
  meta: '玄学',
  fun: '趣味',
  baseline: '对照组',
}
const PICK = [
  { k: 'all', t: '全部' },
  { k: 'fav', t: '收藏' },
  { k: 'math', t: '数学' },
  { k: 'stat', t: '统计' },
  { k: 'meta', t: '玄学' },
  { k: 'fun', t: '趣味' },
  { k: 'baseline', t: '对照组' },
] as const
const pickCat = ref('all')
const pickerOpen = ref(false)

const groupedModels = computed(() => {
  if (pickCat.value === 'fav') {
    const items = ALL_MODELS.filter((m) => store.favorites.includes(m.meta.id))
    return [{ cat: 'fav', label: '收藏', items }]
  }
  if (pickCat.value === 'all') {
    return (['math', 'stat', 'meta', 'fun', 'baseline'] as const).map((c) => ({
      cat: c,
      label: CATS[c],
      items: ALL_MODELS.filter((m) => m.meta.category === c),
    }))
  }
  return [
    {
      cat: pickCat.value,
      label: CATS[pickCat.value],
      items: ALL_MODELS.filter((m) => m.meta.category === pickCat.value),
    },
  ]
})

function fav(id: string) {
  return store.favorites.includes(id)
}
function pick(id: string) {
  store.selectedModelId = id
  pickerOpen.value = false
}
function catLabel(c: string) {
  return CATS[c] ?? c
}

const pad = (n: number) => String(n).padStart(2, '0')
const pct = (v: number) => (v * 100).toFixed(1) + '%'
const money = (v: number) => v.toFixed(2)

// —— 期望回报：把「这一票平均能收回多少」算给用户看 ——
const rule = computed(() => RULES[store.lottery])
/** 最低奖级的名字（双色球六等奖 / 大乐透九等奖）。别写死，从规则里取 */
const lowestLevel = computed(() => {
  const names = rule.value.levelNames
  return names[Math.max(...Object.keys(names).map(Number))] || '末等奖'
})
const lowestPrize = computed(() => {
  const p = FIXED_PRIZE[store.lottery] as Record<number, number>
  return p[Math.max(...Object.keys(p).map(Number))] ?? 5
})
/**
 * 整票期望 = 注数 × 单注期望（期望的线性性，与票型无关），见 ticket.ts 的 planEV。
 * 一、二等奖是浮动奖，用的是历史均值估算值 —— 这句必须写在 title 里，
 * 否则「期望回报」会被当成承诺。
 */
const evAmount = computed(() =>
  plan.value?.best ? planEV(store.lottery, plan.value.best) : 0
)
const evBack = computed(() => {
  const cost = plan.value?.best?.cost || 0
  if (!cost) return '—'
  return ((evAmount.value / cost) * 100).toFixed(1)
})
const evTitle = computed(
  () => `${rule.value.name}单注期望回报按官方奖金表折算；一、二等奖为浮动奖，取历史均值估算`
)
function yi(v: string | number) {
  const n = Number(v)
  if (!n) return '—'
  return n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : (n / 1e4).toFixed(0) + ' 万'
}

const cdText = ref('—')
const nextDrawAt = computed(() => formatDrawDate(store.nextDate))
let timer: any = null
function tick() {
  const target = store.nextDate
  const diff = target.getTime() - Date.now()
  if (diff <= 0) {
    cdText.value = '开奖中'
    return
  }
  const d = Math.floor(diff / 86400000)
  const h = Math.floor((diff % 86400000) / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  cdText.value = (d > 0 ? d + ' 天 ' : '') + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
}
onMounted(() => {
  tick()
  timer = setInterval(tick, 30000)
})
onUnmounted(() => timer && clearInterval(timer))
</script>
