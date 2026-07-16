// web/src/api/hooks.ts：轻 fetch hooks。三态齐（loading/error/data），海报墙 15s 轮询，
// visibilitychange 时暂停轮询（省流、后台不空转）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client.js'
import type {
  LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO, ParkedItemDTO, WorkflowPendingDTO,
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
