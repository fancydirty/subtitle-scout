import { ZIMUKU_HEADERS, type ZimukuClient, type ZimukuSearchResult } from '../../adapters/providers/zimuku.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter } from '../fetchLib.js'

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
  client: Pick<ZimukuClient, 'search' | 'detail'>,
): FetchAdapter {
  return {
    name: 'zimuku',
    enabled: () => true,
    search: async (args) => {
      // v1 只用首条 query(礼貌节流:zimuku 每次搜索都可能撞见验证码破解开销,不像 assrt 那样
      // 廉价到可以并发打多条 query——够用就好,见设计文档)。
      const q = args.queries[0]
      if (!q) return []
      const results = await client.search(q)
      return results.map(toCandidate)
    },
    resolve: async (ref) => {
      const detail = await client.detail(ref.providerId)
      return { url: detail.downloadUrl, filename: detail.filename, headers: ZIMUKU_HEADERS }
    },
  }
}
