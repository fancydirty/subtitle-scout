// web/src/activity/ActivityStuck.tsx：活动页的卡死/出问题态——「fail-closed 拦下的活」怎么显示
// （spec §7.2）。
//
// ── 这里有一个真实的设计张力，不是需求写得含糊 ──────────────────────────────────
//
// 裁决 L7：**不做「点开看 trace」**。用户原话：那是「青黄不接的中间点」——一个既不够浅（对
// 只想知道"我能不管了吗"的人是噪音）又不够深（真要排查，展开面板给的东西远不如真实日志）的
// 折中。真要排查就去看日志。
//
// **但同时**：界面必须让问题**看得见**。藏起来的失败就是静默失效——这个系统最不该有的东西。
//
// 解法（spec 已定，三条都写死在下面的代码里）：
//  1. 副标题直接写**红字事实**（"遇到问题——会重试"）+ 红点。事实本身就在第一屏，不需要点开。
//  2. 进度条**保持在故障发生时的阶段**——不清零、不变红条（铁律①：红只给点不给块）。
//  3. **不提供任何展开入口**。所以本文件里没有 button、没有 onClick、没有 Collapsible、
//     没有"详情/展开/查看痕迹"。测试有 grep 回归锁。
//
// 换句话说：**信息给满，入口给零**。这两件事不矛盾——L7 反对的是"半深不浅的下钻"，不是
// "让人知道出事了"。
//
// ── 开放问题的裁决：`reason` 原文一律**不透传** ─────────────────────────────────
//
// `WorkflowHeldJobDTO.reason` 是内部技术字符串。已核实它的真身是 **`jobs.last_error`**
// （src/dashboard/apiV2.ts:1089 原样取列），而写进那一列的是：
//   - `completeError(jobId, error, now)` / `completeHeld(...)`（src/v2/jobsRepo.ts:401/380）的
//     `error` 入参，调用点包括
//       · translateWorkerTask.ts:182  `translate ${r.status}: ${r.reason ?? ''}`
//       · translateWorkerTask.ts:148  `translate job 41 payload 缺 videoPath`
//       · cli/index.ts:417           `worker_task job 41 has unparseable payload: {...}`
//       · cli/index.ts:520           `unknown worker_task taskType: undefined`
//       · reconcileAll.ts:141         捕获到的异常 message 原文
//
// 也就是说 **reason 是自由文本，不是枚举**——它没有值域。里面混着 jobId、payload 片段、
// 上游异常栈的 message、中英混排的开发者措辞。
//
// 于是三条铁律同时被它踩中：
//   铁律②零数字：`translate job 41 …` 直接把 jobId 糊到界面上。
//   铁律③不暴露机械：`worker_task` / `payload` / `taskType` 全是机器词，且 grep 锁扫的
//                    正是 worker/job 这些词。
//   L1 只有绿和红：异常原文的语气无法归档，也就没法给它选一个诚实的点色。
//
// 因此**不给它建映射表**。理由不是懒，是那张表**建不出来**：映射表要求键有值域，而这里的键
// 是 `${string} ${number}: ${unknown}` 这种模板拼出来的自由文本。任何前缀匹配表都会在下一次
// 有人改一句错误信息措辞时静默失配，回落到"透传原文"或"显示空白"——两个结果都比一开始就不
// 透传更糟（前者违规，后者是静默失效）。而 L7 已经给了这个问题的答案：**细节归日志**。
//
// 落地方式：走 phrases.ts 的 `decisionPhrase('error', lang)`，键是**写死的常量 'error'**，
// 不是 reason。它产出的正是 spec §7.2 逐字要求的那句"遇到问题——会重试"（tone='bad' → 红点），
// 中英双语已在那份表里。reason 因此**连读都不读**——本组件的 props 里压根没有这个字段，
// 违规不可能"顺手"发生，得有人显式把它加进来（那一刻在 review 里看得见）。
//
// 代价（诚实记下来）：用户在界面上分不清"取不出内嵌字幕"和"上游 5xx"。这是 L7 的取舍本身，
// 不是本实现的疏漏——真要分辨就去看日志。注意**不是所有失败都被糊平**了：走完一轮拿到结构化
// decision 的 run（translate:extract-failed 之类）在「刚刚完成」段里有各自的人话句（那些是
// **枚举**，值域可控，所以那里逐词映射是对的）。被糊平的只有 held 这一族——它们恰恰是连结论
// 都没产出的那种失败。
//
// ── 进度条：`stageAtFailure` 为什么是入参且允许 null ────────────────────────────
//
// held 与 running 在后端是**互斥**的两个 job 状态（`state='failed'` vs `state='searching'`，
// apiV2.ts:998/1075），所以一条 held 记录**没有** WorkflowRunningWorkerDTO，也就没有 trail。
// 而 spec 要求"进度条保持在故障发生时的阶段"——那个阶段只能来自**故障前最后一次看到的 trail**，
// 那份数据在客户端（轮询/SSE 期间的 useLiveTrail 状态）而不在这个 DTO 里。所以它是入参，
// 由接线任务把"这个 jobId 最后一次见到的 stageFromTrail 值"喂进来。
//
// null（页面是在故障**之后**才打开的，那份客户端状态压根没存在过）时**整条进度条不渲染**。
// 三个候选里选它的理由：
//   - 渲染一条空条 = 视觉上读作 0%，那正是 spec 明令禁止的"清零"。
//   - 渲染不定态扫动条 = 那条动画的语义是"在干活"，而 held 的活恰恰**停着**——假话。
//   - 不渲染 = 如实表达"这一屏不知道它走到哪了"。上面那句红字事实是完整的，缺一条装饰条
//     不影响"问题看得见"这个唯一目的。
import { backdropUrl, posterUrl } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import type { WorkflowHeldJobDTO } from '../../api/types.js'
import { PosterThumb } from '../library/PosterThumb.js'
import { decisionPhrase } from '../workflow/phrases.js'
import { formatRetryIn } from './text.js'

/** 一条 held 记录 + 接线层补上的展示素材。
 *
 *  为什么 title/posterPath/backdropPath 是**外部补的**而不是从 held 里读：held 只有
 *  `itemId`（own-id，形如 `tmdb:1396/s12e04`——一个技术标识符，铁律③不许直接上界面）。
 *  剧名与海报现在由后端 held DTO 自带（apiV2.ts 的那处 LEFT JOIN，ActivityPage 透传）——
 *  早年按 jobId 去 recent[] 反查的 join 已退役：recent 是 20 条滑动窗口，held 停留天级，
 *  join 会过期（详见 ActivityPage.tsx 的 held → StuckItem 段）。本组件不做数据查找。 */
export interface StuckItem {
  held: WorkflowHeldJobDTO
  /** 剧名/片名。后端 held DTO 自带（LEFT JOIN 富化）；查无时接线层传 null。 */
  title: string | null
  posterPath: string | null
  backdropPath: string | null
  /** 故障发生时的阶段条宽（stageFromTrail 的值）。拿不到 → null → 不渲染进度条。
   *  见文件头最后一段的三选一论证。 */
  stageAtFailure: number | null
}

interface Props {
  items: readonly StuckItem[]
  /** 渲染时刻，算"多久后重试"用。由调用方注入，同 hero/ActivityDone 的既有口径。 */
  now: number
}

function StuckHero({ item, now }: { item: StuckItem; now: number }) {
  const { lang } = useT()
  // 红字事实。键是**写死的 'error'**，不是 item.held.reason——见文件头那段裁决。
  // decisionPhrase('error') 的 tone 恒为 'bad'，正是这一屏要的红。
  const phrase = decisionPhrase('error', lang)
  const bd = backdropUrl(item.backdropPath)
  // 模糊海报降级：同 hero 的既有判据（`backdropPath === null`，不是"这是不是电影"）。
  const blurred = bd ? null : posterUrl(item.posterPath)
  // 主语。title 查无时**给空串，不退回 itemId**（2026-07-31 审计 C-3 修正）。
  //
  // 原实现是 `item.title ?? item.held.itemId ?? ''`，理由写的是"诚实兜底，同 hero 的口径"。
  // 但那和本文件第 85 行自己写的话直接矛盾——那里说 itemId「形如 tmdb:1396/s12e04，
  // 一个技术标识符，铁律③不许直接上界面」。两句话不能同时成立，而铁律那句是对的：
  // 显示 `tmdb:1396/s12e04` 不是诚实，是把内部标识符当人话糊给用户。
  //
  // 与 hero 的口径也不冲突：hero 降级到的是 `seriesId`（`tmdb:1396` 这种），本身同样是
  // 技术值——那处该一并收拾，但不在这次改动范围里（它有独立的测试锁着现行为）。
  // 这里空串会让 PosterThumb 走 '?' 占位，屏上仍有一张图（L4）+ 一句红字事实（L7），
  // 少的只是一个用户看不懂的字符串。
  const title = item.title ?? ''

  return (
    // 复用 hero 的几何（.act-hero*）：这一屏说的还是"当前这一件事"，只是那件事停住了。
    // data-art 同 hero 的三档美术路径。
    <div
      className="act-hero"
      data-testid="activity-stuck-hero"
      data-art={bd ? 'backdrop' : blurred ? 'blur-poster' : 'none'}
    >
      {bd ? (
        <div
          className="act-hero-backdrop"
          style={{ backgroundImage: `url(${bd})` }}
          aria-hidden="true"
          data-testid="activity-stuck-backdrop"
        />
      ) : null}
      {blurred ? (
        <div
          className="act-hero-blur-poster"
          style={{ backgroundImage: `url(${blurred})` }}
          aria-hidden="true"
          data-testid="activity-stuck-blur-poster"
        />
      ) : null}
      <div className="act-hero-scrim" aria-hidden="true" />
      {/* .act-hero-body 在 CSS 里只有 position/z-index/height，**没有 display**
          （styles.css:1472-1476）——Astryx 的 HStack 曾是它 flex 的唯一来源。Task 13 给
          ActivityHero.tsx 补的类**不作用于本文件**（CSS 类共用、组件不共用），所以这里要
          原样再给一遍。 */}
      <div className="act-hero-body flex gap-4">
        <div className="act-hero-poster" data-testid="activity-stuck-poster">
          <PosterThumb posterPath={item.posterPath} name={title} />
        </div>
        {/* 同上：.act-hero-main（styles.css:1505-1508）只有 min-width/flex，没有 display。 */}
        <div className="act-hero-main flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold">{title}</span>
            {/* ⚠️ 这个 flex 是**红点存亡**所系，不是装饰：.act-hero-pulse 在 CSS 里没有 display
                （styles.css:1513-1520 只有 width/height/border-radius/flex/background/animation），
                而它在下面是个裸 <span>。inline 元素忽略 width/height——那个 6px 红点全靠它作为
                flex item 被 blockify。删掉这个 flex，"问题看得见"这一屏最核心的视觉信号直接
                消失，而那条 dataset.tone === 'bad' 的断言照绿（jsdom 不做布局）。 */}
            <div className="flex items-center gap-2">
              {/* 红点。复用 hero 那个 6px 脉动点的类，data-tone 走 phrase.tone（'bad'）——
                  颜色分支全在 CSS 里按属性选，本组件不写死任何色值（同 hero/ActivityDone
                  的既有手法）。红**只染这个 6px 点**。 */}
              <span
                className="act-hero-pulse"
                data-tone={phrase.tone}
                aria-hidden="true"
                data-testid="activity-stuck-dot"
              />
              {/* 红字事实。这就是"问题看得见"的全部——不需要点开任何东西。 */}
              {/* 不给颜色类：红由 .act-stuck-fact 那条 CSS 给，而 styles.css 全文未分层，赢过
                  @layer utilities 里的任何 text-* 工具类（给了不生效，只会骗人）。原文也
                  本来没有 color prop——它一直是靠那条 CSS 变红的。 */}
              <span
                className="act-stuck-fact text-[13px] leading-5"
                data-testid="activity-stuck-fact"
              >
                {phrase.text}
              </span>
            </div>
          </div>
          {/* 进度条：**保持在故障发生时的阶段**。
              - 不清零：width 就是故障时那个 stage 值。
              - 不变红条（铁律①红只给点不给块）：这里**刻意不给 data-tone**，条走的仍是
                .act-hero-bar-fill 那条中性色规则。测试有回归锁断言条上没有红。
              - data-mode='staged'：静态宽度，**不是** indeterminate——那条扫动动画的语义是
                "在干活"，而这活停着（说它在动是假话）。
              - stageAtFailure 为 null → 整条不渲染（见文件头三选一论证）。 */}
          {item.stageAtFailure !== null ? (
            <div
              className="act-hero-bar"
              data-mode="staged"
              aria-hidden="true"
              data-testid="activity-stuck-bar"
            >
              <div
                className="act-hero-bar-fill"
                data-testid="activity-stuck-bar-fill"
                style={{ width: `${item.stageAtFailure}%` }}
              />
            </div>
          ) : null}
          <div className="act-hero-facts flex items-center justify-between">
            {/* "4 小时后重试"——那句"会重试"的承诺需要一个可核对的时刻，否则它是空安慰。
                nextRetryAt 为 null 时**整行不渲染**：不编一个时刻（同空态 lastScanAt 的口径）。
                ⚠️ 这里**不显示 errorAttempt**（"第 3 次重试"）——铁律②零数字，且那个计数是
                内部退避梯的状态，对"我能不管了吗"这个问题没有任何帮助，只会放大焦虑。 */}
            {/* 不给颜色类：.act-hero-facts > * 那条（Task 13 已迁成 --color-weak）未分层，
                赢任何工具类。那一条是 hero 与本屏**共用**的，别在这里再迁一次。 */}
            {item.held.nextRetryAt !== null ? (
              <span
                className="font-mono text-[13px] leading-5"
                data-testid="activity-stuck-retry"
              >
                {formatRetryIn(item.held.nextRetryAt - now, lang)}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ActivityStuck({ items, now }: Props) {
  // 空 → 整段不渲染（同队列段/完成段：不给"暂无故障"占位——那又是一句在断言系统健康的话）。
  if (items.length === 0) return null
  return (
    // ⚠️ 这一段里没有任何 button / role="button" / 可点控件——L7。测试有 grep 回归锁。
    <section className="act-stuck" data-testid="activity-stuck">
      {items.map((item) => (
        // key 走 jobId（held 行的身份键，恒唯一）。不用数组下标：held 是会变动的集合，
        // 下标复用会把一条记录的 DOM（含 PosterThumb 的 failed 状态）串给另一条——同
        // ActivityDone / ConveyorFeed 的既有论证。
        <StuckHero key={item.held.jobId} item={item} now={now} />
      ))}
    </section>
  )
}
