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

/** F1 铁原则:只做"源语言→中文"单跳直译,永不中继(JP→EN→CN 丢义严重,用户明令禁止)。
 *  故源语言外挂搜索腿只认这个集合;日漫(origin ja)等 F2 的 jimaku 日文源落地后再加 'ja'。
 *  值域=TMDB original_language 小写码('en'/'ja'),比对方(listTranslateCandidates/
 *  cli/fetchSourceSub.ts 的语言门)负责 lower+trim 防脏值。 */
export const SUPPORTED_SOURCE_LANGS = ['en', 'ja']

function isSupportedSourceLang(originLang: string | null): boolean {
  if (!originLang) return false
  return SUPPORTED_SOURCE_LANGS.includes(originLang.trim().toLowerCase())
}

export interface TranslateCandidate {
  itemId: string
  videoPath: string
}

export function listTranslateCandidates(db: ScoutDb): TranslateCandidate[] {
  // F1:候选从单腿(内嵌非中文轨)扩成双腿 OR(内嵌非中文轨 OR origin_lang ∈ SUPPORTED_SOURCE_LANGS)。
  // episodes 无 origin_lang 列,JOIN series 取;movies 直取自身列。embedded_langs 的 IS NOT NULL
  // 预筛随之取消——零内嵌(NULL/'[]')但源语言受支持的项正是 F1 要救的("零字幕数据"场景),
  // 判定移到下方 JS 过滤。同一条目两腿都命中只出现一次(一行一判,天然去重)。
  const rows = db.prepare(
    `SELECT e.id AS id, e.path AS path, e.embedded_langs AS embedded_langs, s.origin_lang AS origin_lang
       FROM episodes e JOIN series s ON e.series_id = s.id
      WHERE e.sub_status = 'unavailable'
     UNION ALL
     SELECT id, path, embedded_langs, origin_lang FROM movies WHERE sub_status = 'unavailable'`,
  ).all() as Array<{ id: string; path: string; embedded_langs: string | null; origin_lang: string | null }>
  return rows
    .filter((r) => hasNonChineseTrack(r.embedded_langs) || isSupportedSourceLang(r.origin_lang))
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
  runItem: (videoPath: string) => Promise<Pick<TranslateItemResult, 'status' | 'sidecarPath' | 'reason' | 'sourceRef'> & { llmCalls?: number }>
  /** installed 后踢一脚 ingest,让新 sidecar 尽快记账成 covered(镜像 rescue 的先例)。 */
  requestIngest?: () => void
  runs?: Pick<RunsRepo, 'insert'>
}

export async function runTranslateWorkerTask(
  job: Job,
  deps: TranslateWorkerTaskDeps,
  jobs: Pick<JobsRepo, 'completeDone' | 'completeError' | 'completeHeld' | 'park'>,
  now: () => number,
): Promise<void> {
  const startedAt = now()
  const recordRun = (decision: string, detail: string, llmCalls = 0): void => {
    deps.runs?.insert({
      jobId: job.id, startedAt, finishedAt: now(), decision, detail: detail.slice(0, 200), journalPath: null,
      llmCalls,
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
    const llmCalls = r.llmCalls ?? 0
    if (r.status === 'installed') {
      jobs.completeDone(job.id, now())
      // F1:sourceRef(外挂搜索腿的 'provider:id')进 detail 供追溯;内嵌轨腿无此值,不加尾巴。
      recordRun('translate:installed', `${videoPath} → ${r.sidecarPath ?? '?'}${r.sourceRef ? ` (source: ${r.sourceRef})` : ''}`, llmCalls)
      deps.requestIngest?.()
    } else if (r.status === 'already-covered' || r.status === 'no-embedded' || r.status === 'no-source') {
      // 候选预筛与现场重探之间世界变了(有人装了字幕/轨其实不可抽)——无事可做,不算错。
      // no-source(F1)同口径:外挂搜索穷尽也没有=诚实无源;unavailable 的衰减复查会周期性再给机会。
      jobs.completeDone(job.id, now())
      recordRun(`translate:${r.status}`, videoPath, llmCalls)
    } else if (r.status === 'held') {
      // held(fail-closed 质量闸拦下):衰减重试(用户裁决 2026-07-22——首周每天,然后隔三差
      // 五,之后周级;模型 nondeterministic 值得再给机会,但绝不热循环烧配额)。
      // 同签名熔断:同一 held 失败签名反复出现 = 模型对这条字幕系统性过不了闸,衰减重试只烧配额
      // 不产结果(job29 重试 11 次全同样错误实案)→ park 成 dormant,转人工审查(不再自动重试)。
      const heldError = `translate held: ${r.reason ?? ''}`
      const prevSig = (job.last_error ?? '').slice(0, 80)
      const newSig = heldError.slice(0, 80)
      if (job.last_error !== null && prevSig === newSig) {
        jobs.park(job.id, `translate held 签名重复,转人工审查: ${r.reason ?? ''}`, now())
        recordRun('translate:held-parked', `${videoPath} 同签名熔断: ${r.reason ?? ''}`, llmCalls)
      } else {
        jobs.completeHeld(job.id, heldError, now())
        recordRun('translate:held', `${videoPath} ${r.reason ?? ''}`, llmCalls)
      }
    } else {
      // extract/write 失败:诚实失败,completeError 走瞬时退避梯。
      jobs.completeError(job.id, `translate ${r.status}: ${r.reason ?? ''}`, now())
      recordRun(`translate:${r.status}`, `${videoPath} ${r.reason ?? ''}`, llmCalls)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    jobs.completeError(job.id, msg, now())
    recordRun('error', msg, 0)
  }
}
