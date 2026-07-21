// F1 · 源语言外挂字幕获取腿(translateItem.fetchSourceSub 的 CLI 接线层)。源文件零字幕数据
// (无中文外挂、无可用内嵌轨)时,按**源语言**搜外挂(英剧搜英字),下载解出 SRT 文本交给 E 的
// 翻译管道直译中文。铁原则:只做"源语言→中文"单跳直译,永不中继——语言门只认
// SUPPORTED_SOURCE_LANGS(现=en);日漫(origin ja)在 F2 jimaku 日文源落地前宁可 no-source。
// 纪律:内部任何网络/解包错都吞成"试下一候选",全败 null,**绝不抛**(抛错留给真正的意外,
// 由 translateWorkerTask 走 completeError 退避;这里的失败是"诚实无源"→ no-source)。
import AdmZip from 'adm-zip'
import { extname, basename } from 'node:path'
import type { ScoutDb } from '../v2/db.js'
import { SUPPORTED_SOURCE_LANGS } from '../v2/translateWorkerTask.js'
import type { CandidateRef, SubtitleCandidate } from '../core/schemas.js'
import { candidateKey } from '../core/schemas.js'
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from './fetchLib.js'
import { downloadDirect, type DownloadResult } from '../adapters/download/direct.js'
import { decodeToUtf8 } from '../files/subtitleEncoding.js'
import { parseSrtCues, type SrtCue } from '../translate/qualityGate.js'

/** 库定位结果:videoPath → 条目身份(episodes JOIN series / movies,path 精确匹配)。 */
export interface LocatedItem {
  title: string
  /** series/movies.provider_ids JSON 里的 imdb id(如 'tt14827638');缺失=undefined。
   *  兜底搜索必须带上(可行性验证:文本 query 有假阴性,imdb 命中率高得多)。 */
  imdb?: string
  year?: number
  season?: number
  episode?: number
  /** TMDB original_language 小写码('en'/'ja');NULL=未解析。语言门比对前 lower+trim 防脏值。 */
  originLang: string | null
}

export interface FetchSourceSubDeps {
  locate: (videoPath: string) => LocatedItem | null
  search: (args: FetchArgs) => Promise<SubtitleCandidate[]>
  resolve: (ref: CandidateRef) => Promise<{ url: string; filename?: string; headers?: Record<string, string> }>
  download: (url: string, opts?: { headers?: Record<string, string> }) => Promise<DownloadResult>
  parseSrt: (text: string) => SrtCue[]
}

export type FetchSourceSub = (videoPath: string) => Promise<{ srtText: string; sourceRef: string } | null>

/** 按序最多试 3 个候选——OS 每日下载配额有限,机械循环不该一晚烧光;3 个都解不出基本就是没有。 */
export const MAX_CANDIDATE_ATTEMPTS = 3

/** zip 魔数(PK\x03\x04)。判 zip 不靠文件名/Content-Type——provider 的 filename 经常缺失或撒谎,
 *  字节头才是权威(downloadDirect 只回 bytes+可选 filename,解包责任在消费方,即这里)。 */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** 从下载物解出字幕文本。zip → 恰好 1 个 .srt 条目才收(多条目=季包,无从机械选集——C-D1 先例:
 *  绝不静默拿 entries[0] 装错集,宁跳过换候选);raw → 编码归一后原文返回,能不能算 SRT 交给
 *  调用方的 parseSrt 闸(v1 只收 parse 得过的,ass/ssa 自然被拦)。解不出 → null。 */
function subtitleTextFromDownload(dl: DownloadResult): string | null {
  if (isZip(dl.bytes)) {
    const entries = new AdmZip(dl.bytes).getEntries().filter((e) =>
      !e.isDirectory && extname(e.entryName).toLowerCase() === '.srt' && !basename(e.entryName).startsWith('.'))
    if (entries.length !== 1) return null
    return decodeToUtf8(entries[0].getData()).data.toString('utf8')
  }
  return decodeToUtf8(dl.bytes).data.toString('utf8')
}

export function makeFetchSourceSub(deps: FetchSourceSubDeps): FetchSourceSub {
  return async (videoPath) => {
    let located: LocatedItem | null
    try { located = deps.locate(videoPath) } catch { return null }
    if (!located) return null

    // 语言门=中继防线:origin ∉ 集合(现只 en)一票否决,根本不搜——日漫(ja)绝不会搜到英字拿去译。
    const lang = (located.originLang ?? '').trim().toLowerCase()
    if (!SUPPORTED_SOURCE_LANGS.includes(lang)) return null

    let candidates: SubtitleCandidate[]
    try {
      candidates = await deps.search({
        queries: [located.title],
        imdb: located.imdb,
        year: located.year,
        season: located.season,
        episode: located.episode,
        languages: [lang],
      })
    } catch { return null } // 全 provider 失败/配置缺失——对本腿而言就是"这次没有源"

    for (const c of candidates.slice(0, MAX_CANDIDATE_ATTEMPTS)) {
      try {
        // fileIndex:null=整包/顶层文件(机械路径不做 zip 内选集,多条目包在解包处跳过)。
        const resolved = await deps.resolve({ provider: c.provider, providerId: c.providerId, fileIndex: null })
        const dl = await deps.download(resolved.url, resolved.headers ? { headers: resolved.headers } : undefined)
        const text = subtitleTextFromDownload(dl)
        if (text === null) continue
        if (deps.parseSrt(text).length === 0) continue // srt 闸:解不出一条 cue 的不收
        return { srtText: text, sourceRef: candidateKey(c) }
      } catch { continue } // 网络/配额/解包错 → 试下一候选
    }
    return null
  }
}

/** 真实 locate:接 ScoutDb 按 path 精确匹配。episodes 无 origin_lang 列,JOIN series 取
 *  (origin_lang/provider_ids/name/year 都是剧级属性);movies 直取自身列。查无此 path → null。 */
export function makeDbLocate(db: ScoutDb): FetchSourceSubDeps['locate'] {
  return (videoPath) => {
    const ep = db.prepare(
      `SELECT e.season AS season, e.episode AS episode, s.name AS title, s.year AS year,
              s.provider_ids AS provider_ids, s.origin_lang AS origin_lang
         FROM episodes e JOIN series s ON e.series_id = s.id
        WHERE e.path = ?`,
    ).get(videoPath) as { season: number; episode: number; title: string; year: number | null; provider_ids: string | null; origin_lang: string | null } | undefined
    if (ep) {
      return {
        title: ep.title, imdb: imdbFromProviderIds(ep.provider_ids), year: ep.year ?? undefined,
        season: ep.season, episode: ep.episode, originLang: ep.origin_lang,
      }
    }
    const mv = db.prepare(
      `SELECT name AS title, year, provider_ids, origin_lang FROM movies WHERE path = ?`,
    ).get(videoPath) as { title: string; year: number | null; provider_ids: string | null; origin_lang: string | null } | undefined
    if (mv) {
      return {
        title: mv.title, imdb: imdbFromProviderIds(mv.provider_ids), year: mv.year ?? undefined,
        season: undefined, episode: undefined, originLang: mv.origin_lang,
      }
    }
    return null
  }
}

/** series/movies.provider_ids(JSON,ingest 写成小写键 record,如 {"tmdb":"1","imdb":"tt..."})
 *  → imdb id。NULL/坏 JSON/非对象/缺键 → undefined(imdb 是搜索增益,缺席不是 blocker——
 *  口径同 v2/findSubtitleWorkerTask.ts 的 parseProviderIds)。 */
function imdbFromProviderIds(json: string | null): string | undefined {
  if (!json) return undefined
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return undefined
    const imdb = (parsed as Record<string, unknown>).imdb
    return typeof imdb === 'string' && imdb ? imdb : undefined
  } catch { return undefined }
}

/** 生产组装:真 deps 一站绑齐(db 定位 + fetchLib 搜索/解析 + downloadDirect + srt parser)。
 *  daemon translate worker(cli/index.ts translate 分支)与手动 CLI(translateItemCommand.ts)
 *  共用这一个入口,防两处组装漂移。 */
export function makeRealFetchSourceSub(
  db: ScoutDb, adapters: FetchAdapter[], emit: (e: FetchEvent) => void = () => {},
): FetchSourceSub {
  return makeFetchSourceSub({
    locate: makeDbLocate(db),
    search: (args) => runSearch(args, adapters, emit),
    resolve: (ref) => runResolve(ref, adapters, emit),
    download: (url, opts) => downloadDirect(url, opts),
    parseSrt: parseSrtCues,
  })
}
