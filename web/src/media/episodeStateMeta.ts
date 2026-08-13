// web/src/media/episodeStateMeta.ts：八态 → i18n 文案键 的映射，**唯一一份**。
//
// 🔴 与 `web/src/library/episodeState.ts` 的裁决（任务书点名的债务①）
// ─────────────────────────────────────────────────────────────────────────
// 那个文件里有一套**同名异义**的七态 `EpisodeCellState`：
//   covered / hardsub / missing / throttled / error / dashed / partial
// 本目录用的是后端 mediaLibraryApi.ts 的八态 `EpisodeState`：
//   covered / translating / unsolvable / origin-skip / embedded / pending / unjudged / absent
//
// **本页面绝不复用它，一行都不 import**。三条理由，每条都能单独定罪：
//
//  ① **值域不同，同名的那两个也不同义。** 旧的 'covered' 把 embedded 与 ignored 一起折进来
//     （见该文件 classifyOnDisk 的 switch：covered/embedded/ignored 三个 case 落同一个返回值），
//     而新八态里 embedded 是**独立一态**（◆，语义是"自带内嵌轨、不需要外挂"）。旧的 'missing'
//     在新八态里根本没有对应——它对应 'pending'（排队等找）与 'unsolvable'（判死停牌）**两个
//     语义相反**的态，而设计文档 §4.3 点名要求这两者视觉可分（否则用户会等一个永远不来的结果）。
//     写一个 map 把两套对上，等于把"终局"与"在跑"合并，正是本仓栽过四次的病。
//
//  ② **数据源不同。** 旧七态长在 `episodes` 表（经 LibraryOnDiskEpisodeDTO.subStatus），
//     新八态长在 `files` 表的 sub_status/needs_subtitle/skip_reason 三列。生产 series 表 0 行、
//     works 表 110 行——两者读的不是同一批行，复用类型只会制造"看起来能对上"的假象。
//
//  ③ **生命周期不同。** 旧七态随旧 library 页面在 Task ⑪ 移入 `_legacy`。今天在它上面建依赖，
//     那天就要么把它从 `_legacy` 里捞回来，要么临时重写媒体库页——两个都是不该发生的事。
//
// 所以：类型名刻意不同（EpisodeCellState vs EpisodeState）、目录刻意分开（library/ vs media/）、
// 文案键前缀刻意不同（library_legend_* vs media_state_*）。撞不到一起。
import type { EpisodeState } from '../api/types.js'
import type { TKey } from '../i18n/useT.js'

/** 八态 → 文案键。**穷尽 Record**（不是带 default 的 switch）：后端将来加第九态时，
 *  这里少一个键 TS 立刻报错——而 switch 的 default 会静默把新态显示成兜底文案。 */
export const EPISODE_STATE_LABEL: Record<EpisodeState, TKey> = {
  covered: 'media_state_covered',
  translating: 'media_state_translating',
  unsolvable: 'media_state_unsolvable',
  'origin-skip': 'media_state_origin_skip',
  embedded: 'media_state_embedded',
  extra: 'media_state_extra',
  pending: 'media_state_pending',
  unjudged: 'media_state_unjudged',
  absent: 'media_state_absent',
}

/** 图例里列出的态与顺序——**只列八个染色态**，absent 不在其中（虚线格不染色，它由
 *  "边框形状"这个正交维度表达，见 §4.3 那张两维度表；把它塞进颜色图例会让人以为
 *  虚线也是一种颜色）。顺序 = 后端 STATE_RANK 的聚合序，与后端同序不是巧合：用户在图例里
 *  看到的先后，就是同一格多份文件时谁代表这一格的先后。
 *
 *  ⚠️ `extra` 在**末位**，与后端 STATE_RANK 逐字一致（2026-08-13 审计）：它说的是
 *  「**这一份**不算数」，不是「这一格不用管」，故只有当一格的全部文件都是 extra 时才报
 *  extra。排进"已解决"段会让一个 Trailer 盖掉同格里真正在排队的正片。 */
export const LEGEND_STATES: readonly Exclude<EpisodeState, 'absent'>[] = [
  'covered',
  'origin-skip',
  'embedded',
  'translating',
  'unsolvable',
  'pending',
  'unjudged',
  'extra',
]
