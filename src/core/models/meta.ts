import type { Prediction } from '../../types'
import { RULES } from '../lottery'
import { normalize, rndInt, type Model, type ModelCtx } from './types'

/**
 * 玄学 / 趣味 共用一个工厂，按编号前缀自动归类：
 * id 以 X 开头 = 玄学（中国传统术数命理），以 Q 开头 = 趣味（西方神秘学 / 生活化 / 随机玩法）。
 */
const M = (
  id: string, name: string, desc: string,
  predict: (c: ModelCtx) => Prediction, needsProfile = false
): Model => ({ meta: { id, name, category: id[0] === 'Q' ? 'fun' : 'meta', desc, needsProfile }, predict })

const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']

/** 公历转儒略日序 */
function jdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  return (
    d + Math.floor((153 * mm + 2) / 5) + 365 * yy +
    Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
  )
}

/** 日干支：0 = 甲子。通用儒略日推算，娱乐用途。 */
export function dayGanzhi(date: Date) {
  const idx = (jdn(date.getFullYear(), date.getMonth() + 1, date.getDate()) + 49) % 60
  return { gan: idx % 10, zhi: idx % 12, idx, name: GAN[idx % 10] + ZHI[idx % 12] }
}

/** 给指定号码加权，其余为 1 */
export function boost(size: number, nums: number[], weight = 4): number[] {
  const arr = new Array(size).fill(1)
  for (const n of nums) if (n >= 1 && n <= size) arr[n - 1] = weight
  return normalize(arr)
}

/** 天干/地支序号映射到 1-33 号码池 */
function spread(base: number, size: number, step: number): number[] {
  const out: number[] = []
  for (let n = base; n <= size; n += step) out.push(n)
  return out.length ? out : [Math.max(1, base % size)]
}

// ---------------------------------------------------------------- X01 天干地支
export const X01 = M(
  'X01', '天干地支 · 日柱',
  '以开奖日干支起局，天干序号取红球、地支取蓝球。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const g = dayGanzhi(nextDate)
    const frontNums = [...spread(g.gan + 1, F, 10), ...spread(g.zhi + 1, F, 12)]
    const backNums = [(g.zhi % B) + 1, ((g.zhi + 6) % B) + 1]
    return {
      frontProbs: boost(F, frontNums),
      backProbs: boost(B, backNums),
      narrative: `${nextDate.toISOString().slice(0, 10)} 日柱为「${g.name}」，天干${GAN[g.gan]}配红球、地支${ZHI[g.zhi]}配蓝球。`,
      confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- X02 五行生克
const ELEMENT = ['木', '火', '土', '金', '水']
export const X02 = M(
  'X02', '五行生克',
  '号码按尾数配五行，取当日天干五行所生之数。日期驱动，无需输入。',
  ({ lottery, nextDate }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const g = dayGanzhi(nextDate)
    const self = Math.floor(g.gan / 2) // 0木 1火 2土 3金 4水
    const born = (self + 1) % 5 // 我所生者
    // 尾数配五行：1,2木 3,4火 5,6土 7,8金 9,0水
    const tailMap = [1, 1, 3, 3, 5, 5, 7, 7, 9, 9] // 尾数 -> 代表数字
    const lucky = [tailMap[born * 2], tailMap[born * 2 + 1]]
    const nums: number[] = []
    for (let n = 1; n <= F; n++) if (lucky.includes(n % 10)) nums.push(n)
    return {
      frontProbs: boost(F, nums),
      backProbs: boost(B, nums.filter((n) => n <= B)),
      narrative: `日干${GAN[g.gan]}属${ELEMENT[self]}，${ELEMENT[self]}生${ELEMENT[born]}，取${ELEMENT[born]}对应尾数 ${lucky.join('、')}。`,
      confidence: 0.48,
    }
  }
)

// ---------------------------------------------------------------- X03 周易金钱卦
export const X03 = M(
  'X03', '周易 · 金钱卦',
  '模拟三枚铜钱掷六次起六爻卦，卦序转号码。程序化揲蓍。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    // 每爻 6老阴 7少阳 8少阴 9老阳
    const yao = Array.from({ length: 6 }, () => [6, 7, 8, 9][rndInt(4)])
    const trigram = (a: number[]) => {
      const bits = a.map((v) => (v === 7 || v === 9 ? 1 : 0))
      return (bits[0] << 2) | (bits[1] << 1) | bits[2]
    }
    const up = trigram(yao.slice(0, 3))
    const down = trigram(yao.slice(3, 6))
    const gua = up * 8 + down + 1 // 1..64
    const nums = [gua, ((gua * 2) % F) + 1, ((gua * 3) % F) + 1, ((gua + 11) % F) + 1]
    return {
      frontProbs: boost(F, nums, 5),
      backProbs: boost(B, [((gua % B) + 1)], 5),
      narrative: `六爻 ${yao.join(' ')}，得第 ${gua} 卦（上卦${up + 1} 下卦${down + 1}），卦序转号。`,
      confidence: 0.52,
    }
  }
)

// ---------------------------------------------------------------- Q01 星座运势
const ZODIAC: { end: [number, number]; name: string; lucky: number[] }[] = [
  { end: [1, 19], name: '摩羯', lucky: [10, 20, 30] },
  { end: [2, 18], name: '水瓶', lucky: [11, 22, 33] },
  { end: [3, 20], name: '双鱼', lucky: [12, 24] },
  { end: [4, 19], name: '白羊', lucky: [9, 18, 27] },
  { end: [5, 20], name: '金牛', lucky: [6, 15, 24] },
  { end: [6, 21], name: '双子', lucky: [5, 14, 23] },
  { end: [7, 22], name: '巨蟹', lucky: [2, 11, 20] },
  { end: [8, 22], name: '狮子', lucky: [1, 10, 19] },
  { end: [9, 22], name: '处女', lucky: [4, 13, 22] },
  { end: [10, 23], name: '天秤', lucky: [7, 16, 25] },
  { end: [11, 22], name: '天蝎', lucky: [8, 17, 26] },
  { end: [12, 21], name: '射手', lucky: [3, 12, 21] },
  { end: [12, 31], name: '摩羯', lucky: [10, 20, 30] },
]

function zodiacOf(birth: string) {
  const d = new Date(birth)
  if (isNaN(d.getTime())) return null
  const m = d.getMonth() + 1
  const day = d.getDate()
  for (const z of ZODIAC) if (m < z.end[0] || (m === z.end[0] && day <= z.end[1])) return z
  return ZODIAC[0]
}

export const Q01 = M(
  'Q01', '星座运势',
  '12 星座每日幸运数字。需在玄学档案填写生日。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const z = profile.birthDate ? zodiacOf(profile.birthDate) : null
    if (!z) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '未填写生日，星座模型退化为均匀分布。可在玄学档案补充。',
        confidence: 0,
      }
    }
    return {
      frontProbs: boost(F, z.lucky, 6),
      backProbs: boost(B, z.lucky.filter((n) => n <= B), 6),
      narrative: `你的太阳星座是${z.name}座，今日幸运数字 ${z.lucky.join('、')}。`,
      confidence: 0.45,
    }
  }, true
)

// ---------------------------------------------------------------- Q02 塔罗
const TAROT = [
  '愚者', '魔术师', '女祭司', '皇后', '皇帝', '教皇', '恋人', '战车',
  '力量', '隐者', '命运之轮', '正义', '倒吊人', '死神', '节制', '恶魔',
  '高塔', '星星', '月亮', '太阳', '审判', '世界',
]
export const Q02 = M(
  'Q02', '塔罗 · 大阿卡纳',
  '22 张大阿卡纳随机抽三张构成牌阵，牌序转号码。',
  ({ lottery }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    const picks = [rndInt(22), rndInt(22), rndInt(22)]
    const nums = picks.flatMap((p) => [p + 1, ((p + 1) * 2) % F + 1])
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, picks.map((p) => (p % B) + 1), 5),
      narrative: `抽到「${picks.map((p) => TAROT[p]).join('」「')}」，牌序 ${picks.map((p) => p + 1).join('、')} 转号码。`,
      confidence: 0.5,
    }
  }
)

// ---------------------------------------------------------------- Q03 姓名笔画
const STROKES: Record<string, number> = {
  王: 4, 李: 7, 张: 11, 刘: 15, 陈: 16, 杨: 13, 黄: 12, 赵: 14, 周: 8, 吴: 7,
  徐: 10, 孙: 10, 马: 10, 朱: 6, 胡: 11, 郭: 15, 何: 7, 高: 10, 林: 8, 罗: 19,
  郑: 19, 梁: 11, 谢: 17, 宋: 7, 唐: 10, 许: 11, 韩: 17, 冯: 12, 邓: 19, 曹: 11,
  彭: 12, 曾: 12, 肖: 19, 田: 5, 董: 15, 袁: 10, 潘: 15, 蒋: 17, 蔡: 17, 余: 7,
  杜: 7, 叶: 15, 程: 12, 苏: 22, 魏: 18, 吕: 11, 丁: 2, 任: 6, 沈: 8, 姚: 9,
  卢: 16, 姜: 9, 崔: 11, 钟: 17, 谭: 19, 陆: 16, 汪: 8, 范: 15, 金: 8, 石: 5,
}
function strokeSum(name: string): number {
  let s = 0
  for (const ch of name) s += STROKES[ch] ?? 8
  return s
}

export const Q03 = M(
  'Q03', '姓名笔画',
  '按姓名笔画数配号。需在玄学档案填写姓名。',
  ({ lottery, profile }) => {
    const { frontMax: F, backMax: B } = RULES[lottery]
    if (!profile.name) {
      return {
        frontProbs: normalize(new Array(F).fill(1)),
        backProbs: normalize(new Array(B).fill(1)),
        narrative: '未填写姓名，笔画模型退化为均匀分布。可在玄学档案补充。',
        confidence: 0,
      }
    }
    const sum = strokeSum(profile.name)
    const nums = [sum % F + 1, (sum * 2) % F + 1, (sum + 7) % F + 1, (sum % 11) + 1]
    return {
      frontProbs: boost(F, nums.filter((n) => n >= 1 && n <= F), 5),
      backProbs: boost(B, [(sum % B) + 1], 5),
      narrative: `「${profile.name}」共 ${sum} 画，笔画数转号码。`,
      confidence: 0.42,
    }
  }, true
)

export const META_MODELS: Model[] = [X01, X02, X03, Q01, Q02, Q03]
