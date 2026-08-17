// web/src/api/hooks.ts：轻 fetch hooks。三态齐（loading/error/data），轮询类 15s，
// visibilitychange 时暂停轮询（省流、后台不空转）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client.js'
import { useReloadOnFound } from './reloadOnPresence.js'
import type {
  RunHistoryDTO,
  WorkflowPassDTO, RunTraceDTO,
  SettingsDTO, MediaRootDTO,
  SubtitleVerifyListDTO,
  SubtitleCompareDTO,
  SetupStatusDTO,
  ProvidersDTO,
  ShiftedItemDTO,
  DormantTaskDTO,
  HealthDTO,
  MediaLibraryItemDTO,
  MediaLibraryDetailDTO,
  ActivityDTO,
  FoundGroupDTO,
} from './types.js'

export interface Async<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

const LIBRARY_POLL_MS = 15_000

// ---- 2026-08-12（无活 UI 端点裁决）：四个旧库 hook 已删除 ----
// useLibrary / useSeries / useLibrarySeriesDetail / useLibraryMovieDetail 连同它们的
// client 方法、DTO 与后端端点一并删除。前三者在 Task ⑪ 之后消费方只剩 _legacy/（或归零：
// AppShell 删旧分支时把后两个 hook 的调用一并删了），useSeries 更是全仓零调用。
// 媒体库的活 hook 是 useMediaLibrary / useMediaLibraryDetail。
//
// ⚠️ LIBRARY_POLL_MS（上方 15s 常量）**不随之删除**：它是本文件 8 个轮询 hook 共用的节律
//    常量，名字里的 LIBRARY 是历史命名，不代表它属于旧库那一族。

const PAGE = 50

/** 全局历史分页。offset 由页码推导。 */
export function useRuns(page: number): Async<RunHistoryDTO[]> {
  const [data, setData] = useState<RunHistoryDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .runs(page * PAGE, PAGE, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [page, nonce])

  return { data, loading, error, reload }
}

export const RUNS_PAGE_SIZE = PAGE

// ── parked 族已整体删除，2026-08-13 ──────────────────────────────────────────
// `ParkedItemDTO` / `TriageDTO` / `api.parked` / `api.triage` / `api.unexclude` /
// `useParked` / `useTriage`，连同后端 GET /api/parked、GET /api/v2/triage、
// POST /api/v2/triage/unexclude 与 PendingBox/ExcludedBox 两个区。
// 判据：parked_paths 的唯一写入者 src/v2/ingest.ts 本轮退役，表从此零写入者——
// 留着读出面 = 给一张永远为空的表建界面。正本论证见 web/src/triage/TriagePage.tsx
// 头注释的「2.5 parked 族的结局」段。

/** dashboard-F4：中泳道 pass 记录——同 useLibrary/useWorkflowPending 的既有轮询节奏（15s、
 *  后台不可见时暂停）。limit 固定传入（Lanes.tsx 目前只用一个值，不做分页）。 */
export function useWorkflowPasses(limit: number): Async<WorkflowPassDTO[]> {
  const [data, setData] = useState<WorkflowPassDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.workflowPasses(limit)
      setData(d)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [limit])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}

// `useWorkflowWorkers` 已于 2026-08-13 随 GET /api/v2/workflow/workers 一并删除
// （裁决见 src/dashboard/apiV2.ts 墓碑注释）。它是本文件里最后一个"只服务 _legacy 页面"
// 的轮询 hook——留着就是每 15 秒对一个已不存在的端点打一次 404。

/** dashboard-F6：Settings tab 行为级设置——一次性 + 手动 reload（同 useTriage/useParked 的既有
 *  先例：设置改动是低频人工动作，不需要常驻轮询；BehaviorSection 单键 PUT 成功后直接用响应体
 *  回写本地状态，不依赖这里的 reload——reload 只在首载失败重试时用）。 */
export function useSettings(): Async<SettingsDTO> {
  const [data, setData] = useState<SettingsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .settings(ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [nonce])

  return { data, loading, error, reload }
}

/** dashboard-F6：部署层 env 脱敏只读展示——一次性（同 useSettings，deploy env 在运行期内不会
 *  变化，没有轮询的理由）。 */
export function useRoots(): Async<MediaRootDTO[]> {
  const [data, setData] = useState<MediaRootDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .roots(ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [nonce])

  return { data, loading, error, reload }
}

/** dashboard-F4：RunDetail 右侧板的快照回放——一次性请求（同 useSeries/
 *  useLibrarySeriesDetail：详情不轮询），runId 为 null 时（RunDetail 未开）完全不发请求
 *  （同 useLibrarySeriesDetail 对 id=null 的既有降级口径）。 */
export function useRunTrace(runId: number | null): Async<RunTraceDTO> {
  const [data, setData] = useState<RunTraceDTO | null>(null)
  const [loading, setLoading] = useState(runId != null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (runId == null) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .runTrace(runId, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [runId, nonce])

  return { data, loading, error, reload }
}

/** 字幕校验（2026-07-30）：一次拿一批条目的校验结论，供剧集页整季渲染芯片。
 *
 *  为什么 key 是 join 后的字符串而不是数组本身：调用方几乎必然在 render 里现算这个
 *  id 列表（`season.onDisk.map(e => e.id)`），每次 render 都是新引用 —— 直接放进
 *  useEffect 依赖数组会无限重发请求。join 成字符串让依赖变成值比较。
 *
 *  空列表不发请求（省一次必然返回空的往返），data 给 `{items:[]}` 而非 null——
 *  调用方因此不需要区分"还没加载"和"没有条目"两种空。 */
export function useSubtitleVerify(itemIds: readonly string[]): Async<SubtitleVerifyListDTO> {
  const key = itemIds.join(',')
  const [data, setData] = useState<SubtitleVerifyListDTO | null>(null)
  const [loading, setLoading] = useState(key.length > 0)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (key.length === 0) {
      setData({ items: [] })
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .subtitleVerify(key.split(','), ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [key, nonce])

  return { data, loading, error, reload }
}

/** 对照图数据（2026-07-30）：itemId 为 null 时不发请求（面板关着）。 */
export function useSubtitleCompare(itemId: string | null): Async<SubtitleCompareDTO> {
  const [data, setData] = useState<SubtitleCompareDTO | null>(null)
  const [loading, setLoading] = useState(itemId !== null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (itemId === null) {
      // 关面板时清掉旧数据：否则下次打开另一集会先闪一帧上一集的时间轴
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .subtitleCompare(itemId, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [itemId, nonce])

  return { data, loading, error, reload }
}

/** setup/status：BootstrapGate 与 EngineBanner 共用。15s 轮询——engineEnabled 翻转 ≤15s 上屏
 *  （spec A §5.5 的"下 tick 生效"在前端侧的镜像）；可见性暂停与 useLibrary 同样板。 */
export function useSetupStatus(): Async<SetupStatusDTO> {
  const [data, setData] = useState<SetupStatusDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.setupStatus()
      setData(rows)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}

/**
 * useSetupProviders：Settings Providers 区的行数据（打码/source/上次测试点）。15s 轮询与
 * useSetupStatus 同节拍；编辑/测试动作后组件直接调 reload 立即刷新，不等下一拍。
 */
export function useSetupProviders(): Async<ProvidersDTO> {
  const [data, setData] = useState<ProvidersDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const dto = await api.setupProviders()
      setData(dto)
      setError(null)
    } catch (e) {
      // String(e) 而非 e instanceof Error ? e.message : String(e)——本文件 12 个既有 hook
      // 一律 String(e)，同文件同层的 useSetupStatus（Task 14 Step 5）也是。
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      // 守卫写法照抄既有轮询 hook（本文件 useLibrary/useWorkflowPasses/
      // useSetupStatus 四处一模一样）：visibilitychange 连发或 effect 复跑时，
      // 没这道判断会叠出第二个 setInterval，旧句柄被覆盖后再也 clear 不掉——越切标签页轮询越快。
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}

/** Plan C（spec §4.1）：偏移清单。15s 轮询同既有节律——偏移是"检出后静置"的事实，
 *  不需要更快的刷新（SSE 只喂在跑任务的痕迹，与这里无关）。 */
export function useShiftedSubtitles(): Async<ShiftedItemDTO[]> {
  const [data, setData] = useState<ShiftedItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.subtitleShifted()
      setData(rows)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}

/** Plan C（spec §4.2）：停车任务清单。同 15s 节律。 */
export function useDormantTasks(): Async<DormantTaskDTO[]> {
  const [data, setData] = useState<DormantTaskDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.workflowDormant()
      setData(rows)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const reload = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])

  useEffect(() => {
    void load()
    const start = () => {
      if (timer.current == null) timer.current = setInterval(() => void load(), LIBRARY_POLL_MS)
    }
    const stop = () => {
      if (timer.current != null) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load()
        start()
      } else {
        stop()
      }
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return { data, loading, error, reload }
}

/**
 * Task ⑦：健康快照（GET /api/v2/health）。
 *
 * ── 为什么**不轮询**（与隔壁 useLibrary 的 15s 轮询刻意不同）───────────────────
 * 这个端点的存在理由是"SSE 断线期间丢了事件，重连后纠正当前态"（后端 F-6 论证）。
 * 纠正的**触发时机是重连**，不是时间——挂个 15 秒定时器等于在一条已经好好连着的 SSE
 * 旁边再开一路轮询，正是 R-F6「用 SSE 不用轮询」要消灭的东西。
 *
 * 故：首载一次 + 暴露 reload()。**谁在重连时调 reload 是消费页面的责任**（Task ⑨ 的
 * 活动页：订 useEventsStatus，从 retrying/connecting 变回 open 时调一次）。
 * ⚠️ 本 task **没有任何生产调用点**——三个页面都还是占位壳。这是有意的、也是如实记录的：
 * 本仓的病 A 是"加了能力却没定谁写/谁读/谁触发"，所以这里把三方**写明**：
 *   谁写 = 后端 /api/v2/health；谁读 = Task ⑨ 活动页顶部状态条 + 健康横幅；
 *   谁触发 = 首载 + SSE 从非 open 恢复到 open 时的那一次 reload。
 * 在 Task ⑨ 接上之前，它只有测试在用——**不算完成**，与 Task ①「无消费者不标完成」同一条纪律。
 */
export function useHealth(): Async<HealthDTO> {
  const [data, setData] = useState<HealthDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    api
      .health(ctrl.signal)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [nonce])

  return { data, loading, error, reload }
}

/** Task ⑧：媒体库页海报墙（GET /api/v2/mediaLibrary）。
 *
 *  ── 为什么**不轮询**（与隔壁 useLibrary 的 15s 轮询刻意不同）───────────────────
 *  useLibrary 那 15s 是 dashboard-F2 时代"顶栏新鲜度行必须活着"的遗产。媒体库页回答的是
 *  「我这部剧应该有哪些集、磁盘上有哪些」——**磁盘扫描是分钟到小时级的事实**，每 15 秒
 *  重打一次全库聚合（buildMediaLibrary 是三条全表查询 + 逐格聚合）只是在给自己制造负载，
 *  用户也看不出任何差别。故：首载一次 + 暴露 reload()。同 useTriage/useSettings 的既有先例。
 *
 *  谁触发 reload：错误态那个「重试」按钮（MediaLibraryPage）；SSE `found`（基线之后）；
 *  `health.current` 从有变无（MediaLibraryPage 调 shouldReloadMedia）。不定时轮询。 */
export function useMediaLibrary(): Async<MediaLibraryItemDTO[]> {
  const [data, setData] = useState<MediaLibraryItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  useReloadOnFound(reload)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .mediaLibrary(ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [nonce])

  return { data, loading, error, reload }
}

/** Task ⑧：媒体库详情（季集网格）。workId 为 null（不在 #/media/:workId 二级路由上）时
 *  **完全不发请求**——Shell 在每次渲染都会调用这个 hook，null 也照打的话另外三个 tab
 *  会白白 404 一次（同 useLibrarySeriesDetail 的既有降级口径，一字不差）。
 *  一次性、不轮询：同 useMediaLibrary 的理由，详情更不需要。found 到达（基线之后）再拉一次。 */
export function useMediaLibraryDetail(workId: string | null): Async<MediaLibraryDetailDTO> {
  const [data, setData] = useState<MediaLibraryDetailDTO | null>(null)
  const [loading, setLoading] = useState(workId != null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  useReloadOnFound(reload)

  useEffect(() => {
    if (workId == null) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .mediaLibraryDetail(workId, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [workId, nonce])

  return { data, loading, error, reload }
}

/** Task ⑩：通知页流水（GET /api/v2/notifications）。
 *
 *  ── 这是通知列表的**唯一**数据源（R-F3 + 设计文档 §3.4 的分工裁决）─────────────
 *  SSE 的 `found` 事件**不进列表**。理由在后端 server.ts:814 与 notificationsRepo 头注释：
 *  `recordFound` 是幂等刷新（同一组 ON CONFLICT DO UPDATE 而非 INSERT），而 SSE 每次装盘
 *  都发一条——**两边的条目数天然不等**。拿 SSE 事件往列表里插，那个差值就会以重复条目的
 *  形态摆在用户眼前（同一部剧在流水里出现两次，一条来自端点、一条来自事件）。
 *  SSE 在通知页的职责是 **found → 再 GET**（见 useReloadOnFound）。事件对象不进列表。
 *
 *  ── 为什么**不轮询**（同 useMediaLibrary/useHealth 的既有理由）────────────────
 *  这一页有 SSE：新成果到达的那一刻 found 事件就到了，立刻再拉账本。在一条已经好好连着
 *  的 SSE 旁边再挂 15 秒定时器，正是 R-F6「用 SSE 不用轮询」要消灭的东西。
 *
 *  谁触发 reload（本仓的病 A 是"加了能力却没定谁触发"，故如实登记）：
 *   ① found 事件（基线之后，本 hook 内）；
 *   ② 错误态的「重试」按钮；
 *   ③ LiveOffBanner 的手动重拉；
 *   ④ SSE 从非 open 恢复到 open 时的那一次补拉——断线期间的 found 事件全部丢失
 *      （eventsBus 的续传只补后端环形缓冲里还在的，且它"不是账目"），不补拉的话
 *      用户会盯着一个永远不更新也永远不提示的列表。 */
export function useNotifications(): Async<FoundGroupDTO[]> {
  const [data, setData] = useState<FoundGroupDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  useReloadOnFound(reload)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .notifications(ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [nonce])

  return { data, loading, error, reload }
}

/** Task ⑨：活动页排队段（GET /api/v2/activity）。
 *
 *  ── 为什么**不轮询**（同 useMediaLibrary/useHealth 的既有理由）─────────────────
 *  R-F6 的裁决是"用 SSE 不用轮询"。队列的变化时机是**离散且可观测**的：daemon 开始处理
 *  下一个作品时会 emit 一条 activity。故这里的刷新触发点是**那条事件**，不是定时器——
 *  由 ActivityPage 在收到 activity 事件时调 reload()（谁触发写明在这里，本仓的病 A 是
 *  "加了能力却没定谁触发"）。
 *
 *  三个 reload 触发点，全部在 ActivityPage：
 *   ① 收到 activity 事件（队列刚少了一个/多了一个）；
 *   ② SSE 从非 open 恢复到 open（断线期间的队列变化一次补齐）；
 *   ③ 错误态那个「重试」按钮。 */
export function useActivity(): Async<ActivityDTO> {
  const [data, setData] = useState<ActivityDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    // ⚠️ **不在这里 setLoading(true)**（与 useMediaLibrary 刻意不同）：这个 hook 会被
    // activity 事件频繁 reload，每次都把 loading 抬起来会让已经渲染出来的队列在每条事件
    // 到达时闪成骨架屏。首载那次的 loading 由 useState 初值给出，之后一律**静默重取**
    // （旧数据留在屏幕上直到新数据到达）。
    api
      .activity(ctrl.signal)
      .then((d) => {
        setData(d)
        setError(null)
      })
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [nonce])

  return { data, loading, error, reload }
}
