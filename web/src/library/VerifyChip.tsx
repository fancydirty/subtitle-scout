// web/src/library/VerifyChip.tsx：字幕校验状态芯片（2026-07-30 spec）——挂在逐集行上，
// 告诉用户这一集的字幕时间轴对不对得上。
//
// 三态，其中只有两种会渲染出东西（用户裁决，写死）：
//  - checked=false        → 渲染 null。还没查过就别装作查过了——空白是诚实的
//  - state='ok'           → 绿点，纯展示不可点。含"验过没问题"与"没能验证"两档
//  - state='shifted'      → 红字芯片，可点，点开检视面板
//
// 为什么没有黄色：用户裁决原话"黄色会让用户觉得这项目有病"。"没能验证"（无参考源/
// 分数太低）在后端就被映射成 'ok' 走绿色——诚实体现在**不假装验证过**，而不是打一个
// 黄标让用户对着一堆自己无从判断的警告发愁。前端因此拿不到"无法验证"这个信息，
// 这是故意的：拿不到就不可能渲染出第三种颜色。
//
// 为什么绿态只有一个点、没有文字：绿是"安静"状态。写"时间轴正常"是一句兑现不了的承诺
// （我们只比对了说话时段，不保证内容对得上），而且会让整季 24 行全都挂一句废话。
// 文字留给 aria-label，屏幕阅读器需要它，视线不需要。
//
// 不用眼睛图标：用户裁决原话"拟人化的太吓人了"。
import type { SubtitleVisualState } from '../api/types.js'
import { useT } from '../i18n/useT.js'

interface Props {
  state: SubtitleVisualState
  checked: boolean
  /** 仅 state='shifted' 时接线。缺席时红芯片降级为不可点的纯展示（父组件还没准备好面板）。 */
  onInspect?: () => void
}

export function VerifyChip({ state, checked, onInspect }: Props) {
  const { t } = useT()

  // 从未检测过 → 什么都不渲染。注意这一条必须早于 state 判断：后端对未检测条目
  // 也给 state='ok'（类型上只有两态），若先看 state 就会把没查过的集子渲染成绿色，
  // 那是在替系统撒谎说"查过了，没问题"。
  if (!checked) return null

  if (state === 'ok') {
    // 纯展示的 span，不是 button——绿态没有任何可做的事，给它键盘焦点只会让
    // Tab 键在一整季的绿点上空转 24 次。
    return (
      <span
        className="library-eprow-verify library-eprow-verify-ok"
        role="img"
        aria-label={t('library_verify_ok')}
        data-testid="verify-chip-ok"
      />
    )
  }

  return (
    <button
      type="button"
      className="library-eprow-verify library-eprow-verify-shifted"
      onClick={onInspect}
      disabled={onInspect === undefined}
      data-testid="verify-chip-shifted"
    >
      {t('library_verify_shifted')}
    </button>
  )
}
