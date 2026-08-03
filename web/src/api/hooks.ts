// web/src/api/hooks.ts：轻 fetch hooks。三态齐（loading/error/data），海报墙 15s 轮询，
// visibilitychange 时暂停轮询（省流、后台不空转）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client.js'
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ParkedItemDTO, WorkflowPendingDTO,
  LibrarySeriesDetailDTO, WorkflowPassDTO, WorkflowWorkersDTO, RunTraceDTO, TriageDTO,
  SettingsDTO, DeploySettingsDTO, MediaRootDTO,
  SubtitleVerifyListDTO,
  SubtitleCompareDTO,
  SetupStatusDTO,
  ProvidersDTO,
} from './types.js'

export interface Async<T> {
  data: T | null
  loading: boolean
  error: string | null
  reload: () => void
}

const LIBRARY_POLL_MS = 15_000

/** 海报墙：首载 + 15s 轮询；页面不可见时暂停，恢复可见立即刷新。 */
export function useLibrary(): Async<LibraryItemDTO[]> {
  const [data, setData] = useState<LibraryItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const rows = await api.library()
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

/** 剧详情：随 id 变化重取，一次性（详情不轮询）。 */
export function useSeries(id: string): Async<SeriesDetailDTO> {
  const [data, setData] = useState<SeriesDetailDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .series(id, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [id, nonce])

  return { data, loading, error, reload }
}

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

/** 去 Jellyfin 化 P6：park 救援页列表——一次性 + 手动 reload（不轮询，认领后调用方自己 reload）。 */
export function useParked(): Async<ParkedItemDTO[]> {
  const [data, setData] = useState<ParkedItemDTO[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .parked(ctrl.signal)
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

/** dashboard-F3：剧集页三层格阵详情——随 id 变化重取，一次性（同 useSeries，详情不轮询）。
 *  id 为 null 时（不在 #/library/:id 二级路由上）完全不发请求——Shell 在每次渲染都会调用
 *  这个 hook（喂给 Topbar 面包屑 + SeriesPage），如果 null 也照样打一次 GET，四个 tab 里
 *  三个会白白 404 一次；hooks 调用顺序仍然稳定（id 从 null 变成字符串只是走 else 分支，
 *  不影响 hook 调用次数/顺序）。 */
export function useLibrarySeriesDetail(id: string | null): Async<LibrarySeriesDetailDTO> {
  const [data, setData] = useState<LibrarySeriesDetailDTO | null>(null)
  const [loading, setLoading] = useState(id != null)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (id == null) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .librarySeriesDetail(id, ctrl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (!ctrl.signal.aborted) setError(String(e))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [id, nonce])

  return { data, loading, error, reload }
}

/** dashboard-F2：外壳级数据面——顶栏新鲜度行 + 侧栏甄别角标共用这一份轮询，避免两处各发一次。
 *  轮询节奏与策略沿用 useLibrary（15s、后台不可见时暂停）：这行是"系统在跑"的唯一信号源，
 *  过期太久等于假装活着（DESIGN.md §0）。本地无 daemon 时 fetch 会失败——data 保持 null，
 *  调用方（Topbar/Sidebar）必须能优雅降级，不许因为这个请求失败就整屏空白。 */
export function useWorkflowPending(): Async<WorkflowPendingDTO> {
  const [data, setData] = useState<WorkflowPendingDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.workflowPending()
      setData(d)
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

/** dashboard-F4：右泳道跑中/近期 worker——同样 15s 轮询做"落后补拉"（SSE 直播是增量，这份
 *  轮询是兜底真源：running[].trail 首屏种子 + 断线重连后的补齐，见 workflow/traceStream.ts
 *  的 onReconnect 钩子，由 Lanes.tsx 在重连时主动调用这里的 reload()）。 */
export function useWorkflowWorkers(): Async<WorkflowWorkersDTO> {
  const [data, setData] = useState<WorkflowWorkersDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.workflowWorkers()
      setData(d)
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

/** dashboard-F5：甄别台（Triage tab）——pending（park 救援清单）。同 useParked 的既有先例：
 *  一次性 + 手动 reload（不轮询——翻案是低频人工动作，不像 workflow 那样需要常驻轮询感知
 *  后台变化）。 */
export function useTriage(): Async<TriageDTO> {
  const [data, setData] = useState<TriageDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .triage(ctrl.signal)
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
export function useDeploySettings(): Async<DeploySettingsDTO> {
  const [data, setData] = useState<DeploySettingsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .deploySettings(ctrl.signal)
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

/** dashboard-F6：守备目录清单——一次性 + 手动 reload（同 useTriage：加根/删根成功后调用方自己
 *  reload，不轮询——守备目录改动同样是低频人工动作）。 */
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
      // 守卫写法照抄既有轮询 hook（本文件 useLibrary/useWorkflowPending/useWorkflowPasses/
      // useWorkflowWorkers/useSetupStatus 五处一模一样）：visibilitychange 连发或 effect 复跑时，
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
