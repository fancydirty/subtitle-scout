// web/src/workbench/RunsHistory.tsx —— 活动页的决策历史段（2026-08-15）。
//
// ══════════════════════════════════════════════════════════════════════════════
// 它为什么存在（此前这段信息在产品里**整体不存在**）
// ══════════════════════════════════════════════════════════════════════════════
// 每次字幕 agent 跑完，"选了谁、为什么没找到"的人话摘要落在 runs 表（后端
// runSubtitleWorkDir 按非空桶各记一行）。但 2026-08-12 前端重做后四 tab 没有任何
// 页面读它——活动页只有"正在跑/排队"（SSE + /api/v2/activity），历史只能 curl。
// 这一段补的就是那半截：跑完之后的"为什么"。
//
// ══════════════════════════════════════════════════════════════════════════════
// 数据与刷新纪律（照 ActivityPage 的既有口径，互不推导）
// ══════════════════════════════════════════════════════════════════════════════
//  · 首载 + 「加载更多」走 GET /api/v2/runs（分页 append，每页 50）
//  · 收到**工作台级 activity 事件**（一个作品跑完了）→ 重拉第一页。activity 是低频
//    事件（一个作品一条），不会造成请求风暴；progress 刻意不订（高频，历史不需要它）。
//  · SSE 断线恢复（resumeEdge）→ 补拉一次（断线期间跑完的作品一次补齐）。
//  · 单行点击展开 trace 回放（GET /api/v2/workflow/runs/:id/trace）——**惰性**：
//    trace_json 可能是几十 KB 的 JSON，首载 50 行全展开是白付。每行只取一次，缓存。
//
// 🔴 decision 词**不翻译**（DESIGN.md §3/§4 与 settings_deploy_present_word 的既有
// 裁决：技术状态词是技术值不是正文）——installed / no_safe_match / retry_later /
// identity / identity_unidentified / error 原样渲染，前置一个语义色圆点。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import type { RunHistoryDTO, RunTraceDTO } from '../api/types.js'
import { useActivityEvent } from '../events/EventsProvider.js'
import { useResumeEdge } from '../events/resumeEdge.js'
import { useEventsStatus } from '../events/EventsProvider.js'
import { useT } from '../i18n/useT.js'
import { relAgo } from './inspectFreshness.js'
import { laneOf } from './workbenchRouting.js'

/** 每页条数——与 hooks.ts 的 RUNS_PAGE_SIZE 同值（那边是旧分页 hook 的常量，
 * 这里自建 feed 是因为需要跨页 append，useRuns 是单页语义）。 */
const PAGE = 50

/** decision → 语义色（Tailwind）。未知的 decision 落 zinc——后端加新词时不炸不瞒。 */
const DECISION_DOT: Record<string, string> = {
  installed: 'bg-emerald-500',
  no_safe_match: 'bg-zinc-400',
  retry_later: 'bg-amber-500',
  error: 'bg-red-500',
  identity: 'bg-sky-500',
  identity_unidentified: 'bg-amber-500',
}

type TraceCache = Record<number, { loading: boolean; data: RunTraceDTO | null }>

/** 分页 append 的 runs feed。 */
function useRunsFeed() {
  const [rows, setRows] = useState<RunHistoryDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exhausted, setExhausted] = useState(false)
  const [nonce, setNonce] = useState(0)
  const reload = useCallback(() => { setRows([]); setExhausted(false); setNonce((n) => n + 1) }, [])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setError(null)
    api
      .runs(0, PAGE, ctrl.signal)
      .then((d) => {
        // /api/v2/runs 不在前端契约层名单里（contracts.ts 的"只声明有人读的"裁决），
        // 这里自己做形状防御：非数组 = 这次响应不可信 → 走错误态，绝不静默当空列表
        // （错误态与空态不共用一句话是本段的纪律，见测试）。
        if (!Array.isArray(d)) throw new Error('unexpected response shape')
        setRows(d)
        setExhausted(d.length < PAGE)
      })
      .catch((e) => { if (!ctrl.signal.aborted) setError(String(e)) })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [nonce])

  const loadMore = useCallback(() => {
    // 用函数式更新拿当前长度做 offset，避免闭包里的 rows 过期。
    setRows((cur) => {
      if (!Array.isArray(cur)) return cur
      void api.runs(cur.length, PAGE).then((d) => {
        if (!Array.isArray(d)) return
        setRows((c) => (c.length === cur.length ? [...c, ...d] : c))
        setExhausted(d.length < PAGE)
      }).catch(() => { /* 加载更多失败：保持现状（首载失败才占错误态） */ })
      return cur
    })
  }, [])

  return { rows, loading, error, exhausted, reload, loadMore }
}

export function RunsHistory() {
  const { t } = useT()
  const feed = useRunsFeed()
  const activityEvent = useActivityEvent()
  const status = useEventsStatus()
  const [openId, setOpenId] = useState<number | null>(null)
  const [traces, setTraces] = useState<TraceCache>({})

  // 工作台级 activity 事件（一个作品跑完了）→ 重拉第一页。
  // 🔴 过滤 lane：巡检级 activity（开始/完成）一轮两条，且**不产生 runs 行**
  // （runs 是 per-作品落的），重拉是白付；identify 不落 runs 行，同理。
  const lastId = useRef(0)
  useEffect(() => {
    if (activityEvent && activityEvent.id > lastId.current) {
      lastId.current = activityEvent.id
      const lane = laneOf(activityEvent)
      if (lane === 'subtitle' || lane === 'translate') feed.reload()
    }
  }, [activityEvent, feed.reload])

  // 断线恢复 → 补拉（判据与 ActivityPage 两处同一个函数，不手抄）。
  useResumeEdge(status, feed.reload)

  /** 展开一行：惰性取 trace，每行只取一次。 */
  const toggle = useCallback((id: number) => {
    setOpenId((cur) => (cur === id ? null : id))
    setTraces((cur) => {
      if (cur[id]) return cur
      void api.runTrace(id).then((d) => {
        setTraces((c) => ({ ...c, [id]: { loading: false, data: d } }))
      }).catch(() => {
        setTraces((c) => ({ ...c, [id]: { loading: false, data: null } }))
      })
      return { ...cur, [id]: { loading: true, data: null } }
    })
  }, [])

  const now = Date.now()

  return (
    <div data-testid="runs-history">
      <div className="wb-section-head" style={{ marginTop: 16 }}>
        {t('runs_section_title')} · {feed.rows.length}
      </div>

      {feed.error && feed.rows.length === 0 ? (
        <div className="wb-card-sub" data-testid="runs-error">{t('runs_error_prefix')}{feed.error}</div>
      ) : feed.loading && feed.rows.length === 0 ? (
        <div className="wb-card-sub" aria-busy="true">{t('wb_loading')}</div>
      ) : feed.rows.length === 0 ? (
        <div className="wb-card-sub" data-testid="runs-empty">{t('runs_empty')}</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {feed.rows.map((r) => {
            const open = openId === r.id
            const trace = traces[r.id]
            return (
              <li key={r.id}>
                <button
                  type="button"
                  data-testid="runs-row"
                  className="wb-card-sub flex w-full items-center gap-2 text-left cursor-pointer"
                  aria-expanded={open}
                  onClick={() => toggle(r.id)}
                >
                  <span
                    aria-hidden
                    className={`inline-block h-2 w-2 shrink-0 rounded-full ${DECISION_DOT[r.decision ?? ''] ?? 'bg-zinc-400'}`}
                  />
                  <span className="shrink-0 font-mono text-xs">{r.decision}</span>
                  <span className="min-w-0 flex-1 truncate">{r.detail}</span>
                  <span className="shrink-0 text-xs opacity-70">
                    {t('runs_ago').replace('{d}', relAgo(now - r.startedAt))}
                  </span>
                </button>
                {open && (
                  <div className="wb-card-sub ml-4" data-testid="runs-trace">
                    {!trace || trace.loading ? (
                      <span>{t('runs_trace_loading')}</span>
                    ) : !trace.data || trace.data.events.length === 0 ? (
                      <span>{t('runs_trace_none')}</span>
                    ) : (
                      <ol className="flex flex-col gap-0.5 font-mono text-xs">
                        {trace.data.events.map((e, i) => (
                          <li key={`${e.runKey}-${e.seq}-${i}`} className="truncate">
                            #{e.seq} {e.tool} · {e.argsSummary}
                            {e.resultSummary ? ` → ${e.resultSummary}` : ''} ({e.tookMs}ms)
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                )}
              </li>
            )
          })}
          {!feed.exhausted && (
            <li>
              <button
                type="button"
                data-testid="runs-more"
                className="wb-card-sub cursor-pointer"
                onClick={feed.loadMore}
              >
                {t('runs_load_more')}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
