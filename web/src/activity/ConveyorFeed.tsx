// web/src/activity/ConveyorFeed.tsx：活动页的传送带——滚动的事件流。agent 每做一步多一行，
// 新行从底部进来把旧行往上顶，顶出容器上边界就消失。
//
// **目的是缓解焦虑**（让用户看到"在动"），不是取证。取证归真实日志——所以这里只显示人话短语，
// 不显示 argsSummary/tookMs/seq 之类的工程值，也不提供滚回去看历史的入口。
//
// 三条用户裁决，写死在这个文件里（不许自行放宽）：
//
// L8 方向：新事件把列**往上顶**，旧的被顶出去。不是原地淡出。
//
// L9 硬出，不做渐隐遮罩（用户原话："那个蒙版遮罩不如去掉，直接硬出"）。硬出有一个必须处理的
//    细节：行被容器上边界切一半会很难看（半个字浮在边界上）。解法是让位移**严格按整行步进**——
//    每次 ROW_H=20px（一行高），容器高度也取整数行（rows × 20px）。这样行要么完整可见、
//    要么完全在界外，永不切半行。
//    副作用好处：位移量恒为 `-20px × 溢出行数`，是个可以纯算出来的数——**不需要测量 DOM 高度**
//    （getBoundingClientRect / offsetHeight 那类读取会强制同步 layout，是 layout thrash 的常见
//    来源；这里一次都不读）。
//
// 亮度分级用 :nth-last-child(1..4) 由亮到暗、n+5 最暗，且**用颜色不是 opacity**（状态→颜色，
//    同 ai-elements ChainOfThought 的口径）。分级规则整个在 CSS 里，见 styles.css 末尾。
//
// 只动新行：容器 bottom-pinned + 行走正常文档流，旧行由 compositor 随 track 的 transform 自然
//    上移，**不对"被顶走"做动画**（assistant-ui reasoning.tsx 的做法——动画只给新行）。落地方式
//    是把入场动画挂在 .conveyor-row 本身：CSS 动画在元素挂载时跑一次就结束，旧行不会重播；
//    track 的 transform 则**故意没有 transition**，位移是瞬时的。零动效依赖，纯 CSS keyframes。
//
// ⚠️ bottom-pin 由 transform 一家做，**不叠 CSS 的 justify-content:flex-end**。规格原文把
//    "容器 bottom-pinned"和"位移 -20px × 溢出行数"并列成两件事，但在真实浏览器里这两者会
//    **双重位移**：overflow:hidden 的 flex 列在 flex-end 下已经把溢出部分推出上边界了（7 行/
//    4 行窗口时可见 row3..6，本身就正确），再叠 -60px 会只剩 row6 + 底部三行空白（已在
//    headless Chromium 实测：flexend-only → [3,4,5,6]，flexend+transform → [6]）。
//    这里改用一条统一表达式 `(visible - n) × ROW_H`：
//      - n > visible 时值为负，恰好等于规格要求的 -ROW_H × 溢出行数（裁决口径逐字不变）；
//      - n < visible 时值为正，把不满屏的列压到底部（这就是 flex-end 本来要做的事）。
//    一条式子同时满足两个性质，且每个取值都是 ROW_H 的整数倍——整行步进的不变量无条件成立，
//    仍然零 DOM 测量。实测四种规模（n=0/2/4/7/120）均 halfCut=false 且末行底边恒贴容器底边。
//
// 无障碍：容器 role="log"（WCAG ARIA23）。该规范**明确允许旧信息消失**，所以传送带合规。
//    不加 aria-live="assertive"——role="log" 已隐含 polite；assertive 会把每条痕迹打断式念出来，
//    对一个每秒可能多行的事件流来说是纯噪音。
//
// 铁律③（不暴露机械）由 toolPhrase 负责，本层只管调用。注意它对**未登记工具原样返回裸工具名**，
// 那是故意的诚实降级（见 phrases.ts 的说明），不要在这一层"美化"掉。
import type { TraceEvent } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { toolPhrase } from '../workflow/phrases.js'

/** 一行的高度，px。CSS 里的 .conveyor-row{height/line-height} 必须与这个常量一致——两边一起
 *  构成"整行步进"这个不变量（L9）。改一处不改另一处会立刻切出半行。 */
export const ROW_H = 20

interface Props {
  events: readonly TraceEvent[]
  /** 可见行数，默认 4。容器高 = rows × 20px。 */
  rows?: number
}

export function ConveyorFeed({ events, rows = 4 }: Props) {
  const { lang } = useT()
  // 取整并至少 1 行：容器高度必须是 ROW_H 的整数倍（整行步进的前提），调用方传 4.5 或 0
  // 不该把这个不变量破掉。这里静默夹紧而不抛错——传送带是安抚性装饰，不值得炸掉整个 hero。
  const visible = Math.max(1, Math.floor(rows))
  // 位移：负值 = 把溢出行顶出上边界（-ROW_H × 溢出行数，同裁决口径）；正值 = 把不满屏的列压到
  // 容器底部（bottom-pin）。纯算术，零 DOM 测量（见文件头 L9 与 ⚠️ 段）。
  const offset = (visible - events.length) * ROW_H
  return (
    <div
      className="conveyor"
      role="log"
      data-testid="conveyor"
      style={{ height: `${visible * ROW_H}px` }}
    >
      <div
        className="conveyor-track"
        style={{ transform: `translateY(${offset}px)` }}
      >
        {events.map((e) => (
          // key 必须带 runKey（同 web/src/workflow/TraceRows.tsx:36 的既有口径）：realign 的
          // 混流合法地含多个 seq=0（各子集 runKey 的 seq 都从 0 起算），纯 seq 会撞 React key。
          // 更要紧的是**不许用数组下标**：事件流是滑动窗口（前端会掐掉过老的行），下标 key 会让
          // 同一条事件在重渲染后落到另一个 DOM 节点上，于是入场动画对着一堆旧行重播。
          <div className="conveyor-row" key={`${e.runKey}#${e.seq}`}>
            {toolPhrase(e.tool, lang)}
          </div>
        ))}
      </div>
    </div>
  )
}
