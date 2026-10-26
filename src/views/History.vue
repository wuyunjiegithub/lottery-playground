<template>
  <div>
    <div class="card mb-3">
      <div class="ct"><h3>数据概况</h3><span class="tag">离线数据包</span></div>
      <div class="grid grid-cols-3 gap-2">
        <div class="kpi">
          <p>双色球</p><b>{{ ssqCount }}</b>
          <span class="text-[9.5px] text-slate-500">2003 → 至今</span>
        </div>
        <div class="kpi">
          <p>大乐透</p><b>{{ dltCount }}</b>
          <span class="text-[9.5px] text-slate-500">2007 → 至今</span>
        </div>
        <div class="kpi">
          <p>当前</p><b class="text-[13px]">{{ RULES[store.lottery].name }}</b>
          <span class="text-[9.5px] text-slate-500">{{ store.history.length }} 期</span>
        </div>
      </div>
    </div>

    <div class="card mb-3">
      <div class="ct">
        <h3>数据更新</h3>
        <span class="tag">{{ store.modeText }}</span>
      </div>
      <button
        v-if="store.canLive"
        class="btn"
        :disabled="store.updating"
        @click="onUpdate"
      >
        {{ store.updating ? '拉取中…' : '检查最新开奖' }}
      </button>
      <div v-else class="text-[11px] text-slate-500 leading-relaxed">
        浏览器受同源策略限制，无法直连官方接口（官方接口无 CORS 头）。
        网页版请用数据包：运行抓取脚本生成 JSON 后导入，或改用桌面端 / APK。
      </div>
      <p v-if="store.updateMsg" class="text-[11px] text-slate-400 mt-2">{{ store.updateMsg }}</p>
    </div>

    <!-- 筛选 -->
    <div class="card mb-3">
      <div class="ct">
        <h3>筛选</h3>
        <span class="tag">命中 {{ filtered.length }} 期</span>
      </div>
      <input
        v-model="search"
        class="w-full bg-ink-700 border border-ink-500 rounded px-2.5 py-1.5 text-[12px] text-slate-200 outline-none focus:border-rose-500 mb-2"
        placeholder="搜索期号或日期，如 2024010 或 2024-01"
      />
      <div class="flex items-center gap-2 mb-2">
        <input v-model="dateFrom" type="date" class="flex-1 bg-ink-700 border border-ink-500 rounded px-2 py-1.5 text-[12px] text-slate-200 outline-none focus:border-rose-500" />
        <span class="text-slate-500">~</span>
        <input v-model="dateTo" type="date" class="flex-1 bg-ink-700 border border-ink-500 rounded px-2 py-1.5 text-[12px] text-slate-200 outline-none focus:border-rose-500" />
      </div>
      <div class="flex gap-1.5 flex-wrap">
        <button
          v-for="n in recentOpts"
          :key="n"
          class="px-2.5 py-1 rounded-full text-[11px] border transition"
          :class="recentN === n ? 'text-white border-transparent' : 'border-ink-500 text-slate-400 bg-ink-700'"
          :style="recentN === n ? 'background: linear-gradient(135deg,#ff5b5e,#e0313c)' : ''"
          @click="recentN = n"
        >
          {{ n === 0 ? '全部' : n + ' 期' }}
        </button>
      </div>
      <button class="text-[10px] text-slate-500 mt-2 underline" @click="resetFilter">重置筛选</button>
    </div>

    <!-- 开奖列表（全量分页，每行含奇偶/大小比） -->
    <div class="card mb-3">
      <div class="ct">
        <h3>开奖列表</h3>
        <span class="tag">共 {{ listAll.length }} 期 · 第 {{ curListPage }}/{{ listPages }} 页</span>
      </div>
      <div class="overflow-x-auto">
        <table class="pt w-full">
          <thead>
            <tr>
              <th>期号</th>
              <th>日期</th>
              <th>前区</th>
              <th>后区</th>
              <th class="text-center">奇偶(前)</th>
              <th class="text-center">大小(前)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in pageRows" :key="d.issue">
              <td class="font-mono text-slate-300">{{ d.issue }}</td>
              <td class="text-slate-500">{{ d.date || '—' }}</td>
              <td>
                <div class="flex gap-1 flex-wrap">
                  <span v-for="n in d.front" :key="'f' + n" class="ball ball-r ball-sm">{{ pad(n) }}</span>
                </div>
              </td>
              <td>
                <div class="flex gap-1 flex-wrap">
                  <span v-for="n in d.back" :key="'b' + n" class="ball ball-b ball-sm">{{ pad(n) }}</span>
                </div>
              </td>
              <td class="text-center font-mono text-[11px]">{{ parityOf(d.front) }}</td>
              <td class="text-center font-mono text-[11px]">{{ sizeOf(d.front) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- 分页 -->
      <div class="flex items-center justify-between mt-3 gap-2 flex-wrap">
        <div class="flex items-center gap-1.5 text-[11px] text-slate-500">
          <span>每页</span>
          <select v-model.number="listSize" class="bg-ink-700 border border-ink-500 rounded px-1 py-1 text-slate-200">
            <option :value="30">30</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
          <span>期</span>
        </div>
        <div class="flex items-center gap-1">
          <button class="pager" :disabled="curListPage <= 1" @click="listPage = 1">«</button>
          <button class="pager" :disabled="curListPage <= 1" @click="listPage = curListPage - 1">‹ 上一页</button>
          <span class="px-2 text-[11px] text-slate-400">{{ curListPage }} / {{ listPages }}</span>
          <button class="pager" :disabled="curListPage >= listPages" @click="listPage = curListPage + 1">下一页 ›</button>
          <button class="pager" :disabled="curListPage >= listPages" @click="listPage = listPages">»</button>
        </div>
      </div>
    </div>

    <!-- 冷热号（前区） -->
    <div class="card mb-3">
      <div class="ct"><h3>{{ RULES[store.lottery].name }}前区 · 冷热号</h3><span class="tag">{{ filtered.length }} 期</span></div>
      <div class="grid grid-cols-9 gap-y-2 gap-x-1">
        <div v-for="b in frontBars" :key="b.n" class="text-center">
          <div
            class="text-[10px]"
            :class="b.isHot ? 'text-rose-400 font-bold' : b.isCold ? 'text-sky-400 font-bold' : 'text-slate-400'"
          >{{ b.n }}</div>
          <div class="h-1.5 rounded bg-ink-600 overflow-hidden mb-0.5">
            <i class="block h-full rounded" :style="`width:${b.w}%;background:hsl(${b.hue},65%,55%)`"></i>
          </div>
          <div
            class="text-[9px]"
            :class="b.isHot ? 'text-rose-400' : b.isCold ? 'text-sky-400' : 'text-slate-500'"
          >{{ b.freq }}</div>
        </div>
      </div>
      <p class="text-[10px] text-slate-500 mt-2">
        红字 = 最热 Top3（出现最多），蓝字 = 最冷 Top3；柱长按相对出现频率。
      </p>
    </div>

    <!-- 冷热号（后区） -->
    <div class="card mb-3">
      <div class="ct"><h3>{{ RULES[store.lottery].name }}后区 · 冷热号</h3><span class="tag">{{ filtered.length }} 期</span></div>
      <div class="grid grid-cols-8 gap-y-2 gap-x-1">
        <div v-for="b in backBars" :key="b.n" class="text-center">
          <div
            class="text-[10px]"
            :class="b.isHot ? 'text-rose-400 font-bold' : b.isCold ? 'text-sky-400 font-bold' : 'text-slate-400'"
          >{{ b.n }}</div>
          <div class="h-1.5 rounded bg-ink-600 overflow-hidden mb-0.5">
            <i class="block h-full rounded" :style="`width:${b.w}%;background:hsl(${b.hue},65%,55%)`"></i>
          </div>
          <div
            class="text-[9px]"
            :class="b.isHot ? 'text-rose-400' : b.isCold ? 'text-sky-400' : 'text-slate-500'"
          >{{ b.freq }}</div>
        </div>
      </div>
    </div>

    <!-- 奇偶 / 大小比（整体） -->
    <div class="card mb-3">
      <div class="ct"><h3>奇偶 / 大小比（整体）</h3></div>
      <div class="space-y-2">
        <div>
          <div class="flex justify-between text-[11px] mb-0.5"><span class="text-slate-400">奇数</span><span>{{ parity.odd }}（{{ parity.oddPct.toFixed(1) }}%）</span></div>
          <div class="h-2 rounded bg-ink-600 overflow-hidden"><i class="block h-full" :style="`width:${parity.oddPct}%;background:linear-gradient(90deg,#f5b944,#ffd77a)`"></i></div>
        </div>
        <div>
          <div class="flex justify-between text-[11px] mb-0.5"><span class="text-slate-400">偶数</span><span>{{ parity.even }}（{{ parity.evenPct.toFixed(1) }}%）</span></div>
          <div class="h-2 rounded bg-ink-600 overflow-hidden"><i class="block h-full" :style="`width:${parity.evenPct}%;background:linear-gradient(90deg,#6aa9ff,#9ecbff)`"></i></div>
        </div>
        <div>
          <div class="flex justify-between text-[11px] mb-0.5"><span class="text-slate-400">大号（≥{{ Math.floor(F / 2) + 1 }}）</span><span>{{ parity.big }}（{{ parity.bigPct.toFixed(1) }}%）</span></div>
          <div class="h-2 rounded bg-ink-600 overflow-hidden"><i class="block h-full" :style="`width:${parity.bigPct}%;background:linear-gradient(90deg,#ff5b5e,#e0313c)`"></i></div>
        </div>
        <div>
          <div class="flex justify-between text-[11px] mb-0.5"><span class="text-slate-400">小号（≤{{ Math.floor(F / 2) }}）</span><span>{{ parity.small }}（{{ parity.smallPct.toFixed(1) }}%）</span></div>
          <div class="h-2 rounded bg-ink-600 overflow-hidden"><i class="block h-full" :style="`width:${parity.smallPct}%;background:linear-gradient(90deg,#34d399,#6ee7b7)`"></i></div>
        </div>
      </div>
      <p class="text-[10px] text-slate-500 mt-2">大小以 {{ F }} 选 {{ FC }} 的中位 {{ (F / 2).toFixed(1) }} 为界；独立随机下奇偶比、大小比均趋近 1:1。</p>
    </div>

    <!-- 和值统计 -->
    <div class="card mb-3">
      <div class="ct"><h3>前区和值统计</h3><span class="tag">{{ sumStat.n }} 期</span></div>
      <div class="grid grid-cols-2 gap-2 text-[11px]">
        <div class="kpi"><p>均值</p><b>{{ sumStat.mean.toFixed(1) }}</b></div>
        <div class="kpi"><p>标准差</p><b>{{ sumStat.std.toFixed(1) }}</b></div>
        <div class="kpi"><p>方差</p><b>{{ sumStat.variance.toFixed(1) }}</b></div>
        <div class="kpi"><p>最小 / 最大</p><b>{{ sumStat.min }} / {{ sumStat.max }}</b></div>
      </div>
      <p class="text-[10px] text-slate-500 mt-2">理论均值 ≈ {{ (FC * (F + 1) / 2).toFixed(1) }}；实际均值贴近理论值属正常波动。</p>
    </div>

    <!-- 三区分布 -->
    <div class="card mb-3">
      <div class="ct"><h3>前区三区分布</h3></div>
      <div class="space-y-1.5">
        <div v-for="(z, i) in zones.counts" :key="i">
          <div class="flex justify-between text-[11px] mb-0.5">
            <span class="text-slate-400">{{ ['一区（低）', '二区（中）', '三区（高）'][i] }}</span>
            <span>{{ z }}（{{ zones.pct[i].toFixed(1) }}%）</span>
          </div>
          <div class="h-2 rounded bg-ink-600 overflow-hidden"><i class="block h-full" :style="`width:${zones.pct[i]}%;background:linear-gradient(90deg,#a78bfa,#c4b5fd)`"></i></div>
        </div>
      </div>
    </div>

    <!-- 重号 / 连号 -->
    <div class="card mb-3">
      <div class="ct"><h3>重号 / 连号</h3></div>
      <div class="grid grid-cols-2 gap-2 text-[11px]">
        <div class="kpi">
          <p>重号率</p><b>{{ repeatStat.avg.toFixed(2) }} 个/期</b>
          <span class="text-[9.5px] text-slate-500">{{ repeatStat.drawRate.toFixed(1) }}% 的期含重号</span>
        </div>
        <div class="kpi">
          <p>连号率</p><b>{{ consecStat.rate.toFixed(1) }}%</b>
          <span class="text-[9.5px] text-slate-500">{{ consecStat.draws }} 期含连号</span>
        </div>
      </div>
    </div>

    <!-- 当前遗漏 Top5 -->
    <div class="card mb-3">
      <div class="ct"><h3>前区当前遗漏 Top5</h3><span class="tag">距上次开出</span></div>
      <div class="flex flex-wrap gap-2">
        <div v-for="o in frontOmTop" :key="o.n" class="px-2 py-1 rounded bg-ink-700 text-[11px]">
          <span class="font-mono text-slate-300">{{ pad(o.n) }}</span>
          <span class="text-slate-500 ml-1">漏 {{ o.v }} 期</span>
        </div>
      </div>
    </div>

    <!-- 号码组合统计（单个 / 两两 / 三三，可排序） -->
    <div class="card mb-3">
      <div class="ct">
        <h3>号码组合统计</h3>
        <span class="tag">{{ filtered.length }} 期</span>
      </div>

      <!-- 前区 / 后区 -->
      <div class="flex gap-1.5 mb-2">
        <button
          v-for="z in zoneTabs"
          :key="z.k"
          class="px-3 py-1.5 rounded-full text-[11px] border transition"
          :class="comboZone === z.k ? 'text-white border-transparent' : 'border-ink-500 text-slate-400 bg-ink-700'"
          :style="comboZone === z.k ? 'background: linear-gradient(135deg,#ff5b5e,#e0313c)' : ''"
          @click="comboZone = z.k; comboTab = 'single'; comboPage = 1"
        >
          {{ z.t }}
        </button>
      </div>

      <!-- 单个 / 两两 / 三三（按该区每期出号个数动态给出） -->
      <div class="flex gap-1.5 mb-2">
        <button
          v-for="t in levels"
          :key="t.k"
          class="px-3 py-1.5 rounded-full text-[11px] border transition"
          :class="comboTab === t.k ? 'text-white border-transparent' : 'border-ink-500 text-slate-400 bg-ink-700'"
          :style="comboTab === t.k ? 'background: linear-gradient(135deg,#ff5b5e,#e0313c)' : ''"
          @click="comboTab = t.k; comboPage = 1"
        >
          {{ t.t }}
        </button>
      </div>

      <p class="text-[10px] text-slate-500 mb-2">
        统计{{ comboZone === 'front' ? '前区' : '后区' }}号码在本区间内的共同出现次数；点击表头可排序（号码 / 次数 / 遗漏），占比 = 出现期数 ÷ 总期数。
        <template v-if="comboZone === 'back' && levels.length === 1">
          （{{ RULES[store.lottery].name }}后区每期仅 1 个号，故只有「单个」。）
        </template>
        <template v-else-if="comboZone === 'back' && levels.length === 2">
          （{{ RULES[store.lottery].name }}后区每期 2 个号，故只有「单个 / 两两」。）
        </template>
      </p>
      <p class="text-[10px] text-slate-500 mb-2">
        「遗漏」= 距上一次开出的期数，按<b class="text-slate-400">完整历史</b>计算（不受上方筛选影响），0 表示上期刚出。
        遗漏只描述历史，与「该不该买」无关——彩票每期独立，同一个组合的遗漏不会积累成补偿。
      </p>

      <div class="overflow-x-auto">
        <table class="pt w-full">
          <thead>
            <tr>
              <th class="cursor-pointer select-none" @click="toggleSort('key'); comboPage = 1">
                号码 / 组合
                <span v-if="comboSort.by === 'key'" class="text-rose-400">{{ comboSort.asc ? '▲' : '▼' }}</span>
              </th>
              <th class="cursor-pointer select-none" @click="toggleSort('count'); comboPage = 1">
                次数
                <span v-if="comboSort.by === 'count'" class="text-rose-400">{{ comboSort.asc ? '▲' : '▼' }}</span>
              </th>
              <th>占比</th>
              <th class="cursor-pointer select-none" @click="toggleSort('omission'); comboPage = 1">
                遗漏
                <span v-if="comboSort.by === 'omission'" class="text-rose-400">{{ comboSort.asc ? '▲' : '▼' }}</span>
              </th>
              <th>上次开出</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in comboPageRows" :key="r.key">
              <td>
                <div class="flex gap-1 flex-wrap">
                  <span
                    v-for="(n, i) in r.nums"
                    :key="i"
                    class="ball ball-sm"
                    :class="comboZone === 'front' ? 'ball-r' : 'ball-b'"
                  >{{ pad(n) }}</span>
                </div>
              </td>
              <td class="font-mono">{{ r.count }}</td>
              <td class="font-mono text-slate-500">{{ pct(r.count) }}</td>
              <td class="font-mono" :class="omClass(r.omission)">
                {{ r.omission < 0 ? '—' : r.omission }}
              </td>
              <td class="font-mono text-slate-500">{{ r.lastIssue || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="flex items-center justify-between mt-3">
        <span class="text-[10px] text-slate-500">共 {{ comboRows.length }} 条</span>
        <div class="flex items-center gap-1">
          <button class="pager" :disabled="comboPage <= 1" @click="comboPage = 1">«</button>
          <button class="pager" :disabled="comboPage <= 1" @click="comboPage = comboPage - 1">‹</button>
          <span class="px-2 text-[11px] text-slate-400">{{ comboPage }} / {{ comboPages }}</span>
          <button class="pager" :disabled="comboPage >= comboPages" @click="comboPage = comboPage + 1">›</button>
          <button class="pager" :disabled="comboPage >= comboPages" @click="comboPage = comboPages">»</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useMainStore } from '../stores/main'
import { RULES } from '../core/lottery'
import { freq, omission } from '../core/models/types'
import { lastSeen, comboCounts, NEVER } from '../core/comboStats'
import type { ComboLevel, LastSeen } from '../core/comboStats'
import type { Draw } from '../types'

const store = useMainStore()

// ---------------- 筛选 ----------------
const search = ref('')
const dateFrom = ref('')
const dateTo = ref('')
const recentN = ref(0)
const recentOpts = [30, 50, 100, 200, 0]

function resetFilter() {
  search.value = ''
  dateFrom.value = ''
  dateTo.value = ''
  recentN.value = 0
}

const filtered = computed<Draw[]>(() => {
  let arr = store.history
  if (recentN.value > 0) arr = arr.slice(-recentN.value)
  const from = dateFrom.value.trim()
  const to = dateTo.value.trim()
  if (from) arr = arr.filter((d) => (d.date || '') >= from)
  if (to) arr = arr.filter((d) => (d.date || '') <= to)
  const q = search.value.trim()
  if (q) arr = arr.filter((d) => d.issue.includes(q) || (d.date || '').includes(q))
  return arr
})

// ---------------- 基础量 ----------------
const F = computed(() => RULES[store.lottery].frontMax)
const B = computed(() => RULES[store.lottery].backMax)
const FC = computed(() => RULES[store.lottery].frontCount)
const mid = computed(() => F.value / 2)

const ssqCount = computed(() => store.draws.filter((d) => d.lottery === 'ssq').length)
const dltCount = computed(() => store.draws.filter((d) => d.lottery === 'dlt').length)
const pad = (n: number) => String(n).padStart(2, '0')

async function onUpdate() {
  const r = await store.updateData()
  if (!r.ok) alert(r.msg)
}

// ---------------- 开奖列表（全量分页） ----------------
const listSize = ref(30)
const listPage = ref(1)
const listAll = computed(() => filtered.value.slice().reverse()) // 最新一期在上
const listPages = computed(() => Math.max(1, Math.ceil(listAll.value.length / listSize.value)))
const curListPage = computed(() => Math.min(Math.max(1, listPage.value), listPages.value))
const pageRows = computed(() => {
  const s = (curListPage.value - 1) * listSize.value
  return listAll.value.slice(s, s + listSize.value)
})

function parityOf(front: number[]) {
  let o = 0
  for (const x of front) if (x % 2 === 1) o++
  return `${o}:${front.length - o}`
}
function sizeOf(front: number[]) {
  let b = 0
  for (const x of front) if (x > mid.value) b++
  return `${b}:${front.length - b}`
}

// ---------------- 统计计算 ----------------
function topSet(arr: number[], k: number): Set<number> {
  return new Set(arr.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, k).map((o) => o.i))
}
function botSet(arr: number[], k: number): Set<number> {
  return new Set(arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v).slice(0, k).map((o) => o.i))
}

const frontFreq = computed(() => freq(filtered.value, F.value, 'front'))
const backFreq = computed(() => freq(filtered.value, B.value, 'back'))
const frontOm = computed(() => omission(filtered.value, F.value, 'front'))
const backOm = computed(() => omission(filtered.value, B.value, 'back'))

function bars(f: number[], om: number[]) {
  const max = Math.max(1, ...f)
  const min = Math.min(...f)
  const hot = topSet(f, 3)
  const cold = botSet(f, 3)
  return f.map((v, i) => {
    const heat = max === min ? 0.5 : (v - min) / (max - min)
    return {
      n: i + 1,
      freq: v,
      w: (v / max) * 100,
      hue: 210 - heat * 210,
      isHot: hot.has(i),
      isCold: cold.has(i),
      om: om[i],
    }
  })
}
const frontBars = computed(() => bars(frontFreq.value, frontOm.value))
const backBars = computed(() => bars(backFreq.value, backOm.value))

const frontOmTop = computed(() =>
  frontOm.value
    .map((v, i) => ({ n: i + 1, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 5)
)

const parity = computed(() => {
  let odd = 0, even = 0, big = 0, small = 0
  const m = F.value / 2
  for (const d of filtered.value) {
    for (const x of d.front) {
      if (x % 2 === 1) odd++
      else even++
      if (x > m) big++
      else small++
    }
  }
  const tot = odd + even || 1
  return {
    odd, even, big, small,
    oddPct: (odd / tot) * 100,
    evenPct: (even / tot) * 100,
    bigPct: (big / tot) * 100,
    smallPct: (small / tot) * 100,
  }
})

const sumStat = computed(() => {
  const arr = filtered.value.map((d) => d.front.reduce((a, b) => a + b, 0))
  if (!arr.length) return { mean: 0, variance: 0, std: 0, min: 0, max: 0, n: 0 }
  const n = arr.length
  const mean = arr.reduce((a, b) => a + b, 0) / n
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  return { mean, variance, std: Math.sqrt(variance), min: Math.min(...arr), max: Math.max(...arr), n }
})

const zones = computed(() => {
  const f = frontFreq.value
  const z = [0, 0, 0]
  const span = F.value / 3
  for (let i = 0; i < f.length; i++) {
    const zi = Math.min(2, Math.floor(i / span))
    z[zi] += f[i]
  }
  const tot = z.reduce((a, b) => a + b, 0) || 1
  return { counts: z, pct: z.map((v) => (v / tot) * 100) }
})

const repeatStat = computed(() => {
  let total = 0, pairs = 0, withRepeat = 0
  for (let i = 1; i < filtered.value.length; i++) {
    const prev = new Set(filtered.value[i - 1].front)
    let c = 0
    for (const x of filtered.value[i].front) if (prev.has(x)) c++
    total += c
    pairs++
    if (c > 0) withRepeat++
  }
  return {
    avg: pairs ? total / pairs : 0,
    drawRate: pairs ? (withRepeat / pairs) * 100 : 0,
  }
})

const consecStat = computed(() => {
  let conn = 0
  for (const d of filtered.value) {
    const a = [...d.front].sort((x, y) => x - y)
    for (let i = 1; i < a.length; i++) {
      if (a[i] - a[i - 1] === 1) { conn++; break }
    }
  }
  return {
    rate: filtered.value.length ? (conn / filtered.value.length) * 100 : 0,
    draws: conn,
  }
})

// ---------------- 号码组合统计 ----------------
interface ComboRow {
  key: string
  nums: number[]
  count: number
  /** 距上次出现的期数；-1 = 全部历史中从未出现 */
  omission: number
  /** 上次出现的期号；从未出现为空串 */
  lastIssue: string
}
type SortBy = 'count' | 'key' | 'omission'

const comboTab = ref<ComboLevel>('single')
const comboZone = ref<'front' | 'back'>('front')
const comboSort = ref<{ by: SortBy; asc: boolean }>({ by: 'count', asc: false })
const comboSize = ref(50)
const comboPage = ref(1)

const zoneTabs: { k: 'front' | 'back'; t: string }[] = [
  { k: 'front', t: '前区' },
  { k: 'back', t: '后区' },
]

const BC = computed(() => RULES[store.lottery].backCount)
/** 当前区每期出号个数：前区 ssq=6 / dlt=5，后区 ssq=1 / dlt=2 */
const zoneCount = computed(() => (comboZone.value === 'front' ? FC.value : BC.value))
/** 档位：单个恒定；两两需每期≥2 个号；三三需每期≥3 个号 */
const levels = computed<{ k: ComboLevel; t: string }[]>(() => {
  const n = zoneCount.value
  const arr: { k: ComboLevel; t: string }[] = [{ k: 'single', t: '单个号码' }]
  if (n >= 2) arr.push({ k: 'pair', t: '两两组合' })
  if (n >= 3) arr.push({ k: 'triple', t: '三三组合' })
  return arr
})

/**
 * 组合 / 号码的「上次出现」位置。
 *
 * 刻意基于 **完整历史** 而不是筛选区间：遗漏回答的是「距上一次开出过了几期」，
 * 这是当前状态的量，一旦按筛选区间算，筛成「近 30 期」就会把所有组合的遗漏
 * 截断在 30 以内，统计量失去意义。次数 / 占比仍然按筛选区间统计。
 * 返回 -1 表示全历史从未出现（此时 lastIssue 为空串）。
 */
function lastSeenIn(
  hist: Draw[],
  field: 'front' | 'back',
  need: ComboLevel
): Map<string, LastSeen> {
  const size = field === 'front' ? F.value : B.value
  return lastSeen(hist, field, need, size)
}

/** 当前区 + 当前档位的全部组合、出现次数与遗漏 */
const combosAll = computed<ComboRow[]>(() => {
  const field = comboZone.value
  const size = field === 'front' ? F.value : B.value
  const need = comboTab.value
  const last = lastSeenIn(store.history, field, need)
  const cnt = comboCounts(filtered.value, field, need, size)
  const rows: ComboRow[] = []
  for (const [key, count] of cnt) {
    const hit = last.get(key)
    rows.push({
      key,
      nums: need === 'single' ? [Number(key)] : key.split('-').map(Number),
      count,
      omission: hit ? hit.omission : NEVER.omission,
      lastIssue: hit ? hit.issue : '',
    })
  }
  return rows
})

const comboRows = computed<ComboRow[]>(() => {
  const arr = combosAll.value.slice()
  const s = comboSort.value
  arr.sort((a, b) => {
    if (s.by === 'count') return s.asc ? a.count - b.count : b.count - a.count
    if (s.by === 'omission') {
      // 「从未出现」(-1) 恒定排最后，两个方向都一样 —— 它不是一个「遗漏很大」的值，
      // 混进数值排序会让「越久没出越靠前」的读法失效。
      if (a.omission < 0) return b.omission < 0 ? 0 : 1
      if (b.omission < 0) return -1
      // asc=false（表头 ▼）= 遗漏从大到小，与 count / key 分支的方向语义保持一致
      return s.asc ? a.omission - b.omission : b.omission - a.omission
    }
    for (let i = 0; i < a.nums.length; i++) {
      if (a.nums[i] !== b.nums[i]) return s.asc ? a.nums[i] - b.nums[i] : b.nums[i] - a.nums[i]
    }
    return 0
  })
  return arr
})
const comboPages = computed(() => Math.max(1, Math.ceil(comboRows.value.length / comboSize.value)))
const comboPageRows = computed(() => {
  const s = (Math.min(Math.max(1, comboPage.value), comboPages.value) - 1) * comboSize.value
  return comboRows.value.slice(s, s + comboSize.value)
})

function toggleSort(by: SortBy) {
  const s = comboSort.value
  if (s.by === by) s.asc = !s.asc
  else {
    s.by = by
    // 切到「遗漏」时默认按遗漏从大到小（最久没出排最前），符合直觉
    s.asc = false
  }
}

function pct(count: number) {
  const n = filtered.value.length
  return n ? ((count / n) * 100).toFixed(1) + '%' : '0%'
}

/** 遗漏越大越偏「冷」，用蓝色梯度表示；0 / 未出现走灰色，不做任何价值暗示 */
function omClass(om: number) {
  if (om < 0) return 'text-slate-600'
  if (om === 0) return 'text-slate-500'
  if (om >= 30) return 'text-sky-400 font-semibold'
  if (om >= 10) return 'text-sky-300'
  return 'text-slate-300'
}

// 筛选 / 换彩种 / 改每页条数时回到第一页
watch([filtered, listSize, () => store.lottery], () => {
  listPage.value = 1
  comboPage.value = 1
})
</script>

<style scoped>
.pager {
  @apply px-2.5 py-1 rounded bg-ink-600 border border-ink-500 text-[11px] text-slate-300;
}
.pager:disabled {
  @apply opacity-40 cursor-not-allowed;
}
</style>
