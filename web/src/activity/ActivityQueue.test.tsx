// web/src/activity/ActivityQueue.test.tsx：「接下来」段的渲染 + 用户裁决回归锁。
//
// 同 ActivityHero.test.tsx 的分工：一半用例不是"测功能"，是**锁裁决**——而每条裁决在代码里都
// 表现为一个很容易被"顺手优化掉"的细节（38px 2:3 而不是 16:9、没有徽章/状态列、空队列整段不
// 渲染而不是给个"暂无"）。每条锁下面都注明它锁的是哪条，以及删掉它之后哪种"合理的改进"会静默
// 溜进来。
//
// CSS 断言走同 ActivityHero.test.tsx 的手法（__STYLES_CSS__ 编译期注入 + cssDecl）：海报比例与
// 宽度这两条裁决的**真身在 CSS 里**，只断言类名在场是假保护——把 CSS 改成 16/9 不会让任何测试
// 变红。踩过的两个坑（`?raw` 在 vitest 里恒空串、`node:fs` 破 tsconfig 的 types 白名单）见
// vitest.config.ts 的注释。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider, type Lang } from '../i18n/useT.js'
import type { WorkflowPendingMovieDTO, WorkflowPendingSeriesDTO } from '../api/types.js'
import { ActivityQueue } from './ActivityQueue.js'

declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 同 ActivityHero.test.tsx 的 cssDecl（含剥注释）——两个文件各一份是刻意的：把它提到共享
 *  helper 里会让"改一处影响两处"，而这两组断言锁的是不同裁决，不该被迫一起演化。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

function seriesRow(over: Partial<WorkflowPendingSeriesDTO> = {}): WorkflowPendingSeriesDTO {
  return {
    seriesId: 'tmdb:1396',
    seriesName: '绝命毒师',
    season: 3,
    missing: 7,
    throttled: 0,
    nextRecheckAt: null,
    sampleReason: null,
    ...over,
  }
}

function movieRow(over: Partial<WorkflowPendingMovieDTO> = {}): WorkflowPendingMovieDTO {
  return {
    id: 'tmdb:27205',
    name: '盗梦空间',
    missing: 1,
    throttled: 0,
    nextRecheckAt: null,
    sampleReason: null,
    ...over,
  }
}

function renderQueue(
  opts: {
    series?: WorkflowPendingSeriesDTO[]
    movies?: WorkflowPendingMovieDTO[]
    autoCheck?: boolean
    lang?: Lang
  } = {},
) {
  return render(
    <I18nProvider initialLang={opts.lang ?? 'zh'}>
      <ActivityQueue
        series={opts.series ?? [seriesRow()]}
        movies={opts.movies ?? []}
        autoCheck={opts.autoCheck}
      />
    </I18nProvider>,
  )
}

afterEach(cleanup)

describe('ActivityQueue：基本渲染', () => {
  it('渲染剧名 + 季号 + 缺字幕集数', () => {
    renderQueue({ series: [seriesRow({ seriesName: '绝命毒师', season: 3, missing: 7 })] })
    expect(screen.getByText('绝命毒师 · 第 3 季')).toBeInTheDocument()
    expect(screen.getByText('7 集缺字幕')).toBeInTheDocument()
  })

  it('段标题带条目数（"接下来 (n)"），计数含剧 + 片两族', () => {
    renderQueue({ series: [seriesRow(), seriesRow({ season: 4 })], movies: [movieRow()] })
    expect(screen.getByText('接下来 (3)')).toBeInTheDocument()
  })

  it('每行右侧一个"等待中"，且整段只有这一档状态词', () => {
    renderQueue({ series: [seriesRow(), seriesRow({ season: 4 })] })
    expect(screen.getAllByTestId('activity-queue-status')).toHaveLength(2)
    expect(screen.getAllByText('等待中')).toHaveLength(2)
  })

  it('同一 seriesId 的多季各渲染一行（pending.series 是逐季一行，不是逐剧）', () => {
    renderQueue({
      series: [seriesRow({ season: 1, missing: 3 }), seriesRow({ season: 2, missing: 5 })],
    })
    expect(screen.getByText('绝命毒师 · 第 1 季')).toBeInTheDocument()
    expect(screen.getByText('绝命毒师 · 第 2 季')).toBeInTheDocument()
    expect(screen.getAllByTestId('activity-queue-row')).toHaveLength(2)
  })

  it('电影行渲染片名 + 不带数字的"缺字幕"（电影没有集，"1 集缺字幕"是假话）', () => {
    const { container } = renderQueue({ series: [], movies: [movieRow({ name: '盗梦空间', missing: 1 })] })
    expect(screen.getByText('盗梦空间')).toBeInTheDocument()
    expect(screen.getByText('缺字幕')).toBeInTheDocument()
    // 反向锁：不许出现"1 集"——电影没有集这个单位。
    expect(container.textContent).not.toContain('1 集')
    expect(container.textContent).not.toMatch(/第 .* 季/)
  })

  it('电影 missing=0（只因停牌在队列里）→ 不渲染事实句，也不编一句"等待复查"', () => {
    const { container } = renderQueue({
      series: [],
      movies: [movieRow({ missing: 0, throttled: 1, nextRecheckAt: 999 })],
    })
    expect(screen.getByText('盗梦空间')).toBeInTheDocument()
    expect(container.textContent).not.toContain('缺字幕')
    // 状态词仍只有"等待中"这一档。
    expect(screen.getByText('等待中')).toBeInTheDocument()
  })
})

describe('ActivityQueue：L5 海报 38px 2:3（用户明确纠正过 16:9）', () => {
  it('每行一个海报框，走 PosterThumb', () => {
    renderQueue({ series: [seriesRow(), seriesRow({ season: 4 })], movies: [movieRow()] })
    expect(screen.getAllByTestId('activity-queue-poster')).toHaveLength(3)
  })

  it('CSS 里海报是 2:3 竖版，且宽 38px（两条裁决的真身，只锁类名是假保护）', () => {
    renderQueue()
    expect(document.querySelector('.act-row-poster')).toBeTruthy()
    const ratio = cssDecl('.act-row-poster', 'aspect-ratio')
    expect(ratio).not.toBeNull()
    const normalized = ratio!.replace(/\s+/g, '')
    expect(normalized).toBe('2/3')
    // 显式否定横版：失败信息要能说清是哪种改动。用户就是把 16:9 纠正成 2:3 的。
    expect(normalized).not.toBe('16/9')
    expect(normalized).not.toBe('16/10')
    // 38px 是 hero:队列 ≈5:1 尺寸比的分母——层级靠图片大小编码，改这个数会把那条裁决一起改掉。
    expect(cssDecl('.act-row-poster', 'width')).toBe('38px')
  })

  it('无海报（pending DTO 没有 posterPath 字段）→ 走首字母占位，几何不变', () => {
    const { container } = renderQueue()
    // 框在场（几何由框给，不由图给），里面是占位而不是 img。
    expect(container.querySelector('.act-row-poster')).toBeTruthy()
    expect(container.querySelector('.act-row-poster .library-poster-fallback')).toBeTruthy()
  })
})

describe('ActivityQueue：裁决回归锁', () => {
  it('空队列 → 整段不渲染（不给"暂无"占位，也不给"接下来 (0)"空壳）', () => {
    const { container } = renderQueue({ series: [], movies: [] })
    expect(container.textContent).toBe('')
    expect(screen.queryByTestId('activity-queue')).toBeNull()
    // 反向锁：一个"接下来 (0)"的空壳标题比没有标题更让人怀疑是不是坏了。
    expect(container.textContent).not.toContain('接下来')
  })

  it('不需要徽章/状态列/术语（hero:队列 5:1 尺寸比已编码层级）', () => {
    const { container } = renderQueue({
      series: [seriesRow({ throttled: 4, nextRecheckAt: 1_700_000_400_000, sampleReason: 'no candidates' })],
    })
    // 停牌计数/复查倒计时/sampleReason 都**不上界面**——那是 Workflow 三泳道那个账本页的读数。
    // "下次复查 4 小时后"会让一个正常等待的条目读起来像出了问题。
    expect(container.textContent).not.toContain('4')
    expect(container.textContent).not.toContain('no candidates')
    expect(container.textContent?.toLowerCase()).not.toContain('recheck')
    expect(container.textContent).not.toContain('停牌')
    // 也没有 Astryx Badge（它会渲染带底色的块，正是"不需要徽章"要排除的东西）。
    expect(container.querySelector('[class*="badge" i]')).toBeNull()
  })

  it('铁律②零数字：不显示 score/offset/百分比，只有集数与季号', () => {
    const { container } = renderQueue({ series: [seriesRow({ season: 3, missing: 7 })] })
    const text = container.textContent ?? ''
    expect(text).not.toContain('%')
    for (const bad of ['score', 'offset', 'confidence', 'ms']) {
      expect(text.toLowerCase()).not.toContain(bad)
    }
    // 允许在场的两个数字。
    expect(text).toContain('3')
    expect(text).toContain('7')
  })

  it('铁律③不暴露机械：textContent 不含 agent/orchestrator/worker/pass/asset/ledger', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderQueue({ series: [seriesRow()], movies: [movieRow()], autoCheck: true, lang })
      const text = (container.textContent ?? '').toLowerCase()
      for (const word of ['agent', 'orchestrator', 'worker', 'pass', 'asset', 'ledger']) {
        expect(text).not.toContain(word)
      }
      cleanup()
    }
  })

  it('不显示工程值：seriesId / movieId 都不在界面上（有名字时）', () => {
    const { container } = renderQueue({ series: [seriesRow()], movies: [movieRow()] })
    expect(container.textContent).not.toContain('tmdb:1396')
    expect(container.textContent).not.toContain('tmdb:27205')
  })

  it('grep 回归锁：本段的字段名是 series，代码里不出现 missingBySeason（spec 判据 12）', () => {
    // missingBySeason 是后端 LibraryRepo 的方法名；前端 DTO 里叫 series。按错名写会取到
    // undefined 且 tsc 不一定拦得住（Partial/索引访问的洞）。这条锁在渲染层的表现是：
    // 组件确实吃到了 series 数组并渲染出了行。
    renderQueue({ series: [seriesRow({ missing: 7 })] })
    expect(screen.getByText('7 集缺字幕')).toBeInTheDocument()
  })
})

describe('ActivityQueue：「自动检查已开启」标签（前端观测不到守护状态）', () => {
  it('autoCheck=true → 标签在场', () => {
    renderQueue({ autoCheck: true })
    expect(screen.getByTestId('activity-auto-chip')).toBeInTheDocument()
    expect(screen.getByText('自动检查已开启')).toBeInTheDocument()
  })

  it('autoCheck 缺席 → 整枚标签不渲染（不把一个看不见的值硬编码成事实）', () => {
    // pending/workers 两个 DTO 里都没有守护状态字段（api/types.ts 全文无 daemon/paused/
    // enabled 一族）。照 spec 草图逐字写死"自动检查已开启"，守护停了之后这句话会当场变成
    // 假话——而那恰恰是用户此刻最需要知道的事（DESIGN.md §8）。
    const { container } = renderQueue({ autoCheck: undefined })
    expect(screen.queryByTestId('activity-auto-chip')).toBeNull()
    expect(container.textContent).not.toContain('自动检查')
  })

  it('autoCheck=false → 也不写"自动检查已关闭"（那是警示语义，本段是低墨排等待清单）', () => {
    const { container } = renderQueue({ autoCheck: false })
    expect(screen.queryByTestId('activity-auto-chip')).toBeNull()
    expect(container.textContent).not.toContain('关闭')
  })
})

describe('ActivityQueue：双语各渲染一次（DESIGN.md §7 运行态跟随 UI 语言）', () => {
  it('中文', () => {
    renderQueue({ series: [seriesRow({ season: 3, missing: 7 })], movies: [movieRow()], autoCheck: true, lang: 'zh' })
    expect(screen.getByText('接下来 (2)')).toBeInTheDocument()
    expect(screen.getByText('绝命毒师 · 第 3 季')).toBeInTheDocument()
    expect(screen.getByText('7 集缺字幕')).toBeInTheDocument()
    expect(screen.getByText('缺字幕')).toBeInTheDocument()
    expect(screen.getAllByText('等待中')).toHaveLength(2)
    expect(screen.getByText('自动检查已开启')).toBeInTheDocument()
  })

  it('英文：同一份数据全英文（单/复数正确）', () => {
    renderQueue({
      series: [seriesRow({ seriesName: 'Breaking Bad', season: 3, missing: 7 })],
      movies: [movieRow({ name: 'Inception' })],
      autoCheck: true,
      lang: 'en',
    })
    expect(screen.getByText('Up next (2)')).toBeInTheDocument()
    expect(screen.getByText('Breaking Bad · Season 3')).toBeInTheDocument()
    expect(screen.getByText('7 episodes missing subtitles')).toBeInTheDocument()
    expect(screen.getByText('missing subtitles')).toBeInTheDocument()
    expect(screen.getAllByText('queued')).toHaveLength(2)
    expect(screen.getByText('auto-check on')).toBeInTheDocument()
    cleanup()
    // 单数不带 s。
    renderQueue({ series: [seriesRow({ seriesName: 'Breaking Bad', missing: 1 })], lang: 'en' })
    expect(screen.getByText('1 episode missing subtitles')).toBeInTheDocument()
  })
})
