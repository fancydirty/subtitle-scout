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
//     正在跑：横版 backdrop 卡片（每 tab 0 或 1 张——后端 currents 是 per-workbench 三槽，
//             字幕 tab 读 subtitle 槽、翻译 tab 读 translate 槽，**互不覆盖**）
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
import { api } from '../api/client.js'
import { useActivity, useHealth } from '../api/hooks.js'
import {
  useActivityEvent, useHealthEvent, useEventsStatus,
} from '../events/EventsProvider.js'
import { subscribeEvents } from '../events/eventsBus.js'
import { useResumeEdge } from '../events/resumeEdge.js'
import { useT, type Lang } from '../i18n/useT.js'
import { localizeError } from '../lib/errorText.js'
import { RootHealthNote } from '../shell/RootHealthNote.js'
import { UnidentifiedNote } from './UnidentifiedNote.js'
import { StalledJobsNote } from './StalledJobsNote.js'
import type { EventsStatus, ScoutEvent } from '../events/types.js'
import type { ActivityQueueItemDTO, HealthDTO, ScoutCurrentDTO } from '../api/types.js'
import { ACTIVITY_TABS, laneOf, type ActivityTab } from './workbenchRouting.js'
import { displayTitle } from './displayTitle.js'
import { stepActionKey, stageOf } from './stepPhrase.js'
// 2026-08-13 清理：`tabOf` 从这行 import 里删除（本文件零调用）。
// 它的文档写着"两个 tab 的唯一入口"，读起来像是本页的路由核心——实测**生产零调用者**，
// 只有 workbenchRouting.test.ts 在测它。为什么用不上：本页两个 tab 的队列不是靠事件分流
// 得来的，而是后端**已经分好**两条（activityData.subtitleQueue / translateQueue，:423），
// 前端只按当前 tab 取其中一条。事件流这侧只需要 laneOf（判 patrol / identify），
// 不需要"事件 → tab"这层映射。
// 函数本体保留在 workbenchRouting.ts（有测试、语义正确、导出可用），只是本页不 import 它。
import { inspectFreshness, liveFreshness, relAgoLabel, relUntilLabel, msUntilNextInspect, workPermission, type LiveFreshness } from './inspectFreshness.js'
import { RunCard, QueueCard, type WorkbenchCardFace } from './WorkbenchCards.js'

// ═══════════════════════════════════════════════════════════════════════════
// 当前态：SSE 增量 + health 快照纠正（per-workbench 三槽，2026-08-30）
// ═══════════════════════════════════════════════════════════════════════════

/** 一个槽的本地视图 = ScoutCurrentDTO（workId / backdrop / lastStep 已在 DTO 上）。 */
type Current = ScoutCurrentDTO

/**
 * 三个工作台各自的当前态（对齐后端 ScoutCurrents / health.currents）。
 *
 * ── 为什么不是单个 current（韩语 live test 实证）──
 * daemonV2 两车道并发（字幕/翻译），单槽下后到的事件把前一车道的本地态整个顶掉：
 * 翻译台高频跑动时字幕 tab 的覆盖格反复被抹掉。三槽让每条带 workbench 的事件只写
 * 自己的槽——subtitle tab 读 subtitle 槽、translate tab 读 translate 槽、
 * 顶部识别状态条读 identify 槽，互不覆盖。
 */
type Currents = {
  identify: Current | null
  subtitle: Current | null
  translate: Current | null
}

const EMPTY_CURRENTS: Currents = { identify: null, subtitle: null, translate: null }

/** data 里的身份/步骤字段：空串与非字符串一律 null，**绝不 Number() 强转**。 */
function nonemptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/**
 * SSE 事件 + health 快照 → 三槽当前态。
 *
 * ── 纠正的触发时机是**重连**，不是时间（后端 useHealth 注释里点名的那条）──
 * 挂个 15 秒定时器等于在一条好好连着的 SSE 旁边再开一路轮询，正是 R-F6 要消灭的东西。
 * 故只在两个时刻用快照：① 首载 ② SSE 从非 open 恢复到 open。
 */
function useCurrentState(health: HealthDTO | null, reloadHealth: () => void): Currents {
  const status = useEventsStatus()

  /** 三槽本地当前态。某槽 null = 那个工作台没在跑。 */
  const [currents, setCurrents] = useState<Currents>(EMPTY_CURRENTS)
  /** 已经把哪一条事件折进去了（按 id 去重）。直订阅下每条事件只回调一次，这份记账的
   *  现役职责是 seeded 播种门的判据（appliedId===0 = 还没应用过任何事件）与重连归零。 */
  const appliedId = useRef(0)

  // ── SSE 增量 ──────────────────────────────────────────────────────────
  // 判据逐字照后端 ScoutEventBus.updateCurrent（那是同一件事的服务端实现）：
  //  · 无 workbench（巡检级/扫描级）→ **清空全部三槽**（巡检完成/失败/下一轮开始都走这条，
  //    巡检边界 = 所有工作台归零）
  //  · activity + 有 workbench       → 该槽新作品开工，index/total 归 null
  //  · progress + 有 workbench       → 推进**该槽**的 index/total（他槽原样不动——修复本体）
  // ⚠️ 两处实现同形是**有意的冗余**：断线时前端只有事件流，必须自己能推导；
  // 而重连后 health 快照会覆盖它——快照是权威，这份推导只是断线期间的近似。
  const applyEvent = useCallback((e: ScoutEvent) => {
    if (e.id <= appliedId.current) return
    appliedId.current = e.id
    const lane = laneOf(e)
    if (lane === 'patrol') {
      setCurrents(EMPTY_CURRENTS)
      return
    }
    // ⚠️ 识别（lane==='identify'）**照样推进当前态**——R-F1 管的是"不进 tab"，
    // 不是"当它不存在"。identify 槽会被渲染在顶部状态条上（见 StatusBar）。
    const kind = lane
    if (e.type === 'activity') {
      const d = e.data
      setCurrents((prev) => ({
        ...prev,
        [kind]: {
          kind, title: e.title ?? null, index: null, total: null,
          workId: nonemptyString(d?.workId),
          backdropPath: nonemptyString(d?.backdropPath),
          chineseTitle: nonemptyString(d?.chineseTitle),
          startedAt: typeof e.at === 'number' ? e.at : Date.now(),
          lastStep: null,
          cueDone: null,
          cueTotal: null,
          // 新作品开工：覆盖格归零——上一部的格子不许贴到新卡上（同 lastStep 归 null 的口径）。
          targets: undefined,
        },
      }))
      return
    }
    if (e.type === 'progress') {
      const d = e.data
      const num = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) ? v : null
      const step = nonemptyString(d?.step)
      const cueDoneVal = num(d?.cueDone)
      const cueTotalVal = num(d?.cueTotal)
      // 覆盖格 targets：后端每条帧带**全量**快照（非增量），所以本条有就整包覆盖。
      const targetsVal = Array.isArray(d?.targets) ? d?.targets as Current['targets'] : undefined
      setCurrents((prev) => {
        // slot 是**本槽**的旧值（同槽必同 kind——旧单槽实现的 sameKind 判断随槽位化退役）；
        // "本条有就覆盖、缺席保留"的逐字段口径原样沿用，只是 prev 换成了本槽。
        const slot = prev[kind]
        return {
          ...prev,
          [kind]: {
            kind, title: e.title ?? null,
            index: num(d?.done), total: num(d?.total),
            workId: nonemptyString(d?.workId) ?? slot?.workId ?? null,
            backdropPath: nonemptyString(d?.backdropPath) ?? slot?.backdropPath ?? null,
            chineseTitle: nonemptyString(d?.chineseTitle) ?? slot?.chineseTitle ?? null,
            startedAt: slot?.startedAt ?? null,
            lastStep: step ?? slot?.lastStep ?? null,
            cueDone: cueDoneVal ?? slot?.cueDone ?? null,
            cueTotal: cueTotalVal ?? slot?.cueTotal ?? null,
            // 本条有就覆盖、缺席本槽保留（节流帧不带 targets，不许把里程碑帧的格子抹掉）。
            targets: targetsVal ?? slot?.targets ?? undefined,
          },
        }
      })
    }
  }, [])

  // ── 🔴 逐帧消费：直订阅 eventsBus，**不走** Context 的 last-wins 槽 ──────────
  // 2026-08-30 demo 双车道实案：Context 槽每类只存最后一条，消费方靠
  // `useEffect(()=>applyEvent(x),[x])` 时，同类型两条事件在同一个 passive-effect
  // 窗口内连发（<一帧间隔）会被 React 合并成一次 effect——前一条对 applyEvent
  // **永久不可见**。demo 每 tick 成对连发 subtitle→translate progress，subtitle 帧
  // 每次被吞，字幕 tab 的 currents 槽建不起来；产品级等价物是 SSE 重连 replay 的
  // 50 帧连发突发（REPLAY_BUFFER_CAP）。eventsBus 的 subscribeEvents 每条事件同步
  // 回调一次、无合并；applyEvent 内部全用函数式 setCurrents，逐帧调用天然安全。
  useEffect(() => {
    const un1 = subscribeEvents('activity', applyEvent)
    const un2 = subscribeEvents('progress', applyEvent)
    return () => { un1(); un2() }
  }, [applyEvent])

  // ── 首载：health 快照播种（三槽整包）─────────────────────────────────────
  // ⚠️ 只在**还没应用过任何事件**时播种：首载的 health 响应可能比第一条 SSE 事件晚到，
  // 无条件覆盖会把更新的事件态倒退回更旧的快照。
  const seeded = useRef(false)
  useEffect(() => {
    if (health && !seeded.current && appliedId.current === 0) {
      seeded.current = true
      // 逐槽显式取值而不是整包透传：老后端/脏响应缺槽时给 null，不让 undefined 溜进本地态。
      setCurrents({
        identify: health.currents?.identify ?? null,
        subtitle: health.currents?.subtitle ?? null,
        translate: health.currents?.translate ?? null,
      })
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

  return currents
}

/** 滚动 log：只追加**实际送到浏览器**的 progress.step 译文，上限 5；新 activity 重置。
 *
 *  ⚠️ **只收翻译车道**（2026-08-30 三槽化随手补的一致性）：这份 log 只被翻译卡渲染
 *  （字幕卡的 5 行滚动 log 已被 ticker 取代），而两车道**并发**——不过滤的话，字幕台的
 *  step 会窜进翻译卡的 log、字幕台开工会把翻译卡的 log 清空。单槽时代这条漏看不见
 *  （字幕事件一来整张翻译卡都没了）；三槽下翻译卡常驻，必须把车道滤干净。 */
function useStepLog(workId: string | null | undefined): string[] {
  const status = useEventsStatus()
  const { t } = useT()
  const [lines, setLines] = useState<string[]>([])
  const appliedAct = useRef(0)
  const appliedProg = useRef(0)

  const resetLog = useCallback(() => {
    appliedAct.current = 0
    appliedProg.current = 0
    setLines([])
  }, [])
  // 与 useCurrentState / StatusBar 同一条边沿：进程重启后事件 id 从 1 再起，
  // 不归零的话 1..n 会被 `id <= applied*` 丢掉，上一张卡的句子贴在新卡上。
  useResumeEdge(status, resetLog)

  const prevWorkId = useRef(workId)
  useEffect(() => {
    if (prevWorkId.current !== workId && prevWorkId.current != null) {
      appliedAct.current = 0
      appliedProg.current = 0
      setLines([])
    }
    prevWorkId.current = workId
  }, [workId])

  // ── 🔴 逐帧消费：直订阅 eventsBus（同 useCurrentState 的论证）───────────────
  // 这份 log 的每条 progress.step 都有信息量——两条不同 step 在同一个 passive-effect
  // 窗口内连发时，Context 的 last-wins 槽只让最后一条进 append，log 静默丢行。
  // activity（清 log 边界）一并直订阅：清与追加必须按**事件到达顺序**执行，
  // 一半走同步回调、一半走 passive effect 会把"开工后追加的行"倒序清掉。
  const onActivity = useCallback((e: ScoutEvent) => {
    if (e.id <= appliedAct.current) return
    appliedAct.current = e.id
    // 字幕/识别车道的开工不清翻译卡的 log（见头注释）；巡检级照清——翻译台此刻已归零。
    const lane = laneOf(e)
    if (lane === 'subtitle' || lane === 'identify') return
    setLines([])
  }, [])

  const onProgress = useCallback((e: ScoutEvent) => {
    if (e.id <= appliedProg.current) return
    appliedProg.current = e.id
    if (laneOf(e) !== 'translate') return
    const step = nonemptyString(e.data?.step)
    if (!step) return
    const phrase = t(stepActionKey(step))
    setLines((prev) => [...prev, phrase].slice(-5))
  }, [t])

  useEffect(() => {
    const un1 = subscribeEvents('activity', onActivity)
    const un2 = subscribeEvents('progress', onProgress)
    return () => { un1(); un2() }
  }, [onActivity, onProgress])

  return lines
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
  health, currents, status, reloadHealth,
}: {
  health: HealthDTO | null
  currents: Currents
  status: EventsStatus
  reloadHealth: () => void
}) {
  const { t, lang } = useT()
  const activity = useActivityEvent()
  const healthEvent = useHealthEvent()
  // 时钟只在挂载时取一次：这一行是"大约多久前"的粒度（分/时/天），
  // 每秒重算会让整个状态条每秒重渲染，而显示的字一分钟才变一次。
  const now = useMemo(() => Date.now(), [health])

  // "有没有工作台在跑" = 三槽任一非 null。⚠️ 不许只看某一个槽——那会在"只有翻译台在跑"
  // 时把 Run now 解禁、把巡检态报成 idle。
  const busy = currents.identify ?? currents.subtitle ?? currents.translate

  // running 跟 SSE 三槽，不跟 health.currents：POST 200 只是 queued，
  // 快照可能整轮都是 null；收工后 patrol 已把三槽清掉，health 却可能还挂着旧的。
  // 禁止 `busy ?? health.currents.*`——patrol 之后 SSE 是 null、中途快照仍可能非 null。
  const fresh = health ? inspectFreshness({ ...health, current: busy }, now) : null
  const perm = health ? workPermission(health) : null
  // 🟡 读数新鲜度。**电平**不是边沿——见 inspectFreshness 里 liveFreshness 的论证。
  const live = liveFreshness(status)

  const [pending, setPending] = useState(false)
  const [roundLive, setRoundLive] = useState(false)
  const [runAlert, setRunAlert] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  const wasRunning = useRef(false)
  const appliedRoundId = useRef(0)

  useEffect(() => {
    const running = busy != null
    if (running) {
      setPending(false)
      inFlightRef.current = false
    }
    if (wasRunning.current && !running) reloadHealth()
    wasRunning.current = running
  }, [busy, reloadHealth])

  const applyRound = useCallback((e: ScoutEvent | null) => {
    if (!e || e.id <= appliedRoundId.current) return
    const round = e.data?.inspectRound
    if (round !== 'start' && round !== 'end') return
    appliedRoundId.current = e.id
    if (round === 'start') {
      setRoundLive(true)
      return
    }
    setRoundLive(false)
    setPending(false)
    inFlightRef.current = false
    reloadHealth()
  }, [reloadHealth])

  useEffect(() => { applyRound(activity) }, [activity, applyRound])
  useEffect(() => { applyRound(healthEvent) }, [healthEvent, applyRound])

  // 进程重启后事件 id 从 1 再起。不归零的话重连后的 inspectRound end 会被
  // `e.id <= appliedRoundId` 丢掉，空巡检的 Run now 卡死到刷新。
  // 不在这里 reloadHealth：useCurrentState 的同一条边沿已经拉过，再拉会涨
  // F-6 用例的 /health 计数。
  const onRoundResume = useCallback(() => {
    appliedRoundId.current = 0
    setRoundLive(false)
    setPending(false)
    inFlightRef.current = false
  }, [])
  useResumeEdge(status, onRoundResume)

  // idle：下次自动检查倒计时（不再渲染「上次自动检查开始于」）。
  // never / stale / running 四态原句保留；stale 仍用「…前」（死亡信号，不是倒计时）。
  // roundLive / busy 必须压过 never：inspectFreshness 在 lastInspectAt=null 时
  // 先返回 never，冷启动第一轮工作台在跑也会被说成"还没检查过"。
  let inspectLine: string
  if (!fresh) inspectLine = t('wb_inspect_unknown')
  else if (roundLive || busy != null || fresh.phase === 'running') inspectLine = t('wb_inspect_running')
  else if (fresh.phase === 'never') inspectLine = t('wb_inspect_never')
  else if (fresh.phase === 'stale') {
    inspectLine = `${t('wb_inspect_stale')}（${relAgoLabel(fresh.msSinceStart ?? 0, lang)}）`
  } else {
    const until = health ? msUntilNextInspect(health, now) : 0
    if (until <= 0) {
      inspectLine = lang === 'zh'
        ? `${t('wb_inspect_next')}${t('wb_inspect_soon')}`
        : `${t('wb_inspect_next')} ${t('wb_inspect_soon')}`
    } else {
      inspectLine = lang === 'zh'
        ? `${t('wb_inspect_next')}${relUntilLabel(until, lang)}`
        : `${t('wb_inspect_next')} ${relUntilLabel(until, lang)}`
    }
  }

  const onRunNow = async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setRunAlert(null)
    setPending(true)
    try {
      await api.triggerInspect()
      reloadHealth()
      // 成功：pending / inFlight 留到 inspectRound end 或 workbench current。
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      setRunAlert(msg.includes('already running') ? t('wb_inspect_already') : t('wb_inspect_run_failed'))
      setPending(false)
      inFlightRef.current = false
    }
  }

  return (
    <div className="wb-statusbar" data-stale={fresh?.phase === 'stale' ? 'true' : 'false'}
         data-live={live}
         aria-label={t('wb_statusbar_label')}>
      <span data-testid="wb-inspect-line">
        <span className="wb-status-dot" aria-hidden="true" /> {inspectLine}
      </span>
      {perm === 'permitted' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="wb-inspect-now"
          disabled={pending || busy != null || roundLive}
          onClick={() => { void onRunNow() }}
        >
          {t('wb_inspect_run')}
        </Button>
      )}
      {runAlert && <span role="alert">{runAlert}</span>}

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

      {/* 🔴 认不出来的目录（病 A 第 7 例）——`/health` 的 `unidentified` 在这里第一次被读。
          紧挨 RootHealthNote 是刻意的：那一行说"引擎**看不看得见**我的库"，这一行说
          "引擎**认不认得**我库里的东西"——同一个问题的第四个侧面，同形同语汇。
          dirCount 为 0 时组件自己返回 null，认得出来的库一个字都不占屏。
          ⚠️ 这里**不给任何按钮**（R-F1「未识别资源不给用户改」）——完整论证见组件头注释。 */}
      <UnidentifiedNote unidentified={health?.unidentified} />

      {/* 🔴-4 记着失败、却再也没被重试的活。紧挨上面两行是刻意的：那两行说
          "引擎看不看得见 / 认不认得我的库"，这一行说"引擎记着有活没干完"——
          同一个问题的第五个侧面，同形同语汇。count 为 0 时组件自己返回 null。
          ⚠️ 这里**不给任何按钮**：唯一可能的那个（redispatch）写出来的行同样没人领。 */}
      <StalledJobsNote stalledJobs={health?.stalledJobs} />

      {/* 🔴 R-F1 的可见形态：识别在**这里**，不在 tab 里。
          三槽化后直接读 identify 槽——它只被 identify 车道的事件推进，
          字幕/翻译的高频帧碰不到它（单槽时代它们会把这一行顶掉）。 */}
      {currents.identify && (
        <span data-testid="wb-identify-line">
          {t('wb_identify_running')}{currents.identify.title ? `：${currents.identify.title}` : ''}
          {currents.identify.index !== null && currents.identify.total !== null
            ? ` ${currents.identify.index}/${currents.identify.total}`
            : ''}
        </span>
      )}

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

/** 「2018 · 动画 · 13 集待处理」那一行。缺席的段**整段不出现**（不留 "· ·"）。
 *
 *  🔴 第四段「16h 后重试」（2026-08-13）：`dueNow === false` 的项必须说出"等到什么
 *  时候"。只说"13 集待处理"而不说它正在退避，用户分不出「系统在等」与「系统卡住了」
 *  ——生产上这两件事看起来一模一样（33 个在等，其中到点可取 0）。
 *  `retryAfter` 缺席（后端老版本 / 到点项）时这一段整段不出现，不编一个时刻。 */
function subtitleLine(
  item: {
    year: number | null; mediaType: 'tv' | 'movie'; pendingFileCount: number
    dueNow?: boolean
    awaitingRescan?: boolean
  },
  t: (k: 'wb_media_tv' | 'wb_media_movie' | 'wb_pending_files' | 'wb_queue_retry_in' | 'wb_queue_awaiting_scan') => string,
): string {
  const parts: string[] = []
  if (item.year !== null) parts.push(String(item.year))
  parts.push(item.mediaType === 'movie' ? t('wb_media_movie') : t('wb_media_tv'))
  parts.push(`${item.pendingFileCount} ${t('wb_pending_files')}`)
  if (item.awaitingRescan) parts.push(t('wb_queue_awaiting_scan'))
  else if (item.dueNow === false) parts.push(t('wb_queue_retry_in'))
  return parts.join(' · ')
}

function faceOf(item: ActivityQueueItemDTO, t: ReturnType<typeof useT>['t'], lang: Lang): WorkbenchCardFace {
  return {
    title: displayTitle(lang, nonemptyString(item.title) ?? t('wb_untitled'), nonemptyString(item.chineseTitle)),
    subtitle: subtitleLine(item, t),
    posterPath: item.posterPath,
    backdropPath: item.backdropPath,
  }
}

function TabPanel({
  tab, current, queue, queueByWorkId, live, logLines,
}: {
  tab: ActivityTab
  current: Current | null
  queue: ActivityQueueItemDTO[]
  queueByWorkId: Map<string, ActivityQueueItemDTO>
  live: LiveFreshness
  logLines: string[]
}) {
  const { t, lang } = useT()
  const queued = current && current.kind === tab
    ? queue.filter((i) => i.workId !== current.workId)
    : queue
  const allWaiting = queued.length > 0 && queued.every((i) => i.dueNow === false)
  const now = Date.now()
  const fromQueue = current?.workId ? queueByWorkId.get(current.workId) : undefined
  const runTitle = current
    ? displayTitle(
      lang,
      nonemptyString(current.title) ?? nonemptyString(fromQueue?.title) ?? t('wb_untitled'),
      nonemptyString(current.chineseTitle) ?? nonemptyString(fromQueue?.chineseTitle),
    )
    : ''
  const runBackdrop = current
    ? nonemptyString(current.backdropPath) ?? nonemptyString(fromQueue?.backdropPath)
    : null
  return (
    <div>
      <div className="wb-section-head">{t('wb_section_running')}</div>
      {/* Task 9（字幕分支装配覆盖格 + ticker）——传给 RunCard 的三个新读数：
          · targets 直接透传（SSE progress / health 快照同型同源）；
          · stepTool 是 raw 工具 id——ActivityTicker 内部走 tickerPhrase 词表翻译，
            raw id 不上屏（不违反 stepLabel 的禁令）。object 暂无独立来源（后端 trace
            桥接帧只带工具名），恒 null → ticker 走降级句（旧 8 句语义）；等 object
            通道接通后具体对象句自动生效；
          · log 只留给翻译台：字幕卡的 5 行滚动 log 被 ticker 取代（useStepLog 是
            hook 不能条件调用，故在这里掐输出，不掐 hook 本身）。 */}
      {current && current.kind === tab ? (
        <RunCard
          face={{
            title: runTitle,
            subtitle: current.kind === 'translate' ? t('wb_run_translate') : t('wb_run_subtitle'),
            posterPath: null,
            backdropPath: runBackdrop,
          }}
          stage={current.lastStep ? stageOf(current.lastStep) : null}
          kind={current.kind === 'translate' ? 'translate' : 'subtitle'}
          progress={
            current.index !== null && current.total !== null
              ? { done: current.index, total: current.total }
              : null
          }
          cueProgress={
            current.cueDone !== null && current.cueTotal !== null
              ? { done: current.cueDone, total: current.cueTotal }
              : null
          }
          stepLabel={current.lastStep ? t(stepActionKey(current.lastStep)) : null}
          targets={current.targets ?? null}
          stepTool={current.lastStep ?? null}
          logLines={current.kind === 'translate' ? logLines : []}
          elapsedLabel={typeof current.startedAt === 'number' ? relAgoLabel(now - current.startedAt, lang) : null}
          staleNote={live === 'live' ? null : t('wb_run_maybe_stale')}
        />
      ) : (
        <div className="wb-card-sub" data-testid="wb-run-empty">{t('wb_running_none')}</div>
      )}

      <div className="wb-section-head" style={{ marginTop: 16 }}>
        {t('wb_section_queued')} · {queued.length}
      </div>
      {queued.length === 0 ? (
        <div className="wb-card-sub" data-testid="wb-queue-empty">{t('wb_queue_none')}</div>
      ) : (
        <>
          {allWaiting && (
            <div
              className="wb-card-sub"
              data-testid="wb-queue-all-backoff"
              role="status"
              aria-live="polite"
            >
              {t('wb_queue_all_backoff')}
            </div>
          )}
          <ul className="wb-list">
            {queued.map((item) => <QueueCard key={item.workId} face={faceOf(item, t, lang)} />)}
          </ul>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// 页面
// ═══════════════════════════════════════════════════════════════════════════

export function ActivityPage() {
  const { t, lang } = useT()
  const { data: health, reload: reloadHealth } = useHealth()
  const { data: activityData, loading, error, reload: reloadActivity } = useActivity()
  const status = useEventsStatus()

  const currents = useCurrentState(health, reloadHealth)
  // 滚动 log 只喂翻译卡（字幕卡已换 ticker），故跟翻译槽的 workId 走。
  const logLines = useStepLog(currents.translate?.workId)
  const activityEvent = useActivityEvent()

  const [tab, setTab] = useState<ActivityTab>('subtitle')

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
    <Section className="mx-auto w-full max-w-page">
      <div className="flex flex-col gap-3">
        <StatusBar health={health} currents={currents} status={status} reloadHealth={reloadHealth} />

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
            description={localizeError(error, lang)}
            actions={
              <Button variant="secondary" onClick={reloadActivity}>{t('wb_retry')}</Button>
            }
          />
        ) : loading && !activityData ? (
          <div className="wb-card-sub" aria-busy="true">{t('wb_loading')}</div>
        ) : (
          <TabPanel
            tab={tab}
            current={currents[tab]}
            queue={queues[tab]}
            queueByWorkId={queueByWorkId}
            live={liveFreshness(status)}
            logLines={logLines}
          />
        )}
      </div>
    </Section>
  )
}
