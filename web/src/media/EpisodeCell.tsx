// web/src/media/EpisodeCell.tsx：R-F12 的落地件——**一格 = 集号 + 状态符号**，两者合二为一。
//
// ── 两个正交维度（设计文档 §4.3 那张表，审计 F-15 纠正过一次混淆）─────────────
//   维度一 **边框**：实线 = 磁盘有此集 / 虚线 = 应有但磁盘没有（R-F5）。判据是 `onDisk`，
//                    **只看这一个字段**。
//   维度二 **集号染色**：✓绿 / ◆蓝 / ◇灰 / ⇄ / ⊘ / ··· / ?。判据是 `episodeState`。
// 两者正交：实线格可以是七种颜色的任意一种，虚线格恒 absent（后端保证，见 DTO 注释）。
//
// ── 为什么不画圆点（R-F12 用户裁决）────────────────────────────────────────
// 原方案三色小圆点被 Carbon Design System 的双通道规则推翻（只靠颜色对色盲无效）。
// 中间方案左竖线被用户否掉（Bootstrap alert 遗产）。最终方案是**状态直接长在集号上**——
// 这是唯一"零额外元素"的做法：状态和本来就要显示的编号合二为一，一屏 40 张卡也不碎。
// 所以这个文件里**没有任何 dot / 圆点 / 左竖线**，也不该有人加回来。
//
// ── 维度三？不。R-F2 的"还有一份没配"是**次要标记**，不是第九个态 ─────────────
// `fileCount` / `subtitledFileCount`（types.ts:683 点名它们是 R-F2 的可见依据）此前
// 生产代码一次都没读过：一集两份文件只配上一份时，UI 显示纯 covered ✓，用户看不出
// "还有一份没配"。现在补上，但**刻意不做成第九个符号**：
//  · 它**不是一个态**。这一格仍然是 covered——R-F2 的口径就是"任一份有就算"，
//    用户确实能看上这一集的字幕，说它不是 covered 才是谎报。八态染色照旧、符号照旧。
//  · 做成第九个符号会**和八态染色打架**：一格里出现两个平级符号（✓ 和某个新符号），
//    用户读不出谁是主状态；图例也会被迫列第九项，而它根本不属于那张颜色表。
// 落地形态：集号 span **内部**一个上标小数字（`E01²`），即 R-F2 那份"还没配上的份数"。
//  · 零额外顶层元素——它长在集号里面，与 R-F12"状态长在集号上"同一条思路，
//    格子的直接子元素仍然是「集号 span + 可选 svg」两个（那条铁律的用例照旧绿）。
//  · Carbon 双通道：它**不靠颜色**传达——数字本身就是文本通道（"2"这个字形），
//    颜色只是弱化处理。屏幕阅读器走 aria-label 整句（"E01 已配字幕 · 还有 1 份没配"）。
//  · R-F11：只有字号与颜色，无投影、无背景色块、无圆角徽章。
import type { MediaLibraryEpisodeDTO } from '../api/types.js'
import { EpisodeMark } from './EpisodeMark.js'
import { EPISODE_STATE_LABEL } from './episodeStateMeta.js'
import { useT } from '../i18n/useT.js'

/** 集号格式：E01 / E12 / E123。补零到两位（一屏里 E1 与 E12 混排会让列宽跳动），
 *  三位及以上原样（国产长剧动辄上百集）。 */
export function formatEpisodeNumber(episode: number): string {
  return `E${String(episode).padStart(2, '0')}`
}

/** R-F2「另一处那份仍要单独去配」的可见量：**这一集还有几份文件没配上字幕**。
 *
 *  ── 为什么需要它（types.ts:683 点名的依据，此前生产代码一次都没读过）──────────
 *  防猴子用户场景：两个「绝命毒师」目录各有一份 E01。后端按 R-F2「任一份有就算」
 *  把这一格判成 covered ✓ —— 那是**对的**，这一集用户确实能看上字幕。但另一处那份
 *  仍然是裸的，用户从界面上完全看不出来。这个函数把差额如实数出来。
 *
 *  ── 判据为什么带 fileCount > 1 ────────────────────────────────────────────
 *  只有一份文件时 `subtitledFileCount < fileCount` 退化成"这一份没配上"——那件事
 *  **八态已经说过了**（pending/unsolvable/unjudged 各自都是它的精确说法），再挂一个
 *  角标是同一个事实说两遍。这个标记只回答八态答不了的那个问题：
 *  "这一格代表的**多份**文件里，还有几份没配上"。
 *
 *  虚线格（fileCount = 0）自然返回 0：没有文件就没有"还有一份"可言。 */
export function extraUnsubtitledCount(ep: {
  fileCount: number
  subtitledFileCount: number
}): number {
  if (ep.fileCount <= 1) return 0
  // 后端理论上保证 subtitledFileCount ≤ fileCount，但这里夹 0：真出现脏数据时
  // 显示一个负数角标比不显示更糟（用户会以为界面坏了）。
  return Math.max(0, ep.fileCount - ep.subtitledFileCount)
}

export function EpisodeCell({ ep }: { ep: MediaLibraryEpisodeDTO }) {
  const { t } = useT()
  const extraUnsubtitled = extraUnsubtitledCount(ep)
  // 无障碍整句：屏幕阅读器读到的是"E01 已配字幕"，而不是把符号与集号读成两个碎片
  // （SVG 自身 aria-hidden，见 EpisodeMark 头注释）。虚线格读"E08 磁盘上没有"。
  // 有另一份没配上时**整句里补一段话**——上标数字对屏幕阅读器是个孤立的"2"，
  // 不成句；R-F2 这条事实必须在文本通道里说全。
  const label = extraUnsubtitled > 0
    ? `${formatEpisodeNumber(ep.episode)} ${t(EPISODE_STATE_LABEL[ep.episodeState])} · ${t('media_extra_unsubtitled')} ${extraUnsubtitled}`
    : `${formatEpisodeNumber(ep.episode)} ${t(EPISODE_STATE_LABEL[ep.episodeState])}`
  return (
    <div
      className="media-ep-cell"
      // 边框实虚由 CSS 按 data-ondisk 选（组件层不写死任何几何/色值，同 activity/ 的
      // data-tone 既有手法）。
      //
      // ⚠️ 这里原先写着「必须用字符串 'true'/'false'，因为 React 会把 data-ondisk={false}
      // 整个属性丢掉」——**实测证伪**（react 19.2.7，jsdom 探针）：
      //     render(<div data-x={false} />) → getAttribute('data-x') === "false"
      // React 对 `data-*` 自定义属性是 String(value)，只有 `undefined`/`null` 才会丢属性
      // （被丢的是 DOM 保留布尔属性如 hidden/disabled，那是另一回事）。
      // 把这条记下来是因为它正是本仓的病 B：把一句听来的规则当成实测结论写进注释。
      // 显式三元仍然保留——理由降级为**可读性**（读代码时一眼看出属性值域是两个字符串），
      // 不再声称它防住了什么。相应地，M8 那次变异（改成 {ep.onDisk}）**测试 0 红是正确的**，
      // 因为那确实是一次空操作。
      data-ondisk={ep.onDisk ? 'true' : 'false'}
      role="listitem"
      aria-label={label}
    >
      <span className="media-ep-num" data-state={ep.episodeState}>
        {formatEpisodeNumber(ep.episode)}
        {/* R-F2 次要标记：**集号 span 内部**的上标数字，不是格子的第三个子元素
            （R-F12「格子里只有集号 + 可选符号」那条铁律不受影响）。
            0 时整个元素不渲染——"还有 0 份没配"是噪音，且会让全配齐的格子看起来有问题
            （同 SeasonBlock 里"缺 0 集"不显示的既有口径）。 */}
        {extraUnsubtitled > 0 ? (
          <sup
            className="media-ep-extra"
            data-extra-unsubtitled={extraUnsubtitled}
            // 与 EpisodeMark 的 SVG 同一套无障碍手法：这个上标是**视觉通道**，
            // 语义已经在外层 aria-label 的整句里说全了（"E01 已配字幕 · 另有份数还没配上 1"）。
            // 不 aria-hidden 的话屏幕阅读器会在整句之外再孤零零读一个 "1"。
            aria-hidden="true"
            // 视力正常用户的解码入口：一个裸的上标数字本身不自明。
            title={t('media_extra_unsubtitled_legend')}
          >
            {extraUnsubtitled}
          </sup>
        ) : null}
      </span>
      <EpisodeMark state={ep.episodeState} />
    </div>
  )
}
