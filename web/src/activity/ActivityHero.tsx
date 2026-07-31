// web/src/activity/ActivityHero.tsx：活动页 hero——"当前这一件事"。剧集路径（movie 路径见下一
// 个任务）。Steam 下载页的解剖：背景大图出血 + 左侧渐变压暗 + 2:3 海报 + 剧名 + 一句人话 +
// 传送带 + 阶段进度条 + 底部两条事实行。
//
// 用户对这块的每个细节都亲自定过。下面每条裁决都写死在代码里，**不许自行放宽**：
//
// L4 必须有图：backdropPath 有值就用 backdropUrl() 做出血背景。为 null 时走**模糊海报降级**
//    （任务 5 / spec §8.3 缺口②）：把海报自身放大模糊当背景。判据是 `backdropPath === null`
//    而**不是**"这是不是一部电影"——见下方 §8.3 段的完整论证。
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
//
// ── spec §8.3 缺口②：电影没有 backdrop（真实的数据不对称，不是 bug）──────────────
//
// 已核实：`series` 表有 poster_path + backdrop_path（src/v2/db.ts:301 的 v-migration 加的），
// 但 `movies` 表**只有 poster_path**（db.ts:49 建表、:221 的 v15 重建都没有 backdrop 列）。
// 所以电影条目的 backdropPath **恒为 null**，DTO 注释（api/types.ts:171）里已写明这不是缺失。
//
// 裁决：电影 hero **不用背景大图**，改为海报自身的模糊放大版当背景（CSS 里
// `filter: blur(40px) saturate(1.4)` + `transform: scale(1.2)`），海报本体也放得比剧集路径更大
// （160px vs 132px），仍是 2:3。
//
// 为什么不去补 schema：为一个字段改 migration + 回填全库 TMDB backdrop 是后端工程，而模糊海报
// 做背景是 Spotify / Apple Music 的成熟做法——视觉上成立，且**零后端改动**。
//
// ⚠️ 判据是 `backdropPath === null`，**不是** "movieName 非空"。这个区别是刻意的：
//  - 缺的是**图片**这个资源，不是"电影"这个种类。将来若给 movies 补了 backdrop，这段代码自动
//    切回正常出血背景，不需要有人回来改判据（也就不会漏改）。
//  - 反向也成立：某部剧集 backdrop 查无（TMDB 没有图/未富化）时，它同样该拿模糊海报兜底，
//    而不是留一块死黑。按 movieName 判会让这类剧集掉进"没有背景层"的空洞。
//  - 文案分族（"第 N 季" vs "这部电影"）走的是另一个判据（movieId/movieName，见 text.ts 的
//    TargetKind 注释）——两件事两个判据，任一侧演化不拖坏另一侧。
//
// 海报也为 null（图都没有）时：不渲染任何背景层（模糊一个不存在的 URL 没有意义），海报框由
// PosterThumb 走首字母占位。hero 本体完整，不崩。
import { Text } from '@astryxdesign/core/Text'
import { VStack } from '@astryxdesign/core/VStack'
import { HStack } from '@astryxdesign/core/HStack'
import { backdropUrl, posterUrl } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import type { WorkflowRunningWorkerDTO } from '../api/types.js'
import { PosterThumb } from '../library/PosterThumb.js'
import { ConveyorFeed } from './ConveyorFeed.js'
import { useLiveTrail } from '../workflow/useLiveTrail.js'
import { stageFromTrail, stageModeOf } from './stage.js'
import { formatElapsed, heroSubtitle, missingLine, type TargetKind } from './text.js'

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
  // 直播痕迹（2026-07-31 接线）：`running.trail` 只是**轮询快照**（15 秒一拍，来自
  // traceBus.peek 的补拉）。传送带的目的是缓解焦虑——一条 15 秒不动的传送带看起来像卡住了，
  // 恰好制造它本该消除的那种焦虑。useLiveTrail 把这份快照当种子、再按 seq 去重追加 SSE
  // 增量，于是每一步工具调用即时出现。
  //
  // 复用 workflow/useLiveTrail 而不是新写：它已处理两个易错点——① 轮询刷新时不能丢掉
  // 直播已追加、轮询还没反映的事件（mergeTrail 按 seq 去重）；② 断线重连后的补拉。
  const trail = useLiveTrail(running.jobId, running.trail)

  // 'hidden'（orchestrate）→ 整个 hero 不渲染。编排层的 run 没有可展示的"当前这一件事"，
  // 它是机械。
  //
  // ⚠️ 这个 early return 必须在**所有 hook 之后**（上面那个 useLiveTrail 就是为此提到这里的）。
  // React 的 hook 规则要求每次渲染的 hook 调用序列一致；把 hook 放在条件返回之后，
  // taskType 从 orchestrate 变成 find_subtitle 的那一帧就会 hook 数量突变。
  // 代价是 hidden 模式下也会订阅一次 SSE——subscribeTrace 是按 runKey 过滤的轻量订阅，
  // 且 orchestrate 的 job 本来就有 trail，订阅它无副作用。
  if (mode === 'hidden') return null

  const bd = backdropUrl(running.backdropPath)
  // 模糊海报降级：backdropPath 为 null 时（电影恒如此，见文件头 §8.3）用海报自身当背景。
  // 两者互斥——bd 有值就绝不走模糊分支，反之亦然。
  const blurred = bd ? null : posterUrl(running.posterPath)
  // 目标种类：文案分族用（"第 N 季" vs "这部电影"）。**独立于**上面那个图片判据。
  // movieId 优先于 movieName：id 是身份键（恒在场），name 可能因未富化而为 null。
  const kind: TargetKind = running.movieId !== null || running.movieName !== null ? 'movie' : 'series'
  // 剧名缺失（空名/查无）时降级显示 id——诚实兜底，同 DTO 注释里写明的口径。电影路径取
  // movieName/movieId，否则会给一部电影显示 seriesId（恒 null → 空标题）。
  const title = kind === 'movie'
    ? (running.movieName ?? running.movieId ?? '')
    : (running.seriesName ?? running.seriesId ?? '')
  const subtitle = heroSubtitle(running.taskType, running.seasons, lang, kind)
  const elapsed = formatElapsed(now - running.startedAtLease, lang)
  // 条宽：**只喂给 CSS 的 width**，绝不进文本节点（裁决 L10 + 铁律②）。indeterminate 族不算
  // 宽度——CSS 用一条来回扫的动画表达"在干活但不谎报走到哪了"。
  const width = mode === 'staged' ? stageFromTrail(trail) : null

  return (
    // data-art 让 CSS 知道走的是哪条美术路径：'backdrop' 正常出血、'blur-poster' 模糊海报降级、
    // 'none' 图都没有。海报尺寸按它选（模糊分支下海报更大，因为背景不再承担叙事）。
    <div className="act-hero" data-testid="activity-hero" data-art={bd ? 'backdrop' : blurred ? 'blur-poster' : 'none'}>
      {bd ? (
        <div
          className="act-hero-backdrop"
          style={{ backgroundImage: `url(${bd})` }}
          aria-hidden="true"
          data-testid="activity-hero-backdrop"
        />
      ) : null}
      {/* 模糊海报背景（spec §8.3 电影降级）。blur/scale 全在 CSS 里——比例与滤镜是这条裁决的
          真身，测试对着 CSS 源文件断言 blur 确实在场。 */}
      {blurred ? (
        <div
          className="act-hero-blur-poster"
          style={{ backgroundImage: `url(${blurred})` }}
          aria-hidden="true"
          data-testid="activity-hero-blur-poster"
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
          <ConveyorFeed events={trail} rows={3} />
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
