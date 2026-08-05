import { SUBHD_HEADERS, type SubhdClient, type SubhdSearchResult } from '../../adapters/providers/subhd.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter } from '../fetchLib.js'

/** subhd.tv 是中文字幕专属源——当目标语言非中文时必须排除，避免污染非中文任务的候选池。
 *  前缀匹配（无尾锚 $）对齐 assrtAdapter.ts / zimukuAdapter.ts 的 CHINESE_LANGUAGE_PREFIX。 */
const CHINESE_LANGUAGE_PREFIX = /^(zh|chi|zho|chs|cht|cn)/i

/** 从 CDN 文件 url 派生带真实扩展名的文件名（`.../1782478768658.ass` → `1782478768658.ass`）。
 *  这个扩展名是 writeSubtitle 分派的权威依据：.ass/.srt/.ssa 裸存、.zip 解包、.rar/.7z 诚实抛
 *  UnsupportedArchiveError（"only zip in v1"）。不派生（无扩展名）时返回 undefined——绝不硬编一个
 *  错的兜底（否则 .rar 会被下载层兜成 download.srt，把压缩包二进制当字幕写成垃圾）。 */
function deriveFilename(url: string): string | undefined {
  try {
    const base = new URL(url).pathname.split('/').pop() ?? ''
    return /\.[A-Za-z0-9]+$/.test(base) ? base : undefined
  } catch {
    return undefined
  }
}

function toCandidate(r: SubhdSearchResult): SubtitleCandidate {
  return {
    provider: 'subhd',
    providerId: r.id,
    videoName: r.videoName,
    nativeName: r.videoName,
    language: r.language,
    subtype: r.subtype,
    releaseSite: r.releaseSite ?? 'subhd',
    uploadDate: null,
    // subhd 详情页/搜索页不预先列出压缩包内文件清单（要解压才知道）——与 zimuku/opensubtitles
    // 同款空 fileList；下载产物可能是单文件 .ass/.srt 或压缩包 .rar/.7z/.zip（见 STRUCTURE.md），
    // 由下载层按 CDN url 扩展名/内容分派。
    fileList: [],
  }
}

/**
 * subhd FetchAdapter 工厂——镜像 zimukuAdapter.ts 的抽取模式。client 收窄到用到的 2 个方法（Pick），
 * 测试用假 client 免造真 SubhdClient（curl/真网络/限速）。
 *
 * 真实下载链路（curl 实测 2026-07-20，见 adapters/providers/subhd.ts / __fixtures__/subhd/STRUCTURE.md）：
 * resolveDownload 内部串 prepare-download→GET /down(激活)→api/sub/down，返回真 CDN 文件 url。CDN
 * （dlus.subhd.me）credentials omit、无指纹门，故通常不需 cookie（cookie=null）；下载层 undici 直取。
 * headers 仍带浏览器 UA/Accept-Language（跨 CLI 子进程边界，下载发生在主进程 downloadDirect，头须随
 * URL 一起带出）；若某天 resolveDownload 返回了 cookie，也照 zimuku 惯例透传进 Cookie 头。
 */
export function makeSubhdAdapter(
  client: Pick<SubhdClient, 'search' | 'resolveDownload'>,
): FetchAdapter {
  return {
    name: 'subhd',
    enabled: (args) => (args.languages ?? []).some(l => CHINESE_LANGUAGE_PREFIX.test(l)),
    search: async (args) => {
      // v1 只用首条 query（礼貌节流：subhd 每次 resolve 都要走 curl mint 三步 + 临时页时间窗，
      // 不像 assrt 廉价到可并发多条 query——够用就好，同 zimukuAdapter）。
      const q = args.queries[0]
      if (!q) return []
      return (await client.search(q)).map(toCandidate)
    },
    resolve: async (ref) => {
      const { url, cookie } = await client.resolveDownload(ref.providerId)
      const headers = { ...SUBHD_HEADERS, ...(cookie ? { Cookie: cookie } : {}) }
      const filename = deriveFilename(url)
      return { url, ...(filename ? { filename } : {}), headers }
    },
  }
}
