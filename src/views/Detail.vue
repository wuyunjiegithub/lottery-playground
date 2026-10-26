<template>
  <div class="md:grid md:grid-cols-[224px_1fr] md:gap-4">
    <!-- 左侧：模型菜单（md+），点击即切换，右侧内容实时重算 -->
    <aside class="hidden md:block">
      <div class="sticky top-0 max-h-[calc(100vh-3rem)] overflow-y-auto pr-1 pb-4">
        <p class="text-[11px] text-slate-500 mb-2 px-1">选择模型</p>
        <div v-for="g in groups" :key="g.k" class="mb-3">
          <p class="text-[10px] text-slate-600 mb-1 px-1">{{ g.t }} · {{ g.models.length }}</p>
          <button
            v-for="m in g.models"
            :key="m.meta.id"
            class="w-full text-left px-2 py-1 rounded-lg text-[11px] mb-0.5 flex items-center gap-1.5 transition"
            :class="
              m.meta.id === store.selectedModelId
                ? 'bg-ink-600 text-white font-semibold'
                : 'text-slate-400 hover:bg-ink-600/60'
            "
            @click="store.selectedModelId = m.meta.id"
          >
            <span class="font-mono text-[9.5px] opacity-70 shrink-0">{{ m.meta.id }}</span>
            <span class="truncate">{{ m.meta.name }}</span>
            <span v-if="store.favorites.includes(m.meta.id)" class="ml-auto text-amber-400 text-[10px]">★</span>
          </button>
        </div>
      </div>
    </aside>

    <div class="min-w-0">
      <!-- 移动端：模型下拉 -->
      <div class="md:hidden mb-3">
        <select
          class="w-full bg-ink-700 border border-ink-500 rounded-lg px-2.5 py-2 text-[12px] text-slate-200 outline-none focus:border-rose-500"
          :value="store.selectedModelId"
          @change="onPickMobile($event)"
        >
          <optgroup v-for="g in groups" :key="g.k" :label="g.t">
            <option v-for="m in g.models" :key="m.meta.id" :value="m.meta.id">
              {{ m.meta.id }} · {{ m.meta.name }}
            </option>
          </optgroup>
        </select>
      </div>

      <div
        class="flex items-center gap-1.5 text-[12.5px] text-slate-400 mb-3 cursor-pointer"
        @click="emit('go', 'models')"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M15 5l-7 7 7 7" />
        </svg>
        模型广场
      </div>

      <div v-if="!best" class="card text-[13px] text-slate-400 py-8 text-center">
        当前预算下没有可行票型，试着放宽预算区间。
      </div>

      <template v-else>
        <!-- 模型说明 -->
        <div class="card-sm mb-3">
          <div class="flex items-center gap-2 mb-1.5">
            <h3 class="text-[13px] font-semibold">{{ meta.name }}</h3>
            <span class="tag">{{ meta.id }}</span>
            <span class="tag">{{ catName(meta.category) }}</span>
          </div>
          <p class="text-[11.5px] text-slate-400 leading-relaxed">{{ meta.desc }}</p>
        </div>

        <div
          class="mb-3 text-[11.5px] text-slate-300 leading-relaxed bg-ink-600 border-l-2 border-amber-400 rounded-r-lg p-3"
        >
          <span v-html="pred?.narrative"></span>
        </div>

        <!-- 选号依据 · 白话说明 -->
        <div class="card mb-3">
          <div class="ct"><h3>选号依据 · 白话说明</h3><span class="tag">为什么是这几个号</span></div>

          <div class="space-y-3 text-[11.5px] leading-relaxed text-slate-300">
            <div>
              <p><b class="text-red-400">① 这个模型怎么选号：</b>{{ CAT_PLAIN[meta.category] }}</p>
              <p class="text-slate-400 mt-0.5">{{ meta.desc }}</p>
            </div>

            <div>
              <p class="mb-1.5">
                <b class="text-red-400">② 它给每个号码打了分</b>——分数 = 模型认为该号下期出现的可能性，越靠前越高：
              </p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                <div v-for="r in frontTop" :key="'fr' + r.n" class="flex items-center gap-2">
                  <span class="ball ball-r ball-sm" :class="pickedFront.has(r.n) ? '' : 'opacity-35'">{{ pad(r.n) }}</span>
                  <div class="flex-1 h-2 rounded bg-ink-600 overflow-hidden">
                    <i
                      class="block h-full"
                      :style="`width:${(r.w / frontMaxW) * 100}%;background:linear-gradient(90deg,#ff5b5e,#e0313c)`"
                    ></i>
                  </div>
                  <span class="text-[10px] font-mono text-slate-500 w-11 text-right">{{ r.pct.toFixed(1) }}%</span>
                </div>
              </div>
              <p class="text-[10px] text-slate-500 mt-1.5">
                前区（{{ store.lottery === 'ssq' ? '红球' : '前区' }}）评分前 12；彩色 = 已进入票面，灰淡 = 评分靠前但未入票。
              </p>
            </div>

            <div>
              <p class="mb-1.5"><b class="text-red-400">③ 后区同样打分：</b></p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                <div v-for="r in backTop" :key="'br' + r.n" class="flex items-center gap-2">
                  <span class="ball ball-b ball-sm" :class="pickedBack.has(r.n) ? '' : 'opacity-35'">{{ pad(r.n) }}</span>
                  <div class="flex-1 h-2 rounded bg-ink-600 overflow-hidden">
                    <i
                      class="block h-full"
                      :style="`width:${(r.w / backMaxW) * 100}%;background:linear-gradient(90deg,#6aa9ff,#2a5fb8)`"
                    ></i>
                  </div>
                  <span class="text-[10px] font-mono text-slate-500 w-11 text-right">{{ r.pct.toFixed(1) }}%</span>
                </div>
              </div>
            </div>

            <div>
              <p>
                <b class="text-red-400">④ 票面怎么来的：</b>
                前区取分数最高的顶 {{ best.frontNums.length }} 个号、后区取分数最高的顶 {{ best.backNums.length }} 个号，组成「{{ best.label }}」。
                <span v-if="best.dans?.length">
                  其中 <b class="text-amber-400">胆码</b> 是最有把握的几个（每注必含），其余为<b class="text-slate-400">拖码</b>。
                </span>
                <span v-else>复式票一次覆盖多个号，注数与金额随之增加；单式票则恰好 {{ best.bets }} 注。</span>
              </p>
            </div>

            <div>
              <p>
                <b class="text-red-400">⑤ 模型自评置信度：</b>{{ ((pred?.confidence ?? 0) * 100).toFixed(0) }}%。
                <span class="text-slate-500">这只是模型的「自称」，不代表真实中奖概率。</span>
              </p>
            </div>

            <div class="disc">
              <b class="text-amber-400">说句大实话：</b>{{ RULES[store.lottery].name }}每期独立随机，任何模型都无法真正提高中奖概率。上面这些「高分号」只是把历史数据的某种特征换个角度看，中奖全靠运气。请理性购彩、量力而行。
            </div>
          </div>
        </div>

        <!-- 推荐票面 -->
        <div class="card mb-3 border-red-500/60">
          <div class="flex items-center gap-2 mb-2.5">
            <b class="text-[13px]">{{ best.label }}</b>
            <span class="text-[9.5px] px-1.5 py-0.5 rounded text-white font-semibold" style="background: linear-gradient(135deg,#ff5b5e,#e0313c)">
              推荐
            </span>
            <span class="ml-auto text-[15px] font-bold text-red-400">{{ best.cost }} 元</span>
          </div>

          <div class="text-[10.5px] text-slate-500 mb-1.5">
            {{ store.lottery === 'ssq' ? '红球' : '前区' }} · {{ best.frontNums.length }} 个
            <span v-if="best.dans?.length" class="text-slate-600">（金色 = 胆码，每注必含）</span>
          </div>
          <div class="flex gap-1.5 flex-wrap mb-2.5">
            <span
              v-for="(n, i) in best.frontNums"
              :key="'f' + n + i"
              class="ball ball-r"
              :class="best.dans?.length && !best.dans.includes(n) ? 'opacity-45' : ''"
              >{{ pad(n) }}</span
            >
          </div>

          <div class="text-[10.5px] text-slate-500 mb-1.5">
            {{ store.lottery === 'ssq' ? '蓝球' : '后区' }} · {{ best.backNums.length }} 个
          </div>
          <div class="flex gap-1.5 flex-wrap mb-3">
            <span v-for="n in best.backNums" :key="'b' + n" class="ball ball-b">{{ pad(n) }}</span>
          </div>

          <div v-if="best.dans?.length" class="text-[11px] text-slate-400 mb-2.5">
            胆码 <b class="text-amber-400">{{ best.dans.map(pad).join(' ') }}</b>
            ｜ 拖码 {{ best.tuos?.map(pad).join(' ') }}
          </div>

          <div class="bg-ink-800 border border-dashed border-ink-500 rounded-lg p-2.5 font-mono text-[11px] text-slate-400 leading-relaxed">
            {{ best.formula }}<br />
            一等奖概率 = {{ best.bets }} / {{ totalComb }}<br />
            至少中奖 = <span class="text-red-400">{{ pct(best.metrics.pWin) }}</span>
            ｜ 覆盖 {{ best.metrics.coverage }} 个号
          </div>
        </div>

        <!-- 票型评估 -->
        <div class="card mb-3">
          <div class="ct">
            <h3>算法评估了 {{ ranked.length }} 种票型</h3>
            <span class="tag">每种都列出实际号码</span>
          </div>

          <p class="text-[10.5px] text-slate-500 leading-relaxed mb-2.5">
            算法在预算内枚举了全部合法票型，逐一打分后只保留得分最高的几种。
            <b class="text-slate-400">它们花的钱、注数完全一样</b>（{{ ranked[0]?.bets ?? 0 }} 注 ·
            {{ ranked[0]?.cost ?? 0 }} 元）—— 所以真正要比的是
            <b class="text-slate-400">号码怎么分配</b>：号码买得越分散，中奖率越高但每注金额越薄。
            <template v-if="ranked.length > shownPlans.length">
              <span class="text-slate-600">（共 {{ ranked.length }} 种，此处列出前 {{ shownPlans.length }} 种）</span>
            </template>
          </p>

          <div class="space-y-2">
            <div
              v-for="(p, i) in shownPlans"
              :key="i"
              class="rounded-lg border p-2.5"
              :class="i === 0 ? 'border-red-500/60 bg-red-500/5' : 'border-ink-500'"
            >
              <!-- 票型标题行 -->
              <div class="flex items-baseline gap-2 mb-2">
                <b class="text-[12px]">{{ p.label }}</b>
                <span v-if="i === 0" class="text-[9px] px-1.5 py-0.5 rounded text-white font-semibold bg-red-500">
                  推荐
                </span>
                <span class="ml-auto text-[10px] font-mono text-slate-500">
                  {{ p.bets }} 注 · {{ p.cost }} 元 · 覆盖 {{ p.metrics.coverage }} 号
                </span>
              </div>

              <!-- 号码：胆码 / 拖码 / 后区 -->
              <div class="flex gap-1 flex-wrap items-center mb-2">
                <template v-for="(n, k) in p.frontNums" :key="'f' + n + k">
                  <span
                    class="ball ball-r ball-xs"
                    :class="p.dans?.length && !p.dans.includes(n) ? 'opacity-45' : ''"
                    :title="p.dans?.length ? (p.dans.includes(n) ? '胆码（每注必含）' : '拖码') : ''"
                  >{{ pad(n) }}</span>
                </template>
                <span class="text-slate-600 text-[10px] mx-0.5">+</span>
                <span v-for="n in p.backNums" :key="'b' + n" class="ball ball-b ball-xs">{{ pad(n) }}</span>
              </div>

              <!-- 胆拖构成 / 复式的注数是怎么来的（复式没有 dans，这一行解释 bets 从哪来） -->
              <p v-if="p.dans?.length" class="text-[10px] text-slate-500 mb-2">
                <b class="text-amber-400">胆码</b> {{ p.dans.map(pad).join(' ') }}
                <span class="mx-1 text-slate-600">｜</span>
                <b class="text-slate-400">拖码</b> {{ p.tuos?.map(pad).join(' ') }}
                <span class="ml-1 text-slate-600">— 每注含 {{ p.dans.length }} 胆，注数 = {{ dantuoFormula(p) }}</span>
              </p>
              <p v-else class="text-[10px] text-slate-500 mb-2">
                复式票，注数 = {{ p.formula }}
              </p>

              <!-- 指标条 -->
              <div class="flex items-center gap-2 text-[10px]">
                <span class="text-slate-500 shrink-0">中奖率</span>
                <div class="flex-1 h-1.5 rounded bg-ink-600 overflow-hidden">
                  <i
                    class="block h-full"
                    :style="`width:${Math.min(100, p.metrics.pWin * 100)}%;background:linear-gradient(90deg,#6ee7b7,#10b981)`"
                  ></i>
                </div>
                <span class="font-mono text-emerald-400 w-14 text-right">{{ pct(p.metrics.pWin) }}</span>
                <span class="shrink-0" :class="riskOf(p) === '高' ? 'text-red-400' : 'text-slate-500'">
                  风险{{ riskOf(p) }}
                </span>
              </div>
            </div>
          </div>

          <p class="text-[10.5px] text-slate-500 leading-relaxed mt-2.5 pt-2.5 border-t border-ink-500">
            <b class="text-amber-400">为什么选它：</b>{{ reason }}<br />
            <b class="text-amber-400">期望回报全都一样：</b>{{ money(planEV(store.lottery, best)) }} 元
            —— {{ evSame }}
            <br />
            票型改变的只是<b>奖金分布的形状</b>：中奖率高的常常是「薄奖多注」，想搏大奖就得接受更低的中奖率。
          </p>
        </div>

        <button class="btn-ghost" @click="copy">复制票面文本</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useMainStore } from '../stores/main'
import { RULES } from '../core/lottery'
import { C } from '../core/lottery'
import { planEV, singleBetEV } from '../core/ticket'
import { ALL_MODELS } from '../core/models'
import type { TicketPlan, ModelMeta } from '../types'

const emit = defineEmits(['go'])
const store = useMainStore()

const result = computed(() => store.recommendPlan(store.selectedModelId))
const pred = computed(() => result.value.pred)
const best = computed(() => result.value.best)
const ranked = computed(() => result.value.ranked)
/** 一次最多摊开 8 种票型，否则页面会撑得过长 */
const MAX_SHOWN_PLANS = 8
const shownPlans = computed(() => ranked.value.slice(0, MAX_SHOWN_PLANS))
const meta = computed(() => store.selectedModel.meta)

// ---------------- 左侧模型菜单 ----------------
const CAT_ORDER: { k: ModelMeta['category']; t: string }[] = [
  { k: 'math', t: '数学' },
  { k: 'stat', t: '统计' },
  { k: 'meta', t: '玄学' },
  { k: 'fun', t: '趣味' },
  { k: 'baseline', t: '对照组' },
]
const groups = computed(() =>
  CAT_ORDER.map((g) => ({ ...g, models: ALL_MODELS.filter((m) => m.meta.category === g.k) }))
)
function onPickMobile(e: Event) {
  store.selectedModelId = (e.target as HTMLSelectElement).value
}
function catName(c: string) {
  return c === 'math' ? '数学'
    : c === 'stat' ? '统计'
    : c === 'meta' ? '玄学'
    : c === 'fun' ? '趣味'
    : '对照'
}

// ---------------- 选号依据（白话） ----------------
const CAT_PLAIN: Record<string, string> = {
  math: '这是一类「数学模型」，用公式或概率推演，给每个号码算一个「下期出现的可能性」分数。',
  stat: '这是一类「统计 / 机器学习模型」，从历史开奖里找规律（频率、遗漏、共现等），再据此给号码打分。',
  meta: '这是一类「玄学模型」，走中国传统术数命理的路子（干支、五行、周易、紫微、八字、黄历等），按日子或时辰起局选号，仅供娱乐。',
  fun: '这是一类「趣味模型」，用星座、塔罗、生肖、姓名、梦境等方式选号，或干脆随机抽一个，图个乐，不具备任何预测力。',
  baseline: '这是「对照组」，用完全随机或固定规则出号，用来和上面那些模型做比较。',
}

function rank(probs: number[]) {
  return probs
    .map((p, i) => ({ n: i + 1, w: p }))
    .sort((a, b) => b.w - a.w)
    .map((r) => ({ ...r, pct: r.w * 100 }))
}
const frontRank = computed(() => (pred.value ? rank(pred.value.frontProbs) : []))
const backRank = computed(() => (pred.value ? rank(pred.value.backProbs) : []))
const frontTop = computed(() => frontRank.value.slice(0, 12))
const backTop = computed(() => backRank.value.slice(0, 6))
const frontMaxW = computed(() => Math.max(1e-9, ...frontTop.value.map((r) => r.w)))
const backMaxW = computed(() => Math.max(1e-9, ...backTop.value.map((r) => r.w)))
const pickedFront = computed(() => new Set(best.value?.frontNums || []))
const pickedBack = computed(() => new Set(best.value?.backNums || []))

// ---------------- 票面评估 ----------------
const totalComb = computed(() => {
  const r = RULES[store.lottery]
  return (C(r.frontMax, r.frontCount) * C(r.backMax, r.backCount)).toLocaleString()
})

function riskOf(p: TicketPlan) {
  const sd = Math.sqrt(p.metrics.variance) / Math.max(1, p.cost)
  if (p.kind === 'dantuo') return sd > 60 ? '高' : '中'
  return sd > 60 ? '中' : '低'
}

/**
 * 胆拖票的注数怎么算出来的。
 * 双色球：C(拖数, 6−胆数) × 后区个数；大乐透：C(拖数, 5−胆数) × C(后区个数, 2)。
 * 后区基数必须按彩种取，不能写死 6 / 5（两彩种前区基数不同）。
 */
function dantuoFormula(p: TicketPlan) {
  const rule = RULES[store.lottery]
  const a = p.dans?.length ?? 0
  const b = p.tuos?.length ?? 0
  const m = p.backNums.length
  const head = `C(${b},${rule.frontCount - a})`
  return store.lottery === 'ssq'
    ? `${head} × ${m}`
    : `${head} × C(${m},${rule.backCount})`
}

const reason = computed(() => {
  const b = best.value
  if (!b) return ''
  return `均衡策略下它在「覆盖 ${b.metrics.coverage} 个号」与「中奖率 ${(b.metrics.pWin * 100).toFixed(1)}%」之间取得平衡，并优先把预算花满。`
})

/**
 * 期望回报旁那句解释：把「为什么全都一样」算给用户看。
 * 只有一种票型时没什么可比的，别硬说「N 种票型分钱不差」。
 */
const evNote = computed(() => {
  const one = singleBetEV(store.lottery)
  const n = ranked.value[0]?.bets ?? 0
  return `${n} 注 × 每注 ${money(one)} 元`
})

const evSame = computed(() => {
  const n = ranked.value.length
  const tail = `都来自同一个恒等式：${evNote.value}`
  if (n <= 1) return `这个金额下只凑得出这一种票型，${tail}。`
  return `${n} 种票型分钱不差，${tail}。`
})

const pad = (n: number) => String(n).padStart(2, '0')
const pct = (v: number) => (v * 100).toFixed(1) + '%'
const money = (v: number) => v.toFixed(2)

function copy() {
  const b = best.value
  if (!b) return
  const text = `${RULES[store.lottery].name} 第 ${store.nextIssue} 期\n${b.label} ${
    b.cost
  } 元\n${b.frontNums.map(pad).join(' ')} + ${b.backNums.map(pad).join(' ')}`
  navigator.clipboard?.writeText(text)
  alert('票面已复制')
}
</script>
