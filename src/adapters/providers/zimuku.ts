export const ZIMUKU_BASE = 'https://www.zimuku.org'

export interface ZimukuSearchResult {
  id: string
  title: string
}

/**
 * 搜索结果列表解析:只依赖 /detail/<id>.html 详情页链接这个最稳定的锚点(不绑定具体的
 * class/容器结构——版面改版风险最低的选择,"够用就好",见设计文档)。
 */
export function parseSearchResults(html: string): ZimukuSearchResult[] {
  const results: ZimukuSearchResult[] = []
  const re = /<a href="\/detail\/(\d+)\.html">([^<]+)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) results.push({ id: m[1], title: m[2].trim() })
  return results
}
