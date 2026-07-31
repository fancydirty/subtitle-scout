// web/src/activity/ActivityDone.test.tsx：「刚刚完成」段的渲染 + 用户裁决回归锁。
//
// 这个文件里最重要的两条不是功能测试，是回归锁：
//
//  1) **L6 锁**：完成列表在场时，DOM 里不许有"全部完成/都齐了/一切正常"这类断言句。用户原话：
//     Steam 只显示完成列表。把这条删掉之后会静默溜进来的"合理改进"是——「列表非空说明一切正常，
//     加个绿横幅更友好」。那恰恰是用户明确否掉的东西。
//
//  2) **铁律②锁**：DTO 带着 llmCalls（审计 UX-P0 加的成本账本，三泳道账本页的成本后缀），
//     而铁律②明确排除内部计量值。所以这里喂一个**不会与其它任何读数相撞的** llmCalls 值，
//     断言那个数字不在 DOM 里。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider, type Lang } from '../i18n/useT.js'
import type { WorkflowRecentRunDTO } from '../api/types.js'
import { ActivityDone } from './ActivityDone.js'

const T0 = 1_700_000_000_000

/** styles.css 原文（vitest.config.ts 的 define 编译期注入）——铁律①的两条锁要读 CSS 源文件：
 *  「语义点只有绿/红/灰」与「红只染点不铺块」的真身都在 CSS 里，只断言 data-tone 属性在场
 *  锁不住它们（把 CSS 里的 ok 改成琥珀色不会让任何 DOM 断言变红）。 */
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function recentRow(over: Partial<WorkflowRecentRunDTO> = {}): WorkflowRecentRunDTO {
  return {
    id: 901,
    jobId: 41,
    decision: 'installed',
    detail: null,
    finishedAt: T0 - 120_000,
    seriesId: 'tmdb:1396',
    movieId: null,
    seriesName: '绝命毒师',
    movieName: null,
    posterPath: '/poster.jpg',
    backdropPath: '/backdrop.jpg',
    llmCalls: null,
    ...over,
  }
}

function renderDone(
  opts: {
    recent?: WorkflowRecentRunDTO[]
    now?: number
    onOpen?: (row: WorkflowRecentRunDTO) => void
    lang?: Lang
  } = {},
) {
  return render(
    <I18nProvider initialLang={opts.lang ?? 'zh'}>
      <ActivityDone
        recent={opts.recent ?? [recentRow()]}
        now={opts.now ?? T0}
        onOpen={opts.onOpen}
      />
    </I18nProvider>,
  )
}

afterEach(cleanup)

describe('ActivityDone：基本渲染', () => {
  it('渲染主语 + 人话短语（走 decisionPhrase，不是裸 decision 词）', () => {
    const { container } = renderDone()
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('字幕已装好')).toBeInTheDocument()
    // 反向锁：裸 decision 枚举值不上界面（L3 的同一条精神）。
    expect(container.textContent).not.toContain('installed')
  })

  it('段标题带条目数（"刚刚完成 (n)"）', () => {
    renderDone({ recent: [recentRow(), recentRow({ id: 902 }), recentRow({ id: 903 })] })
    expect(screen.getByText('刚刚完成 (3)')).toBeInTheDocument()
  })

  it('渲染相对时间（"2 分钟前"），时间是入参不是 Date.now', () => {
    renderDone({ recent: [recentRow({ finishedAt: T0 - 120_000 })], now: T0 })
    expect(screen.getByText('2 分钟前')).toBeInTheDocument()
  })

  it('finishedAt 为 null → 不渲染时间（不编一个"刚刚"出来）', () => {
    renderDone({ recent: [recentRow({ finishedAt: null })] })
    expect(screen.queryByTestId('activity-done-time')).toBeNull()
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
  })

  it('主语降级链：seriesName → movieName → id', () => {
    renderDone({ recent: [recentRow({ seriesName: null, movieName: '盗梦空间', seriesId: null, movieId: 'tmdb:27205' })] })
    expect(screen.getByText('盗梦空间')).toBeInTheDocument()
    cleanup()
    renderDone({ recent: [recentRow({ seriesName: null, movieName: null })] })
    expect(screen.getByText('tmdb:1396')).toBeInTheDocument()
  })

  it('decision 为 null → 不渲染短语与语义点（不把 "null" 糊到界面上）', () => {
    const { container } = renderDone({ recent: [recentRow({ decision: null })] })
    expect(screen.queryByTestId('activity-done-dot')).toBeNull()
    expect(container.textContent).not.toContain('null')
    // 主语与时间仍在——这一行仍是一个可读的事实。
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('2 分钟前')).toBeInTheDocument()
  })

  it('空列表 → 整段不渲染（不给"暂无"占位）', () => {
    const { container } = renderDone({ recent: [] })
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('activity-done')).toBeNull()
  })

  it('海报与队列行同几何（.act-row-poster，38px 2:3）', () => {
    const { container } = renderDone()
    // spec §7.1 要求完成列表"用与 hero 同几何的海报"——而 hero:队列的 5:1 尺寸比是靠 38px
    // 这一档建立的，所以完成行必须复用队列行那个类，不能自起一个。
    expect(container.querySelector('.act-row-poster')).toBeTruthy()
    const img = container.querySelector<HTMLImageElement>('.act-row-poster img')
    expect(img).toBeTruthy()
    expect(img!.src).toContain('/poster.jpg')
  })

  it('posterPath 为 null → 首字母占位，不崩', () => {
    const { container } = renderDone({ recent: [recentRow({ posterPath: null })] })
    expect(container.querySelector('.act-row-poster .library-poster-fallback')).toBeTruthy()
  })
})

describe('ActivityDone：L1 只有绿和红（语义点走 decisionPhrase 的 tone）', () => {
  it.each([
    ['installed', 'ok'],
    ['realign:done', 'ok'],
    ['error', 'bad'],
    ['realign:error', 'bad'],
    ['no_safe_match', 'neutral'],
    ['retry_later', 'neutral'],
  ])('decision=%s → 语义点 data-tone=%s', (decision, tone) => {
    renderDone({ recent: [recentRow({ decision })] })
    expect(screen.getByTestId('activity-done-dot').dataset.tone).toBe(tone)
  })

  it('"没找到能放心用的字幕"是灰不是红（铁律④：等待/失败是面向下一步的中性事实）', () => {
    renderDone({ recent: [recentRow({ decision: 'no_safe_match' })] })
    expect(screen.getByTestId('activity-done-dot').dataset.tone).toBe('neutral')
    expect(screen.getByText('没找到能放心用的字幕')).toBeInTheDocument()
  })

  it('tone 与语言无关（同一 decision 在中英两侧 tone 一致）', () => {
    for (const [lang, text] of [['zh', '遇到问题——会重试'], ['en', 'hit a problem — will retry']] as const) {
      renderDone({ recent: [recentRow({ decision: 'error' })], lang })
      expect(screen.getByTestId('activity-done-dot').dataset.tone).toBe('bad')
      expect(screen.getByText(text)).toBeInTheDocument()
      cleanup()
    }
  })
})

describe('ActivityDone：裁决回归锁', () => {
  // ── L6：字幕齐了不写字说「齐了」，只显示完成列表 ──────────────────────────
  it('L6：完成列表在场时，DOM 里没有「全部完成/都齐了」这类断言句', () => {
    // 用户原话：Steam 只显示完成列表。删掉这条锁之后会静默溜进来的"合理改进"是——
    // 「列表非空说明一切正常，加个绿横幅更友好」。那恰恰是用户明确否掉的东西。
    const { container } = renderDone({
      recent: [
        recentRow({ id: 901, decision: 'installed' }),
        recentRow({ id: 902, decision: 'installed', seriesName: '风骚律师' }),
        recentRow({ id: 903, decision: 'translate:installed', seriesName: '毒枭' }),
      ],
    })
    const text = container.textContent ?? ''
    // 全绿（三行全 ok）恰恰是最容易被加横幅的状态——所以这条用例刻意用全 ok 的数据。
    for (const bad of [
      '全部完成', '都齐了', '齐了', '全部齐', '一切正常', '都装好了', '没有待处理', '大功告成',
      'all done', 'all caught up', 'everything', 'nothing to do', 'up to date', 'fully covered',
    ]) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase())
    }
    // 结构侧的锁：这个 section 的直系子元素只有"标题 + n 行"，没有第 n+2 个块可以塞横幅。
    const section = screen.getByTestId('activity-done')
    expect(section.children).toHaveLength(1 + 3)
  })

  it('L6 英文侧同样没有断言句', () => {
    const { container } = renderDone({
      recent: [recentRow({ seriesName: 'Breaking Bad' })],
      lang: 'en',
    })
    const text = (container.textContent ?? '').toLowerCase()
    for (const bad of ['all done', 'all caught up', 'nothing', 'complete', 'everything']) {
      expect(text).not.toContain(bad)
    }
  })

  // ── 铁律②零数字：不显示 llmCalls ─────────────────────────────────────────
  it('铁律②：llmCalls 有值时那个数字不出现在 DOM 里', () => {
    // llmCalls=4173 刻意选成一个**不会与任何其它读数相撞**的值：条目数是 1、相对时间是
    // "2 分钟前"，都不含 4173。若断言用 3 之类的小数字，它会与"刚刚完成 (3)"的计数
    // 撞车，让这条锁变成永假（那正是上一轮变异验证栽过的坑：红了但不是因为你想的原因）。
    const { container } = renderDone({ recent: [recentRow({ llmCalls: 4173 })] })
    const text = container.textContent ?? ''
    expect(text).not.toContain('4173')
    // 也不许从后门以属性形式带出来（title/aria-label 会被屏幕阅读器念出来）。
    expect(container.innerHTML).not.toContain('4173')
  })

  it('铁律②：不显示 score/offset/百分比/耗时毫秒，只有相对时间这一个数字读数', () => {
    const { container } = renderDone({ recent: [recentRow({ llmCalls: 4173, jobId: 8642 })] })
    const text = container.textContent ?? ''
    expect(text).not.toContain('%')
    for (const bad of ['score', 'offset', 'confidence']) {
      expect(text.toLowerCase()).not.toContain(bad)
    }
    // jobId 也是工程值（run 的内部身份），不上界面。
    expect(text).not.toContain('8642')
  })

  it('铁律②：不显示 detail（agent 的原始决策文本，是取证材料不是人话）', () => {
    const { container } = renderDone({
      recent: [recentRow({ detail: 'installed 3 assets via worker pass #7' })],
    })
    expect(container.textContent).not.toContain('assets')
    expect(container.textContent).not.toContain('#7')
  })

  it('铁律③不暴露机械：textContent 不含 agent/orchestrator/worker/pass/asset/ledger', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderDone({
        recent: [
          recentRow({ decision: 'installed' }),
          recentRow({ id: 902, decision: 'error' }),
          recentRow({ id: 903, decision: 'no_safe_match' }),
        ],
        onOpen: () => {},
        lang,
      })
      const text = (container.textContent ?? '').toLowerCase()
      for (const word of ['agent', 'orchestrator', 'worker', 'pass', 'asset', 'ledger']) {
        expect(text).not.toContain(word)
      }
      cleanup()
    }
  })

  it('铁律①：CSS 里语义点只有绿/红/灰三档，没有黄', () => {
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const block = /\.act-row-dot[\s\S]{0,400}?\}\s*\.act-row-dot\[data-tone='ok'\][\s\S]{0,600}?neutral'\][^}]*\}/.exec(noComments)?.[0] ?? ''
    expect(block.length).toBeGreaterThan(0)
    expect(block).not.toMatch(/\b(gold|yellow|amber|orange)\b/i)
    expect(block).toContain('--color-text-green')
    expect(block).toContain('--color-text-red')
    // neutral 必须是灰（spec §6 的三档），不是黄不是蓝。
    expect(block).toMatch(/data-tone='neutral'\][^}]*--color-text-gray/)
  })

  it('铁律①：红只染点不铺块（没有任何红底色的行/卡片规则）', () => {
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const rowBlocks = noComments.match(/\.act-row[^{]*\{[^}]*\}/g) ?? []
    expect(rowBlocks.length).toBeGreaterThan(0)
    for (const b of rowBlocks) {
      // 只看 background 声明：dot 那三条是 background 的颜色，但它们的选择器是 .act-row-dot，
      // 尺寸 6px——"铺块"指的是给整行/整卡加红底。这里断言除了 dot 之外没有任何 background
      // 用到红色 token。
      if (b.includes('.act-row-dot')) continue
      expect(b).not.toMatch(/background[^;]*--color-text-red/)
    }
  })
})

describe('ActivityDone：「查看」动作（对位 Steam 的 ▶ Play）', () => {
  it('onOpen 在场 → 每行一个"查看"按钮，点击触发回调并带上那一行', () => {
    const onOpen = vi.fn()
    const rows = [recentRow({ id: 901 }), recentRow({ id: 902, seriesName: '风骚律师' })]
    renderDone({ recent: rows, onOpen })
    const buttons = screen.getAllByRole('button', { name: '查看' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1]!)
    expect(onOpen).toHaveBeenCalledTimes(1)
    // 带上的是**那一行**，不是第一行——回调参数错位会让"查看"跳到别的条目。
    expect(onOpen).toHaveBeenCalledWith(rows[1])
  })

  it('onOpen 缺席 → 整个按钮不渲染（点不动的按钮比没有按钮更糟，同 L11 的精神）', () => {
    const { container } = renderDone({ onOpen: undefined })
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.textContent).not.toContain('查看')
  })

  it('英文下按钮读 View', () => {
    renderDone({ onOpen: () => {}, lang: 'en' })
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument()
  })
})

describe('ActivityDone：双语各渲染一次（DESIGN.md §7 运行态跟随 UI 语言）', () => {
  it('中文', () => {
    renderDone({
      recent: [recentRow({ decision: 'installed', finishedAt: T0 - 120_000 })],
      now: T0,
      onOpen: () => {},
      lang: 'zh',
    })
    expect(screen.getByText('刚刚完成 (1)')).toBeInTheDocument()
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('字幕已装好')).toBeInTheDocument()
    expect(screen.getByText('2 分钟前')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看' })).toBeInTheDocument()
  })

  it('英文：同一份数据全英文', () => {
    renderDone({
      recent: [recentRow({ seriesName: 'Breaking Bad', decision: 'installed', finishedAt: T0 - 120_000 })],
      now: T0,
      onOpen: () => {},
      lang: 'en',
    })
    expect(screen.getByText('Just finished (1)')).toBeInTheDocument()
    expect(screen.getByText('Breaking Bad')).toBeInTheDocument()
    expect(screen.getByText('subtitles installed')).toBeInTheDocument()
    expect(screen.getByText('2m ago')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument()
  })
})
