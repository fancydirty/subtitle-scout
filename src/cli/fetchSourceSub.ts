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
import { runSearch, runResolve, type FetchAdapter, type FetchArgs, type FetchEvent } from '../adapters/fetchLib.js'
import { downloadDirect, type DownloadResult } from '../adapters/download/direct.js'
import { decodeToUtf8 } from '../files/subtitleEncoding.js'
import { parseSrtCues, type SrtCue } from '../translate/qualityGate.js'

/** 库定位结果:videoPath → 条目身份(files JOIN works,path 精确匹配 / C4)。 */
export interface LocatedItem {
  title: string
  /** works.provider_ids JSON 里的 imdb id(如 'tt14827638');缺失=undefined。
   *  兜底搜索必须带上(可行性验证:文本 query 有假阴性,imdb 命中率高得多)。
   *  这一列由识别时的 getExternalIds 落库,存量作品由 daemon boot 的回填 pass 补齐(C5 + C21)。 */
  imdb?: string
  year?: number
  /** 电影为 undefined（`files.season`/`episode` 对电影是 NULL）——见 makeDbLocate 里
   *  "NULL→undefined 是契约"那段论证：`season: null` 与"不带 season 参数"对 provider 不等价。 */
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

export type FetchSourceSub = (
  videoPath: string,
  accept?: (srtText: string) => Promise<boolean>,
) => Promise<{ srtText: string; sourceRef: string } | null>

/** 按序最多试 3 个候选——OS 每日下载配额有限,机械循环不该一晚烧光;3 个都解不出基本就是没有。 */
export const MAX_CANDIDATE_ATTEMPTS = 3

/** zip 魔数(PK\x03\x04)。判 zip 不靠文件名/Content-Type——provider 的 filename 经常缺失或撒谎,
 *  字节头才是权威(downloadDirect 只回 bytes+可选 filename,解包责任在消费方,即这里)。 */
function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/** 从下载物解出字幕文本。zip → 恰好 1 个 .srt 条目才收(多条目=季包,无从机械选集——C-D1 先例:
 *  绝不静默拿 entries[0] 装错集,宁跳过换候选);raw → 编码归一后原文返回,能不能算 SRT 交给
 *  调用方的 parseSrt 闸(v1 只收 parse 得过的,ass/ssa 自然被拦)。解不出 → null。
 *  zip 大小上限: 与 subtitleWriter.ts 的 MAX_ZIP_ENTRY_BYTES=32MB 防线一致——不可信字幕站
 *  的 zip 可能是炸弹(100MB 外层解压出 GB 级数据),超限视为解不出(换候选,fail-soft)。 */
const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024 // 32MB,同 subtitleWriter.ts

/** zip 条目的最小接口——只暴露这道闸真正需要的三个字段，便于测试注入伪造条目。 */
export interface ZipEntryLike {
  entryName: string
  isDirectory: boolean
  header: { size: number }
  getData(): Buffer
}

/** 导出仅为可测：端到端路径上 AdmZip 会先因 CRC 校验失败抛错并被外层 catch 吞成"跳过候选",
 *  使得"炸弹被防线拦住"与"炸弹被 CRC 拦住"在黑盒下不可区分(实测:拆掉本函数的 size 闸,
 *  端到端用例依然全绿=假测试)。直接单测本函数、并用 readEntries 注入伪造条目,才能真正锁住这道闸。 */
export function subtitleTextFromDownload(
  dl: DownloadResult,
  readEntries: (bytes: Buffer) => ZipEntryLike[] = (bytes) => new AdmZip(bytes).getEntries() as unknown as ZipEntryLike[],
): string | null {
  if (isZip(dl.bytes)) {
    const entries = readEntries(dl.bytes).filter((e) =>
      !e.isDirectory && extname(e.entryName).toLowerCase() === '.srt' && !basename(e.entryName).startsWith('.'))
    if (entries.length !== 1) return null
    // zip 炸弹防线: header 声明值 + 解压后实际值双重校验(同 subtitleWriter.ts extractEntryCapped)
    const entry = entries[0]
    if (entry.header.size > MAX_ZIP_ENTRY_BYTES) return null
    const data = entry.getData()
    if (data.length > MAX_ZIP_ENTRY_BYTES) return null
    return decodeToUtf8(data).data.toString('utf8')
  }
  return decodeToUtf8(dl.bytes).data.toString('utf8')
}

export function makeFetchSourceSub(deps: FetchSourceSubDeps): FetchSourceSub {
  return async (videoPath, accept) => {
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
        if (accept && !await accept(text)) continue
        return { srtText: text, sourceRef: candidateKey(c) }
      } catch { continue } // 网络/配额/解包错 → 试下一候选
    }
    return null
  }
}

/** 真实 locate：接 ScoutDb 按 path 精确匹配 **files JOIN works**（C4）。
 *
 *  为什么是这两张表而不是 episodes/series/movies（这就是 C4 本身）：新架构的数据全在
 *  files/works 里，而这个函数历史上查的是旧表——按 path 查旧表**查无此行返回 null**，
 *  于是"没有内嵌轨时去 OpenSubtitles 抓源语言字幕再翻"这条杀手锏腿在新架构下从未通过一次。
 *  这解释了 spec 记录的那句"AI 翻译链路在新架构下从未验证过"：它根本接不上。
 *
 *  **INNER JOIN 而非 LEFT JOIN**（work_id IS NULL 的行必须查不到）：没有 work_id 就没有
 *  title/originLang，而搜索 query 与语言门全靠它们。LEFT JOIN 会让未识别的文件带着
 *  `title=undefined` 进 search——今天恰好被语言门（originLang 为 null）先挡住，看似无害，
 *  但语言门是 MVP 的临时形态（R20 明写后续要扩语言），它一放宽就是真实的坏查询。
 *
 *  **不 UNION 旧表兜底**（C10 第 7 步才清理旧表，但本函数从此不看它们）：加兜底有两重害——
 *  ① 新架构的数据缺失会被旧表陈旧行掩盖（旧 episodes 行的 season/episode 可能与今天磁盘上的
 *  文件早已不符，而"按集建行 vs 文件级事实"正是新架构另起 files 表的原因）；
 *  ② 第 7 步删旧表那天，这条腿会在没有任何测试变红的情况下静默退回 C4 状态。
 *
 *  season/episode 直取 `files` 自身列（电影为 NULL → undefined）。NULL→undefined 的转换是
 *  **契约**而非风格：这两个字段直接进 FetchArgs 喂 provider，`season: null` 与"不带 season
 *  参数"对 OpenSubtitles 是两种查询（前者可能 400 或零命中），LocatedItem 把它们声明成
 *  optional 正是为此。 */
export function makeDbLocate(db: ScoutDb): FetchSourceSubDeps['locate'] {
  return (videoPath) => {
    const row = db.prepare(
      `SELECT f.season AS season, f.episode AS episode,
              w.title AS title, w.year AS year,
              w.provider_ids AS provider_ids, w.origin_lang AS origin_lang
         FROM files f JOIN works w ON f.work_id = w.id
        WHERE f.path = ?`,
    ).get(videoPath) as {
      season: number | null; episode: number | null; title: string
      year: number | null; provider_ids: string | null; origin_lang: string | null
    } | undefined
    if (!row) return null
    return {
      title: row.title,
      imdb: imdbFromProviderIds(row.provider_ids),
      year: row.year ?? undefined,
      season: row.season ?? undefined,
      episode: row.episode ?? undefined,
      originLang: row.origin_lang,
    }
  }
}

/** works.provider_ids(JSON,识别时写成小写键 record,如 {"tmdb":"1","imdb":"tt..."})
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
