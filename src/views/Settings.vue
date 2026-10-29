<template>
  <div>
    <div class="card mb-3">
      <div class="ct"><h3>玄学档案</h3><span class="tag">仅存本机 · 改完即存</span></div>
      <p class="text-[11px] text-slate-500 leading-relaxed mb-3">
        八字、星座、姓名笔画等模型需要个人信息。这些信息<b class="text-amber-400">只在本机参与计算，永不上送</b>。
        <b class="text-slate-400">改动即时生效并写入本机</b>，不用点保存；不想要了随时清空。
        日期驱动的玄学模型（干支、五行、黄历等）不需要任何输入。
      </p>

      <label class="block text-[12px] text-slate-400 mb-1">出生日期</label>
      <input
        v-model="store.profile.birthDate"
        type="date"
        class="w-full bg-ink-600 border border-ink-500 rounded-lg px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-red-500 mb-3"
      />

      <label class="block text-[12px] text-slate-400 mb-1">性别（紫微排盘用）</label>
      <div class="flex gap-2 mb-3">
        <button
          v-for="g in GENDERS"
          :key="g.k"
          class="flex-1 py-2 rounded-lg text-[13px] border transition"
          :class="store.profile.gender === g.k ? 'border-red-500 text-red-400 bg-red-500/10' : 'border-ink-500 text-slate-400 bg-ink-600'"
          @click="store.profile.gender = g.k"
        >
          {{ g.t }}
        </button>
      </div>

      <label class="block text-[12px] text-slate-400 mb-1">姓名（姓名笔画用，建议繁体）</label>
      <input
        v-model="store.profile.name"
        type="text"
        placeholder="如：王小明"
        class="w-full bg-ink-600 border border-ink-500 rounded-lg px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-red-500"
      />
    </div>

    <div class="card mb-3">
      <div class="ct"><h3>每期预算</h3><span class="tag">在档案里统一设置</span></div>
      <!--
        预算档位固定 7 列。
        之前用 grid-cols-5，7 个档位除不尽 -> 第一行 5 个、第二行 2 个，右边空一大块；
        改成 flex-grow 又会让两行的列宽不一致（4 个一行 vs 3 个一行），竖着也对不齐。
        固定 7 列 = 永远一行，且每一列的宽度在任何断点下都相同。
      -->
      <div class="grid grid-cols-7 gap-1.5 mb-3">
        <button
          v-for="b in BUDGETS"
          :key="b"
          class="border rounded-xl py-2 text-center transition"
          :class="
            store.budget === b
              ? 'border-red-500 bg-red-500/10'
              : 'border-ink-500 bg-ink-600'
          "
          @click="store.budget = b"
        >
          <b class="block text-[13px]" :class="store.budget === b ? 'text-red-400' : ''">{{ b }}</b>
          <span class="text-[9.5px] text-slate-500">元</span>
        </button>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <span class="text-[12px] text-slate-400 shrink-0">自定义</span>
        <input
          v-model.number="store.budget"
          type="number"
          min="2"
          step="2"
          class="w-[120px] shrink-0 bg-ink-600 border border-ink-500 rounded-lg px-2 py-1.5 text-center text-[13px] text-slate-100 outline-none focus:border-red-500"
          @change="clampBudget"
        />
        <span class="text-[12px] text-slate-400 shrink-0">元 / 期</span>
      </div>
      <p class="text-[10px] text-slate-500 mb-3 leading-relaxed" v-if="fit.bets">
        票面金额 = 注数 × {{ price }} 元，所以只有<b class="text-slate-400">{{ price }} 的整数倍</b>金额能正好花满。
        <template v-if="fit.exact">
          当前正好 <b class="text-red-400">{{ fit.bets }} 注 {{ fit.cost }} 元</b>。
        </template>
        <template v-else>
          {{ store.budget }} 元不是 {{ price }} 的整数倍，凑不出整数注，实际出
          <b class="text-red-400">{{ fit.bets }} 注 {{ fit.cost }} 元</b>，
          余下 {{ store.budget - fit.cost }} 元。
        </template>
      </p>
    </div>

    <button class="btn-ghost text-red-400" @click="onResetAll">清空全部本地数据（含回测结果）</button>

    <p class="text-[10px] text-slate-500 mt-2.5 leading-relaxed">
      「全部本地数据」＝ 玄学档案 + 收藏 + 开奖历史缓存 + <b class="text-slate-400">回测结果</b>。
      开奖历史下次启动会从内置数据包自动灌回，<b class="text-slate-400">回测结果只能重跑</b>。
      <template v-if="store.boardInfo">
        当前这份是 {{ store.boardInfo.periods }} 期 × {{ store.boardInfo.modelCount }} 个模型，
        实跑用了 {{ fmtDur(store.boardInfo.durationMs) }}。
      </template>
    </p>

    <p class="disc mt-3">
      再次提醒：彩票开奖为独立随机事件。本系统所有模型的长期表现与随机选号无统计显著差异，回测看板会如实展示这一结论。
    </p>
  </div>
</template>

<script setup lang="ts">
import { watch, computed } from 'vue'
import { useMainStore } from '../stores/main'
import { budgetFit } from '../core/ticket'
import { RULES } from '../core/lottery'

const store = useMainStore()
const BUDGETS = [10, 30, 50, 100, 200, 300, 500]
/** as const：让 g.k 是 'm' | 'f' 而不是 string，直接赋给 profile.gender 才过得了类型 */
const GENDERS = [
  { k: 'm', t: '男' },
  { k: 'f', t: '女' },
] as const

/**
 * 改即存。原来这里维护一份本地副本 `p`，要用户点「保存档案」才写回 store，
 * 多一次操作不说，还多一份「改了没保存」的状态要解释。
 * 现在直接绑 store，任何输入立刻落盘（store 里的 budget 自带 persist，
 * profile 没有 watcher，所以这里补一个深监听）。
 */
watch(
  () => store.profile,
  () => store.persist(),
  { deep: true }
)

/** 输入框直接绑了预算，得挡一下 0 和负数（票面最小 2 元） */
function clampBudget() {
  const v = Math.round(Number(store.budget))
  store.budget = Number.isFinite(v) && v >= 2 ? v : 2
}

const fit = computed(() => budgetFit(store.lottery, store.budget))
/** 单注票价。写死 2 元在加彩种那天就会变成错的，从 RULES 取 */
const price = computed(() => RULES[store.lottery].price)

function fmtDur(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${s % 60} 秒`
}

/**
 * 清库前把代价写在弹窗里：这一步会连回测账本一起端掉，
 * 而回测是全量 78 模型实跑十几分钟的活，删掉就得原样再跑一遍。
 * 用户明确要过：只留这一个清空入口，不再做「只清档案」的细分按钮。
 */
function onResetAll() {
  const b = store.boardInfo
  const cost = b
    ? `\n\n当前这份回测（${b.periods} 期 × ${b.modelCount} 个模型）实跑用了 ${fmtDur(b.durationMs)}，删掉就要原样再跑一遍。`
    : ''
  const msg =
    '将清空本机全部数据：\n· 玄学档案\n· 收藏的模型\n· 开奖历史缓存（下次启动自动重新灌入）\n· 回测结果' +
    cost +
    '\n\n确定？'
  if (!confirm(msg)) return
  store.resetAll()
  alert('已清空')
}
</script>
