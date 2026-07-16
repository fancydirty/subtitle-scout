import {defineTheme} from '@astryxdesign/core/theme'

/** subtitle-scout 官方深色主题（dark-only，light 位同值）——spec §2 设计语言的 token 落地，
 *  改这里必须先读 web/DESIGN.md（每个值的出处与禁令都在那儿）。改完跑 `npm run theme:build`
 *  重新编译 scout.css/scout.d.ts/scout.js（三个产物随源码一并提交——运行期只消费产物，
 *  构建产线不装 @astryxdesign/cli 也能跑）。
 *
 *  token 名是 Astryx 的强类型面（--color-background-body/card/surface 一族，不是自创名）——
 *  写错 TS 直接报，别猜，`./node_modules/.bin/astryx docs tokens` 查全表。 */
export const scoutTheme = defineTheme({
  name: 'scout',
  // 单 accent：lime——每屏至多一处亮色（DESIGN.md 铁律，出处 v2 mockup + Trigger.dev 手法）。
  color: {accent: '#a3e635', neutralStyle: 'cool'},
  typography: {
    // 正文 13px；ratio 1.2 的几何阶梯给 heading。
    scale: {base: 13, ratio: 1.2},
    // mono 是技术层专属声音（路径/ID/时长/时间戳/语言码）——正文绝不 mono。
    code: {family: 'Geist Mono', fallbacks: 'ui-monospace, SFMono-Regular, Menlo, monospace'},
  },
  radius: {base: 4, multiplier: 1},
  tokens: {
    // canvas 近黑微冷 + surface 阶梯（body < card < surface 逐级抬升一档）。
    '--color-background-body': ['#0b0c0f', '#0b0c0f'],
    '--color-background-card': ['#111318', '#111318'],
    '--color-background-surface': ['#16181f', '#16181f'],
    // hairline 半透明白——深色下零 drop-shadow，层级全靠 1px 发丝线与 surface 阶梯。
    '--color-border': ['rgba(255,255,255,0.07)', 'rgba(255,255,255,0.07)'],
    // ink 阶梯（4 级）：primary 主文本 / secondary 次文本 / gray 弱化 / disabled 失效。
    '--color-text-primary': ['#e6e8ec', '#e6e8ec'],
    '--color-text-secondary': ['#9aa1ac', '#9aa1ac'],
    '--color-text-gray': ['#6b7280', '#6b7280'],
    '--color-text-disabled': ['#4b5563', '#4b5563'],
    // 语义色只给状态词与 6px 圆点——排队/中性/取消一律灰（不是黄，不是蓝）。
    '--color-text-green': ['#28bf5c', '#28bf5c'],
    '--color-text-orange': ['#e8a33d', '#e8a33d'],
    '--color-text-red': ['#e11d48', '#e11d48'],
  },
})
