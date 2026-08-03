// web/src/activity/ActivityEmpty.test.tsx：空态（spec §7.1）的渲染 + 裁决回归锁。
//
// 这个文件里的重点不是"两行字渲染出来了"，而是**两条极容易被善意改坏的裁决**：
//
//  L6 不写"字幕都齐了"。空态加一句"全部完成！"是个极自然的"改进"，而它是用户明确否掉的东西
//     （原话：Steam 只显示完成列表），并且**还是假话**——前端看不到库里还缺不缺（park/dormant
//     的条目不在 pending 里）。下面有一条扫全族断言句的回归锁。
//
//  lastScanAt 为 null 时不编时刻。`relativeFinished(now - (lastScanAt ?? now))` 会输出"刚刚"，
//     一行看起来无害的兜底，实际把"从没扫过 / 守护死了"伪装成"刚刚检查过，一切正常"——恰好谎
//     在时间戳这个元件存在的唯一理由上。下面有正反两条锁。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider, type Lang } from '../i18n/useT.js'
import type { WorkflowFreshnessDTO, WorkflowRecentRunDTO } from '../api/types.js'
import { ActivityEmpty } from './ActivityEmpty.js'

// CSS 断言的取值方式同 ActivityHero / ActivityDone / ActivityStuck 三个测试文件（那里有完整
// 论证）：`?raw` 在 vitest 里恒返回空串（断言会全部变成永假），`node:fs` 会撞 tsconfig 的
// types 白名单——所以走 vitest.config.ts:21 的 `define` 在编译期把文件内容替换进来。
//
// 这一屏为什么需要读 CSS：它的两档 ink 分居两侧——时间戳那档在 CSS（.act-empty-stamp），
// 诚实状态行那档在组件层（text-muted-foreground，因为 CSS 里没人管那行的颜色）。哪一档在哪儿
// 是**级联分层**决定的，不是风格选择；只看 DOM 的话，把任意一档改错都是全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明。先剥注释（同上述三个文件的既有实现：声明前隔着
 *  一条注释会读不到，且注释里提到的颜色名不该被当成真声明）。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

const T0 = 1_700_000_000_000

/** 最常见的形状：扫过盘、巡检铺量中。 */
function meta(over: Partial<WorkflowFreshnessDTO> = {}): WorkflowFreshnessDTO {
  return {
    roots: ['/media'],
    lastScanAt: T0 - 180_000, // 3 分钟前
    files: 568,
    lastVerifySweepAt: T0 - 600_000,
    verifiedItems: 12,
    verifiableItems: 282,
    ...over,
  }
}

function recentRow(over: Partial<WorkflowRecentRunDTO> = {}): WorkflowRecentRunDTO {
  return {
    id: 7,
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

function renderEmpty(
  opts: {
    meta?: Partial<WorkflowFreshnessDTO>
    recent?: readonly WorkflowRecentRunDTO[]
    now?: number
    lang?: Lang
    onOpen?: (row: WorkflowRecentRunDTO) => void
  } = {},
) {
  return render(
    <I18nProvider initialLang={opts.lang ?? 'zh'}>
      <ActivityEmpty
        meta={meta(opts.meta)}
        recent={opts.recent ?? []}
        now={opts.now ?? T0}
        onOpen={opts.onOpen}
      />
    </I18nProvider>,
  )
}

afterEach(cleanup)

describe('ActivityEmpty：新鲜度时间戳（spec §7.1 的核心元件）', () => {
  it('lastScanAt 有值 → 渲染相对时间戳', () => {
    renderEmpty()
    expect(screen.getByText('最近检查 3 分钟前')).toBeInTheDocument()
  })

  it('英文渲染 Last checked 3m ago', () => {
    renderEmpty({ lang: 'en' })
    expect(screen.getByText('Last checked 3m ago')).toBeInTheDocument()
  })

  it('刚扫过（<5s）→ 成句"刚刚检查过"，不是别扭的"最近检查 刚刚"', () => {
    renderEmpty({ meta: { lastScanAt: T0 - 1_000 } })
    expect(screen.getByText('刚刚检查过')).toBeInTheDocument()
    cleanup()
    renderEmpty({ meta: { lastScanAt: T0 - 1_000 }, lang: 'en' })
    expect(screen.getByText('Checked just now')).toBeInTheDocument()
  })

  it('时间戳元素必须在场（判据 7：空态必须存在新鲜度时间戳）', () => {
    renderEmpty()
    expect(screen.getByTestId('activity-empty-stamp')).toBeInTheDocument()
  })

  it('久未检查照实说（6 天前）——时间戳会自己变旧，那正是它的用处', () => {
    // 守护死了之后这一行就停在那里发臭，用户一眼看见。这是这个元件存在的全部理由。
    renderEmpty({ meta: { lastScanAt: T0 - 6 * 86_400_000 } })
    expect(screen.getByText('最近检查 6 天前')).toBeInTheDocument()
  })

  // ── lastScanAt === null：不编时刻 ────────────────────────────────────────
  it('lastScanAt 为 null → 如实说"还没扫过"，**不编一个时刻**', () => {
    const { container } = renderEmpty({ meta: { lastScanAt: null } })
    expect(screen.getByText('还没扫过')).toBeInTheDocument()
    // 反向锁（这条是变异验证逼出来的关键断言）：`?? now` 那种兜底会输出"刚刚"，
    // 把"从没扫过/守护死了"伪装成"刚刚检查过，一切正常"。
    const text = container.textContent ?? ''
    expect(text).not.toContain('刚刚')
    expect(text).not.toContain('最近检查')
    // 也不许出现任何"N 秒/分钟/小时/天前"式的读数——那都是编出来的时刻。
    expect(text).not.toMatch(/\d+\s*(秒|分钟|小时|天)前/)
  })

  it('lastScanAt 为 null（英文）→ Not scanned yet，且无 ago 读数', () => {
    const { container } = renderEmpty({ meta: { lastScanAt: null }, lang: 'en' })
    expect(screen.getByText('Not scanned yet')).toBeInTheDocument()
    const text = container.textContent ?? ''
    expect(text.toLowerCase()).not.toContain('just now')
    expect(text).not.toMatch(/\d+[smhd]\s*ago/i)
  })
})

describe('ActivityEmpty：L6 回归锁（不写「字幕都齐了」）', () => {
  it('DOM 里没有「都齐了/全部完成/一切正常」这一族断言句', () => {
    // 用户原话：Steam 只显示完成列表。这一族措辞断言的是**整个库的完备性**，而前端只有
    // running/pending/recent 三个窗口，压根看不到库里还缺不缺（park/dormant 的条目不在
    // pending 里）——所以它既违裁决又是假话。
    for (const lang of ['zh', 'en'] as const) {
      // 最容易诱发那句话的形状：有完成记录 + 队列空 + 刚扫过（"看起来一切都好"）。
      const { container } = renderEmpty({ recent: [recentRow()], lang })
      const text = container.textContent ?? ''
      for (const claim of ['都齐了', '齐了', '全部完成', '一切正常', '一切就绪', '没有问题', '都搞定', '完成了！']) {
        expect(text).not.toContain(claim)
      }
      const lower = text.toLowerCase()
      for (const claim of ['all caught up', 'all done', "you're all set", 'all set', 'everything is', 'nothing to do', 'up to date', 'no issues', 'complete!']) {
        expect(lower).not.toContain(claim)
      }
      // 判据 7 的原文口径：不含"齐"字样。
      expect(text).not.toContain('齐')
      cleanup()
    }
  })

  it('渲染的是诚实运行态事实（"现在没有在处理的字幕"），不是对库的评价', () => {
    renderEmpty()
    expect(screen.getByText('现在没有在处理的字幕')).toBeInTheDocument()
    cleanup()
    renderEmpty({ lang: 'en' })
    expect(screen.getByText('No subtitles in progress')).toBeInTheDocument()
  })

  it('没有横幅/绿勾/插画类装饰（L6 的同型错误：绿勾同样在断言库的完备性）', () => {
    const { container } = renderEmpty({ recent: [recentRow()] })
    // 空态一个状态色都不用——没有语义点（那是完成行的元件，不是空态的总结）。
    expect(container.querySelector('.act-empty .act-hero-pulse')).toBeNull()
    // 也没有 svg 插画（"空空如也"的吉祥物是另一版同型的装饰而非信息）。
    expect(container.querySelectorAll('.act-empty-facts svg')).toHaveLength(0)
  })
})

describe('ActivityEmpty：完成列表（复用 ActivityDone，§7.1 要求与 hero 同几何的海报）', () => {
  it('有完成记录 → 渲染列表', () => {
    renderEmpty({ recent: [recentRow()] })
    expect(screen.getByTestId('activity-done')).toBeInTheDocument()
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('字幕已装好')).toBeInTheDocument()
  })

  it('完成行海报走 .act-row-poster（38px 2:3，与 hero 同几何——§7.1 逐字要求）', () => {
    const { container } = renderEmpty({ recent: [recentRow()] })
    const poster = container.querySelector('.act-row-poster img')
    expect(poster).toBeTruthy()
    expect(poster!.getAttribute('src')).toContain('/poster.jpg')
  })

  it('多条完成记录全部渲染', () => {
    renderEmpty({ recent: [recentRow(), recentRow({ id: 8, seriesName: '风骚律师' })] })
    expect(screen.getAllByTestId('activity-done-row')).toHaveLength(2)
  })

  it('recent 为空 → 完成段不渲染，但**两行事实仍在**（不许是空白页）', () => {
    // 裁决：此刻没有任何主语可以配图，凭空放一张插画是装饰而不是信息。空态优雅退化成
    // 两行事实——而它们恰恰是这一屏唯一必须在场的东西。
    const { container } = renderEmpty({ recent: [] })
    expect(screen.queryByTestId('activity-done')).toBeNull()
    expect(screen.getByTestId('activity-empty-idle')).toBeInTheDocument()
    expect(screen.getByTestId('activity-empty-stamp')).toBeInTheDocument()
    // 反向锁：不是空白页。
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0)
  })

  it('完成记录为空 + 从未扫过（全新装机）→ 仍渲染两行诚实事实，不是白页', () => {
    // 这是最"没什么可说"的一屏，也是最容易被写成空白/插画的一屏。
    const { container } = renderEmpty({ recent: [], meta: { lastScanAt: null, lastVerifySweepAt: null } })
    expect(screen.getByText('现在没有在处理的字幕')).toBeInTheDocument()
    expect(screen.getByText('还没扫过')).toBeInTheDocument()
    expect((container.textContent ?? '').trim().length).toBeGreaterThan(0)
    // 而且这一屏**没有**编出来的时刻，也没有"N / M 已检查"（巡检没跑过 → 0/282 会读成坏了）。
    expect(screen.queryByTestId('activity-empty-checked')).toBeNull()
  })
})

describe('ActivityEmpty：「N / M 已检查」（裸计数，不是评分）', () => {
  it('铺量中 → 渲染 12 / 282 已检查', () => {
    renderEmpty()
    expect(screen.getByText('12 / 282 已检查')).toBeInTheDocument()
    cleanup()
    renderEmpty({ lang: 'en' })
    expect(screen.getByText('12 / 282 checked')).toBeInTheDocument()
  })

  it('巡检从未跑过（lastVerifySweepAt=null）→ 不显示（0/282 会读成"这功能坏了"）', () => {
    renderEmpty({ meta: { lastVerifySweepAt: null, verifiedItems: 0 } })
    expect(screen.queryByTestId('activity-empty-checked')).toBeNull()
  })

  it('已铺满（done >= total）→ 不显示（"282 / 282" 是一句没有信息的废话）', () => {
    renderEmpty({ meta: { verifiedItems: 282, verifiableItems: 282 } })
    expect(screen.queryByTestId('activity-empty-checked')).toBeNull()
  })

  it('verifiableItems=0（没有可校验的条目）→ 不显示，且不出现 0 / 0', () => {
    const { container } = renderEmpty({ meta: { verifiedItems: 0, verifiableItems: 0 } })
    expect(screen.queryByTestId('activity-empty-checked')).toBeNull()
    expect(container.textContent).not.toContain('0 / 0')
  })

  it('不换算成百分比（铁律②：裸计数允许，百分比禁）', () => {
    const { container } = renderEmpty()
    const text = container.textContent ?? ''
    expect(text).not.toContain('%')
    // 12/282 ≈ 4% —— 不许出现任何换算结果。
    expect(text).not.toContain('4%')
  })
})

describe('ActivityEmpty：铁律回归锁', () => {
  it('铁律②零数字：不显示 jobId / run id / llmCalls', () => {
    const { container } = renderEmpty({ recent: [recentRow({ llmCalls: 37 })] })
    const text = container.textContent ?? ''
    expect(text).not.toContain('41')   // jobId
    expect(text).not.toContain('37')   // llmCalls
    expect(text).not.toContain('%')
  })

  it('铁律③不暴露机械：textContent 不含 agent/orchestrator/worker/pass/asset/ledger/job', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderEmpty({ recent: [recentRow()], lang })
      const text = (container.textContent ?? '').toLowerCase()
      for (const word of ['agent', 'orchestrator', 'worker', 'pass', 'asset', 'ledger', 'job']) {
        expect(text).not.toContain(word)
      }
      cleanup()
    }
  })

  it('铁律①：空态没有红也没有绿的状态块（空态是中性事实，不是"好"也不是"坏"）', () => {
    const { container } = renderEmpty()
    // 两行事实区里没有任何语义点/状态色元素。
    const facts = container.querySelector('.act-empty-facts')!
    expect(facts.querySelector('[data-tone]')).toBeNull()
    // 也没有内联颜色（红/绿/黄都不许）。
    expect(facts.innerHTML).not.toMatch(/color\s*:\s*(red|green|#f8|#3f|#d2|#e8)/i)
  })

  it('空态没有按钮（没有需要用户做的决定；onOpen 缺席时完成行也不给按钮）', () => {
    const { container } = renderEmpty({ recent: [recentRow()] })
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('onOpen 在场时完成行才有「查看」（那是 ActivityDone 的既有契约，空态不改它）', () => {
    renderEmpty({ recent: [recentRow()], onOpen: () => {} })
    expect(screen.getByText('查看')).toBeInTheDocument()
  })
})

describe('ActivityEmpty：双语各渲染一次（DESIGN.md §7 运行态跟随 UI 语言）', () => {
  it('中文：状态行 + 时间戳 + 裸计数 + 完成列表，全中文', () => {
    renderEmpty({ recent: [recentRow()], lang: 'zh' })
    expect(screen.getByText('现在没有在处理的字幕')).toBeInTheDocument()
    expect(screen.getByText('最近检查 3 分钟前')).toBeInTheDocument()
    expect(screen.getByText('12 / 282 已检查')).toBeInTheDocument()
    expect(screen.getByText('字幕已装好')).toBeInTheDocument()
    expect(screen.getByText('2 分钟前')).toBeInTheDocument()
  })

  it('英文：同一份数据全英文', () => {
    renderEmpty({ recent: [recentRow()], lang: 'en' })
    expect(screen.getByText('No subtitles in progress')).toBeInTheDocument()
    expect(screen.getByText('Last checked 3m ago')).toBeInTheDocument()
    expect(screen.getByText('12 / 282 checked')).toBeInTheDocument()
    expect(screen.getByText('subtitles installed')).toBeInTheDocument()
    expect(screen.getByText('2m ago')).toBeInTheDocument()
  })
})

// ── 时间戳的 ink 档位：这一档的真身在 CSS，不在组件里 ──────────────────────────
//
// .act-empty-stamp 那条 color 是这一屏 CSS 侧**唯一**的颜色声明（.act-empty 与
// .act-empty-facts 都不管颜色）。组件层给不了它：styles.css 全文未分层，赢过 @layer utilities
// 里的任何 text-* 工具类——所以这一档只能在这里锁。
describe('ActivityEmpty：时间戳的 ink 档位（真身在 CSS）', () => {
  it('.act-empty-stamp 走 --color-weak（ink 最弱的一档：它是给人核对的背景事实，不是主角）', () => {
    expect(cssDecl('.act-empty-stamp', 'color')).toBe('var(--color-weak)')
    // 配对取证：DOM 侧那两个元素确实套着这个类，否则上面锁的是一条没人用的规则。
    renderEmpty()
    for (const testId of ['activity-empty-stamp', 'activity-empty-checked']) {
      expect(screen.getByTestId(testId).className.split(/\s+/)).toContain('act-empty-stamp')
    }
  })
})
