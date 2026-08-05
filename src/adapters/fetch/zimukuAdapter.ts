import { ZIMUKU_HEADERS, type ZimukuClient, type ZimukuSearchResult } from '../../adapters/providers/zimuku.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter } from '../fetchLib.js'

/** zimuku.org 是中文字幕专属源——当目标语言非中文时必须排除，避免污染非中文任务的候选池。
 *  前缀匹配（无尾锚 $）对齐 assrtAdapter.ts 的 CHINESE_LANGUAGE_PREFIX：裸 'zh'/'cn'、
 *  ISO 639-2 'chi'/'zho'、简繁 shorthands 'chs'/'cht'、以及任意带这些前缀的形式
 *  （'zh-cn'/'zh-tw' 等）均命中。 */
const CHINESE_LANGUAGE_PREFIX = /^(zh|chi|zho|chs|cht|cn)/i

function toCandidate(r: ZimukuSearchResult): SubtitleCandidate {
  return {
    provider: 'zimuku',
    providerId: r.id,
    videoName: r.title,
    nativeName: r.title,
    language: null,
    subtype: null,
    releaseSite: 'zimuku',
    uploadDate: null,
    // zimuku 详情页不预先列出压缩包内文件清单(要解压才知道)——与 opensubtitles 单文件候选
    // 同款空 fileList 处理。v1 只支持单字幕压缩包,writeSubtitle 在没有 selectFileName 时默认取
    // zip 内第一个字幕文件。
    fileList: [],
  }
}

/**
 * zimuku FetchAdapter 工厂——镜像 assrtAdapter.ts/opensubtitlesAdapter.ts 的抽取模式。
 * client 收窄到用到的 2 个方法(Pick),测试用假 client 免造真 ZimukuClient(网络/WAF/限速)。
 */
export function makeZimukuAdapter(
  client: Pick<ZimukuClient, 'search' | 'resolveDownload'>,
): FetchAdapter {
  return {
    name: 'zimuku',
    enabled: (args) => (args.languages ?? []).some(l => CHINESE_LANGUAGE_PREFIX.test(l)),
    search: async (args) => {
      // v1 只用首条 query(礼貌节流:zimuku 每次搜索都可能撞见验证码破解开销,不像 assrt 那样
      // 廉价到可以并发打多条 query——够用就好,见设计文档)。
      const q = args.queries[0]
      if (!q) return []
      const results = await client.search(q)
      return results.map(toCandidate)
    },
    // 真实下载链路(2026-07-19 抓包)detail→dld→镜像:resolveDownload 串起 detail(拿 /dld url)
    // 与 dld(拿镜像 /download/.../svr 链 + PHPSESSID cookie),返回首个镜像绝对 URL。镜像带
    // PHPSESSID 请求 → 301 到 s.zimuku.org CDN 取文件,downloadDirect 自动跟随重定向。
    // filename 不返回——CandidateRef 无该字段;下载层按 contentType 兜底(download.zip/.srt),
    // 最终盘上文件名由 writeSubtitle 用视频名派生。
    resolve: async (ref) => {
      const { url, cookie } = await client.resolveDownload(ref.providerId)
      const headers = { ...ZIMUKU_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
      return { url, headers }
    },
  }
}
