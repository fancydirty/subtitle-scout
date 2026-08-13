// web/src/media/EpisodeMark.tsx：R-F12 集号染色的**符号**半边——八态各一个内联 SVG。
//
// ── 为什么是内联 SVG 而不是 Unicode 文本（设计文档 §4.3 裁决）────────────────────
// `···`(U+22EF) 与 `⇄`(U+21C4) 在等宽字体里的字宽与基线都不一致（前者是标点宽、后者是
// 全角箭头），塞进 `E01 ✓` 这种集号格里会让同一行的八种态**互相错位**——一屏 40 张卡时
// 抖动极其明显。SVG 是固定 12×12 盒子，八个态占位逐像素相同。
//
// 规格照 shell/NavIcons.tsx 的既有约定（那份是 18×18/1.8px）：
//   · viewBox 12×12（集号格比导航图标小一号，与 13px mono 集号视觉等高）
//   · 笔画 1.8px、`stroke="currentColor"`——**颜色不在这里定**，由外层 .media-ep-num
//     按 data-state 上色（组件层不写死任何色值，同 activity/ 的 data-tone 既有手法）
//   · strokeLinecap/Join round：1.8px 在 12px 盒子里是粗笔画，方角端点会糊成方块
//
// ── Carbon 双通道（R-F12 的立论依据）───────────────────────────────────────
// 状态 = **颜色 + 形状**两个通道。这个文件负责形状那一半，缺了它就退化成"只靠颜色"——
// 对色盲无效、对屏幕阅读器不可见。所以 `absent` 之外的八态**每一个都必须有可分辨的形状**，
// 不许出现两个态共用同一个图形只换颜色。EpisodeMark.test.tsx 有一条"八个态的图形两两不同"
// 的用例钉着这条。
//
// ── 无障碍 ───────────────────────────────────────────────────────────────
// SVG 自身 aria-hidden（它是装饰性的形状通道），语义走外层 EpisodeCell 的 aria-label
// （"E01 已配字幕"整句），避免屏幕阅读器把符号和集号读成两个割裂的片段。
import type { ReactElement } from 'react'
import type { EpisodeState } from '../api/types.js'

/** 除 absent 外的七态——absent 不画符号（虚线格不染色，R-F12），故从这个联合里排除。 */
export type MarkState = Exclude<EpisodeState, 'absent'>

const STROKE = 1.8

/** 八态的符号语义（设计文档 §4.3）：
 *    covered ✓ / translating ⇄ / unsolvable ⊘ / origin-skip ◇ / embedded ◆ /
 *    extra ▭ / pending ··· / unjudged ? / absent（不画）
 *
 *  ⚠️ **每个 case 的返回值就是那个态的判据本身**——把 covered 的 ✓ 写成 ◇ 不会有任何
 *  类型错误，只会让用户看到一个与事实相反的标记。EpisodeMark.test.tsx 逐态断言几何。
 *
 *  ⚠️ 返回类型显式标注 `ReactElement`（不是让 TS 推断）+ 末尾 `never` 守卫，两者缺一不可：
 *  没有它们时删掉任意一个 case，switch 会**静默推出 `| undefined`**（无 default、无显式
 *  返回类型），`tsc` 退出码 0 —— 本文件头上"第九态时 TS 立刻报错"那句话在这一处曾经不成立
 *  （审计实测：删 `case 'extra'` → tsc 通过，只有 3 条用例红）。
 *  显式返回类型让"漏一个 case"在**这一行**就报 TS2366（不是等运行期渲染出空白），
 *  never 守卫让"加了第十态"在**赋值那一行**就报 TS2322 并指出漏了哪个态。 */
function shapeOf(state: MarkState): ReactElement {
  switch (state) {
    // ✓ 对勾：两段折线，先下后上（右上角收笔明显高于起笔——这是"勾"与"折角"的区别）。
    case 'covered':
      return <path d="M2.2 6.4 L4.7 9 L9.8 3.2" fill="none" />
    // ⇄ 双向箭头：上行向右、下行向左。**两个箭头必须反向**——同向就成了 ⇉（"都在往一个
    // 方向走"），而这个态说的是"送出去翻译、译回来"的往返。
    case 'translating':
      return (
        <>
          <path d="M1.6 4.2 H10.4 M8.4 2.4 L10.4 4.2 L8.4 6" fill="none" />
          <path d="M10.4 8.2 H1.6 M3.6 6.4 L1.6 8.2 L3.6 10" fill="none" />
        </>
      )
    // ⊘ 禁止/停牌：圆 + 一道对角斜杠（左上→右下）。
    case 'unsolvable':
      return (
        <>
          <circle cx="6" cy="6" r="4.2" fill="none" />
          <path d="M3 9 L9 3" fill="none" />
        </>
      )
    // ◇ 空心菱形：原生就是目标语言，压根不需要字幕（"这里本来就没东西要做"→ 空心）。
    case 'origin-skip':
      return <path d="M6 1.6 L10.4 6 L6 10.4 L1.6 6 Z" fill="none" />
    // ◆ 实心菱形：自带内嵌轨（"东西已经在里面了"→ 实心）。与 ◇ 同一个轮廓、**只差填充**
    // 是有意的：两者是同一族"不需要外挂字幕"的事实，实/空表达"有内容 / 没内容"。
    // 填充用 currentColor 而非 stroke——否则实心与空心在小尺寸下几乎看不出差别。
    case 'embedded':
      return <path d="M6 1.6 L10.4 6 L6 10.4 L1.6 6 Z" fill="currentColor" stroke="none" />
    // ▭ 空心横矩形：机械特典（NCOP/NCED/PV/menu），"不算在找字幕的范围"。
    // 形状选横向矩形而不是再来一个菱形/圆：它与 ◇◆ 同属"不用操心"一族，但**理由不同**
    // （那两个是"不需要字幕"，这个是"这东西压根不算数"），共用轮廓会让人以为是同一件事。
    // 横宽比 2:1 是刻意的——在 12px 盒子里它与 ◇ 的方向感正交，余光扫过就能分辨。
    case 'extra':
      return <rect x="1.6" y="3.6" width="8.8" height="4.8" rx="0.8" fill="none" />
    // ··· 三点：排队等找字幕。三个实心点，水平居中等距。
    case 'pending':
      return (
        <>
          <circle cx="2" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="10" cy="6" r="1" fill="currentColor" stroke="none" />
        </>
      )
    // ? 问号：系统答不上来。上半是钩、下面一个独立的点（问号的点与钩分离是它的辨识特征，
    // 连成一笔就成了 "2"）。
    case 'unjudged':
      return (
        <>
          <path d="M3.6 4 A2.4 2.4 0 1 1 6 7.2 V8" fill="none" />
          <circle cx="6" cy="10.2" r="0.9" fill="currentColor" stroke="none" />
        </>
      )
  }
  // 编译期穷尽守卫。走到这里说明 MarkState 多了一个上面没处理的态：`state` 此时的类型
  // 是 never，赋给 never 变量成立；一旦漏了 case，它的类型就是那个漏掉的字面量联合，
  // 赋值立刻 TS2322 且错误信息直接点名漏了谁。
  // 运行期 throw 不是装饰：JS 侧真传进一个未知态时，返回 undefined 会让 React 渲染出一个
  // 空 svg（用户看到没有符号的集号格，且无人报错），抛错至少是可见的。
  const _exhaustive: never = state
  throw new Error(`EpisodeMark: 未处理的态 ${String(_exhaustive)}`)
}

/** 一个 12×12 的状态符号。`absent` 传进来返回 null——**虚线格不染色**（R-F12），
 *  调用方不需要自己判空。 */
export function EpisodeMark({ state }: { state: EpisodeState }) {
  if (state === 'absent') return null
  return (
    <svg
      className="media-ep-mark"
      data-state={state}
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth={STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      {shapeOf(state)}
    </svg>
  )
}
