// web/src/triage/text.ts：甄别 tab 的动态文案组装 + 纯路径处理——纯函数，双语（DESIGN.md §7
// 只豁免 Workflow 区，甄别区正常双语）。带运行期数字的句子走这里而不是 useT.ts 的扁平表（同
// library/text.ts 的既有分工：t() 故意不支持插值）。
import type { Lang } from '../i18n/useT.js'
import type { ParkedItemDTO } from '../api/types.js'
import { formatDuration } from '../library/text.js'

/** 目录组头文件计数——"12 files" / "12 个文件"（PendingBox 的组卡头 + ClaimDialog 副标题共用）。 */
export function fileCountLabel(n: number, lang: Lang): string {
  return lang === 'zh' ? `${n} 个文件` : `${n} file${n === 1 ? '' : 's'}`
}

/** 折叠列表的展开提示——">5 条折叠显示 +N more"（组卡文件列表 + ClaimDialog 路径列表共用）。 */
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

/** 最后一个 '/' 之后的那一段——文件路径给"文件名"，目录路径给"目录尾段"（dirTail），同一个
 *  函数天然覆盖两种输入形状，不需要为目录单独写一份。mono 展示用，full path 走 title 属性
 *  兜底。没有 '/' 时原样返回（理论不该发生：本项目路径恒为绝对路径，防御性处理）。 */
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

// ---- 验收修复轮一 Task V2：目录组分组（spec §C.1/§C.3）----

/** 待甄别箱的一个目录组——claimParked 的 override 覆盖粒度是 dirname(path) 前缀（见
 *  src/dashboard/apiV2.ts claimParked 注释），所以"目录=认领单元"与后端语义一比一：一次认领
 *  顺带救活整目录的兄弟集。UI 因此按目录分组、一组一个认领对话框，不是逐文件多选。 */
export interface DirGroup {
  /** 目录绝对路径（POSIX），claimParked 的 override 前缀本体。 */
  dir: string
  /** 目录尾段（mono 展示用），dir 本身走 title 属性兜底全路径。 */
  dirTail: string
  files: ParkedItemDTO[]
}

/** duplicate-content 停车行的"重复副本"park reason（见 src/v2/ingest.ts 的
 *  upsertParkedPath(path, 'duplicate-content', ...) 调用点）——归重复源战役本体（字幕自动
 *  同步）尚未落地，本轮只做呈现分组：这类行不需要人工认领，与"待人工认领"的行分开成组、默认
 *  折叠（见 PendingBox 的 Collapsible 用法），避免用户看见一堆"重复"行误以为出了问题。 */
const DUPLICATE_PARK_REASON = 'duplicate-content'

/** 单个 reason 桶内部按 dirname 分组：组内文件按 path 排序（稳定展示顺序，不随后端返回顺序
 *  抖动），组间按文件数降序（文件最多的目录最可能是用户最想优先处理的那一部剧，排最前）——
 *  并列时按 dir 名排序兜底，保证同一份输入的分组顺序在两次渲染之间保持确定，不依赖 Map 迭代
 *  顺序这种隐式契约。 */
function groupByDir(rows: ParkedItemDTO[]): DirGroup[] {
  const buckets = new Map<string, ParkedItemDTO[]>()
  for (const row of rows) {
    const dir = dirnameOf(row.path)
    const bucket = buckets.get(dir)
    if (bucket) bucket.push(row)
    else buckets.set(dir, [row])
  }
  const groups = [...buckets.entries()].map(([dir, files]) => ({
    dir,
    dirTail: pathTail(dir),
    files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
  }))
  groups.sort((a, b) => b.files.length - a.files.length || a.dir.localeCompare(b.dir))
  return groups
}

/** PendingBox 的分组入口：先按 park reason 分两桶（duplicate-content 单独归箱，spec §C.3），
 *  桶内再各自按目录分组（spec §C.1）。 */
export function groupPending(rows: ParkedItemDTO[]): { actionable: DirGroup[]; duplicates: DirGroup[] } {
  const duplicateRows = rows.filter((r) => r.parkReason === DUPLICATE_PARK_REASON)
  const actionableRows = rows.filter((r) => r.parkReason !== DUPLICATE_PARK_REASON)
  return { actionable: groupByDir(actionableRows), duplicates: groupByDir(duplicateRows) }
}
