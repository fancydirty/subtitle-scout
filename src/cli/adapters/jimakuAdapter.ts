// jimaku.cc FetchAdapter(F2)。仅 ja 语言启用;search 按 title→entries→files?episode 产候选;
// resolve 按 fileIndex 取直链(下载无需 auth)。宁空/宁停不装错集。
import type { JimakuClient, JimakuEntry } from '../../adapters/providers/jimaku.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter, FetchEvent } from '../fetchLib.js'

const JA = /^(ja|jpn|jp)([-_]|$)/i
/** 每条 search 最多试前 N 个 entry——jimaku 按相关度排,Frieren 类 query 会掺无关(Dragon Ball)。 */
const MAX_ENTRIES = 3

/**
 * jimaku 文本搜索对长英文全称极脆(真机:"Frieren: Beyond Journey's End"→0,
 * "Frieren"→15)。产查询变体:全称 → 冒号前主标题 → 去括号/季标 → 首个实义词。
 * 保序去重;search 按序试到第一个非空 entries 即停。
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
  // 冒号/破折号副标题:"Frieren: Beyond…" / "Title - Season 2"
  const head = raw.split(/[:：–—-]/)[0] ?? raw
  push(head)
  // 去括号内容 + 季标尾巴
  push(head.replace(/[（(][^）)]*[）)]/g, ''))
  push(head.replace(/\s+(season|s)\s*\d+.*$/i, ''))
  // 首个 ≥3 字符 token(跳过 The/A)
  const tokens = head.split(/\s+/).filter((w) => !/^(the|a|an)$/i.test(w) && w.length >= 2)
  if (tokens[0] && tokens[0].length >= 3) push(tokens[0])
  return out
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
      let entries: JimakuEntry[] = []
      let lastErr: unknown
      for (const q of jimakuQueryVariants(query)) {
        try {
          entries = await client.search({ query: q })
          if (entries.length > 0) break
        } catch (e) {
          lastErr = e
          emit?.({ event: 'provider_error', provider: 'jimaku', message: `search(${q}): ${String(e)}` })
        }
      }
      if (entries.length === 0 && lastErr) throw lastErr
      const out: SubtitleCandidate[] = []
      for (const entry of entries.slice(0, MAX_ENTRIES)) {
        try {
          const files = await client.files(entry.id, args.episode)
          if (files.length === 0) continue
          out.push({
            provider: 'jimaku',
            providerId: String(entry.id),
            videoName: entry.english_name ?? entry.name,
            nativeName: entry.japanese_name ?? entry.name,
            language: 'ja',
            subtype: null,
            releaseSite: 'jimaku',
            uploadDate: null,
            fileList: files.map((f, i) => ({ index: i, name: f.name })),
          })
          // 把 url 暂存到 resolve 用:adapter 闭包缓存(同 entry 同次 search 的 files)
          cacheFiles(entry.id, files)
        } catch (e) {
          emit?.({ event: 'provider_error', provider: 'jimaku', message: `files(${entry.id}): ${String(e)}` })
        }
      }
      return out
    },
    resolve: async (ref) => {
      const entryId = Number(ref.providerId)
      if (!Number.isFinite(entryId)) throw new Error(`jimaku bad providerId ${ref.providerId}`)
      let files = takeCached(entryId)
      if (!files) files = await client.files(entryId)
      if (files.length === 0) throw new Error(`jimaku ${entryId}: no files`)
      if (ref.fileIndex != null) {
        const f = files[ref.fileIndex]
        if (!f) {
          throw new Error(
            `jimaku ${entryId}: fileIndex ${ref.fileIndex} 越界(filelist ${files.length})——拒绝静默回落`,
          )
        }
        return { url: f.url, filename: f.name }
      }
      // fileIndex null=整包/顶层:jimaku 无 zip 季包语义,取第一项(单集 files 已按 episode 过滤)
      return { url: files[0].url, filename: files[0].name }
    },
  }
}

// 进程内短缓存:search→resolve 同一次 translate 路径内复用,避免 resolve 再打 files。
// key=entryId;值带时间戳,5min TTL 防过期直链(jimaku 直链实测无签名过期,仍保守)。
const fileCache = new Map<number, { at: number; files: { url: string; name: string }[] }>()
const CACHE_TTL_MS = 5 * 60_000

function cacheFiles(entryId: number, files: { url: string; name: string }[]): void {
  fileCache.set(entryId, { at: Date.now(), files: files.map((f) => ({ url: f.url, name: f.name })) })
}
function takeCached(entryId: number): { url: string; name: string }[] | null {
  const hit = fileCache.get(entryId)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { fileCache.delete(entryId); return null }
  return hit.files
}

/** 测试用:清空缓存。 */
export function _clearJimakuFileCache(): void { fileCache.clear() }
