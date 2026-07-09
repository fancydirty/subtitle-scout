// web/src/api/useDashboard.ts
import { useEffect, useState, useCallback } from 'react'
import { api } from './client.js'
import type { SummaryDTO, RunsDTO } from './types.js'

const POLL_MS = 12_000

export function useDashboard() {
  const [summary, setSummary] = useState<SummaryDTO | null>(null)
  const [runs, setRuns] = useState<RunsDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([api.summary(), api.runs()])
      setSummary(s); setRuns(r); setError(null)
    } catch (e) { setError(String(e)) }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  return { summary, runs, error, refresh }
}
