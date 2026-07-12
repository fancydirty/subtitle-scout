/**
 * 极简、"够用"的 HTML 标签属性解析工具——不是完整 HTML parser,只解决对抗性评审指出的具体
 * 脆弱性:手搓正则对属性顺序、引号风格(单/双)、额外属性(class/title/data-*)高度敏感,
 * 而且属性值内部出现的裸 `>`(比如 title="预告: </a> 佯攻" 这种诱饵)会让 `[^>]*` 式的正则
 * 提前把标签"腰斩",产生错误的标签边界。
 *
 * 用法:给定标签名和起始搜索位置,返回下一个匹配标签的属性映射(键小写)和标签在原字符串中的
 * 边界(start/end)。属性值解析正确跳过引号内部的任意字符(包括 `>`/`<`),只在真正闭合标签的
 * 裸 `>` 或自闭合 `/>` 处结束扫描——因此"标题诱饵夹带 </a>"这类对抗样本不会让解析提前失焦。
 *
 * 用于 zimuku.ts(搜索结果锚点 / 详情页 id="down" 下载锚点)和 yunsuo.ts(挑战表单里的
 * form/input/img)——都是"标签形状稳定但属性写法不受我们控制"的场景,两步解析(先定位标签
 * 边界,再按名字读属性)比手搓单个属性顺序敏感的正则更耐撞。
 */
export interface TagMatch {
  /** 属性名(小写)→ 属性值(未做 HTML 实体解码——目前用到的字段都不含实体) */
  attrs: Record<string, string>
  /** 标签起始 `<` 在原字符串中的下标 */
  start: number
  /** 开标签结束(闭合的裸 `>` 或自闭合 `/>` 之后)在原字符串中的下标——之后就是标签内容 */
  end: number
}

const WHITESPACE_RE = /\s/
const NAME_BOUNDARY_RE = /[\s=/>]/
const UNQUOTED_VALUE_BOUNDARY_RE = /[\s>]/

/**
 * 从 `fromIndex` 起查找下一个 `<tagName ...>` 开标签(标签名大小写不敏感),返回其属性映射与
 * 标签边界。找不到时返回 null。
 */
export function findNextTag(html: string, tagName: string, fromIndex = 0): TagMatch | null {
  const openTagRe = new RegExp(`<${tagName}(?=[\\s/>])`, 'gi')
  openTagRe.lastIndex = fromIndex
  const m = openTagRe.exec(html)
  if (!m) return null

  const start = m.index
  let i = start + m[0].length
  const attrs: Record<string, string> = {}

  while (i < html.length) {
    while (i < html.length && WHITESPACE_RE.test(html[i])) i++
    if (i >= html.length) break
    if (html[i] === '>') { i++; break }
    if (html[i] === '/' && html[i + 1] === '>') { i += 2; break }

    const nameStart = i
    while (i < html.length && !NAME_BOUNDARY_RE.test(html[i])) i++
    const name = html.slice(nameStart, i).toLowerCase()
    if (!name) { i++; continue } // 保护:遇到孤立的 `=` 之类畸形字符时前进一格,避免死循环

    while (i < html.length && WHITESPACE_RE.test(html[i])) i++

    let value = ''
    if (html[i] === '=') {
      i++
      while (i < html.length && WHITESPACE_RE.test(html[i])) i++
      const quote = html[i]
      if (quote === '"' || quote === "'") {
        i++
        const valueStart = i
        while (i < html.length && html[i] !== quote) i++ // 引号内的 `>`/`<` 一律不当边界
        value = html.slice(valueStart, i)
        i++ // 跳过闭合引号(即使已经跑到字符串末尾,i 也只是等于 length,安全)
      } else {
        const valueStart = i
        while (i < html.length && !UNQUOTED_VALUE_BOUNDARY_RE.test(html[i])) i++
        value = html.slice(valueStart, i)
      }
    }
    attrs[name] = value
  }

  return { attrs, start, end: i }
}
