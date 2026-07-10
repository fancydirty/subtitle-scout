// web/src/api/hooks.ts：轻 fetch hooks。三态齐（loading/error/data），海报墙 15s 轮询，
// visibilitychange 时暂停轮询（省流、后台不空转）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client.js'
import type { LibraryItemDTO, SeriesDetailDTO, RunHistoryDTO } from './types.js'

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
