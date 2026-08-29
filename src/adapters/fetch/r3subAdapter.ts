import type { R3subClient, R3subSearchRow } from '../providers/r3sub.js'
import type { FetchAdapter } from '../fetchLib.js'
import type { SubtitleCandidate } from '../../core/schemas.js'

/** r3sub 是台版官方中文字幕站——中文源门控，与 assrt 同套前缀（zh/cmn/yue/繁简）。
 *  yue（粤语）也算：r3sub 的 iTunes 官方包常含 yue-Hant 轨。 */
const CHINESE_LANGUAGE_PREFIX = /^(zh|chi|zho|chs|cht|cn|cmn|yue)/i

/** 命中 ≤ 此数时才逐条取详情填 fileList（懒加载，控请求量——r3sub 每次请求都过一次广告站，
 *  照 zimuku "够用就好" 精神）。超过则 fileList 留空，agent 需要时会点具体候选再取。 */
const LAZY_FILELIST_THRESHOLD = 3

function toCandidate(row: R3subSearchRow, files: string[]): SubtitleCandidate {
  return {
    provider: 'r3sub',
    providerId: row.id,
    videoName: row.titleEn || row.titleCn,
    nativeName: row.titleCn || null,
    language: row.langMark || null,
    subtype: row.subtype || null,
    releaseSite: row.source || null,   // 'iTunes官方' 是强质量信号，如实透传给 agent
    uploadDate: null,
    fileList: files.map((name, index) => ({ index, name })),
  }
}

/**
 * r3sub FetchAdapter 工厂。client 收窄到 search/detail（下载不走网络 resolve——r3sub 是两跳
 * + HTML 中转 + 末跳 POST，无法塞进 resolve→GET 契约，改在 tools 层照 local 先例旁路，见
 * findSubtitleWorker.tools.ts 的 r3sub 分支）。
 */
export function makeR3subAdapter(
  client: Pick<R3subClient, 'search' | 'detail'>,
): FetchAdapter {
  return {
    name: 'r3sub',
    enabled: (args) => (args.languages ?? []).some((l) => CHINESE_LANGUAGE_PREFIX.test(l)),
    search: async (args) => {
      // 首条 query 即可（礼貌节流：r3sub 每次搜索都过一次广告站，不像 assrt 廉价可并发多查）。
      const q = args.queries[0]
      if (!q) return []
      const rows = await client.search(q)
      // 懒加载 fileList：命中少时逐条取详情补齐（agent 选集需要），命中多时留空。
      if (rows.length > 0 && rows.length <= LAZY_FILELIST_THRESHOLD) {
        return Promise.all(
          rows.map(async (row) => {
            const show = await client.detail(row.id).catch(() => ({ zipName: '', files: [] as string[] }))
            return toCandidate(row, show.files)
          }),
        )
      }
      return rows.map((row) => toCandidate(row, []))
    },
    resolve: async () => {
      throw new Error(
        'r3sub 下载走 tools 层旁路（两跳+HTML中转），不经 runResolve/downloadDirect——' +
        'install 应命中 findSubtitleWorker.tools.ts 的 r3sub 分支（照 local 先例）',
      )
    },
  }
}
