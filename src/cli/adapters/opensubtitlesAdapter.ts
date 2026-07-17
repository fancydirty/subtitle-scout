import type { OpenSubtitlesClient } from '../../adapters/providers/opensubtitles.js'
import { osToCandidates, OsQuotaExhaustedError } from '../../adapters/providers/opensubtitles.js'
import type { FetchAdapter, FetchEvent } from '../fetchLib.js'

/**
 * 配额耗尽事件（真·失败路径专用）：标准 FetchEvent 的 `provider_error` 成员上 `code`/`resetAt`
 * 现已类型化（fetchLib.ts），JSON.stringify 序列化进 stderr 的 NDJSON 行。历史上（旧管线）
 * providerPort.ts 的 `JSON.parse(line)` 读到后，若 code 是 quota_exhausted 会构造
 * ProviderQuotaExhaustedError 一路带 resetAt 传到 pipeline.ts → v2 executor，据此按重置时间精确
 * 退避（不再是盲的短退避阶梯）——providerPort.ts/pipeline.ts/旧 v2 executor 均已随旧管线退役
 * 删除。今天的消费方（search_source 工具，见 agent/resultHandles.ts；cli/index.ts 的日志分支）
 * 只读 provider/message 做展示，尚未接上 resetAt 精确退避这一层——code/resetAt 字段留在事件
 * schema 上，为未来接线保留信号，不是当前有消费方在读。
 * 只用于 resolveDownload 本身抛出 OsQuotaExhaustedError 的场景——这次调用真的失败了。
 */
const emitQuotaExhausted = (emit: (e: FetchEvent) => void, message: string, resetAt: string | null) => {
  emit({ event: 'provider_error', provider: 'opensubtitles', message, code: 'quota_exhausted', resetAt })
}

/**
 * 配额预警事件（成功路径专用，journal honesty review finding）：本次下载已经 SUCCEEDED，
 * 只是响应体里 remaining<=0，提前告知"下一次调用会撞配额"。用 provider_notice 而不是
 * provider_error——journal/dashboard 的读者不该把一次成功下载看成一个错误步骤。
 * code/resetAt 语义与 emitQuotaExhausted 一致，供上游按 reset 时间退避用。
 */
const emitQuotaNotice = (emit: (e: FetchEvent) => void, message: string, resetAt: string | null) => {
  emit({ event: 'provider_notice', provider: 'opensubtitles', message, code: 'quota_exhausted', resetAt })
}

/**
 * 'tt13152020' → 13152020；无值时 undefined。
 * 0（'tt0000000' 占位符，部分刮削器用它标记"未匹配"）和 NaN（畸形值，如误传整个 imdb URL）
 * 一律视为"无 imdb"，退化到标题+season/episode 查询——否则会带着必然 0 命中的 imdb_id 查询提交，
 * 而本该走的标题查询分支被跳过（`imdb != null` 对 0 和 NaN 都是 true）。
 */
const imdbDigits = (s: string | undefined): number | undefined => {
  if (!s) return undefined
  const n = Number(s.replace(/^tt/, ''))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * OpenSubtitles FetchAdapter 工厂——从 subtitle-fetch.ts 的 buildAdapters() 闭包里抽出，供直接单测
 * （镜像 assrtAdapter.ts 的抽取模式：subtitle-fetch.ts 顶层 main().catch() 会在 import 时触发副作用，
 * 闭包内联逻辑没有独立测试面）。
 *
 * 修复（OS-only e2e 实测破防）：Jellyfin 传入的 args.imdb 永远是"条目自身"的 imdb——
 * 电影是电影的，剧集是该集自己的（如 Peacemaker S01E01 → tt13152020），从不是剧集级 parent imdb。
 * 旧逻辑在有 season 时把它当 parentImdbId 传给 OS API 的 parent_imdb_id 参数，实测 0 命中；
 * 而同一个 id 作为 imdb_id 查询能命中（imdb_id 本身已经是"具体条目"的粒度，不需要再叠 season/episode）。
 * 因此：只要有 imdb 就直接查 imdb_id（不带 season/episode）；只有没有 imdb 时才退化到标题 + season/episode。
 */
export function makeOpenSubtitlesAdapter(
  client: Pick<OpenSubtitlesClient, 'search' | 'resolveDownload'>,
): FetchAdapter {
  return {
    name: 'opensubtitles',
    enabled: () => true,
    search: async (args) => {
      const languages = args.languages ?? ['zh-cn', 'zh-tw']
      const imdb = imdbDigits(args.imdb)
      let resp = await client.search(imdb != null
        ? { imdbId: imdb, languages }
        : { query: args.queries[0], season: args.season, episode: args.episode, year: args.year, languages })
      // Shelby Oaks 实案（验收轮一，2026-07-17）：TMDB 主发行年与 OS 特征年差一年是跨年上映/
      // 节展片的常态（此案 2025 vs 2024），严格年份过滤会把确实存在的字幕滤成零、且在 fail-soft
      // 世界里无声无息——agent 拿到被污染的"全网没有"证据后判无。标题查询带年份零命中时去掉
      // 年份重试一次：召回优先，归属判断本来就归 agent（findSubtitleSkill 的逐候选判断），
      // 多召回不放大误装风险。imdb 路径不需要（imdb 本身就是精确身份，没有年份参与）。
      if (imdb == null && args.year != null && resp.data.length === 0) {
        resp = await client.search({ query: args.queries[0], season: args.season, episode: args.episode, languages })
      }
      return osToCandidates(resp)
    },
    resolve: async (ref, emit) => {
      try {
        const r = await client.resolveDownload(Number(ref.providerId))
        // 本次成功，但 remaining 已见底：提前 emit 一个信息性配额事件，让后续调用有机会按
        // reset_time_utc 退避，而不是等到真的 406 了才发现（那时已经白跑了一整趟 LLM+search）。
        if (r.remaining != null && r.remaining <= 0) {
          emitQuotaNotice(emit, `opensubtitles download quota exhausted after this call (resets ${r.reset_time_utc ?? 'unknown'})`, r.reset_time_utc ?? null)
        }
        return { url: r.link, filename: r.file_name ?? undefined }
      } catch (e) {
        if (e instanceof OsQuotaExhaustedError) {
          emitQuotaExhausted(emit, e.message, e.resetAt)
        }
        throw e
      }
    },
  }
}
