<template>
  <div>
    <!-- 真相卡片 -->
    <div
      class="mb-3 rounded-2xl p-4 border border-red-500/30"
      style="background: linear-gradient(135deg, rgba(255, 77, 79, 0.1), rgba(245, 185, 68, 0.06))"
    >
      <h4 class="text-[12.5px] text-red-400 mb-2 flex items-center gap-1.5">
        <span class="w-1.5 h-1.5 rounded-full bg-red-400"></span>真相卡片 · 实验结论
      </h4>
      <p v-if="!store.board.length" class="text-[11.5px] text-slate-400 leading-relaxed">
        点下方按钮跑一次回测，系统会用置换检验告诉你：这些模型到底有没有一个能打过随机。
      </p>
      <p v-else class="text-[11.5px] text-slate-300 leading-relaxed">
        回测 <b class="text-amber-400">{{ boardPeriods }}</b> 期，共
        <b class="text-amber-400">{{ store.board.length }}</b> 个模型，其中
        <b class="text-amber-400">{{ noDiff }}</b> 个的收益率与随机基线（B01）
        <b class="text-red-400">无显著差异</b>（p &gt; 0.05）。<br />
        结论：历史数据无法预测未来开奖。
      </p>
      <!--
        多重比较的坑必须自己说出来。只报「N 个无显著差异」会让人反过来读：
        「那剩下的就是有本事的」——恰恰相反，跑 77 组比较按 5% 门槛
        平均本来就会撞出约 4 个假阳性。
      -->
      <p v-if="cmpCount" class="text-[10.5px] text-slate-500 leading-relaxed mt-1.5" data-multiple>
        <template v-if="sigCount">
          另有 <b class="text-amber-400">{{ sigCount }}</b> 个跑出了 p ≤ 0.05，但这不代表它们有本事：
        </template>
        <template v-else>
          这一轮连一个 p ≤ 0.05 都没出现。即便出现也不代表有本事：
        </template>
        同时做 <b class="text-slate-400">{{ cmpCount }}</b> 组比较，按 5% 的门槛平均本就会撞出约
        <b class="text-slate-400">{{ falsePos }}</b> 个「看起来显著」的 —— 那是掷骰子掷出来的，不是规律。
      </p>
    </div>

    <!-- 进度 -->
    <div
      v-if="busy || store.progress.phase === 'cancelled' || store.progress.phase === 'error'"
      class="card mb-3"
    >
      <div class="ct">
        <h3>{{ busy ? '回测进行中' : store.progress.phase === 'error' ? '回测出错' : '已停止' }}</h3>
      </div>

      <template v-if="busy">
        <div class="flex items-end justify-between mb-2">
          <div class="text-[11px] text-slate-400">
            <span class="text-slate-300">{{ phaseText }}</span>
            <span class="block text-[10px] text-slate-500 mt-0.5">
              第 {{ donePeriod }} / {{ prog.periodCount }} 期 · 当前模型
              {{ prog.currentModelName || '—' }}
            </span>
          </div>
          <b class="text-[20px] font-mono text-amber-400 leading-none">{{ pctNum }}%</b>
        </div>

        <div class="h-2.5 rounded-full bg-ink-500 overflow-hidden">
          <div
            class="h-full rounded-full transition-[width] duration-200 ease-out"
            :style="{ width: pctNum + '%', background: 'linear-gradient(90deg,#ff5b5e,#f5b944)' }"
          ></div>
        </div>

        <div class="flex justify-between text-[10px] text-slate-500 mt-1.5">
          <span>已用 {{ fmtDur(prog.elapsedMs) }}</span>
          <span v-if="prog.etaMs > 800" data-eta>预计还需 {{ fmtDur(prog.etaMs) }}</span>
          <span v-else>即将完成…</span>
        </div>

        <!--
          把「实时速率外推的全程总时长」摆出来，和点开跑那一刻的预估对照。
          之前只有「预计还需」，于是页面上同时存在「参数区 18 分钟 / 进度条 80 分钟」
          两个打架的数字，用户当然觉得预估是错的。
        -->
        <p v-if="liveTotalMs" class="text-[10.5px] text-slate-300 mt-2 leading-relaxed" data-live-total>
          按当前速率，这套设置全程约 <b class="text-amber-400">{{ fmtDur(liveTotalMs) }}</b>{{ driftText }}
          —— 已自动校正本机预估。
        </p>

        <p v-if="prog.incrementalPeriods > 0" class="text-[10.5px] text-emerald-500 mt-2" data-incremental>
          本次只补算新增的 {{ prog.incrementalPeriods }} 期，前 {{ store.boardInfo?.upTo }} 期沿用上次结果。
        </p>

        <p class="text-[10px] text-slate-600 mt-1.5 leading-relaxed">
          剩余时间按当前实际速率折算，比开跑前的预估准；别把这个标签页切到后台，
          浏览器会给后台页降频，可能慢上好几倍。
        </p>

        <button class="btn-ghost mt-2.5 w-full" @click="store.cancelRun()">停止回测</button>
      </template>

      <p v-else class="text-[11.5px]" :class="store.progress.phase === 'error' ? 'text-red-400' : 'text-slate-400'">
        {{ store.progress.message }}
      </p>
    </div>

    <!-- 控制 -->
    <div class="card mb-3">
      <div class="ct">
        <h3>回测参数</h3>
        <span class="tag">{{ RULES[store.lottery].name }} · 共 {{ total }} 期</span>
      </div>

      <label class="block text-[12px] text-slate-400 mb-1">训练集（前若干期只喂给模型，不结算）</label>
      <input
        v-model.number="sample"
        type="number"
        :min="60"
        :max="maxSample"
        step="100"
        class="w-full bg-ink-600 border border-ink-500 rounded-lg px-2 py-1.5 text-center text-[13px] text-slate-100 outline-none focus:border-red-500 mb-1.5"
      />
      <div class="flex gap-1.5 mb-3">
        <button
          v-for="p in PRESETS"
          :key="p.sample"
          class="flex-1 py-1.5 rounded-lg text-[11px] border transition"
          :class="sample === p.sample ? 'border-red-500 text-red-400 bg-red-500/10' : 'border-ink-500 text-slate-400 bg-ink-600'"
          @click="sample = p.sample"
        >
          样本 {{ p.sample }}
          <span class="block text-[9px] opacity-70">约 {{ fmtDur(estAt(p.sample)) }}</span>
        </button>
        <button
          class="flex-1 py-1.5 rounded-lg text-[11px] border transition"
          :class="!PRESETS.some((p) => p.sample === sample) ? 'border-red-500 text-red-400 bg-red-500/10' : 'border-ink-500 text-slate-400 bg-ink-600'"
          @click="sample = maxSample"
        >
          全部历史
          <span class="block text-[9px] opacity-70">约 {{ fmtDur(estAllMs) }}</span>
        </button>
      </div>

      <div class="rounded-lg bg-ink-600 border border-ink-500 px-2.5 py-2 mb-3 text-[11px] leading-relaxed">
        <div class="text-slate-300">
          回测窗口 <b class="text-amber-400">{{ periods }}</b> 期（第 {{ sample + 1 }} ~ {{ total }} 期），
          <b class="text-slate-300">{{ modelCount }}</b> 个模型
        </div>
        <div class="text-slate-500 mt-0.5">
          规模约 <b class="text-slate-300">{{ unitsText }}</b> 个计算单元 · 预算
          <b class="text-slate-300">{{ store.budget }}</b> 元
        </div>

        <div v-if="store.dataAdded > 0" class="mt-1 text-emerald-500">
          本次启动已自动拉取最新数据，新增 {{ store.dataAdded }} 期。
        </div>

        <div v-if="plan.mode === 'cache'" class="mt-1 text-emerald-500" data-plan-cache>
          这套设置已经算到第 {{ plan.upTo }} 期且历史没有更新，点一下直接读本地库，秒开。
        </div>
        <div v-else-if="plan.mode === 'extend'" class="mt-1 text-amber-400" data-plan-extend>
          上次已算到第 {{ plan.upTo }} 期。<b>这次只补算新增的 {{ plan.extend }} 期</b>
          （约 {{ fmtDur(estExtendMs) }}），前面的一律沿用旧结果 —— 逐位等价，攒几分钟的重算全省了。
        </div>
        <div v-else class="mt-1 text-slate-500" data-plan-full>
          本机这套设置约需 <b class="text-slate-400">{{ fmtDur(estFullMs) }}</b>
          <template v-if="!estConfident">（未校准，只能当量级看）</template>。
        </div>
        <!-- 这份说明在三种模式下都在：即使是直接读缓存的模式，用户也可能点下面的「完全重算」 -->
        <div class="mt-0.5 text-[10px] text-slate-600" data-est-note>
          耗时预估 · {{ estNote }}。实际耗时取决于设备，标签页切到后台还会被浏览器降频；
          开跑后进度条上的剩余时间按<b class="text-slate-500">实时速率</b>折算，比这个准。
        </div>

        <div v-if="store.boardInfo?.durationMs && plan.mode !== 'cache'" class="mt-0.5 text-slate-500">
          参考：上次（{{ store.boardInfo.periods }} 期 × {{ store.boardInfo.modelCount }} 模型）实跑用了
          <b class="text-slate-400">{{ fmtDur(store.boardInfo.durationMs) }}</b>。
        </div>
      </div>

      <!-- 重型模型说明整块删掉了：那是给人解释「为什么全跑」的，用户明确说没必要显示 -->
      <button class="btn" :disabled="busy" @click="run(false)" data-run-btn>
        {{
          busy
            ? '回测中…'
            : plan.mode === 'cache'
              ? `读取缓存（${modelCount} 个模型）`
              : plan.mode === 'extend'
                ? `增量补算新增 ${plan.extend} 期（约 ${fmtDur(estExtendMs)}）`
                : `开始回测（${modelCount} 个模型，约 ${fmtDur(estFullMs)}）`
        }}
      </button>
      <button class="btn-ghost mt-2" :disabled="busy" @click="run(true)">
        清除缓存并完全重算
      </button>
      <p v-if="lastCached !== null && !busy" class="text-[10.5px] text-slate-500 mt-2">
        {{ lastCached ? '本次结果来自本地缓存，未重新计算。' : '本次为实算结果，已永久写入本地库。' }}
      </p>
      <p
        v-else-if="store.progress.phase === 'done' && store.progress.message"
        class="text-[10.5px] text-emerald-500 mt-2"
      >
        {{ store.progress.message }}
      </p>
    </div>

    <!-- 排行榜 -->
    <div class="card" v-if="store.board.length">
      <div class="ct">
        <h3>模型排行榜</h3>
        <!-- 开关自带标签就够了，不再另写一段说明 -->
        <div class="ml-auto flex items-center gap-2">
          <span
            class="text-[10.5px]"
            :class="stopMode ? 'text-slate-300' : 'text-slate-500'"
            data-stop-label
          >中二等奖即收手</span>
          <button
            type="button"
            class="relative w-9 h-5 rounded-full transition shrink-0"
            :class="stopMode ? 'bg-red-500' : 'bg-ink-500'"
            :aria-pressed="stopMode"
            :aria-label="'中二等奖及以上即收手'"
            @click="stopMode = !stopMode"
            data-stop-toggle
            title="中二等奖及以上即收手：第一次中一等奖/二等奖就停手，净盈亏只算到中奖那期"
          >
            <span
              class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              :class="stopMode ? 'translate-x-4' : ''"
            ></span>
          </button>
        </div>
      </div>
      <div
        v-for="(r, i) in view"
        :key="r.modelId"
        class="flex items-center gap-2.5 py-2 border-b border-ink-500 last:border-0"
        :class="r.modelId === 'B01' ? 'bg-amber-500/10 -mx-2 px-2 rounded-lg' : ''"
        :data-board-row="r.modelId"
      >
        <span
          class="w-5 h-5 rounded-md grid place-items-center text-[10.5px] shrink-0"
          :class="i === 0 ? 'text-white font-bold' : 'bg-ink-600 text-slate-500'"
          :style="i === 0 ? 'background: linear-gradient(135deg,#ff5b5e,#e0313c)' : ''"
        >
          {{ i + 1 }}
        </span>
        <div class="min-w-0 flex-1">
          <div class="text-[12px] truncate">
            {{ r.modelName }}
            <span
              v-if="r.showStopped"
              class="ml-1 text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 align-middle"
              data-stopped
            >已收手</span>
          </div>
          <div class="text-[9.5px] text-slate-500">
            {{ r.modelId }} ·
            <!-- 收手模式下「期数」就是真正掏钱买的期数，跟全程期数并排写清楚，
                 否则同一个数字在两种模式下含义不同，很容易被当成同一个口径 -->
            <span v-if="stopMode" data-buy-periods :title="buyPeriodsTitle(r)">
              <span v-if="r.showStopped">已买 {{ r.trials }} / {{ boardPeriods }} 期</span>
              <span v-else>买满 {{ r.trials }} 期</span>
            </span>
            <span v-else>{{ r.trials }} 期</span>
            · 中奖率 {{ (r.winRate * 100).toFixed(1) }}%
            <span v-if="r.bestLevel" class="text-amber-400">
              · 最高 {{ levelName(r.bestLevel) }}
            </span>
            <span v-if="r.modelId === 'B01'" class="text-amber-400">· 黄金基线</span>
            <span v-if="r.showStopped" class="text-emerald-400">
              · 第 {{ r.stopIssue }} 期收手（{{ levelName(r.stopLevel) }}）
            </span>
            <span v-else-if="stopMode" class="text-slate-500">· 全程未中大奖</span>
          </div>
          <!-- 只有一个百分比看不出量级：把「投出去多少、收回来多少」也摆出来 -->
          <div class="text-[9.5px] text-slate-600" data-io>
            投入 {{ fmtYuan(r.totalCost) }} → 回收
            <span :class="r.totalPrize >= r.totalCost ? 'text-red-400' : 'text-emerald-500'">
              {{ fmtYuan(r.totalPrize) }}
            </span>
          </div>
        </div>
        <span
          class="text-[12px] font-semibold"
          :class="r.roi >= 0 ? 'text-red-400' : 'text-emerald-500'"
          data-roi
        >
          {{ pct(r.roi) }}
        </span>
        <button
          class="text-[10px] px-1.5 py-0.5 rounded border shrink-0 transition"
          :class="
            store.detailModelId === r.modelId
              ? 'border-amber-500 text-amber-400 bg-amber-500/10'
              : 'border-ink-500 text-slate-500 hover:text-slate-300'
          "
          :disabled="store.detailLoading"
          @click="toggleDetail(r.modelId)"
          :data-detail-btn="r.modelId"
        >
          {{ detailOpen && store.detailModelId === r.modelId ? '明细中' : '明细' }}
        </button>
      </div>

      <p class="text-[10.5px] text-slate-500 mt-2.5 leading-relaxed">
        点任意一行的「明细」，弹框列出它每一期买了哪些号、哪几个中了。
        <template v-if="store.archiveInfo?.status === 'done'">
          回测结束后已把全部 {{ store.archiveInfo.total }} 个模型的逐期明细存进本地库，点开直接读，不再现算。
        </template>
        <template v-else-if="store.archiveInfo?.status === 'running'">
          回测已结束，正在把逐期明细存进本地库（{{ store.archiveInfo.done }}/{{ store.archiveInfo.total }}），
          还没存到的模型会当场算一次并落库。
        </template>
        <template v-else>
          回测结束后明细会自动存进本地库，点开直接读；还没存到的模型会当场算一次并落库。
        </template>
      </p>
    </div>

    <!--
      逐期明细：做成**弹框**而不是页内联的一段。
      明细动辄几千期，内联的话得一路滑到底才看得见，而上面的排行榜反而被顶得看不见；
      弹框自带遮罩 + 内部滚动，开在哪一行都能立刻看到，关掉就回到排行榜原处。

      Teleport 到 body：父级 .card 有 overflow/border-radius，
      不 teleport 的话弹框会被裁进卡片里。
    -->
    <Teleport to="body">
      <div
        v-if="detailOpen"
        class="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
        data-detail-mask
      >
        <div class="absolute inset-0 bg-black/70" @click="closeDetail"></div>

        <div
          class="relative flex flex-col w-full sm:w-[44rem] sm:max-w-[calc(100vw-2rem)] max-h-[88vh] rounded-t-2xl sm:rounded-2xl bg-ink-700 border border-ink-500 shadow-2xl overflow-hidden"
          role="dialog"
          aria-modal="true"
          data-detail-panel
        >
          <!-- 头部不随内容滚动：模型名与「正在算哪一注」要一直在眼前 -->
          <div class="flex items-center gap-2 px-3.5 py-3 border-b border-ink-500 shrink-0">
            <div class="min-w-0 flex-1">
              <div class="text-[13px] font-semibold truncate">逐期明细</div>
              <div class="text-[10px] text-slate-500 truncate">
                {{ detailModelName }} · {{ store.detailModelId }}
              </div>
            </div>
            <span
              class="tag shrink-0 border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
              v-if="store.detailFrom === 'disk' && !store.detailLoading"
              data-detail-cached
            >本地缓存</span>
            <span
              class="tag shrink-0 border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
              v-else-if="store.detailFrom === 'extend' && !store.detailLoading"
              data-detail-cached
            >缓存+补新期</span>
            <span class="tag ml-auto shrink-0" v-if="store.detailModelId && !store.detailLoading">
              {{ filterWin ? '只看得奖期' : '全部期数' }}
            </span>
            <button
              class="w-7 h-7 rounded-lg grid place-items-center bg-ink-600 text-slate-400 text-[13px] shrink-0"
              aria-label="关闭"
              @click="closeDetail"
            >
              ✕
            </button>
          </div>

          <div class="overflow-y-auto overscroll-contain px-3.5 py-3">
      <p
        v-if="store.detailError && !store.detailRows.length"
        class="text-[11.5px] leading-relaxed"
        :class="store.detailError === '已停止' ? 'text-slate-400' : 'text-red-400'"
      >
        {{ store.detailError }}
      </p>

      <template v-else>
        <!-- 汇总条 -->
        <div v-if="detailStats.rows.length && !store.detailLoading" class="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-2.5">
          <div class="kpi">
            <p>已结算</p>
            <b>{{ detailStats.rows.length }} 期</b>
          </div>
          <div class="kpi">
            <p>中奖期数</p>
            <b class="text-amber-400">{{ detailStats.wins }}</b>
          </div>
          <div class="kpi">
            <p>最高奖级</p>
            <b :class="detailStats.best ? 'text-amber-400' : 'text-slate-500'">
              {{ detailStats.best ? levelName(detailStats.best) : '未中奖' }}
            </b>
          </div>
          <div class="kpi">
            <p>净盈亏</p>
            <!-- 七位数加变体符号在 4 列布局里会被折成「…元」换行，压字号 + 不换行 -->
            <b
              class="whitespace-nowrap text-[15px] sm:text-[16px]"
              :class="detailStats.net >= 0 ? 'text-red-400' : 'text-emerald-500'"
              :title="`${detailStats.net >= 0 ? '+' : ''}${detailStats.net} 元`"
            >
              {{ detailStats.net >= 0 ? '+' : '' }}{{ fmtInt(detailStats.net) }} 元
            </b>
          </div>
        </div>
        <p
          v-if="detailStats.rows.length && !store.detailLoading"
          class="text-[10px] text-slate-500 -mt-1 mb-2.5"
          data-net-note
        >
          净盈亏 = 回收 {{ fmtYuan(detailStats.prize) }} − 投入
          {{ fmtYuan(detailStats.cost) }}（{{ detailStats.rows.length }} 期累计）
        </p>

        <!-- 奖级分布 -->
        <div v-if="levelChips.length" class="flex flex-wrap gap-1 mb-2.5">
          <span
            v-for="c in levelChips"
            :key="c.level"
            class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/25"
          >
            {{ levelName(c.level) }} × {{ c.count }}
          </span>
        </div>

        <!-- 加载进度 -->
        <div v-if="store.detailLoading" class="rounded-lg bg-ink-600 border border-ink-500 p-2.5 mb-2.5">
          <div class="flex items-end justify-between mb-1.5">
            <span class="text-[11px] text-slate-300">正在逐期重算…</span>
            <b class="text-[15px] font-mono text-amber-400">{{ Math.floor(store.detailProgress * 100) }}%</b>
          </div>
          <div class="h-1.5 rounded-full bg-ink-500 overflow-hidden">
            <div
              class="h-full rounded-full transition-[width] duration-150"
              :style="{ width: Math.floor(store.detailProgress * 100) + '%', background: 'linear-gradient(90deg,#ff5b5e,#f5b944)' }"
            ></div>
          </div>
          <button class="btn-ghost mt-2" @click="store.cancelDetail()">停止</button>
        </div>

        <!-- 筛选 -->
        <div v-if="detailRows.length > 6" class="flex gap-1.5 mb-2.5">
          <button
            v-for="f in FILTERS"
            :key="f.v"
            class="flex-1 py-1.5 rounded-lg text-[11px] border transition"
            :class="
              filter === f.v
                ? 'border-red-500 text-red-400 bg-red-500/10'
                : 'border-ink-500 text-slate-400 bg-ink-600'
            "
            @click="filter = f.v"
          >
            {{ f.t }}
          </button>
        </div>

        <!-- 期列表 -->
        <div v-if="visibleRows.length" class="rounded-xl border border-ink-500 overflow-hidden" data-detail-list>
          <div
            v-for="row in visibleRows"
            :key="row.index"
            class="px-2.5 py-2 border-b border-ink-500 last:border-0"
            :class="row.level ? 'bg-amber-500/[0.06]' : ''"
            data-detail-row
          >
            <!-- 期号 + 奖级 -->
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-[11.5px] text-slate-200 font-medium">第 {{ row.issue }} 期</span>
              <span class="text-[9.5px] text-slate-500">{{ fmtDate(row.date) }}</span>
              <span
                v-if="row.level"
                class="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30"
              >
                {{ levelName(row.level) }} · {{ row.prize }} 元
              </span>
              <span v-else class="ml-auto text-[10px] text-slate-600">未中奖</span>
            </div>

            <!-- 开奖号码 -->
            <div class="flex items-center gap-1 flex-wrap mb-1">
              <span class="text-[9.5px] text-slate-500 w-8 shrink-0">开奖</span>
              <span class="grp-tag grp-front">前</span>
              <span class="flex flex-wrap gap-0.5">
                <span
                  v-for="n in drawOf(row).front"
                  :key="'df' + n"
                  class="ball ball-r ball-xs"
                >{{ pad(n) }}</span>
              </span>
              <span class="grp-sep"></span>
              <span class="grp-tag grp-back">后</span>
              <span class="flex flex-wrap gap-0.5">
                <span
                  v-for="n in drawOf(row).back"
                  :key="'db' + n"
                  class="ball ball-b ball-xs"
                >{{ pad(n) }}</span>
              </span>
            </div>

            <!-- 模型选号（命中高亮） -->
            <div class="flex items-start gap-1 flex-wrap">
              <span class="text-[9.5px] text-slate-500 w-8 shrink-0 pt-0.5">选号</span>
              <span class="grp-tag grp-front mt-0.5">前</span>
              <span class="flex flex-wrap gap-0.5">
                <span
                  v-for="n in row.hit.pickedFront"
                  :key="'pf' + n"
                  class="ball ball-xs"
                  :class="pickCls(row, n)"
                  :title="pickTitle(row, n)"
                >{{ pad(n) }}</span>
              </span>
              <span class="grp-sep mt-0.5"></span>
              <span class="grp-tag grp-back mt-0.5">后</span>
              <span class="flex flex-wrap gap-0.5">
                <span
                  v-for="n in row.hit.pickedBack"
                  :key="'pb' + n"
                  class="ball ball-xs"
                  :class="row.hit.hitBack.includes(n) ? 'pick-hit' : 'pick-miss'"
                  :title="row.hit.hitBack.includes(n) ? '命中' : '未中'"
                >{{ pad(n) }}</span>
              </span>
              <span class="ml-auto text-[9.5px] text-slate-500 shrink-0 pt-0.5">
                {{ row.hit.f }}+{{ row.hit.b }}
                <template v-if="row.kind === 'dantuo'">胆拖</template>
                <template v-else-if="row.kind === 'complex'">复式</template>
              </span>
            </div>

            <!-- 胆码 / 拖码标注 -->
            <p v-if="row.kind === 'dantuo'" class="text-[9.5px] text-slate-500 mt-1 ml-[38px]">
              胆 {{ row.dans.map(pad).join(' ') }} · 拖 {{ row.tuos.map(pad).join(' ') }}
            </p>
          </div>
        </div>

        <p v-if="!visibleRows.length" class="text-[11px] text-slate-500 text-center py-3">
          {{ filterWin ? '该模型在这段回测里一次都没中。' : '没有可显示的期次。' }}
        </p>

        <button
          v-if="visibleRows.length < detailRows.length"
          class="btn-ghost mt-2.5"
          @click="shown = detailRows.length"
        >
          展开全部 {{ detailRows.length }} 期
        </button>

        <div v-if="shown < detailRows.length" class="text-center text-[10px] text-slate-500 mt-2">
          已显示 {{ visibleRows.length }} / {{ detailRows.length }} 期
        </div>

        <p class="text-[10px] text-slate-500 mt-2.5 leading-relaxed">
          金色球 = 命中并计入奖级；灰边球 = 开奖里有但这一注用不上（胆拖超出组合数的拖码，
          按规则不计分）；深灰球 = 买了但没中。复式/胆拖买的是一堆号码，
          对奖只按其中<b class="text-slate-400">最有利的那一注</b>算。
        </p>
      </template>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useMainStore } from '../stores/main'
import { RULES } from '../core/lottery'
import { permutationTest } from '../core/backtest'
import type { PeriodDetail } from '../core/backtest'
import { MODEL_COUNT } from '../core/models'
import { estMs, fmtDur } from '../core/perf'

const store = useMainStore()
const lastCached = ref<boolean | null>(null)

/**
 * 「中二等奖及以上即收手」视图开关。
 * 注意：它不是回测参数——回测正常算两套数据（常规 + 收手），这里只是切到哪套来显示，
 * 纯前端变换、按收手后的收益率重排，不触发任何后端重算。
 */
const stopMode = ref(false)

/**
 * 排行榜展示用的「视图」：默认展示常规回测结果；
 * 开启 stopMode 后改用每个模型已算好的收手变体，并按收手后收益率重新排序。
 */
const view = computed(() => {
  const rows = store.board.map((r) => {
    if (stopMode.value) {
      return {
        ...r,
        roi: r.roiStop,
        totalCost: r.totalCostStop,
        totalPrize: r.totalPrizeStop,
        trials: r.trialsStop,
        winRate: r.winRateStop,
        bestLevel: r.bestLevelStop,
        hits: r.hitsStop,
        showStopped: r.stopped,
      }
    }
    return { ...r, showStopped: false }
  })
  rows.sort((a, b) => b.roi - a.roi)
  return rows
})

/**
 * 收手模式那行「期数」的悬停说明。
 *
 * 两种模式下 `r.trials` 的含义不同：常规模式是「回测算了多少期」，
 * 收手模式是「真正掏钱买了多少期」。数字相同但口径不同，不写清楚必然被误读。
 */
function buyPeriodsTitle(r: { showStopped: boolean; trials: number; stopIssue: string | null }) {
  const full = boardPeriods.value
  if (r.showStopped) {
    return `第 ${r.stopIssue} 期中二等奖及以上，此后不再买：实际买入 ${r.trials} 期，全程窗口 ${full} 期`
  }
  return `整段 ${full} 期都没中过二等奖及以上，所以一直买到窗口结束`
}

/**
 * 训练集期数。periods 由它推出：samples 之前的期只进训练，不结算。
 *
 * 注意 `periods = max(60, total − sample)` ⇒ **样本越大，回测期数越少**。
 * 而每期成本随训练长度上升，所以总耗时是个 U 形：
 * 样本小 ⇒ 期数多，每期便宜但架不住堆量；样本大 ⇒ 期数少但每期贵。
 * 具体分钟数别写死，交给 estAt 按本机校准后的模型算。
 */
const sample = ref(1000)
/**
 * 快捷档只标样本值，耗时**不写死**——双色球的数字对大乐透不成立
 * （历史期数不同 ⇒ 同样的样本量对应不同的结算期数）。耗时统一由 estAt 算。
 */
const PRESETS = [{ sample: 500 }, { sample: 1000 }, { sample: 2000 }]

const total = computed(() => store.history.length)
/** 训练集的合法上限：留至少 60 期用来结算 */
const maxSample = computed(() => Math.max(0, total.value - 60))
/** 给定训练样本，算出回测窗口期数。与 store 里的 start 公式保持一致 */
function periodsAt(s: number) {
  return Math.max(60, total.value - s)
}
const periods = computed(() => periodsAt(sample.value))

const modelCount = MODEL_COUNT.total

const busy = computed(
  () => store.progress.phase === 'running' || store.progress.phase === 'saving'
)
const prog = computed(() => store.progress)
const pctNum = computed(() => Math.floor(prog.value.ratio * 100))
const donePeriod = computed(() =>
  Math.max(1, Math.min(prog.value.periodsDone + 1, prog.value.periodCount || 1))
)
const phaseText = computed(() =>
  store.progress.phase === 'saving' ? '正在写入本地库…' : '正在回测…'
)

/**
 * 点「开始回测」那一刻页面显示的预估。留一份快照，好在进度区跟实时速率对照 ——
 * 没有它就没法回答用户最想问的「它俩到底差多少」。
 */
const estAtStart = ref(0)

/**
 * 实测速率（ms/期）。前几期还在热机（JIT + 首次访问大数组），
 * 拿来外推会虚高，所以要跑过几期才算数。
 */
const liveRate = computed(() => {
  const p = prog.value
  if (p.phase !== 'running' || p.periodsDone < 3 || p.elapsedMs < 3000) return 0
  const r = p.elapsedMs / p.periodsDone
  return Number.isFinite(r) && r > 0 ? r : 0
})

/** 用实时速率外推的**全程**总时长（进度条上那个是「还需多久」） */
const liveTotalMs = computed(() =>
  liveRate.value ? liveRate.value * prog.value.periodCount : 0
)

/** 与开跑前预估的差距。差 30% 以内就不啰嗦 */
const driftText = computed(() => {
  if (!liveTotalMs.value || !estAtStart.value) return ''
  const r = liveTotalMs.value / estAtStart.value
  if (r >= 1.3) return `，比开跑前估的 ${fmtDur(estAtStart.value)} 慢 ${r.toFixed(1)} 倍`
  if (r <= 0.75) return `，比开跑前估的 ${fmtDur(estAtStart.value)} 快 ${(1 / r).toFixed(1)} 倍`
  return '，与开跑前的预估基本一致'
})

/**
 * 把实时速率喂回本机校准，**不等跑完**。
 *
 * 不做这一步的话，第一次跑的人会一直看到参数区写着公式给的十几分钟、
 * 而进度条按真实速率说要一个多小时 —— 两个数字同时挂在屏幕上，只会让人觉得
 * 「预估是假的」。回写之后参数区那个数字几十秒内就会爬到真实量级，两者收敛。
 *
 * 只对全量回测做：增量补算只算末尾几期，恰好是全程最贵的那一段，
 * 拿它的速率去外推全窗口会系统性高估。
 */
watch(
  () => prog.value.periodsDone,
  () => {
    const p = prog.value
    if (p.phase !== 'running' || p.incrementalPeriods > 0 || !p.periodCount) return
    if (!liveRate.value) return
    store.recordPerfRate(liveRate.value, total.value - p.periodCount, total.value)
  }
)

/** 当前设置下的缓存判定：秒开 / 补算 / 重算。与 store 内部同源，不会出现按钮与实际行为不一致 */
const plan = ref<{ mode: 'cache' | 'extend' | 'full'; upTo: number; extend: number; periods: number }>(
  { mode: 'full', upTo: 0, extend: 0, periods: 0 }
)

async function refreshPlan() {
  try {
    const p = await store.probeBoard(periods.value)
    plan.value = !p.has
      ? { mode: 'full', upTo: 0, extend: 0, periods: p.periods }
      : p.extend > 0
        ? { mode: 'extend', upTo: p.upTo, extend: p.extend, periods: p.periods }
        : { mode: 'cache', upTo: p.upTo, extend: 0, periods: p.periods }
  } catch {
    plan.value = { mode: 'full', upTo: 0, extend: 0, periods: 0 }
  }
}

watch(
  [() => store.lottery, () => store.budget, periods, () => store.boardInfo],
  () => {
    lastCached.value = null
    void refreshPlan()
  },
  { immediate: true }
)

async function run(force = false) {
  // 点下去的这一刻页面报的是多少，先存下来：跑起来后要拿实时速率跟它对照
  estAtStart.value = estFullMs.value
  const r = await store.runLeaderboard(periods.value, { force })
  // 被停止或出错时不改「上次结果来源」的提示，避免误导
  if (store.progress.phase === 'cancelled' || store.progress.phase === 'error') return
  lastCached.value = r.cached
  await refreshPlan()
}

/** 排行榜实际覆盖的期数（读缓存时 boardInfo 更准） */
const boardPeriods = computed(() => store.boardInfo?.periods || plan.value.periods || periods.value)

/** 规模：模型数 × 期数 */
const unitsText = computed(() => {
  const n = modelCount * periods.value
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return String(n)
})

/**
 * 耗时估算。
 *
 * 公式住在 `core/perf.ts`（那里有完整的推导注释），这里只负责
 * 把**本机校准系数**乘上去 —— store 每次实跑后会记下「实测 ÷ 公式」并存起来，
 * 于是第二次开始，页面报的数字就是这台机器上的真实量级。
 * 用户实测样本 1000 跑了 81 分钟，而写死系数的时代页面说「十几分钟」，
 * 差的正是这个 factor（本机 4 倍以上并不稀奇，后台标签页还会被浏览器降频）。
 */
const factor = computed(() => store.perf.factor)

/** 结算区间 [startTrain, total) 的预估耗时 */
function estAt(s: number) {
  return estMs(total.value - periodsAt(s), total.value, factor.value)
}
/** 「全部历史」档（训练=全部历史、只结算最后 60 期）的预估耗时 */
const estAllMs = computed(() => estAt(maxSample.value))
/** 全量重算的预估耗时 */
const estFullMs = computed(() => estMs(total.value - periods.value, total.value, factor.value))
/** 增量补算只算新增那几期，耗时按这几期单独估，别拿全窗口的数字吓人 */
const estExtendMs = computed(() => estMs(plan.value.upTo, total.value, factor.value))

/**
 * 预估是否可信。**必须让用户知道这份估算从哪来的**：
 * 一次都没跑过时用的只是撰公式那台机器的系数，这种数字印刷出来就是骗人。
 */
const estConfident = computed(() => store.perf.samples > 0)
const estNote = computed(() =>
  estConfident.value
    ? `已按本机 ${store.perf.samples} 次实跑校准`
    : '本机还没跑过，这只是公式给的粗估，实际可能慢好几倍'
)

const baseline = computed(() => store.board.find((b) => b.modelId === 'B01'))
const noDiff = computed(() => {
  const base = baseline.value
  if (!base) return 0
  return store.board.filter(
    (r) => r.modelId !== 'B01' && permutationTest(r, base) > 0.05
  ).length
})

/** 与基线比较的次数 = 模型数 − 1（B01 自己不跟自己比） */
const cmpCount = computed(() => Math.max(0, store.board.length - 1))
/** p ≤ 0.05 的个数。注意它**不等于**「有本事的个数」 */
const sigCount = computed(() => Math.max(0, cmpCount.value - noDiff.value))
/**
 * 多重比较下的假阳性期望个数：比较次数 × 显著性水平。
 * 77 组 × 5% ≈ 4 个——这正是「榜上有名」最可能的来源。
 */
const falsePos = computed(() => Math.max(1, Math.round(cmpCount.value * 0.05)))

/** 排行榜里的投入/回收动辄十几万，直接印数字看不出量级 */
function fmtYuan(v: number) {
  if (!Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + ' 万'
  return Math.round(v) + ' 元'
}

const pct = (v: number) => (v * 100).toFixed(1) + '%'

/** 千分位。净盈亏动辄七位数，不分位读起来一眼数不清 */
function fmtInt(v: number) {
  if (!Number.isFinite(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

// ------------------------------------------------------------ 逐期明细
const FILTERS = [
  { v: 'all', t: '全部' },
  { v: 'win', t: '只看得奖' },
  { v: 'high', t: '四等奖以上' },
] as const
type FilterKind = (typeof FILTERS)[number]['v']

const filter = ref<FilterKind>('all')
/** 明细一次可能几千期，默认只铺前面一小段，点「展开全部」再放开 */
const PAGE = 60
const shown = ref(PAGE)

const detailModelName = computed(
  () => store.board.find((b) => b.modelId === store.detailModelId)?.modelName || ''
)

const detailRows = computed(() => store.detailRows)

const levelName = (lv: number) => RULES[store.lottery].levelNames[lv] || `${lv} 等奖`

/** 明细统计。与排行榜那一行的数字同源（同一批 stepPeriod 的账） */
const detailStats = computed(() => {
  const rows = detailRows.value
  let cost = 0
  let prize = 0
  let wins = 0
  let best = 0
  const counts: Record<number, number> = {}
  for (const r of rows) {
    cost += r.cost
    prize += r.prize
    if (r.level) {
      wins++
      counts[r.level] = (counts[r.level] || 0) + 1
      if (!best || r.level < best) best = r.level
    }
  }
  return { rows, cost, prize, wins, best, net: prize - cost, counts }
})

/** 奖级分布（数字小的排前面，即高奖在前） */
const levelChips = computed(() =>
  Object.entries(detailStats.value.counts)
    .map(([lv, count]) => ({ level: Number(lv), count }))
    .sort((a, b) => a.level - b.level)
)

const filterWin = computed(() => filter.value !== 'all')

const visibleRows = computed(() => {
  let rows = detailRows.value
  if (filter.value === 'win') rows = rows.filter((r) => r.level > 0)
  else if (filter.value === 'high') rows = rows.filter((r) => r.level > 0 && r.level <= 4)
  // 最新的期排前面，更符合「回看最近发生了什么」的直觉
  return rows.slice().reverse().slice(0, shown.value)
})

/** 明细弹框开关。明细本身按需重算，关掉时不销毁已经在内存里算好的 rows */
const detailOpen = ref(false)

/**
 * 打开/切换某个模型的明细。
 *
 * 注意：判断「是不是同一个模型」要带上 detailOpen —— 之前只看 modelId，
 * 于是关掉弹框后再点同一行会走「收起」分支，界面毫无反应，看着像坏了。
 */
async function toggleDetail(modelId: string) {
  if (detailOpen.value && store.detailModelId === modelId) {
    closeDetail()
    return
  }
  filter.value = 'all'
  shown.value = PAGE
  detailOpen.value = true
  await store.loadDetail(modelId)
}

/** 关闭弹框。正在算就叫停：用户都关了，没必要继续占着主线程 */
function closeDetail() {
  detailOpen.value = false
  if (store.detailLoading) store.cancelDetail()
}

/** ESC 关弹框：一个跑了十几分钟的回测，用户很可能想赶紧把框退掉 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && detailOpen.value) closeDetail()
}
watch(detailOpen, (open) => {
  if (open) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** 按 index 取开奖号码。明细里带着期号，回查一次即可 */
const drawCache = new Map<number, { front: number[]; back: number[] }>()
function drawOf(row: { index: number }) {
  let d = drawCache.get(row.index)
  if (!d) {
    const raw = store.history[row.index]
    d = { front: raw?.front || [], back: raw?.back || [] }
    drawCache.set(row.index, d)
  }
  return d
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * 前区号码的三档配色。多出来的「命中但不计分」这一档是**必须**的：
 * 胆拖票一注只能由「胆码 + need 个拖码」组成，超出 need 的拖码命中了也进不了
 * 任何一注。若把它们和「完全没中」一起画成灰色，用户一定会问
 * 「这个号开奖里明明有，怎么是灰的」——而答案不是 bug，是彩票规则本身。
 */
function pickCls(row: PeriodDetail, n: number) {
  if (row.hit.hitFront.includes(n)) return 'pick-hit'
  const draw = drawOf(row).front
  if (draw.includes(n)) return 'pick-extra'
  return 'pick-miss'
}

function pickTitle(row: PeriodDetail, n: number) {
  if (row.hit.hitFront.includes(n)) return '命中，计入奖级'
  if (drawOf(row).front.includes(n)) return '开奖里有，但这一注用不上（不计分）'
  return '未中'
}

function fmtDate(s: string) {
  if (!s) return ''
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${Number(m[2])}/${Number(m[3])}` : s
}

/**
 * 换了回测设置就作废旧明细：那些号码是对着上一套参数算出来的。
 * 必须放在脚本末尾——它引用了上面才声明的 PAGE / drawCache，
 * 提前注册会撞上 const 的暂时性死区。
 */
watch(
  [() => store.lottery, () => store.budget, periods, () => store.boardInfo?.runKey],
  () => {
    // 换设置了旧明细必然作废，框留着会显示过期数据 —— 直接关掉
    detailOpen.value = false
    store.clearDetail()
    drawCache.clear()
    shown.value = PAGE
    filter.value = 'all'
  }
)
</script>
