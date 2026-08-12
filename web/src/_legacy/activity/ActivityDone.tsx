// web/src/activity/ActivityDone.tsx：活动页的「刚刚完成」段。
//
// spec §3 骨架里的第三块：
//   ├──────────────────────────────────────┤
//   │ 刚刚完成 (n)                          │
//   │  38px海报 │ 剧名 · 装了M集 │ 查看     │
//   └──────────────────────────────────────┘
//
// 用户裁决，写死在这个文件里（不许自行放宽）：
//
// L6 **字幕齐了不写字说「齐了」**，只显示完成列表。用户原话：Steam 只显示完成列表。
//    落地方式是这个组件**只会渲染列表**——它没有任何"全部完成 / 都齐了 / 一切正常"的分支，
//    连一个可以被填上那句话的横幅槽位都不存在。测试有回归锁扫那一族断言句。
//    这条比它看起来更容易被改坏：「列表非空 = 一切正常，加个绿横幅更友好」是个极自然的
//    "改进"，而它恰恰是用户明确否掉的东西。
//
// L1 **只有绿和红，没有黄**。行首那个 6px 语义点的颜色走 decisionPhrase(decision).tone：
//    ok → 绿、bad → 红、neutral → **灰**（不是黄）。tone 与语言无关（phrases.ts 已如此实现），
//    所以这条在中英同时成立。颜色分支全在 CSS 里按 data-tone 选，本组件不写死任何色值。
//    注意"没找到能放心用的字幕"是 neutral（灰）不是红——铁律④的既有口径：等待/失败是面向
//    下一步的中性事实，红只给真故障，且红只染点不铺块。
//
// L3 **不暴露机械**：行文案说"字幕已装好"，不说"worker 完成 3 个 install_subtitle"。人话由
//    workflow/phrases.ts 的 decisionPhrase 负责——它已双语化，本层只调用。未登记的 decision
//    词它会原样回显（诚实降级，见 phrases.ts 的论证），**不要在这一层"美化"掉**。
//
// 铁律②零数字：**不显示 llmCalls**（DTO 里带着这个字段——审计 UX-P0 加的成本账本，是三泳道
//    账本页 ActivityRow 的成本后缀）。它是内部计量值，铁律②明确排除。这里刻意连读都不读，
//    测试有回归锁：llmCalls 有值时 DOM 里不许出现那个数字。
//    在场的数字只有相对时间（"2 分钟前"——时间事实，判据 5 允许）。
//
// 「查看」按钮：spec §3 里它对位 Steam 的 `▶ Play`——一个**有用的动作**（去看这个条目现在什么
//    样），而不是"忽略/关掉"。本任务只负责触发 onOpen 回调；具体跳去哪由接线任务决定
//    （RunDetail 仍在、Library 详情页也在，选哪个是接线时的路由决策，不是这一层的事）。
//    onOpen 缺席时**整个按钮不渲染**——一个点不动的按钮比没有按钮更糟（同 L11 的精神）。
import { Button } from '../../components/ui/button.js'
import { useT } from '../../i18n/useT.js'
import type { WorkflowRecentRunDTO } from '../../api/types.js'
import { PosterThumb } from '../library/PosterThumb.js'
import { decisionPhrase } from '../workflow/phrases.js'
import { doneHeading, openLabel, relativeFinished } from './text.js'

interface Props {
  /** WorkflowWorkersDTO.recent[]。 */
  recent: readonly WorkflowRecentRunDTO[]
  /** 渲染时刻，算相对时间用。由调用方注入（不在组件内读 Date.now），同 ActivityHero 的口径。 */
  now: number
  /** 「查看」被点。缺席 → 不渲染按钮（见文件头）。 */
  onOpen?: (row: WorkflowRecentRunDTO) => void
}

function DoneRow({ row, now, onOpen }: { row: WorkflowRecentRunDTO; now: number; onOpen?: (r: WorkflowRecentRunDTO) => void }) {
  const { lang } = useT()
  // 主语：剧名优先、片名兜底、都没有就降级 id——同 hero 的诚实兜底口径。
  const title = row.seriesName ?? row.movieName ?? row.seriesId ?? row.movieId ?? ''
  // decision 为 null（历史行/未写决策）时不编一个语气出来：走 decisionPhrase 的兜底会把
  // 'null' 这个字符串糊到界面上，所以这里直接不渲染短语与语义点，只留主语 + 时间。
  const phrase = row.decision === null ? null : decisionPhrase(row.decision, lang)
  return (
    // flex 承重：.act-row-poster{flex:none} 与 .act-row-main{flex:1} 写在 CSS 里、指望父级是
    // flex 容器，而 .act-row 自己在 CSS 里没有 display（Task 14 已核实）。.act-row-main 的
    // flex:1 就是把时间与「查看」推到右侧的那股力。
    <div className="act-row flex items-center gap-3" data-testid="activity-done-row">
      {/* 与队列行同一个几何（38px 2:3，.act-row-poster）——spec §7.1 要求完成列表"用与 hero
          同几何的海报"，而 hero:队列的 5:1 尺寸比是靠这一档 38px 建立的。 */}
      <div className="act-row-poster" data-testid="activity-done-poster">
        <PosterThumb posterPath={row.posterPath} name={title} />
      </div>
      <div className="act-row-main">
        <span className="text-[13px] leading-5">{title}</span>
        {phrase ? (
          // ⚠️ 这个 flex 是**承重**的，不是装饰：.act-row-dot 在 CSS 里没有 display
          // （styles.css:1659 起只有 width/height/border-radius/flex/background），而它是个
          // <span>。inline 元素忽略 width/height——那个 6px 的圆全靠它作为 flex item 被
          // blockify。删掉 flex，点会整个消失，而 L1 那 8 条 data-tone 断言照绿。
          <div className="flex items-center gap-2">
            {/* 语义点：绿/红/灰三档，**没有黄**（L1）。颜色按 data-tone 在 CSS 里选，
                组件层不写死色值——同 hero 脉动点的既有手法。红只染这个 6px 点，不铺块。 */}
            <span
              className="act-row-dot"
              data-tone={phrase.tone}
              aria-hidden="true"
              data-testid="activity-done-dot"
            />
            {/* 不给颜色类：.act-row-fact 已在 styles.css 里给 --color-weak，且 styles.css 全文
                未分层，赢过 @layer utilities 里的任何 text-* 工具类（给了不生效）。 */}
            <span className="act-row-fact font-mono text-[13px] leading-5">{phrase.text}</span>
          </div>
        ) : null}
      </div>
      {/* 相对时间。finishedAt 为 null（理论上不该出现在 recent 里）时不渲染——不编"刚刚"。 */}
      {row.finishedAt !== null ? (
        <span
          className="act-row-time font-mono text-[13px] leading-5"
          data-testid="activity-done-time"
        >
          {relativeFinished(now - row.finishedAt, lang)}
        </span>
      ) : null}
      {onOpen ? (
        // shadcn Button 的文案走 children，**没有 label prop**（Astryx 有）。忘了搬会得到一个
        // 空按钮——好在那是"自己会喊"的：按可及名取按钮的两条用例当场变红。
        <Button size="sm" variant="ghost" onClick={() => onOpen(row)}>
          {openLabel(lang)}
        </Button>
      ) : null}
    </div>
  )
}

export function ActivityDone({ recent, now, onOpen }: Props) {
  const { lang } = useT()
  // 空 → 整段不渲染（同队列段：不给"暂无"占位）。
  if (recent.length === 0) return null

  return (
    // ⚠️ 这个 section 里**只有**标题 + 列表。没有横幅、没有总结句、没有"全部完成"——L6。
    <section className="act-section" data-testid="activity-done">
      {/* .act-section-head 在 CSS 里只有 width/padding，没有 display。注意这里**没有**
          justify-between（原文也没有 hAlign）——本段头只有一个子元素，队列段那个才是两端对齐。 */}
      <div className="act-section-head flex items-center">
        {/* 这一处**要**给颜色类：.act-section-head 里没人管颜色，原 color="secondary" 是真在
            生效的 #9aa1ac = text-muted-foreground。 */}
        <span className="text-[13px] leading-5 text-muted-foreground">{doneHeading(recent.length, lang)}</span>
      </div>
      {recent.map((row) => (
        // key 走 row.id（run 的身份键，恒唯一）。**不用数组下标**：recent 是滑动窗口，
        // 新 run 从头部进来会把每个下标对应的数据整体错位一格，React 会把旧 DOM 节点连同
        // 它的状态（PosterThumb 的 failed）复用给另一条 run——于是一张加载失败的海报会
        // 传染给一个本来有图的条目。同 ConveyorFeed 的既有论证。
        <DoneRow key={row.id} row={row} now={now} onOpen={onOpen} />
      ))}
    </section>
  )
}
