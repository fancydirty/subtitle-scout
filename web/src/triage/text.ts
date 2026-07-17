// web/src/triage/text.ts：甄别 tab 的动态文案组装 + 纯路径处理——纯函数，双语（DESIGN.md §7
// 只豁免 Workflow 区，甄别区正常双语）。带运行期数字的句子走这里而不是 useT.ts 的扁平表（同
// library/text.ts 的既有分工：t() 故意不支持插值）。
import type { Lang } from '../i18n/useT.js'
import { formatDuration } from '../library/text.js'

/** ClaimDialog 头部副标题——"N files selected" / "已选 N 个文件"。 */
export function selectedCountLabel(n: number, lang: Lang): string {
  return lang === 'zh' ? `已选 ${n} 个文件` : `${n} file${n === 1 ? '' : 's'} selected`
}

/** 选中路径列表折叠——">5 条折叠显示 +N more"。 */
export function moreLabel(n: number, lang: Lang): string {
  return lang === 'zh' ? `还有 ${n} 个…` : `+${n} more`
}

/** 已认领箱的相对认领时间——复用 library/text.ts 的 formatDuration（mono 技术单位 s/m/h/d，
 *  跟路径/ID 一样"技术值不翻译"的口径），只有前后缀跟着语言走（同 formatDuration 自身文档注释
 *  里点名的分工：那份是特意为双语正文场景准备的算法）。 */
export function relativeClaimedAgo(deltaMs: number, lang: Lang): string {
  const d = formatDuration(deltaMs)
  return lang === 'zh' ? `${d} 前` : `${d} ago`
}

/** 路径尾段（最后一个 '/' 之后的文件名）——PendingBox/进度行的 mono 展示用，full path 走
 *  title 属性兜底。没有 '/' 时原样返回（理论不该发生：本项目路径恒为绝对路径，防御性处理）。 */
export function pathTail(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx >= 0 ? path.slice(idx + 1) : path
}

/** POSIX dirname——浏览器没有 node:path，这里只覆盖本项目实际会遇到的形状（绝对 POSIX 路径），
 *  不是通用实现。跟 Node path.dirname 语义对齐：根下的文件（'/'+一段）dirname 是 '/'；没有
 *  '/' 的裸文件名（理论不该出现在这个 UI 里）dirname 退化成 '.'。 */
export function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return path.slice(0, idx)
}

/** 提交前去重：同目录的多个选中路径只保留第一条——claimParked 的 override 覆盖粒度是
 *  dirname(path) 前缀（见 src/dashboard/apiV2.ts claimParked 注释："一次认领顺带救活整目录的
 *  兄弟集"），同目录内的第二条 POST 是纯浪费请求，不会带来任何额外效果。保序（Map 迭代顺序=
 *  插入顺序）：不改变用户勾选时的相对次序，进度行按这个顺序展示。 */
export function dedupeByDirname(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    const dir = dirnameOf(p)
    if (seen.has(dir)) continue
    seen.add(dir)
    out.push(p)
  }
  return out
}
