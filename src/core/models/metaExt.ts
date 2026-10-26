import type { Prediction } from '../../types'
import { RULES } from '../lottery'
import { normalize, rndInt, type Model, type ModelCtx } from './types'
import { dayGanzhi, boost } from './meta'

/**
 * 与 meta.ts 相同：按编号前缀归类 —— X = 玄学（中国传统术数），Q = 趣味（西方神秘学 / 随机玩法）。
 */
const M = (
  id: string, name: string, desc: string,
  predict: (c: ModelCtx) => Prediction, needsProfile = false
): Model => ({ meta: { id, name, category: id[0] === 'Q' ? 'fun' : 'meta', desc, needsProfile }, predict })

// ---------------------------------------------------------------- 历法工具

/** 二十八宿：以儒略日序对 28 取模轮转（简化推算） */
const XIU = ['角', '亢', '氐', '房', '心', '尾', '箕', '斗', '牛', '女', '虚', '危', '室', '壁',
  '奎', '娄', '胃', '昴', '毕', '觜', '参', '井', '鬼', '柳', '星', '张', '翼', '轸']

function jdnOf(date: Date): number {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate()
  const a = Math.floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
}

/** 建除十二神（黄历），按月建地支推算 */
const JIANCHU = ['建', '除', '满', '平', '定', '执', '破', '危', '成', '收', '开', '闭']
const YIJI: Record<string, string> = {
  建: '宜出行', 除: '宜扫舍', 满: '宜开市', 平: '宜修饰', 定: '宜安床', 执: '宜捕捉',
  破: '宜破屋', 危: '宜安床', 成: '宜开市', 收: '宜纳财', 开: '宜祈福', 闭: '宜筑堤',
}

/** 玄空飞星：年星入中宫（2004-2023 八运、2024-2043 九运，简化推算） */
function yearStar(year: number): number {
  // 以 2000 年 9 星入中为基准逆推
  const base = 9
  const idx = ((base - 1 - ((year - 2000) % 9)) + 9) % 9
  return idx + 1
}

/** 洛书九宫：戴九履一，左三右七，二四为肩，六八为足，五居中 */
const LUOSHU = [5, 1, 9, 3, 7, 4, 2, 8, 6] // 索引按宫位 1-9 的常用排布近似

const TRIGRAM_NAMES = ['坤', '震', '兑', '乾', '艮', '离', '坎', '巽']

// ---------------------------------------------------------------- X04 河图洛书
export const X04 = M(
  'X04', '河图洛书',
  '按洛书九宫数配号，取当日飞泊之宫对应数字。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const j = jdnOf(nextDate)
    const gong = (j % 9) + 1
    const num = LUOSHU[gong - 1] || 5
    const nums: number[] = []
    for (let n = num; n <= F; n += 9) nums.push(n)
    return {
      frontProbs: boost(F, nums),
      backProbs: boost(B, [((num - 1) % B) + 1]),
      narrative: `今日飞泊${gong}宫，洛书数 ${num}，配号 ${nums.slice(0, 4).join('、')}。`,
      confidence: 0.47,
    }
  }
)

// ---------------------------------------------------------------- X05 玄空飞星
export const X05 = M(
  'X05', '玄空飞星',
  '按流年飞星入中宫，取当旺星与生气星对应的数字。年份驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const y = nextDate.getFullYear()
    const star = yearStar(y)
    const next = (star % 9) + 1 // 未来当旺
    const nums = [star, next, star + 9, next + 9, star + 18].filter((n) => n <= F)
    return {
      frontProbs: boost(F, nums),
      backProbs: boost(B, [star % B + 1, next % B + 1]),
      narrative: `${y} 年 ${star} 星入中宫，当旺 ${star}、生气 ${next}，据此配号。`,
      confidence: 0.46,
    }
  }
)

// ---------------------------------------------------------------- X06 梅花易数
export const X06 = M(
  'X06', '梅花易数',
  '以开奖年月日时起卦，取体卦用卦互变之数。时间起卦，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const y = nextDate.getFullYear()
    const m = nextDate.getMonth() + 1
    const d = nextDate.getDate()
    const h = nextDate.getHours()
    const up = (y + m + d) % 8
    const down = (y + m + d + h) % 8
    const yao = (y + m + d + h) % 6
    const gua = up * 8 + down + 1
    const nums = [up + 1, down + 1, gua, ((gua * 2) % F) + 1].filter((n) => n >= 1 && n <= F)
    return {
      frontProbs: boost(F, nums, 5),
      backProbs: boost(B, [(yao % B) + 1], 5),
      narrative: `${y}年${m}月${d}日${h}时起卦：${TRIGRAM_NAMES[up]}${TRIGRAM_NAMES[down]}卦，动爻 ${yao + 1}。`,
      confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- X07 纳甲筮法
export const X07 = M(
  'X07', '纳甲筮法',
  '六爻配地支，取当日旺相之支对应的数字。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const g = dayGanzhi(nextDate)
    const zhi = g.zhi
    // 旺相休囚死：当日地支为旺，其次为相
    const wang = zhi
    const xiang = (zhi + 4) % 12
    const nums: number[] = []
    for (let n = wang + 1; n <= F; n += 12) nums.push(n)
    for (let n = xiang + 1; n <= F; n += 12) nums.push(n)
    return {
      frontProbs: boost(F, nums),
      backProbs: boost(B, [(wang % B) + 1, (xiang % B) + 1]),
      narrative: `日支为旺（第 ${wang + 1} 支），相者第 ${xiang + 1} 支，取旺相之数。`,
      confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- X08 六十四卦
export const X08 = M(
  'X08', '六十四卦卦序',
  '按日期取模 64 得卦序，卦序直接映射号码池。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const j = jdnOf(nextDate)
    const gua = (j % 64) + 1
    const nums = [gua % F + 1, (gua * 3) % F + 1, (gua + 7) % F + 1, (gua + 23) % F + 1]
    return {
      frontProbs: boost(F, nums, 5),
      backProbs: boost(B, [(gua % B) + 1], 5),
      narrative: `今日值第 ${gua} 卦，卦序转号码。`, confidence: 0.44,
    }
  }
)

// ---------------------------------------------------------------- X09 奇门遁甲（简版）
const DOOR = ['休', '生', '伤', '杜', '景', '死', '惊', '开']
export const X09 = M(
  'X09', '奇门遁甲（简版）',
  '九宫八卦排盘，取开门、生门、休门（三吉门）所在宫位的数字。日期驱动。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const g = dayGanzhi(nextDate)
    const start = g.zhi % 8
    const lucky = [start, (start + 1) % 8, (start + 7) % 8]
    const nums = lucky.flatMap((p) => {
      const base = p + 1
      return [base, base + 8, base + 16, base + 24].filter((n) => n <= F)
    })
    return {
      frontProbs: boost(F, nums, 4),
      backProbs: boost(B, lucky.map((p) => (p % B) + 1), 4),
      narrative: `三吉门：${lucky.map((p) => DOOR[p]).join('、')}门，取其宫位数。`,
      confidence: 0.43,
    }
  }
)

// ---------------------------------------------------------------- X10 紫微斗数
export const X10 = M(
  'X10', '紫微斗数',
  '按生辰排命宫，取主星化禄之数。需玄学档案（出生年月日时 + 性别）。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    if (!profile.birthDate) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '未填写出生日期，紫微排盘无法进行，退化为均匀分布。', confidence: 0,
      }
    }
    const d = new Date(profile.birthDate)
    const g = dayGanzhi(d)
    const hour = Number(profile.birthDate.slice(11, 13) || 12)
    const palace = (g.zhi + Math.floor(hour / 2)) % 12
    const nums: number[] = []
    for (let n = palace + 1; n <= F; n += 12) nums.push(n)
    const gender = profile.gender === 'f' ? '阴' : '阳'
    return {
      frontProbs: boost(F, nums, 6),
      backProbs: boost(B, [(palace % B) + 1], 6),
      narrative: `${gender}命，命宫在${XIU[palace % 28]}（第 ${palace + 1} 宫），取化禄之数。`,
      confidence: 0.44,
    }
  }, true
)

// ---------------------------------------------------------------- X11 八字四柱
export const X11 = M(
  'X11', '八字四柱',
  '排出年月日时四柱干支，取日主喜用神对应的数字。需玄学档案。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    if (!profile.birthDate) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '未填写出生日期，八字无法排盘，退化为均匀分布。', confidence: 0,
      }
    }
    const d = new Date(profile.birthDate)
    const g = dayGanzhi(d)
    // 年柱按年干支，简化：以年对 60 取模
    const yearGan = ((d.getFullYear() - 4) % 10 + 10) % 10
    const dayGan = g.gan
    // 喜用神：以日主五行所缺为用（简化）
    const element = Math.floor(dayGan / 2)
    const useful = (element + 2) % 5
    const tailMap = [1, 1, 3, 3, 5, 5, 7, 7, 9, 9]
    const lucky = [tailMap[useful * 2], tailMap[useful * 2 + 1]]
    const nums: number[] = []
    for (let n = 1; n <= F; n++) if (lucky.includes(n % 10)) nums.push(n)
    return {
      frontProbs: boost(F, nums),
      backProbs: boost(B, nums.filter((n) => n <= B)),
      narrative: `日主天干第 ${dayGan + 1} 位，年干第 ${yearGan + 1} 位，取用神尾数 ${lucky.join('、')}。`,
      confidence: 0.45,
    }
  }, true
)

// ---------------------------------------------------------------- Q04 生肖
const SX = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']
const SX_LUCKY = [
  [2, 11, 20], [1, 10, 19], [3, 12, 21], [4, 13, 22],
  [5, 14, 23], [6, 15, 24], [7, 16, 25], [8, 17, 26],
  [9, 18, 27], [10, 19, 28], [11, 20, 29], [12, 21, 30],
]
export const Q04 = M(
  'Q04', '生肖幸运号',
  '按出生年份定生肖，取该生肖的传统幸运数字。需玄学档案。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    if (!profile.birthDate) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '未填写出生年份，生肖模型退化为均匀分布。', confidence: 0,
      }
    }
    const y = new Date(profile.birthDate).getFullYear()
    const idx = ((y - 4) % 12 + 12) % 12
    const lucky = SX_LUCKY[idx]
    return {
      frontProbs: boost(F, lucky.filter((n) => n <= F), 6),
      backProbs: boost(B, lucky.filter((n) => n <= B), 6),
      narrative: `属${SX[idx]}，传统幸运数字 ${lucky.join('、')}。`, confidence: 0.43,
    }
  }, true
)

// ---------------------------------------------------------------- Q05 塔罗凯尔特十字
const TAROT22 = [
  '愚者', '魔术师', '女祭司', '皇后', '皇帝', '教皇', '恋人', '战车',
  '力量', '隐者', '命运之轮', '正义', '倒吊人', '死神', '节制', '恶魔',
  '高塔', '星星', '月亮', '太阳', '审判', '世界',
]
export const Q05 = M(
  'Q05', '塔罗 · 凯尔特十字',
  '抽出十张牌摆成凯尔特十字牌阵，取正位牌的数字。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const picks = Array.from({ length: 10 }, () => rndInt(22))
    const nums = picks.flatMap((p) => [p + 1, ((p + 1) * 3) % F + 1])
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, picks.map((p) => (p % B) + 1), 5),
      narrative: `凯尔特十字：${picks.slice(0, 5).map((p) => TAROT22[p]).join('、')}…（共十张）`,
      confidence: 0.48,
    }
  }
)

// ---------------------------------------------------------------- Q06 塔罗小阿卡纳
const SUITS = ['权杖', '圣杯', '宝剑', '星币']
export const Q06 = M(
  'Q06', '塔罗 · 小阿卡纳',
  '按四元素花色抽牌，花色对应号段，牌面对应具体号码。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const suit = rndInt(4)
    const face = 1 + rndInt(14)
    const base = Math.floor((suit * F) / 4)
    const nums = [base + face, base + ((face * 2) % 14) + 1, ((face * 3) % F) + 1]
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, [(face % B) + 1, ((face + suit) % B) + 1], 5),
      narrative: `抽到${SUITS[suit]} ${face}，${SUITS[suit]}对应号段 ${base + 1} 起。`,
      confidence: 0.46,
    }
  }
)

// ---------------------------------------------------------------- Q07 生命灵数
export const Q07 = M(
  'Q07', '生命灵数 Numerology',
  '把出生年月日数字逐级归约至 1-9，得生命灵数并配号。需玄学档案。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    if (!profile.birthDate) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '未填写生日，灵数模型退化为均匀分布。', confidence: 0,
      }
    }
    const digits = profile.birthDate.replace(/\D/g, '')
    let s = digits.split('').reduce((a, c) => a + Number(c), 0)
    while (s > 9) s = String(s).split('').reduce((a, c) => a + Number(c), 0)
    const nums: number[] = []
    for (let n = s; n <= F; n += 9) nums.push(n)
    return {
      frontProbs: boost(F, nums, 6),
      backProbs: boost(B, [((s - 1) % B) + 1], 6),
      narrative: `生日 ${digits} 归约得生命灵数 ${s}，配号 ${nums.slice(0, 4).join('、')}。`,
      confidence: 0.44,
    }
  }, true
)

// ---------------------------------------------------------------- Q08 数字根
export const Q08 = M(
  'Q08', '数字根 Digital Root',
  '取期号与日期的数字根，对应号码族。日期驱动，无需输入。',
  ({ lottery, nextDate, history }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const s = nextDate.toISOString().slice(0, 10).replace(/\D/g, '')
    let r = s.split('').reduce((a, c) => a + Number(c), 0)
    while (r > 9) r = String(r).split('').reduce((a, c) => a + Number(c), 0)
    const nums: number[] = []
    for (let n = r; n <= F; n += 9) nums.push(n)
    const issue = history[history.length - 1]?.issue || ''
    const ir = issue.split('').reduce((a, c) => a + Number(c) || 0, 0) % 9 + 1
    return {
      frontProbs: boost(F, [...nums, ir], 5),
      backProbs: boost(B, [((r - 1) % B) + 1, ((ir - 1) % B) + 1], 5),
      narrative: `日期数字根 ${r}，期号数字根 ${ir}，据此配号。`, confidence: 0.42,
    }
  }
)

// ---------------------------------------------------------------- Q09 卢恩符文
const RUNES = ['Fehu', 'Uruz', 'Thurisaz', 'Ansuz', 'Raidho', 'Kaunan', 'Gebo', 'Wunjo',
  'Hagalaz', 'Naudiz', 'Isaz', 'Jera', 'Eihwaz', 'Pertho', 'Algiz', 'Sowilo',
  'Tiwaz', 'Berkanan', 'Ehwaz', 'Mannaz', 'Laguz', 'Ingwaz', 'Dagaz', 'Othala']
export const Q09 = M(
  'Q09', '卢恩符文 Runes',
  '从 24 枚古弗萨克符文中随机抽取三枚，符文序号转号码。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const picks = Array.from({ length: 3 }, () => rndInt(24))
    const nums = picks.flatMap((p) => [p + 1, (p + 1) * 2 % F + 1])
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, picks.map((p) => (p % B) + 1), 5),
      narrative: `抽到 ${picks.map((p) => RUNES[p]).join('、')}（序号 ${picks.map((p) => p + 1).join('、')}）。`,
      confidence: 0.45,
    }
  }
)

// ---------------------------------------------------------------- Q10 卡巴拉
export const Q10 = M(
  'Q10', '卡巴拉生命之树',
  '生命之树 22 条路径对应 22 个数字，按日期随机取径。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const seed = jdnOf(nextDate)
    const paths = [1 + ((seed * 7) % 22), 1 + ((seed * 13) % 22), 1 + ((seed * 3) % 22)]
    const nums = paths.flatMap((p) => [p, ((p * 3) % F) + 1])
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, paths.map((p) => ((p - 1) % B) + 1), 5),
      narrative: `今日路径 ${paths.join('、')}（生命之树 22 径）。`, confidence: 0.43,
    }
  }
)

// ---------------------------------------------------------------- X12 黄历宜忌
export const X12 = M(
  'X12', '黄历宜忌',
  '按当日建除十二神取数，并附上传统宜忌。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const g = dayGanzhi(nextDate)
    const jcIdx = (g.zhi + nextDate.getMonth() + 1) % 12
    const name = JIANCHU[jcIdx]
    const lucky = [jcIdx + 1, jcIdx + 13, jcIdx + 25].filter((n) => n <= F)
    return {
      frontProbs: boost(F, lucky),
      backProbs: boost(B, [(jcIdx % B) + 1]),
      narrative: `今日${name}日，${YIJI[name]}。建除取数 ${lucky.join('、')}。`,
      confidence: 0.42,
    }
  }
)

// ---------------------------------------------------------------- X13 二十八宿
export const X13 = M(
  'X13', '二十八宿',
  '按日期轮转二十八宿，取当日星宿序号配号。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const j = jdnOf(nextDate)
    const idx = ((j % 28) + 28) % 28
    const n = idx + 1
    const nums = [n, ((n + 7) % F) + 1, ((n + 14) % F) + 1, ((n + 21) % F) + 1].filter((x) => x <= F)
    return {
      frontProbs: boost(F, nums),
      backProbs: boost(B, [((n - 1) % B) + 1]),
      narrative: `今日值${XIU[idx]}宿（第 ${n} 宿），配号 ${nums.join('、')}。`,
      confidence: 0.44,
    }
  }
)

// ---------------------------------------------------------------- Q11 梦境数字
export const Q11 = M(
  'Q11', '梦境数字',
  '把你梦到的数字直接当作幸运号。需在玄学档案填写。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const nums = (profile.dreamNumbers || []).filter((n) => n >= 1 && n <= F)
    if (!nums.length) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '还没记录梦境数字。在「档案」页填写后，本模型会直接使用它们。',
        confidence: 0,
      }
    }
    return {
      frontProbs: boost(F, nums, 8),
      backProbs: boost(B, nums.filter((n) => n <= B), 8),
      narrative: `你梦到了 ${nums.join('、')}，就用它们。`, confidence: 0.5,
    }
  }, true
)

// ---------------------------------------------------------------- Q12 民间抽签
export const Q12 = M(
  'Q12', '民间抽签',
  '模拟庙宇签筒，从 1-100 签中随机抽一支，签文序号转号码。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const qian = 1 + rndInt(100)
    const nums = [(qian % F) + 1, ((qian * 2) % F) + 1, ((qian * 3) % F) + 1]
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, [(qian % B) + 1], 5),
      narrative: `抽得第 ${qian} 签，签序转号码。`, confidence: 0.44,
    }
  }
)

export const META_EXT_MODELS: Model[] = [
  X04, X05, X06, X07, X08, X09, X10, X11, Q04,
  Q05, Q06, Q07, Q08, Q09, Q10, X12, X13, Q11, Q12,
]
