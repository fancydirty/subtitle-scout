// E AI 翻译 · daemon 自动触发接线(v1,env 门控)。三件套:
// ① listTranslateCandidates:可译候选 = sub_status='unavailable'(搜索穷尽确认无中字)且
//    embedded_langs 含非中文轨——翻译是**最后手段**,只救 find-subtitle 管线判无的项,天然收窄
//    候选集与 LLM 成本(全库当前仅个位数)。embedded_langs 只存语言 tag 不存 codec,故这里只是
//    廉价预筛;权威判定(文本轨 vs 图形轨、能否抽)由 translateItem 现场重探,预筛错杀不了对
//    (最坏 no-embedded/extract-failed 收尾)。
// ② dispatchTranslateTasks:每候选 upsert 一行 taskType='translate' 的 worker_task。identity 用
//    合成 seriesId `translate:<itemId>`(orchestrator-shard 先例)——同季两集不共享 identity 行,
//    重复派发幂等。**调用方(daemon tick)必须 env 门控**(TRANSLATE_MODEL 未配→根本不接线,
//    功能休眠零成本,同 SUBHD_ENABLED 模式)。
// ③ runTranslateWorkerTask:claims-and-runs 一行(镜像 rescueWorkerTask 形状)。installed→done+
//    踢 ingest(下一轮扫描把新 sidecar 记账成 covered);held/extract-failed→completeError(可
//    重试,fail-closed 不装);already-covered/no-embedded→done(无事可做)。
import type { ScoutDb } from './db.js'
import type { Job, JobsRepo } from './jobsRepo.js'
import type { RunsRepo } from './runsRepo.js'
import type { TranslateItemResult } from '../translate/translateItem.js'

/** 中文 tag 判定(原始 ffprobe tag,口径同 translateItem.isChinese)。 */
function isChineseTag(lang: string): boolean {
  const l = lang.toLowerCase()
  return l.startsWith('zh') || l === 'chi' || l === 'zho' || l === 'chs' || l === 'cht'
}

function hasNonChineseTrack(embeddedLangsJson: string | null): boolean {
  if (!embeddedLangsJson) return false
  let langs: unknown
  try { langs = JSON.parse(embeddedLangsJson) } catch { return false }
  if (!Array.isArray(langs)) return false
  return langs.some((l) => typeof l === 'string' && !isChineseTag(l))
}

export interface TranslateCandidate {
  itemId: string
  videoPath: string
}

export function listTranslateCandidates(db: ScoutDb): TranslateCandidate[] {
  const rows = db.prepare(
    `SELECT id, path, embedded_langs FROM episodes WHERE sub_status = 'unavailable' AND embedded_langs IS NOT NULL
     UNION ALL
     SELECT id, path, embedded_langs FROM movies WHERE sub_status = 'unavailable' AND embedded_langs IS NOT NULL`,
  ).all() as Array<{ id: string; path: string; embedded_langs: string | null }>
  return rows
    .filter((r) => hasNonChineseTrack(r.embedded_langs))
    .map((r) => ({ itemId: r.id, videoPath: r.path }))
}

/** 返回本轮新建的 job 行数(幂等:已有 identity 行时 created=0)。 */
export function dispatchTranslateTasks(db: ScoutDb, jobs: JobsRepo, now: () => number): number {
  let created = 0
  for (const c of listTranslateCandidates(db)) {
    const outcome = jobs.upsertWorkerTask(
      { seriesId: `translate:${c.itemId}`, season: null, movieId: null },
      { taskType: 'translate', videoPath: c.videoPath, itemId: c.itemId },
      null, now(),
    )
    if (outcome.outcome === 'created') created++
  }
  return created
}

export interface TranslateWorkerTaskDeps {
  /** 端到端翻译一个视频(translateItem 预绑定真实 deps)。 */
  runItem: (videoPath: string) => Promise<Pick<TranslateItemResult, 'status' | 'sidecarPath' | 'reason'>>
  /** installed 后踢一脚 ingest,让新 sidecar 尽快记账成 covered(镜像 rescue 的先例)。 */
  requestIngest?: () => void
  runs?: Pick<RunsRepo, 'insert'>
}

export async function runTranslateWorkerTask(
  job: Job,
  deps: TranslateWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError'>,
  now: () => number,
): Promise<void> {
  const startedAt = now()
  const recordRun = (decision: string, detail: string): void => {
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: detail.slice(0, 200), journalPath: null,
      traceJson: null,
    })
  }

  let videoPath: string | undefined
  try {
    const payload = JSON.parse(job.payload ?? '{}') as Record<string, unknown>
    if (typeof payload.videoPath === 'string' && payload.videoPath) videoPath = payload.videoPath
  } catch { /* fallthrough 到下方缺 videoPath 处理 */ }
  if (!videoPath) {
    jobs.completeError(job.id, `translate job ${job.id} payload 缺 videoPath`, now())
    return
  }

  try {
    const r = await deps.runItem(videoPath)
    if (r.status === 'installed') {
      jobs.completeDone(job.id, now())
      recordRun('translate:installed', `${videoPath} → ${r.sidecarPath ?? '?'}`)
      deps.requestIngest?.()
    } else if (r.status === 'already-covered' || r.status === 'no-embedded') {
      // 候选预筛与现场重探之间世界变了(有人装了字幕/轨其实不可抽)——无事可做,不算错。
      jobs.completeDone(job.id, now())
      recordRun(`translate:${r.status}`, videoPath)
    } else {
      // held(fail-closed 质量闸拦下)/extract-failed:诚实失败,completeError 走重试退避。
      jobs.completeError(job.id, `translate ${r.status}: ${r.reason ?? ''}`, now())
      recordRun(`translate:${r.status}`, `${videoPath} ${r.reason ?? ''}`)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg)
  }
}
