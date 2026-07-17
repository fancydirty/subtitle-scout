// web/src/api/hooks.ts：轻 fetch hooks。三态齐（loading/error/data），海报墙 15s 轮询，
// visibilitychange 时暂停轮询（省流、后台不空转）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client.js'
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ParkedItemDTO, WorkflowPendingDTO,
  LibrarySeriesDetailDTO, WorkflowPassDTO, WorkflowWorkersDTO, RunTraceDTO, TriageDTO,
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

/** dashboard-F5：甄别台（Triage tab）——pending（park 救援清单）+ claimed（已认领 override
 *  清单）。同 useParked 的既有先例：一次性 + 手动 reload（不轮询，ClaimDialog 提交成功后调用方
 *  自己 reload——认领是低频人工动作，不像 workflow 那样需要常驻轮询感知后台变化）。 */
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
