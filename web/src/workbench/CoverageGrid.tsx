// web/src/workbench/CoverageGrid.tsx —— 一部作品的覆盖情况**画出来**：
//  · 剧集流 → 计数行（四档数字）+ 逐格状态方块（flex-wrap 网格）
//  · 电影流（isSingleFileGrid）→ 退化成一枚状态丸，不铺格子网格（一部电影只有一格，
//    铺一个孤零零的方块比一枚丸更难认）
//  · 空数组 → 返回 null（沉默不占位——没 target 就没有覆盖情况可画）
//
// 计数与形态判定全在 targetState.ts 的纯函数里，这里只负责渲染。四档文案走 wb_grid_*，
// pendingSource 为 0 时不追加那一段（多数剧集所有集都有源，恒挂「0 暂缺」是噪声）。
import { useT } from '../i18n/useT.js'
import { countStates, isSingleFileGrid, type Target } from './targetState.js'

export function CoverageGrid({ targets }: { targets: Target[] }) {
  const { t } = useT()
  if (targets.length === 0) return null

  // 电影流：一枚状态丸，按唯一那格着色。data-state 供样式取色（与格子同一套 [data-state=…]）。
  if (isSingleFileGrid(targets)) {
    const only = targets[0]!
    return <span className="wb-grid-pill" data-testid="wb-grid-pill" data-state={only.state} title={only.label} />
  }

  const c = countStates(targets)
  // 计数行：形如 `31 installed · 1 in progress · 6 pending`，pendingSource>0 时追加 `· N unavailable`。
  // t() 不插值，数字与译文用 JS 拼（同 wb_ticker 的调用方口径）。
  const parts = [
    `${c.installed} ${t('wb_grid_installed')}`,
    `${c.active} ${t('wb_grid_active')}`,
    `${c.pending} ${t('wb_grid_pending')}`,
  ]
  if (c.pendingSource > 0) parts.push(`${c.pendingSource} ${t('wb_grid_pending_source')}`)

  return (
    <div className="wb-grid-wrap">
      <div className="wb-grid-count" data-testid="wb-grid-count">{parts.join(' · ')}</div>
      <div className="wb-grid">
        {targets.map((tg) => (
          <span
            key={tg.key}
            className="wb-grid-cell"
            data-testid="wb-grid-cell"
            data-state={tg.state}
            title={tg.label}
          >
            {/* 二级 testid（带 key）供定位具体一格；一级 wb-grid-cell 供计总数。 */}
            <span data-testid={`wb-grid-cell-${tg.key}`} data-state={tg.state} title={tg.label} className="wb-grid-cell-inner" />
          </span>
        ))}
      </div>
    </div>
  )
}
