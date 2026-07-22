// jimaku.cc FetchAdapter(F2)。仅 ja 语言启用;search 按 title→entries→files?episode 产候选;
// resolve 按 fileIndex 取直链(下载无需 auth)。宁空/宁停不装错集。
import type { JimakuClient } from '../../adapters/providers/jimaku.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter, FetchEvent } from '../fetchLib.js'

const JA = /^(ja|jpn|jp)([-_]|$)/i
/** 每条 search 最多试前 N 个 entry——jimaku 按相关度排,Frieren 类 query 会掺无关(Dragon Ball)。 */
const MAX_ENTRIES = 3

/**
 * jimaku 文本搜索对长英文全称极脆(真机:"Frieren: Beyond Journey's End"→0,
 * "Frieren"→15)。产查询变体:全称 → 冒号前主标题 → 去括号/季标 → 首个实义词。
 * 保序去重;search 按序试到第一个**产出可用候选**的变体即停(不是第一个非空 entries——
 * 无关 hit 拿不到当集文件时继续往下个变体走)。
 * 连字符只切"两侧有空格"的(季标分隔),保住 Spider-Man/K-On! 的词内连字符。
 */
export function jimakuQueryVariants(title: string): string[] {
  const raw = title.trim()
  if (!raw) return []
  const out: string[] = []
  const push = (s: string) => {
    const t = s.replace(/\s+/g, ' ').trim()
    if (t && !out.includes(t)) out.push(t)
  }
  push(raw)
  // 冒号副标题 / 空格连字符季标:"Frieren: Beyond…" / "Title - Season 2"(词内 - 不切)
  const head = raw.split(/[:：]|\s[-–—]\s/)[0] ?? raw
  push(head)
  // 去括号内容 + 季标尾巴
  push(head.replace(/[（(][^）)]*[）)]/g, ''))
  push(head.replace(/\s+(season|s)\s*\d+.*$/i, ''))
  // 首个 ≥3 字符 token(跳过 The/A)
  const tokens = head.split(/\s+/).filter((w) => !/^(the|a|an)$/i.test(w) && w.length >= 2)
  if (tokens[0] && tokens[0].length >= 3) push(tokens[0])
  return out
}

/** providerId 自描述形态:`<entryId>#ep<N>`(剧集)或 `<entryId>#all`(电影/无集号)。
 *  resolve 据此找回**当次 search 缓存的该集文件列表**——CandidateRef 不携带 episode,
 *  裸 entryId 在缓存过期/多集交错时会拿错集的文件(宁停不装错集的死角)。 */
function providerIdOf(entryId: number, episode?: number): string {
  return episode != null ? `${entryId}#ep${episode}` : `${entryId}#all`
}

/** jimaku 标题校验(审计🔴:变体回退 "Adam's" 曾返回 BanG Dream/DEAD DEAD/高达——
 *  全是不相关番,adapter 毫无校验就收了,翻译出来的字幕跟目标视频毫不相干)。
 *  规则:原始查询(非变体)分词后,至少一个 ≥3 字符的词出现在 entry 的英文名或日文名里。
 *  "Adam's Sweet Agony" tokens=[adam,sweet,agony]; BanG Dream → 零交集→拒。
 *  "Frieren" token=[frieren]; Frieren entry → 交集→过。 */
export function entryMatchesQuery(
  englishName: string | null | undefined,
  japaneseName: string | null | undefined,
  originalQuery: string,
): boolean {
  const STOP = new Set(['the', 'a', 'an', 'no', 'of', 'to'])
  const tokens = originalQuery
    .toLowerCase()
    .replace(/[^\w\s\u3040-\u30ff\u4e00-\u9faf]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
  if (tokens.length === 0) return true // 无法分词→不过滤(保守,不误杀)
  const haystack = `${englishName ?? ''} ${japaneseName ?? ''}`.toLowerCase()
  return tokens.some((t) => haystack.includes(t))
}

export function makeJimakuAdapter(
  client: Pick<JimakuClient, 'search' | 'files'>,
): FetchAdapter {
  return {
    name: 'jimaku',
    enabled: (args) => (args.languages ?? []).some((l) => JA.test(l)),
    search: async (args, emit?: (e: FetchEvent) => void) => {
      const query = args.queries[0]
      if (!query) return []
      const out: SubtitleCandidate[] = []
      let lastErr: unknown
      let anyCallSucceeded = false
      for (const q of jimakuQueryVariants(query)) {
        let entries
        try {
          entries = await client.search({ query: q })
          anyCallSucceeded = true
        } catch (e) {
          lastErr = e
          emit?.({ event: 'provider_error', provider: 'jimaku', message: `search(${q}): ${String(e)}` })
          continue
        }
        // 标题校验:变体回退搜出的无关番(BanG Dream 冒充 Adam)在此拦截
        const matched = entries.filter((e) =>
          entryMatchesQuery(e.english_name ?? e.name, e.japanese_name, query),
        )
        for (const entry of matched.slice(0, MAX_ENTRIES)) {
          try {
            const files = await client.files(entry.id, args.episode)
            if (files.length === 0) continue
            const providerId = providerIdOf(entry.id, args.episode)
            cacheFiles(providerId, files)
            out.push({
              provider: 'jimaku',
              providerId,
              videoName: entry.english_name ?? entry.name,
              nativeName: entry.japanese_name ?? entry.name,
              language: 'ja',
              subtype: null,
              releaseSite: 'jimaku',
              uploadDate: null,
              fileList: files.map((f, i) => ({ index: i, name: f.name })),
            })
          } catch (e) {
            emit?.({ event: 'provider_error', provider: 'jimaku', message: `files(${entry.id}): ${String(e)}` })
          }
        }
        // 有可用候选即停;无关 hit(entries 非空但无当集文件)继续下个变体
        if (out.length > 0) break
      }
      // 所有变体都"调用层失败"(不是"诚实空")才抛——有任一变体成功过(哪怕空)就是诚实无结果
      if (out.length === 0 && lastErr && !anyCallSucceeded) throw lastErr
      return out
    },
    resolve: async (ref) => {
      const files = takeCached(ref.providerId)
      if (!files || files.length === 0) {
        // fail-closed:缓存只有 5min TTL 且 resolve 拿不到 episode 上下文,无缓存时
        // 重拉无过滤全季列表会静默装错集——宁抛(让调用方重新 search)不猜。
        throw new Error(`jimaku resolve ${ref.providerId}: 缓存未命中/已过期——请重新 search(拒绝无 episode 上下文重拉)`)
      }
      if (ref.fileIndex != null) {
        const f = files[ref.fileIndex]
        if (!f) {
          throw new Error(
            `jimaku ${ref.providerId}: fileIndex ${ref.fileIndex} 越界(filelist ${files.length})——拒绝静默回落`,
          )
        }
        return { url: f.url, filename: f.name }
      }
      return { url: files[0].url, filename: files[0].name }
    },
  }
}

// 进程内短缓存:search→resolve 同一次 translate/find 路径内复用,避免 resolve 再打 files。
// key=自描述 providerId(entryId#epN);5min TTL;超 64 键时清扫过期+最久未动(daemon 常驻防漏)。
const fileCache = new Map<string, { at: number; files: { url: string; name: string }[] }>()
const CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX_KEYS = 64

function cacheFiles(providerId: string, files: { url: string; name: string }[]): void {
  if (fileCache.size >= CACHE_MAX_KEYS) {
    const now = Date.now()
    for (const [k, v] of fileCache) if (now - v.at > CACHE_TTL_MS) fileCache.delete(k)
    while (fileCache.size >= CACHE_MAX_KEYS) {
      const oldest = fileCache.keys().next().value
      if (oldest === undefined) break
      fileCache.delete(oldest)
    }
  }
  fileCache.set(providerId, { at: Date.now(), files: files.map((f) => ({ url: f.url, name: f.name })) })
}
function takeCached(providerId: string): { url: string; name: string }[] | null {
  const hit = fileCache.get(providerId)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { fileCache.delete(providerId); return null }
  return hit.files
}

/** 测试用:清空缓存。 */
export function _clearJimakuFileCache(): void { fileCache.clear() }
