// web/src/api/reloadOnPresence.ts：媒体库该不该因在场变化再拉一次（不定时轮询）。
//
// found 序号变了 → 刚装上字幕。SSE 推导的 live current 从有变无 → 本轮扫盘已排进主循环。
// 不看 GET /health：那次快照是冻结的，ActivityPage 的 reloadHealth 是另一份 hook 实例。
import { useCallback, useEffect, useRef } from 'react'
import { useActivityEvent, useEventsStatus, useFoundEvent, useProgressEvent } from '../events/EventsProvider.js'
import { useResumeEdge } from '../events/resumeEdge.js'
import type { ScoutEvent } from '../events/types.js'
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

/** 基线之后的 found → reload。挂载时 Context 里已有的事件不算（否则一进页就空转重拉）。
 *  SSE 恢复（daemon 重启）后 id 从 1 重数：清 seenFoundId，否则 `id <= seen` 把新 found 丢掉。 */
export function useReloadOnFound(reload: () => void): void {
  const found = useFoundEvent()
  const status = useEventsStatus()
  const seenFoundId = useRef<number | null>(null)
  const baselineTaken = useRef(false)

  const onResume = useCallback(() => {
    seenFoundId.current = null
    // 挂载基线已经过了：重启后的 id=1 是 live，不当新基线吞掉。
    baselineTaken.current = true
  }, [])
  useResumeEdge(status, onResume)

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

/** activity/progress 带 workbench → live current 非 null；activity 不带（巡检）→ null。
 *  按事件 id 去重（同 ActivityPage appliedId：Context 存的是最后一条，重渲染会再读到）。
 *  两个 slot 按 id 升序一起折：同一 tick 里 progress 与 activity 都更新时，
 *  分开的 effect 会先处理较大 id 而把较小 id 当旧事件丢掉。
 *
 *  挂载首跑只把 Context 里已有的 slot 折进 prevCurrent / appliedId，不 reload
 *  （进 #/media 时 last progress 常仍带 workbench、last activity 已是巡检，重放会空转多 GET）。
 *  恢复边沿：appliedId 归零并冻结当时的 slot 对象——跨 boot 的 id=1 不能跟上一进程的高 id 比。 */
export function useReloadWhenCurrentClears(reload: () => void): void {
  const activity = useActivityEvent()
  const progress = useProgressEvent()
  const status = useEventsStatus()
  const appliedId = useRef(0)
  const prevCurrent = useRef<ScoutCurrentDTO | null>(null)
  const baselineTaken = useRef(false)
  const activityRef = useRef(activity)
  const progressRef = useRef(progress)
  activityRef.current = activity
  progressRef.current = progress
  const frozen = useRef(new Set<ScoutEvent>())

  const onResume = useCallback(() => {
    appliedId.current = 0
    baselineTaken.current = true
    const held = [activityRef.current, progressRef.current]
      .filter((e): e is ScoutEvent => e != null)
      .sort((a, b) => a.id - b.id)
    frozen.current = new Set(held)
    let next: ScoutCurrentDTO | null = null
    for (const e of held) next = liveCurrentFromEvent(e)
    prevCurrent.current = next
  }, [])
  useResumeEdge(status, onResume)

  useEffect(() => {
    const pending = [activity, progress]
      .filter((e): e is ScoutEvent =>
        e != null && !frozen.current.has(e) && e.id > appliedId.current)
      .sort((a, b) => a.id - b.id)
    if (!baselineTaken.current) {
      baselineTaken.current = true
      for (const e of pending) {
        appliedId.current = e.id
        prevCurrent.current = liveCurrentFromEvent(e)
      }
      return
    }
    for (const e of pending) {
      appliedId.current = e.id
      const next = liveCurrentFromEvent(e)
      if (shouldReloadMedia(prevCurrent.current, next, e.id, e.id)) reload()
      prevCurrent.current = next
    }
  }, [activity, progress, reload])
}

function liveCurrentFromEvent(e: ScoutEvent): ScoutCurrentDTO | null {
  if (e.workbench === undefined) return null
  return {
    kind: e.workbench,
    title: e.title ?? null,
    index: null,
    total: null,
    workId: null,
    backdropPath: null,
    chineseTitle: null,
    startedAt: typeof e.at === 'number' ? e.at : Date.now(),
    lastStep: null,
    cueDone: null,
    cueTotal: null,
  }
}
