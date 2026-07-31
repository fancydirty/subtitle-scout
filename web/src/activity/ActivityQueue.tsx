// web/src/activity/ActivityQueue.tsx：活动页的「接下来」段——低墨排的等待队列。
//
// spec §3 骨架里的第二块：
//   ├──────────────────────────────────────┤
//   │ 接下来 (n)          [自动检查已开启]  │  低墨排
//   │  38px海报 │ 剧名 · 第N季 · M集缺字幕 │ 等待中 │
//   └──────────────────────────────────────┘
//
// 用户裁决，写死在这个文件里（不许自行放宽）：
//
// L5 队列海报必须 **2:3 竖版、38px 宽**（用户明确纠正过 16:9）。落在 CSS 的
//    .act-row-poster{aspect-ratio:2/3;width:38px}，测试对着这两个值断言（读 CSS 源文件——
//    只锁类名在场的话把 CSS 改成 16/9 也会全绿）。
//
// hero:队列的图片尺寸比 ≈ 5:1（132~160px vs 38px）—— **层级靠图片大小编码**。这条裁决的直接
//    推论是：队列行**不需要徽章/状态列/术语**。所以这里每行只有海报 + 一句事实 + 一个"等待中"，
//    没有 Badge、没有停牌角标、没有 sampleReason（那是 Workflow 三泳道那个账本页的东西）。
//
// L3 不暴露机械：行文案说"3 集缺字幕"，不说 worker/job/dispatch。
//
// 铁律②零数字：不显示 score / offsetMs / 百分比。在场的数字只有集数与季号（集数事实，
//    spec 判据 5 明确允许）。**不渲染** nextRecheckAt 的倒计时——那是三泳道账本页的读数，
//    且"下次复查 4 小时后"会让一个正常等待的条目读起来像出了问题。
//
// 铁律①只有绿和红：队列里没有任何一行是"好"或"坏"——它们都只是还没轮到。所以"等待中"走中性
//    灰（spec §6 三档里的 neutral），**没有黄**（L1：黄会让用户觉得这项目有病）。
//
// ⚠️ 数据字段名是 `pending.series`，**不是 `missingBySeason`**——后者是后端 LibraryRepo 的方法名
//    （libraryRepo.ts:532），buildWorkflowPending 已把它译成 `series`（apiV2.ts:741）。spec
//    判据 12 对前端代码 grep `missingBySeason` 有回归锁，必须为空。
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { useT } from '../i18n/useT.js'
import type { WorkflowPendingMovieDTO, WorkflowPendingSeriesDTO } from '../api/types.js'
import { PosterThumb } from '../library/PosterThumb.js'
import { missingLine, movieMissingLine, queueHeading, queuedLabel, seasonLabel } from './text.js'

interface Props {
  /** GET /api/v2/workflow/pending 的 `series[]`（逐季一行）。 */
  series: readonly WorkflowPendingSeriesDTO[]
  /** 同一响应的 `movies[]`。 */
  movies: readonly WorkflowPendingMovieDTO[]
  /**
   * 「自动检查已开启」那枚小标签是否显示。
   *
   * 为什么是**可选入参而不是写死那句话**：spec 骨架图里画了这枚标签，但守护进程是否在跑
   * 这件事**前端看不到**——pending/workers 两个 DTO 里都没有这个字段（api/types.ts 全文无
   * daemon/paused/enabled 一族）。照草图逐字写死"自动检查已开启"就是把一个前端观测不到的值
   * 硬编码成事实：守护停了之后这句话会当场变成假话，而它恰恰是用户此刻最需要知道的事
   * （DESIGN.md §8：前端只呈现事实）。
   *
   * 所以缺席（undefined）时**整枚标签不渲染**——队列本身就已经诚实地表达了"这些还没轮到"。
   * 等某个 DTO 真带上守护状态，接线任务把它喂进来即可，本组件不需要改。
   */
  autoCheck?: boolean
}

/** 海报 + 一句事实 + "等待中" 的通用行。剧/片两族共用同一个几何（38px 2:3），差别只在中间那句。
 *  `fact` 为 null 时不渲染事实行（电影 missing=0 的情形，见 movieMissingLine 的注释）。 */
function QueueRow({ posterPath, title, fact }: { posterPath: string | null; title: string; fact: string | null }) {
  const { lang } = useT()
  return (
    <HStack gap={3} vAlign="center" className="act-row" data-testid="activity-queue-row">
      {/* pending 的两个 DTO 里都**没有** posterPath（apiV2.ts:699-714 的两个形状只到
          sampleReason）。补一个后端字段不在本任务范围内，所以这里恒传 null——PosterThumb 走
          首字母占位，几何（38px 2:3）与真有图时逐像素一致，L5 的裁决落在框上而不落在图上。
          接线任务若给 pending 补了 posterPath，把它透传进来即可，本组件不需要改。 */}
      <div className="act-row-poster" data-testid="activity-queue-poster">
        <PosterThumb posterPath={posterPath} name={title} />
      </div>
      <div className="act-row-main">
        <Text type="body">{title}</Text>
        {fact ? (
          <Text type="code" color="secondary" className="act-row-fact">{fact}</Text>
        ) : null}
      </div>
      {/* "等待中"：中性灰，不是徽章也不是黄。整个队列段只有这一档状态词（见文件头的尺寸比论证）。 */}
      <Text type="code" color="secondary" className="act-row-status" data-testid="activity-queue-status">
        {queuedLabel(lang)}
      </Text>
    </HStack>
  )
}

export function ActivityQueue({ series, movies, autoCheck }: Props) {
  const { lang } = useT()
  const count = series.length + movies.length
  // 空队列 → **整段不渲染**。不给"暂无待处理"之类的占位：L6 的同一条精神（Steam 只显示列表），
  // 而且"接下来 (0)" 这个空壳标题比没有标题更让人怀疑是不是坏了。真正的空态叙述（新鲜度
  // 时间戳）归 §7.1，是下一个任务的事，不该在这里长一半出来。
  if (count === 0) return null

  return (
    <section className="act-section" data-testid="activity-queue">
      <HStack vAlign="center" hAlign="between" className="act-section-head">
        <Text type="body" color="secondary">{queueHeading(count, lang)}</Text>
        {/* autoCheck 缺席时整枚标签不在场（见 Props 上方的论证）。给 false 时也**不写**
            "自动检查已关闭"——那是个警示语义，本段是低墨排的等待清单，不该在这里报警。 */}
        {autoCheck === true ? (
          <Text type="code" color="secondary" className="act-auto-chip" data-testid="activity-auto-chip">
            {lang === 'zh' ? '自动检查已开启' : 'auto-check on'}
          </Text>
        ) : null}
      </HStack>
      {series.map((row) => (
        // key 带 season：pending 的 series[] 是**逐季一行**，同一 seriesId 合法地出现多次
        // （S1 缺 3 集、S2 缺 5 集是两行），纯 seriesId 会撞 React key。
        <QueueRow
          key={`${row.seriesId}#${row.season}`}
          posterPath={null}
          title={`${row.seriesName} · ${seasonLabel(row.season, lang)}`}
          fact={missingLine(row.missing, lang)}
        />
      ))}
      {movies.map((row) => (
        // 电影没有季，也**没有集**——所以事实句走 movieMissingLine（"缺字幕"，不带数字），
        // 不套 missingLine：那会输出"1 集缺字幕"，而电影没有集，是假话（DESIGN.md §8）。
        <QueueRow
          key={row.id}
          posterPath={null}
          title={row.name}
          fact={movieMissingLine(row.missing, lang)}
        />
      ))}
    </section>
  )
}
