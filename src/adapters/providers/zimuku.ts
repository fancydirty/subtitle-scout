import { basename } from 'node:path'

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

export interface ZimukuDetailResult {
  downloadUrl: string
  filename: string
}

/**
 * 详情页解析:抓 id="down" 的下载锚点(社区脚本/实地侦察共同印证的下载按钮标记)。文件名从
 * 下载 URL 的 basename 派生(zimuku 静态文件名通常已含语言/季信息,比详情页标题更适合直接
 * 落盘);解析不出锚点视为页面结构漂移,fail closed 抛错而不是静默返回空。
 */
export function parseDetailPage(html: string, baseUrl: string): ZimukuDetailResult {
  const m = html.match(/id="down"[^>]*href="([^"]+)"/)
  if (!m) throw new Error('zimuku detail page has no download link (id="down") — page shape drift?')
  const downloadUrl = new URL(m[1], baseUrl).toString()
  const filename = basename(new URL(downloadUrl).pathname) || 'subtitle.zip'
  return { downloadUrl, filename }
}

