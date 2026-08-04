// web/src/activity/ActivityPage.tsx：活动页容器——把五个组件接成一屏，取代旧的 Workflow 三泳道。
//
// 这一页回答的是「现在怎么样了，我可以不管了吗」，不是「系统都干了什么」（后者是账目，
// 是旧 Workflow 页的定位）。用户裁决：「活动页是运行态展示，不是账本」「Steam 的下载页」。
//
// ## 这个文件只做三件事
//
// 1. **发请求**（复用既有的两个 hook，不新增端点）
// 2. **决定渲染哪一屏**（在跑 → hero；全闲 → 空态；有故障 → 卡死态）
// 3. **把 held 记录 join 上剧名与海报**——后端 held DTO 只有 jobId/itemId/reason，
//    没有名字也没有图，而 L4 要求必须有图
//
// 所有视觉与文案裁决都在那五个子组件里，这里刻意不重复表达它们。
//
// ## 三屏的优先级：故障 > 在跑 > 空闲
//
// 有 held 记录时先给卡死态，即使同时有别的 job 在跑。理由：L7 的张力是「不给排查入口，
// 但问题必须看得见」——如果一条正常运行的 hero 把故障挤到屏幕下方，那就等于没看见。
// 故障是这一屏唯一「需要用户知道」的事，其余都是「让他放心不管」。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSetupStatus, useWorkflowPending, useWorkflowWorkers } from '../api/hooks.js'
import { api } from '../api/client.js'
import type { WorkflowRecentRunDTO } from '../api/types.js'
import { ActivityHero } from './ActivityHero.js'
import { ActivityQueue } from './ActivityQueue.js'
import { ActivityDone } from './ActivityDone.js'
import { ActivityEmpty } from './ActivityEmpty.js'
import { ActivityStuck, type StuckItem } from './ActivityStuck.js'
import { RunDetail, type RunDetailSource } from '../workflow/RunDetail.js'
import { RerunDialog } from '../workflow/RerunDialog.js'
import type { RerunRequest } from '../workflow/rerun.js'

export function ActivityPage() {
  const pending = useWorkflowPending()
  const workers = useWorkflowWorkers()
  // 发动机开关的状态源（spec A §5.5 出数据、spec C §5.3 定位置）。这是 useSetupStatus 的第二个
  // 实例（另一个在 EngineBanner 里）——本仓没有 react-query/swr，每个 hook 实例各自 15 秒轮询，
  // 与 banner 同频，是既有约定（Spec C §6-2 只禁止**更快**的轮询，不禁止同频的第二个实例）。
  const setup = useSetupStatus()
  // 渲染时刻统一从这里取，往下透传。子组件一律不读 Date.now（时间是入参而非副作用，
  // 这样测试能确定性地断言"已进行 2 分 14 秒"这类读数）——五个子组件都遵守这条。
  //
  // 每秒自增一次（2026-07-31 实机盯页面时发现）：原来只在渲染时取一次，而这一页的重渲染
  // 只由 15 秒轮询触发——"已进行 3 秒"于是在屏上**卡住 15 秒不动**，而它恰恰是这一屏
  // 用来表达"系统还活着"的元件之一。一个不动的秒表比没有秒表更糟：它看起来像卡死了。
  //
  // 只在**有活在跑**时才开这个 interval（下面那个依赖）——空态的"最近检查 3 分钟前"是
  // 分钟量级读数，每秒重渲染整棵树纯属浪费。
  const [now, setNow] = useState(() => Date.now())
  const hasLiveWork = (workers.data?.running.length ?? 0) > 0
  useEffect(() => {
    if (!hasLiveWork) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [hasLiveWork])

  // 「查看」落到既有的 RunDetail（痕迹快照回放）。它是**独立路由式的排障视图**，
  // 不是 L7 禁止的那个「点开看 trace」——后者指的是在活动页内嵌一个半深度的展开区
  // （用户原话「青黄不接的中间点」）。RunDetail 是完整的排障面板，且入口在「刚刚完成」
  // 那一段（已完成的事），不在 hero（正在发生的事）上。
  const [openRun, setOpenRun] = useState<RunDetailSource | null>(null)
  const [rerunRequest, setRerunRequest] = useState<RerunRequest | null>(null)
  const onOpen = useCallback(
    (row: WorkflowRecentRunDTO) => setOpenRun({ kind: 'worker', run: row }),
    [],
  )

  // held → StuckItem（2026-07-31 审计 C-3 后简化）。
  //
  // 曾经这里按 jobId 去 recent[] 反查名字与海报——那个 join 的**设计假设是对的**
  // （held 与 recent 由同一次收官连续写入，审计用真 DB 复刻确认命中），但它**会过期**：
  // held 停留天级（heldBackoffMs +1d/+3d/+7d），recent 是 20 条滑动窗口，生产节奏
  // （每小时 20 条）下一小时内就被挤出。此后卡死态没有图（违反 L4）、退化成显示
  // `tmdb:1396/s12e04` 这种技术标识符（违反 L3）。
  //
  // 后端已给 held DTO 补上名字与海报（apiV2.ts 的那处 LEFT JOIN），所以这里直接用，
  // 不再有跨集合 join，也就没有过期问题。
  //
  // stageAtFailure 恒传 null：held 记录**没有 trail**（后端 held 是 state='failed'、
  // running 是 state='searching'，两者互斥），所以"故障时的阶段"在服务端根本不存在。
  // 要它非 null 得让前端跨轮次记住每个 jobId 最后见到的 stage——那是客户端状态而非事实。
  // ActivityStuck 论证过 null 时整条不渲染，比渲染空条（读作 0%，正是禁止的清零）
  // 或扫动条（谎称在干活）都诚实。
  const stuck = useMemo<StuckItem[]>(
    () => (workers.data?.held ?? []).map((h) => ({
      held: h,
      title: h.seriesName ?? h.movieName ?? null,
      posterPath: h.posterPath,
      backdropPath: h.backdropPath,
      stageAtFailure: null,
    })),
    [workers.data],
  )

  const running = workers.data?.running ?? []
  const recent = workers.data?.recent ?? []

  // 缺字幕集数：按 seriesId 汇总 pending.series[]（逐季一行）。
  // ⚠️ 那个字段叫 `series`，**不是 missingBySeason**（后者是后端 LibraryRepo 的方法名，
  // spec 判据 12 要求前端代码 grep 它必须为空）。
  const missingBySeries = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of pending.data?.series ?? []) {
      m.set(s.seriesId, (m.get(s.seriesId) ?? 0) + s.missing)
    }
    return m
  }, [pending.data])

  // 首载：两个数据源都还没到位 → 什么都不渲染（不给骨架屏/转圈）。
  // 理由同 SummaryLine 的既有哲学：宁可空白一瞬，也不显示一个可能立刻被推翻的状态。
  if (pending.data === null && workers.data === null) return null

  // 失败开放：只有 data === null（还没回来 / 拉取失败）才回落成「开」。写成 `?? false` 会在
  // 拉取失败时把正在干活的后端画成「已停工」；写成 `|| true` 会让真的关掉也显示成开——两种都
  // 不会被 hero 那边的测试抓住（那边是直接喂 prop 的），所以本页测试里各有一条锁守着。
  const engineEnabled = setup.data ? setup.data.engineEnabled : true

  const onEngineChange = async (next: boolean) => {
    try {
      await api.updateSettings({ engine_enabled: next ? 'true' : 'false' })
    } catch {
      // 不吞：受控件不位移——checked={engineEnabled}，真值只在 setup.data.engineEnabled，
      // 拨动后拇指**不会立刻动**，要等下面这次回读把服务端值拉回来才动；PUT 失败则纹丝不动，
      // 「拨了没反应」本身就是诚实的失败信号（本屏无 toast 承接错误文案，L7：不给排查入口）。
      // catch 不能省：不 catch，rejection 就是控制台里一条 unhandled rejection——那才真的没人看见。
    }
    setup.reload()
  }

  const body = stuck.length > 0
    ? <ActivityStuck items={stuck} now={now} />
    : running.length > 0
      ? (
        <>
          {running.map((r, i) => (
            <ActivityHero
              key={r.jobId}
              running={r}
              missingCount={r.seriesId === null ? null : missingBySeries.get(r.seriesId) ?? null}
              now={now}
              // 发动机是**全局**开关，只挂第一条。并发在跑时每条 hero 各挂一个的话，同一个状态
              // 在屏上出现两次、拨一个另一个跟着变，读起来像「每个任务各有一台发动机」。
              // hero 的两个 prop 都是 optional，给 undefined 就是那一块不渲染，组件侧不用改。
              engineEnabled={i === 0 ? engineEnabled : undefined}
              onEngineChange={i === 0 ? onEngineChange : undefined}
            />
          ))}
          <ActivityQueue
            series={pending.data?.series ?? []}
            movies={pending.data?.movies ?? []}
          />
          <ActivityDone recent={recent} now={now} onOpen={onOpen} />
        </>
      )
      // 全闲：空态自带「刚刚完成」列表与新鲜度时间戳（L6——不写「都齐了」，只给可核对的事实）。
      // meta 缺席时不渲染：那一屏的全部内容就是 meta 里的时间戳，没有它没什么可说的。
      : pending.data === null
        ? null
        : <ActivityEmpty meta={pending.data.meta} recent={recent} now={now} onOpen={onOpen} />

  // 三块之间 12px。这个 VStack 是**裸的**（没有 className），CSS 里没有任何选择器命中它——
  // flex flex-col gap-3 就是布局的唯一来源，掉了整页会贴成一坨。逐值等价：Astryx 的
  // gap={3} → --spacing-3 = 12px（tokens.stylex.ts:158），Tailwind gap-3 = 0.75rem，
  // 而 styles.css 与 theme/scout.css 都没有改根字号，所以也是 12px。
  return (
    <div className="flex flex-col gap-3">
      {body}
      {openRun !== null ? (
        <RunDetail
          source={openRun}
          now={now}
          onClose={() => setOpenRun(null)}
          onRerun={setRerunRequest}
        />
      ) : null}
      {/* RerunDialog 自己管两阶段（确认 → 结果），request=null 即关闭。
          关闭时刷新 workers——重派可能已改变在跑集合。 */}
      <RerunDialog
        request={rerunRequest}
        onClose={() => { setRerunRequest(null); workers.reload() }}
      />
    </div>
  )
}
