// web/src/workbench/ActivityPage.tsx —— 活动页（#/activity）。Steam 下载页那种
// 「现在怎么样了，我可以不管了吗」。
//
// ══════════════════════════════════════════════════════════════════════════════
// 页面结构
// ══════════════════════════════════════════════════════════════════════════════
//   ┌ 顶部状态条 ────────────────────────────────────────────────┐
//   │ 巡检态（正在巡检 / 上次开始于 X 前 / 从没跑过 / **daemon 可能没在跑**） │
//   │ 识别态（「正在识别：X」）        ← R-F1：识别在这里，**不占 tab**      │
//   │ 巡检级/扫描级最近一条（守备目录读取失败之类） ← 无 workbench 的 6 个 emit │
//   │ 引擎不许可时的那一句（开关关了 / 凭据没配）                            │
//   └────────────────────────────────────────────────────────────┘
//   [ 字幕 | 翻译 ]  ← 两个 tab（R-F1：**只有两个**）
//     正在跑：横版 backdrop 卡片（0 或 1 张——后端 current 是单数）
//     已排队：竖版 poster 卡片列表
//
// ══════════════════════════════════════════════════════════════════════════════
// 三个数据源，各管一段（**互不推导**，这是本页最要紧的纪律）
// ══════════════════════════════════════════════════════════════════════════════
//  ① SSE（events/）      —— 变化流。当前在处理谁、进度「第 3/8 个」
//  ② GET /api/v2/health  —— **快照**。断线重连后纠正当前态（后端 F-6 的存在理由）
//  ③ GET /api/v2/activity —— 排队段的作品身份与两张图
//
// 🔴 **「第 i/n 个」只信 ①②（冻结快照），排队列表只信 ③（实时重查）**。
// 两者绝不互相推导：不许拿 `subtitleQueue.length` 当 n，也不许拿 n-i 去截断排队列表。
// 理由是 /api/v2/health 那条「刻意不返回 queue」的裁决（health.test.ts:410 钉着）：
// listSubtitleQueue 是实时重查，与 R4 的冻结快照语义相反，混用会让进度条来回跳。
// 完整论证见后端 activityApi.ts 头注释。
//
// ══════════════════════════════════════════════════════════════════════════════
// 断线重连怎么纠正（后端 F-6，也是 /health 存在的全部理由）
// ══════════════════════════════════════════════════════════════════════════════
// SSE 是**变化**不是快照。断线期间巡检跑完、50 槽环形缓冲又被 progress 冲掉的话，
// 重连后的 replay 里既没有"正在处理 X"也没有"巡检完成"——前端会**永远停在**上一次
// 看到的那句「正在处理 X」。用户看到的是一个假装在忙、实际早就歇了的界面。
//
// 处置之一：订 `useEventsStatus()`，从**掉线状态恢复**的那一刻拉一次 /health，
// 拿快照覆盖本地的当前态。判据在 events/resumeEdge.ts（**不在本文件手写**——
// 手写的三份副本已经漂移过一次，见那个文件的头注释）。
//
// ⚠️ 但"重连后拉快照"只在**重连成功之后**才生效，而下面两个状态里它一次都不会发生：
//   · `retrying`     —— 退避重连中，可能持续任意久
//   · `unavailable`  —— 503 终态，eventsBus 一次都不会再重连（eventsBus.ts:262），
//                       "重连后纠正"这条路**根本不会被触发**
// 这两段时间里，上面那句「正在处理 X」原样挂着，而它已经是一句谎话。
//
// 处置之二（诚实性，不是排障）：把"读数已经不新鲜了"这件事**说出来**。
// 落点两处、说的是同一件事的两个粒度：
//   ① 顶部状态条一行——页面级。没有在跑卡片时（"这个工作台现在没在跑什么"同样可能
//      是过期的谎话）它是唯一的载体。
//   ② 在跑卡片上一行——那张卡片才是用户真正盯着的那句谎话本体。
// 形态照抄既有的 stale 档（inspectFreshness 的「daemon 可能没在跑」）：状态条里的
// 一行字 + 双通道（文字本身说清楚 + 空心点的形状差异，不只靠颜色）。
// **不做弹窗、不报错、不提 HTTP/SSE/状态码**——R-F9/R-F10 的裁决是排障类一律不推给
// 用户，这里推的是"你看到的数字有多新"，与 stale 那一档同类。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Section } from '../components/ui/section.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Button } from '../components/ui/button.js'
import { useActivity, useHealth } from '../api/hooks.js'
import {
  useActivityEvent, useProgressEvent, useHealthEvent, useEventsStatus,
} from '../events/EventsProvider.js'
import { useResumeEdge } from '../events/resumeEdge.js'
import { useT } from '../i18n/useT.js'
import { RootHealthNote } from '../shell/RootHealthNote.js'
import type { ScoutEvent, EventsStatus } from '../events/types.js'
import type { ActivityQueueItemDTO, HealthDTO, ScoutCurrentDTO } from '../api/types.js'
import { ACTIVITY_TABS, laneOf, tabOf, workIdOf, type ActivityTab } from './workbenchRouting.js'
import { inspectFreshness, liveFreshness, relAgo, workPermission, type LiveFreshness } from './inspectFreshness.js'
import { RunCard, QueueCard, type WorkbenchCardFace } from './WorkbenchCards.js'

// ═══════════════════════════════════════════════════════════════════════════
// 当前态：SSE 增量 + health 快照纠正
// ═══════════════════════════════════════════════════════════════════════════

/** 「现在在处理什么」的本地视图。
 *
 *  = 后端 ScoutCurrentDTO **加一个 `workId`**。为什么要加这一个字段：
 *  取图需要 id，而 /health 的 `current` 里**没有** workId（那个 DTO 是 Task ④ 定的，
 *  当时还没有取图这个需求）。SSE 的事件里有（Task ⑨ 补的 `data.workId`）。
 *
 *  🔴 故 workId 是**只有 SSE 那条路才填得上**的字段，快照那条路恒 null。
 *  这不是缺陷而是如实：快照纠正之后卡片会短暂失去图（降级成纯排印），
 *  下一条 SSE 事件到达时补回来。**绝不为此去猜**——比如拿 title 去队列里反查 id，
 *  那正是"标题字符串匹配"那条被否掉的路（同名翻拍会配错图）。 */
type Current = ScoutCurrentDTO & { workId: string | null }

/**
 * SSE 事件 + health 快照 → 当前态。
 *
 * ── 纠正的触发时机是**重连**，不是时间（后端 useHealth 注释里点名的那条）──
 * 挂个 15 秒定时器等于在一条好好连着的 SSE 旁边再开一路轮询，正是 R-F6 要消灭的东西。
 * 故只在两个时刻用快照：① 首载 ② SSE 从非 open 恢复到 open。
 */
function useCurrentState(health: HealthDTO | null, reloadHealth: () => void): Current | null {
  const activity = useActivityEvent()
  const progress = useProgressEvent()
  const status = useEventsStatus()

  /** 本地当前态。null = 没有任何工作台在跑。 */
  const [current, setCurrent] = useState<Current | null>(null)
  /** 已经把哪一条事件折进去了（按 id 去重——四层 Context 存的是"最后一条"，
   *  组件因别的原因重渲染时会再读到同一条，不去重会重复应用）。 */
  const appliedId = useRef(0)

  // ── SSE 增量 ──────────────────────────────────────────────────────────
  // 判据逐字照后端 ScoutEventBus.updateCurrent（那是同一件事的服务端实现）：
  //  · 无 workbench（巡检级/扫描级）→ **清空**（巡检完成/失败/下一轮开始都走这条）
  //  · activity + 有 workbench       → 新作品开工，index/total 归 null
  //  · progress + 有 workbench       → 推进 index/total
  // ⚠️ 两处实现同形是**有意的冗余**：断线时前端只有事件流，必须自己能推导；
  // 而重连后 health 快照会覆盖它——快照是权威，这份推导只是断线期间的近似。
  const applyEvent = useCallback((e: ScoutEvent | null) => {
    if (!e || e.id <= appliedId.current) return
    appliedId.current = e.id
    const lane = laneOf(e)
    if (lane === 'patrol') {
      setCurrent(null)
      return
    }
    // ⚠️ 识别（lane==='identify'）**照样推进当前态**——R-F1 管的是"不进 tab"，
    // 不是"当它不存在"。它会被渲染在顶部状态条上（见 StatusBar）。
    const kind = lane
    if (e.type === 'activity') {
      setCurrent({ kind, title: e.title ?? null, index: null, total: null, workId: workIdOf(e) })
      return
    }
    if (e.type === 'progress') {
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null
      setCurrent({
        kind, title: e.title ?? null,
        index: num(e.data?.done), total: num(e.data?.total),
        workId: workIdOf(e),
      })
    }
  }, [])

  useEffect(() => { applyEvent(activity) }, [activity, applyEvent])
  useEffect(() => { applyEvent(progress) }, [progress, applyEvent])

  // ── 首载：health 快照播种 ────────────────────────────────────────────────
  // ⚠️ 只在**还没应用过任何事件**时播种：首载的 health 响应可能比第一条 SSE 事件晚到，
  // 无条件覆盖会把更新的事件态倒退回更旧的快照。
  const seeded = useRef(false)
  useEffect(() => {
    if (health && !seeded.current && appliedId.current === 0) {
      seeded.current = true
      // workId 恒 null：/health 的 current 里没有这个字段（见 Current 的注释）。
      setCurrent(health.current === null ? null : { ...health.current, workId: null })
    }
  }, [health])

  // ── 🔴 断线重连纠正（后端 F-6 的执行点）────────────────────────────────
  // 判据在 events/resumeEdge.ts。⚠️ **不是** `was !== 'open'`：那样写会把首连的
  // `connecting → open` 也算成重连（eventsBus 的初始状态就是 'connecting'），
  // 每次挂载都在挂载期 fetch 之外多打一次 /health。
  const onResume = useCallback(() => {
    // 重连了：本地那份靠事件推导出来的当前态可能已经过时（断线期间的变化全丢了），
    // 拉快照重新对齐。快照到达后由上面那个 seeding effect 覆盖。
    reloadHealth()
    // 允许下一次快照覆盖本地态（seeded 那道闸只管首载）。
    seeded.current = false
    appliedId.current = 0
  }, [reloadHealth])
  useResumeEdge(status, onResume)

  return current
}

// ═══════════════════════════════════════════════════════════════════════════
// 顶部状态条
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 顶部状态条。四类信息在这里落地，**它们都不占 tab**：
 *  ① 巡检时间态（含"daemon 可能没在跑"——债务二）
 *  ② 识别态（R-F1：识别降级到这里）
 *  ③ 巡检级/扫描级事件的最近一条（无 workbench 的那 6 个 emit 点）
 *  ④ 引擎不许可的原因（读 workPermitted，不是 engineEnabled）
 *  ⑤ 🟡 读数新鲜度（实时通道掉了 → 下面这些数字可能已经过期）
 *  ⑥ 🔴 守备目录健康度（`/health` 的 `roots[]`，终局审计 🔴-1）
 *
 * ⚠️ ⑤ 与 ⑥ 说的**不是同一件事**，两条并列不是冗余：
 *   ⑤ = 我（浏览器）听不听得见后端；⑥ = 后端看不看得见你的磁盘。
 * 两者可以任意组合出现（实时通道好好的、而挂载掉了，是最常见的那一种）。
 */
function StatusBar({
  health, current, patrolEvent, status,
}: {
  health: HealthDTO | null
  current: Current | null
  patrolEvent: ScoutEvent | null
  status: EventsStatus
}) {
  const { t } = useT()
  // 时钟只在挂载时取一次：这一行是"大约多久前"的粒度（分/时/天），
  // 每秒重算会让整个状态条每秒重渲染，而显示的字一分钟才变一次。
  const now = useMemo(() => Date.now(), [health])

  const fresh = health ? inspectFreshness(health, now) : null
  const perm = health ? workPermission(health) : null
  // 🟡 读数新鲜度。**电平**不是边沿——见 inspectFreshness 里 liveFreshness 的论证。
  const live = liveFreshness(status)

  // 巡检那一句。⚠️ 债务一：`lastInspectAt` 是**开始**时刻不是完成时刻，
  // 故 idle 分支的文案是「上次巡检**开始于** X 前」——不许写成"完成于"。
  let inspectLine: string
  if (!fresh) inspectLine = t('wb_inspect_unknown')
  else if (fresh.phase === 'never') inspectLine = t('wb_inspect_never')
  else if (fresh.phase === 'running') inspectLine = t('wb_inspect_running')
  else if (fresh.phase === 'stale') {
    inspectLine = `${t('wb_inspect_stale')}（${relAgo(fresh.msSinceStart ?? 0)}）`
  } else inspectLine = `${t('wb_inspect_idle')} ${relAgo(fresh.msSinceStart ?? 0)}`

  return (
    <div className="wb-statusbar" data-stale={fresh?.phase === 'stale' ? 'true' : 'false'}
         data-live={live}
         aria-label={t('wb_statusbar_label')}>
      <span data-testid="wb-inspect-line">
        <span className="wb-status-dot" aria-hidden="true" /> {inspectLine}
      </span>

      {/* 🟡 读数已过期。
          · **两通道**（Carbon）：文字本身把话说全（"可能已经不是最新的"）+ 点变成**空心**
            （形状差异）。颜色只是第三重，色觉障碍与灰度打印下信息不丢。
          · `role="status"` + `aria-live="polite"`：读屏器要能知道读数不新鲜了，
            但**不打断**用户正在听的内容——这不是错误，是一条背景事实。
          · **不是弹窗、不是 EmptyState**：既有的 stale 档就长这样（状态条里一行字），
            两件同类的事必须长得像，否则用户会以为它们说的是两回事。 */}
      {live !== 'live' && (
        <span data-testid="wb-live-line" role="status" aria-live="polite">
          <span className="wb-status-dot wb-status-dot-hollow" aria-hidden="true" />
          {' '}
          {live === 'off' ? t('wb_live_unavailable') : t('wb_live_retrying')}
        </span>
      )}

      {/* 🔴 守备目录健康度（终局审计 🔴-1）——`/health` 的 `roots[]` 在这里第一次被读。
          落点选在状态条里，与「上次巡检」「实时更新」并列：那两行说的是"引擎在不在动、
          我听不听得见"，这一行说的是"引擎能不能看见我的库"——同一个问题（我的库现在
          是什么状况）的第三个侧面。三行同形（一个标记 + 一句话），用户不必学第二套语汇。
          两个名单都空时组件自己返回 null，健康的根一个字都不占屏。 */}
      <RootHealthNote roots={health?.roots} />

      {/* 🔴 R-F1 的可见形态：识别在**这里**，不在 tab 里。
          判据是 current.kind === 'identify'（laneOf 的同一套口径在 useCurrentState 里已用过）。 */}
      {current?.kind === 'identify' && (
        <span data-testid="wb-identify-line">
          {t('wb_identify_running')}{current.title ? `：${current.title}` : ''}
          {current.index !== null && current.total !== null
            ? ` ${current.index}/${current.total}`
            : ''}
        </span>
      )}

      {/* 巡检级/扫描级事件（无 workbench）——降级为状态条一行，**不进任何 tab**，
          也不丢（设计文档明写它们降级为顶部状态条）。 */}
      {patrolEvent && <span data-testid="wb-patrol-line">{patrolEvent.message}</span>}

      {/* 引擎不许可：读 workPermitted（= engineEnabled && setupSatisfied，后端同源），
          **不是** engineEnabled——只看后者会在"开关开着但凭据没配"时说引擎在跑，
          而 daemon 其实整轮跳过。两态分开是因为可执行动作不同。 */}
      {perm === 'engine-off' && <span data-testid="wb-perm-line">{t('wb_engine_off')}</span>}
      {perm === 'setup-incomplete' && <span data-testid="wb-perm-line">{t('wb_setup_incomplete')}</span>}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 一个 tab 的内容
// ═══════════════════════════════════════════════════════════════════════════

/** 「2018 · 动画 · 13 集待处理」那一行。缺席的段**整段不出现**（不留 "· ·"）。 */
function subtitleLine(
  item: { year: number | null; mediaType: 'tv' | 'movie'; pendingFileCount: number },
  t: (k: 'wb_media_tv' | 'wb_media_movie' | 'wb_pending_files') => string,
): string {
  const parts: string[] = []
  if (item.year !== null) parts.push(String(item.year))
  parts.push(item.mediaType === 'movie' ? t('wb_media_movie') : t('wb_media_tv'))
  parts.push(`${item.pendingFileCount} ${t('wb_pending_files')}`)
  return parts.join(' · ')
}

function faceOf(item: ActivityQueueItemDTO, t: ReturnType<typeof useT>['t']): WorkbenchCardFace {
  return {
    title: item.chineseTitle ?? item.title,
    subtitle: subtitleLine(item, t),
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
  }
}

function TabPanel({
  tab, current, queue, queueByWorkId, live,
}: {
  tab: ActivityTab
  current: Current | null
  queue: ActivityQueueItemDTO[]
  queueByWorkId: Map<string, ActivityQueueItemDTO>
  /** 在跑那个作品的 workId（来自 SSE 的 data.workId）——用它取图。 */
  /** 🟡 读数新鲜度。非 'live' 时给在跑卡片挂一行"可能已经跑完了"。 */
  live: LiveFreshness
}) {
  const { t } = useT()
  return (
    <div>
      <div className="wb-section-head">{t('wb_section_running')}</div>
      {current && current.kind === tab ? (
        <RunCard
          face={{
            title: current.title ?? t('wb_untitled'),
            // 在跑卡片的副行：能从排队表里查到这个作品就用它的年份/类型，
            // 查不到（它已经离开队列了——**这是常态**）就只说"正在处理"。
            // 🔴 绝不拿 queue.length 编一个 "第 x/n"——见文件头那条纪律。
            subtitle: t('wb_running_now'),
            posterPath: null,
            backdropPath: null,
            ...facePatch(current, queueByWorkId, t),
          }}
          progress={
            current.index !== null && current.total !== null
              ? `${current.index}/${current.total}`
              : null
          }
          // 🟡 通道掉了 → 这张卡片上的「正在处理 X」可能早就不成立了。
          // ⚠️ retrying 与 unavailable **共用同一句**（顶部状态条那两句才是分开的）：
          // 卡片上要回答的是"这句话还算不算数"，两态的答案完全一样（都不算）；
          // "自己会好 vs 得刷新页面"是**下一步做什么**，那属于页面级的那条，
          // 在卡片上重复一遍只会让两条提示互相稀释。
          staleNote={live === 'live' ? null : t('wb_run_maybe_stale')}
        />
      ) : (
        <div className="wb-card-sub" data-testid="wb-run-empty">{t('wb_running_none')}</div>
      )}

      <div className="wb-section-head" style={{ marginTop: 16 }}>
        {t('wb_section_queued')} · {queue.length}
      </div>
      {queue.length === 0 ? (
        <div className="wb-card-sub" data-testid="wb-queue-empty">{t('wb_queue_none')}</div>
      ) : (
        <ul className="wb-list">
          {queue.map((item) => <QueueCard key={item.workId} face={faceOf(item, t)} />)}
        </ul>
      )}
    </div>
  )
}

/** 在跑卡片的图与副行——**靠 workId 从队列表里查**，查不到就无图降级。
 *
 *  🔴 为什么 workId 而不是标题匹配：同名翻拍与中文译名切换都会让字符串匹配落到
 *  另一部剧上（表现为"卡片配了别人的图"，测试里几乎照不出来）。daemonV2 的两处 emit
 *  为此专门补了 `data.workId`（daemonV2.events.test.ts 钉着）。
 *
 *  ⚠️ 查不到是**常态**：作品一旦开始处理就离开了队列（listSubtitleQueue 的谓词是
 *  "还没做的"），所以在跑的那个通常**不在** /api/v2/activity 的返回里。
 *  故这里拿到 null 完全正常，卡片走无图降级——这不是失败路径。 */
function facePatch(
  current: Current,
  queueByWorkId: Map<string, ActivityQueueItemDTO>,
  t: ReturnType<typeof useT>['t'],
): Partial<WorkbenchCardFace> {
  const id = current.workId
  if (!id) return {}
  const item = queueByWorkId.get(id)
  if (!item) return {}
  return {
    title: item.chineseTitle ?? item.title,
    subtitle: subtitleLine(item, t),
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 页面
// ═══════════════════════════════════════════════════════════════════════════

export function ActivityPage() {
  const { t } = useT()
  const { data: health, reload: reloadHealth } = useHealth()
  const { data: activityData, loading, error, reload: reloadActivity } = useActivity()
  const status = useEventsStatus()

  const current = useCurrentState(health, reloadHealth)
  const activityEvent = useActivityEvent()
  const healthEvent = useHealthEvent()

  const [tab, setTab] = useState<ActivityTab>('subtitle')

  // 巡检级/扫描级的最近一条：activity 与 health 两类里 lane==='patrol' 的那些。
  // 取两者中更新的一条（id 更大的）——它们共用同一个 id 序列。
  const patrolEvent = useMemo(() => {
    const cands = [activityEvent, healthEvent].filter(
      (e): e is ScoutEvent => e !== null && laneOf(e) === 'patrol',
    )
    return cands.sort((a, b) => b.id - a.id)[0] ?? null
  }, [activityEvent, healthEvent])

  // ── 队列刷新的触发点（谁触发写明在 useActivity 的注释里）──────────────────
  // ① 收到 activity 事件 → 队列刚少了一个/多了一个。
  //    ⚠️ 只对**工作台级**的 activity 重拉：巡检级那些（开始/完成）同样意味着队列变了，
  //    所以也要拉——故这里不加 lane 过滤，任何 activity 都拉一次。
  //    activity 是低频事件（一个作品一条），不会造成请求风暴；progress 才是高频的，
  //    **刻意不订它**。
  const lastActivityId = useRef(0)
  useEffect(() => {
    if (activityEvent && activityEvent.id > lastActivityId.current) {
      lastActivityId.current = activityEvent.id
      reloadActivity()
    }
  }, [activityEvent, reloadActivity])

  // ② SSE 从掉线状态恢复 → 断线期间的队列变化一次补齐。
  //    判据与 useCurrentState 那处**同一个函数**（events/resumeEdge.ts）——
  //    这两处曾经是两份手抄，同时漏掉了 connecting 那一支。
  useResumeEdge(status, reloadActivity)

  const queues = useMemo(() => ({
    subtitle: activityData?.subtitleQueue ?? [],
    translate: activityData?.translateQueue ?? [],
  }), [activityData])

  const queueByWorkId = useMemo(() => {
    const m = new Map<string, ActivityQueueItemDTO>()
    for (const it of [...queues.subtitle, ...queues.translate]) m.set(it.workId, it)
    return m
  }, [queues])

  // 错误态**绝不显示空态文案**（§4.4：那是谎报——"没有排队"与"我没能问到"是两件事）。
  // ⚠️ 但状态条照常渲染：它读的是 /health，与本端点是两条独立的路，
  // 一条挂了不该把另一条的信息一起藏起来。
  return (
    <Section>
      <div className="flex flex-col gap-3">
        <StatusBar health={health} current={current} patrolEvent={patrolEvent} status={status} />

        <div className="wb-tabs" role="tablist" aria-label={t('wb_tablist_label')}>
          {ACTIVITY_TABS.map((id) => (
            <button
              key={id}
              className="wb-tab"
              role="tab"
              type="button"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
            >
              {t(id === 'subtitle' ? 'wb_tab_subtitle' : 'wb_tab_translate')}
            </button>
          ))}
        </div>

        {error && !activityData ? (
          <EmptyState
            title={t('wb_error_title')}
            description={error}
            actions={
              <Button variant="secondary" onClick={reloadActivity}>{t('wb_retry')}</Button>
            }
          />
        ) : loading && !activityData ? (
          <div className="wb-card-sub" aria-busy="true">{t('wb_loading')}</div>
        ) : (
          <TabPanel
            tab={tab}
            current={current}
            queue={queues[tab]}
            queueByWorkId={queueByWorkId}
            live={liveFreshness(status)}
          />
        )}
      </div>
    </Section>
  )
}
