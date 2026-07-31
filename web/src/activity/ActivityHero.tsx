// web/src/activity/ActivityHero.tsx：活动页 hero——"当前这一件事"。剧集路径（movie 路径见下一
// 个任务）。Steam 下载页的解剖：背景大图出血 + 左侧渐变压暗 + 2:3 海报 + 剧名 + 一句人话 +
// 传送带 + 阶段进度条 + 底部两条事实行。
//
// 用户对这块的每个细节都亲自定过。下面每条裁决都写死在代码里，**不许自行放宽**：
//
// L4 必须有图：backdropPath 有值就用 backdropUrl() 做出血背景。（为 null 时这一版只保证不崩，
//    真正的降级——模糊海报当背景——归下一个任务。）
//
// L5 海报必须 2:3 竖版，不是 16:9。用户明确纠正过这一点。落地在 CSS 的
//    .act-hero-poster{aspect-ratio:2/3}，测试对着这个比值断言。
//
// L10 进度条 = agent 工作阶段，不是集数；且**不写百分比数字**。用户原话："甚至不需要写成完成
//    百分之多少，就给个进度条就行，也就是说 ui 层面直接把这个麻烦事给消掉"。这个语义选择让
//    单季/多季的条含义完全一样（stage.ts 文件头有完整论证）。条宽走 stageFromTrail(trail)，
//    那个数字的**唯一消费者是 CSS 的 width**——它不进任何文本节点。
//    集数因此退到右下角当背景信息（"9 集缺字幕"）：它还有信息价值，但不再是分母。
//
// L11 无暂停按钮（用户裁决：语义想不清就别画——"暂停"到底是停这一集、停这个 run、还是停整个
//    守护？想不清的按钮比没有按钮更糟）。所以本文件里没有任何 button，测试有 grep 回归锁。
//
// §4.4 不预测剩余时间：只给"已进行 2 分 14 秒"，不给 ETA。理由见 text.ts 的 formatElapsed
//    注释（搜 5 个来源还是 1 个取决于运气，会跳的假 ETA 比不给更伤信任）。
//
// §4.2.2 stageMode 分族（stageModeOf(taskType)）：
//    - 'staged'        → 正常阶段条，宽度 = stageFromTrail(trail)
//    - 'indeterminate' → 不定态细条（CSS 动画来回扫，**不是**具体宽度）——realign/translate 的
//                        工具序列本 spec 未调研，凭空给权重就是编造
//    - 'hidden'        → 整个 hero 不渲染（orchestrate 属铁律③要隐藏的编排机械）
//
// 铁律②零数字：不显示 score / offsetMs / 百分比。在场的数字只有集号、季号、"已进行 2 分 14 秒"
//    （时间事实，不是质量评分）、"9 集缺字幕"（背景信息）。
//
// 铁律①只有绿和红：正常运行态用中性色 + 一个脉动点（紫，不是黄——黄在本设计系统里是警示色，
//    DESIGN.md §2 的"排队/中性=灰，不是黄不是蓝"同一条铁律的延伸）。卡死态的红归下一个任务：
//    这里只留**色彩钩子**（data-tone 属性 + CSS 变量 --act-hero-tone），不写死红色分支。
//
// 铁律③不暴露机械：文案里不出现 agent/orchestrator/worker/pass/asset/ledger。人话由
//    activity/text.ts 与 workflow/phrases.ts（传送带内部）负责，本层只组装。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { backdropUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import type { WorkflowRunningWorkerDTO } from '../api/types.js'
import { PosterThumb } from '../library/PosterThumb.js'
import { ConveyorFeed } from './ConveyorFeed.js'
import { stageFromTrail, stageModeOf } from './stage.js'
import { formatElapsed, heroSubtitle, missingLine } from './text.js'

interface Props {
  running: WorkflowRunningWorkerDTO
  /** 该条目缺字幕的集数，来自 GET workflow/pending 的 `series[].missing`。
   *
   *  ⚠️ 前端 DTO 里那个字段叫 **series**，不是 missingBySeason（后者是后端 repo 的方法名）。
   *  缺席（undefined/null）时**不渲染**右下角那行——不写 0，因为"未提供"与"确实 0 集缺"是两件
   *  不同的事，编一个 0 出来是假事实（DESIGN.md §8）。 */
  missingCount?: number | null
  /** 渲染时刻，算"已进行"用。由调用方注入（不在组件内读 Date.now）——时间是入参而非副作用，
   *  测试才能确定性地断言读数。 */
  now: number
}

export function ActivityHero({ running, missingCount, now }: Props) {
  const { lang } = useT()
  const mode = stageModeOf(running.taskType)
  // 'hidden'（orchestrate）→ 整个 hero 不渲染。**在读任何其它字段之前就返回**：编排层的 run
  // 没有可展示的"当前这一件事"，它是机械。
  if (mode === 'hidden') return null

  const bd = backdropUrl(running.backdropPath)
  // 剧名缺失（空名/查无）时降级显示 seriesId——诚实兜底，同 DTO 注释里写明的口径。
  const title = running.seriesName ?? running.seriesId ?? ''
  const subtitle = heroSubtitle(running.taskType, running.seasons, lang)
  const elapsed = formatElapsed(now - running.startedAtLease, lang)
  // 条宽：**只喂给 CSS 的 width**，绝不进文本节点（裁决 L10 + 铁律②）。indeterminate 族不算
  // 宽度——CSS 用一条来回扫的动画表达"在干活但不谎报走到哪了"。
  const width = mode === 'staged' ? stageFromTrail(running.trail) : null

  return (
    <div className="act-hero" data-testid="activity-hero">
      {bd ? (
        <div
          className="act-hero-backdrop"
          style={{ backgroundImage: `url(${bd})` }}
          aria-hidden="true"
          data-testid="activity-hero-backdrop"
        />
      ) : null}
      {/* 左侧渐变遮罩压暗：让排印在任何一张背景图上都可读。纯装饰，aria-hidden。 */}
      <div className="act-hero-scrim" aria-hidden="true" />
      <HStack gap={4} className="act-hero-body">
        <div className="act-hero-poster" data-testid="activity-hero-poster">
          <PosterThumb posterPath={running.posterPath} name={title} />
        </div>
        <VStack gap={2} className="act-hero-main">
          <VStack gap={1}>
            <Text type="large" weight="semibold">{title}</Text>
            <HStack gap={2} vAlign="center">
              {/* 脉动点：正常运行态的唯一"活着"信号。中性紫，不是黄/蓝（铁律①）。
                  data-tone 是给下一个任务（卡死态转红）留的钩子——这里恒 'live'，
                  颜色分支在 CSS 里按 data-tone 选，本组件不写死任何红。 */}
              <span className="act-hero-pulse" data-tone="live" aria-hidden="true" />
              <Text type="body" color="secondary">{subtitle}</Text>
            </HStack>
          </VStack>
          <ConveyorFeed events={running.trail} rows={3} />
          {/* 进度条：无 role="progressbar"、无 aria-valuenow。这是刻意的——
              progressbar 的无障碍契约要求可读的 value/百分比，而裁决 L10 恰恰是"UI 层面把百分
              比这个麻烦事消掉"。给屏幕阅读器念一个百分比会从后门把它加回来，且那个数字对"agent
              走到哪个阶段"这个语义本身就没有用户可解释的含义。真正的进展叙述由上方的传送带
              （role="log"）承担，那才是可读的。所以这里是纯装饰条，aria-hidden。 */}
          <div
            className="act-hero-bar"
            data-mode={mode}
            aria-hidden="true"
            data-testid="activity-hero-bar"
          >
            <div
              className="act-hero-bar-fill"
              data-testid="activity-hero-bar-fill"
              // indeterminate 时**不给 width**：宽度由 CSS 动画驱动（一段固定宽度的亮块来回
              // 扫）。给了 style.width 就等于假装知道走到哪了。
              style={width === null ? undefined : { width: `${width}%` }}
            />
          </div>
          <HStack className="act-hero-facts" vAlign="center" hAlign="between">
            <Text type="code" color="secondary">{elapsed}</Text>
            {/* 右下角背景信息。missingCount 缺席（undefined/null）→ 整行不渲染。 */}
            {typeof missingCount === 'number' ? (
              <Text type="code" color="secondary" data-testid="activity-hero-missing">
                {missingLine(missingCount, lang)}
              </Text>
            ) : null}
          </HStack>
        </VStack>
      </HStack>
    </div>
  )
}
