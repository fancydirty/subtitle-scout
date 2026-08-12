// web/src/library/SeasonAccordion.test.tsx：季手风琴——≤50 集用行式（EpisodeRow），>50 集回落
// 格阵（SeasonGridBody），季头恒显卷起汇总（覆盖句）。默认测试语言 en（jsdom navigator.language=
// en-US，同 SeriesPage.test.tsx 口径）——覆盖句大数字段在 en 下渲染为 "1 of 2"（zh 才是 "1 / 2"）。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { SeasonAccordion } from './SeasonAccordion.js'
import type { LibrarySeasonDTO, SubtitleCompareDTO } from '../../api/types.js'

afterEach(cleanup)

const NOW = 1_700_000_000_000

function seasonDTO(nEps: number): LibrarySeasonDTO {
  return {
    season: 1,
    canonical: Array.from({ length: nEps }, (_, i) => ({ episode: i + 1, title: `E${i + 1}`, overview: `ov${i + 1}`, airDate: null, stillPath: null })),
    onDisk: Array.from({ length: nEps }, (_, i) => ({ itemId: `ep${i + 1}`, episode: i + 1, path: `/m/e${i + 1}.mkv`, subStatus: 'covered', statusReason: null, recheckAfter: null, files: [] })),
    coverage: [],
  }
}

describe('SeasonAccordion', () => {
  it('默认展开：≤50 集用行式（EpisodeRow），点集展开简介', () => {
    render(<I18nProvider><SeasonAccordion season={seasonDTO(3)} now={NOW} defaultOpen /></I18nProvider>)
    expect(screen.queryByText('ov2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /E2/ }))
    expect(screen.getByText('ov2')).toBeInTheDocument()
  })

  it('>50 集回落格阵（SeasonGridBody：格子是数字按钮，不是逐集行头）', () => {
    render(<I18nProvider><SeasonAccordion season={seasonDTO(60)} now={NOW} defaultOpen /></I18nProvider>)
    // 行式头是 "E0N + 标题"，格阵是裸数字 → 存在纯数字 name 的按钮即证明走了格阵
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument()
  })

  it('季头卷起汇总：覆盖句（大数字段，en 下为 "1 of 2"）', () => {
    const s = seasonDTO(2)
    s.onDisk[1].subStatus = 'missing'
    render(<I18nProvider><SeasonAccordion season={s} now={NOW} defaultOpen={false} /></I18nProvider>)
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
  })
})

// ── 字幕校验接线 / 检视面板：随字幕校验下架删除（spec §5，2026-08-07）───────────────
// 原本这里有一个 describe "SeasonAccordion：字幕校验接线" 含 7 条用例：
//   · :117 "整季只发一个批量请求"——useSubtitleVerify 取整季 verify 状态
//   · :129 "shifted/ok 的集渲染红/绿芯片"——verify 结果流入 EpisodeRow
//   · :145 "季折叠时不查校验"——省往返
//   · :168 "点红芯片打开检视面板（断言落在面板内容渲染之后）"——onInspect 接线
//   · :192 "对照图请求失败 → 错误态，dashboard 不被拖垮"
//   · :208 "面板抛错 → 降级成一句人话，不拖垮 dashboard【I-D1】"
//   · :246 "默认展开、不点开面板 → 子树无 astryx-* 类名（DOM 侧迁移锁）"
// 这 7 条测试的全部前提是 SeasonAccordion 调用 useSubtitleVerify 取数并把 verify prop 传给
// EpisodeRow；SeasonAccordion 不再取 verify、EpisodeRow 不再接 verify prop 后，这些用例无从
// 成立（不是改断言，是整个功能摘掉了），故整组删除。useSubtitleVerify.ts / InspectPanel.tsx /
// web/src/subtitleVerify/** 的源码与测试保留，将来重启用时把这个 describe（连同 stubVerify /
// compareDTO / openPanel 三个 helper、beforeEach 的 ResizeObserver stub、originalFetch /
// vi.restoreAllMocks / vi.unstubAllGlobals 在 afterEach 的清理）恢复即可。
//
