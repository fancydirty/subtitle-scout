// web/src/triage/text.ts：甄别 tab 的动态文案组装 + 纯路径处理——纯函数，双语（DESIGN.md §7
// 只豁免 Workflow 区，甄别区正常双语）。带运行期数字的句子走这里而不是 useT.ts 的扁平表（同
// library/text.ts 的既有分工：t() 故意不支持插值）。
import type { Lang } from '../i18n/useT.js'
import type { ParkedItemDTO } from '../api/types.js'

/** 目录组头文件计数——"12 files" / "12 个文件"（PendingBox 的组卡头）。 */
export function fileCountLabel(n: number, lang: Lang): string {
  return lang === 'zh' ? `${n} 个文件` : `${n} file${n === 1 ? '' : 's'}`
}

/** 折叠列表的展开提示——">5 条折叠显示 +N more"（PendingBox 组卡文件列表用）。 */
export function moreLabel(n: number, lang: Lang): string {
  return lang === 'zh' ? `还有 ${n} 个…` : `+${n} more`
}

// relativeClaimedAgo（已认领箱的相对时间）已随认领退役删除——唯一消费方是已退役的 ClaimedBox。
// settings/text.ts 的 relativeTimeLabel 是同手法的独立实现，不受影响。

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

/** 待甄别箱的一个目录组——同一目录下的兄弟集大概率属于同一部剧，按目录分组呈现事实最贴近
 *  用户心智（历史上这也是认领的覆盖单元；认领已退役，分组呈现本身仍然成立）。 */
export interface DirGroup {
  /** 目录绝对路径（POSIX）。 */
  dir: string
  /** 目录尾段（mono 展示用），dir 本身走 title 属性兜底全路径。 */
  dirTail: string
  files: ParkedItemDTO[]
}

/** duplicates 桶退役记录：曾经这里有一个 DUPLICATE_PARK_REASON = 'duplicate-content' 常量，
 *  把这类停车行单独分桶、默认折叠展示（见已删除的 PendingBox Collapsible 用法）。P2 起 ingest
 *  不再产生 duplicate-content 这个 park reason——撞身份的重复文件改走 item_files 副本入册，
 *  根本不停车了（见 src/v2/ingest.ts）；生产该桶早已清零，是纯死代码，本批退役。
 *
 *  保守边界：DB 里若还有老版本 ingest 留下的历史 duplicate-content 行，退役后不再特殊分桶、也
 *  不该凭空从 UI 消失——下面 groupPending 不再过滤这个 reason，历史行就随其余非 excluded-extra
 *  的行一起落进 actionable，跟其他"待识别"的行同等对待、正常展示。 */

/** excluded-extra 停车行的 park reason（见 src/v2/ingest.ts 的 upsertParkedPath(path,
 *  'excluded-extra', ...) 调用点）——被 exclude_extras 设置当作"特典"排除的文件，可在此
 *  逐文件翻案恢复，让它们回到 pending 池重新参与 ingest。 */
const EXCLUDED_PARK_REASON = 'excluded-extra'

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

/** PendingBox 的分组入口：按 park reason 分两桶——excluded-extra 单独归"翻案"箱，其余
 *  （含历史遗留的 duplicate-content 行，见上方退役记录：那个桶已退役，不再特殊处理）一律归
 *  actionable；桶内再按目录分组（spec §C.1）。 */
export function groupPending(rows: ParkedItemDTO[]): { actionable: DirGroup[]; excluded: ParkedItemDTO[] } {
  const excludedRows = rows.filter((r) => r.parkReason === EXCLUDED_PARK_REASON)
  const actionableRows = rows.filter((r) => r.parkReason !== EXCLUDED_PARK_REASON)
  return {
    actionable: groupByDir(actionableRows),
    excluded: excludedRows.sort((a, b) => a.path.localeCompare(b.path)),
  }
}
