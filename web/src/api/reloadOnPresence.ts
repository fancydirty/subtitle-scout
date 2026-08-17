// web/src/api/reloadOnPresence.ts：媒体库该不该因在场变化再拉一次（不定时轮询）。
//
// found 序号变了 → 刚装上字幕。health.current 从有变无 → 本轮扫盘已排进主循环。
import { useEffect, useRef } from 'react'
import { useFoundEvent } from '../events/EventsProvider.js'
import type { ScoutCurrentDTO } from './types.js'

export function shouldReloadMedia(
  prev: ScoutCurrentDTO | null,
  next: ScoutCurrentDTO | null,
  foundSeq: number,
  prevFoundSeq: number,
): boolean {
  if (foundSeq !== prevFoundSeq) return true
  if (prev !== null && next === null) return true
  return false
}

/** 基线之后的 found → reload。挂载时 Context 里已有的事件不算（否则一进页就空转重拉）。 */
export function useReloadOnFound(reload: () => void): void {
  const found = useFoundEvent()
  const seenFoundId = useRef<number | null>(null)
  const baselineTaken = useRef(false)
  useEffect(() => {
    if (!baselineTaken.current) {
      baselineTaken.current = true
      seenFoundId.current = found?.id ?? null
      return
    }
    if (found == null) return
    if (seenFoundId.current !== null && found.id <= seenFoundId.current) return
    seenFoundId.current = found.id
    reload()
  }, [found, reload])
}
