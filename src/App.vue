<template>
  <div class="h-full flex bg-ink-900 text-slate-100">
    <!-- 桌面端侧栏 -->
    <aside class="hidden md:flex md:w-56 flex-col bg-ink-800 border-r border-ink-500 p-4">
      <div class="flex items-center gap-2 mb-6">
        <div
          class="w-9 h-9 rounded-xl grid place-items-center text-white font-bold"
          style="background: linear-gradient(135deg, #ff5b5e, #e0313c)"
        >
          P
        </div>
        <div>
          <b class="text-[15px] block leading-tight">概率游乐场</b>
          <span class="text-[10px] text-slate-500">PROBABILITY PLAYGROUND</span>
        </div>
      </div>

      <nav class="flex flex-col gap-1">
        <button
          v-for="n in NAV"
          :key="n.k"
          class="flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] transition text-slate-400 hover:bg-ink-700 hover:text-slate-100"
          :class="{ '!text-white font-semibold': activeNav === n.k }"
          :style="activeNav === n.k ? 'background: linear-gradient(135deg,#ff5b5e,#e0313c)' : ''"
          @click="view = n.k"
        >
          <span v-html="n.icon" class="w-[18px] h-[18px] opacity-90"></span>
          {{ n.t }}
        </button>
      </nav>
    </aside>

    <div class="flex-1 flex flex-col min-w-0">
      <!-- 顶部 -->
      <header
        class="flex items-center gap-2 px-4 py-3 border-b border-ink-500 bg-ink-800 shrink-0"
      >
        <div class="md:hidden flex items-center gap-2">
          <div
            class="w-7 h-7 rounded-lg grid place-items-center text-white text-[12px] font-bold"
            style="background: linear-gradient(135deg, #ff5b5e, #e0313c)"
          >
            P
          </div>
          <b class="text-[14px]">概率游乐场</b>
        </div>
        <div class="ml-auto flex gap-1.5">
          <button
            v-for="l in ['dlt', 'ssq']"
            :key="l"
            class="px-3 py-1.5 rounded-full text-[11px] border transition"
            :class="
              store.lottery === l
                ? 'border-red-500 text-red-400 bg-red-500/10'
                : 'border-ink-500 text-slate-400 bg-ink-700'
            "
            @click="store.lottery = l as any"
          >
            {{ RULES[l].name }}
          </button>
        </div>
      </header>

      <!-- 内容 -->
      <main ref="mainEl" class="flex-1 overflow-y-auto p-4 pb-24 md:pb-6 md:px-6">
        <div
          v-if="store.loading"
          class="card text-[13px] text-slate-400 py-10 text-center"
        >
          正在载入历史数据…
        </div>
        <div
          v-else-if="store.error"
          class="card text-[13px] text-red-400 py-8 text-center"
        >
          {{ store.error }}
          <button class="btn-ghost mt-3" @click="store.loadData()">重试</button>
        </div>
        <template v-else>
          <Today v-if="view === 'today'" @go="view = $event" />
          <Models v-else-if="view === 'models'" @go="view = $event" />
          <Detail v-else-if="view === 'detail'" @go="view = $event" />
          <Backtest v-else-if="view === 'backtest'" />
          <History v-else-if="view === 'history'" />
          <Settings v-else-if="view === 'settings'" />
        </template>
      </main>

      <!-- 移动端底部导航 -->
      <nav
        class="md:hidden fixed bottom-0 left-0 right-0 flex bg-ink-800 border-t border-ink-500 pb-[env(safe-area-inset-bottom)]"
      >
        <button
          v-for="n in NAV"
          :key="n.k"
          class="flex-1 flex flex-col items-center gap-0.5 py-2 text-[9.5px]"
          :class="activeNav === n.k ? 'text-red-400' : 'text-slate-500'"
          @click="view = n.k"
        >
          <span v-html="n.icon" class="w-[19px] h-[19px]"></span>
          {{ n.t }}
        </button>
      </nav>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue'
import { useMainStore } from './stores/main'
import { RULES } from './core/lottery'
import Today from './views/Today.vue'
import Models from './views/Models.vue'
import Detail from './views/Detail.vue'
import Backtest from './views/Backtest.vue'
import History from './views/History.vue'
import Settings from './views/Settings.vue'

const store = useMainStore()
const view = ref('today')
const mainEl = ref<HTMLElement>()

// 详情页（detail）是从「模型」进入的子页面，导航高亮仍归属「模型」
const NAV_ALIAS: Record<string, string> = { detail: 'models' }
const activeNav = computed(() => NAV_ALIAS[view.value] || view.value)

// 切换菜单或彩种时，内容滚动容器自动回到顶部，避免停在上一页的滚动位置
watch([view, () => store.lottery], () => {
  nextTick(() => mainEl.value?.scrollTo({ top: 0, behavior: 'smooth' }))
})

const ICON = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>',
  grid:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  star:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l2.5 6.5L21 11l-6.5 2.5L12 20l-2.5-6.5L3 11l6.5-2.5z"/></svg>',
  chart:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 17l5-5 4 3 5-7 4 4"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  cog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 110-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 3.6 1.65 1.65 0 0010 2.09V2a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 8V8a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
}

const NAV = [
  { k: 'today', t: '今日', icon: ICON.home },
  { k: 'models', t: '模型', icon: ICON.grid },
  { k: 'backtest', t: '回测', icon: ICON.chart },
  { k: 'history', t: '历史', icon: ICON.clock },
  { k: 'settings', t: '档案', icon: ICON.cog },
]

onMounted(() => store.loadData())
</script>
