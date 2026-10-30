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

    <div class="md:grid md:grid-cols-2 md:gap-2.5">
      <div
        v-for="row in shown"
        :key="row.m.meta.id"
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
import { ref, computed } from 'vue'
import { useMainStore } from '../stores/main'
import { ALL_MODELS, MODEL_COUNT } from '../core/models'

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

const shown = computed(() => list.value.map((m) => ({ m })))
</script>
