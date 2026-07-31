// web/src/activity/ActivityHero.test.tsx：hero（剧集路径）的渲染 + 全套用户裁决回归锁。
//
// 这个文件里超过一半的用例不是"测功能"，是**锁裁决**——用户对 hero 的每个细节都亲自定过，
// 而这些裁决在代码里都表现为一个很容易被"顺手优化掉"的细节（2:3 而不是 16:9、条读阶段而不是
// 集数、没有百分比数字、没有暂停按钮）。每条锁下面都注明它锁的是哪条裁决，以及把它删掉之后
// 哪种"合理的改进"会静默溜进来。
//
// jsdom 的两个已知限制及本文件的应对（记下来，免得下次有人以为测试覆盖了它们）：
//  1) 不做布局：aspect-ratio / 渐变 / 动画的**视觉结果**这里查不到。所以海报比例锁断言的是
//     "承载 aspect-ratio 的那个类在场"+ "styles.css 里该类的 aspect-ratio 确实是 2/3"（后者
//     直接读 CSS 源文件——这样把 CSS 改成 16/9 也会红，而不是只有改 tsx 才红）。
//  2) 不加载外部 CSS：getComputedStyle 拿不到 styles.css 的规则，故上面那条走读文件而非算样式。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider, type Lang } from '../i18n/useT.js'
import type { TraceEvent, WorkflowRunningWorkerDTO } from '../api/types.js'
import { ActivityHero } from './ActivityHero.js'
import { STAGE_START, stageFromTrail } from './stage.js'

const T0 = 1_700_000_000_000

function trail(tools: string[]): TraceEvent[] {
  return tools.map((tool, i) => ({
    runKey: 'job-1',
    seq: i,
    tool,
    argsSummary: `args${i}`,
    resultSummary: `result${i}`,
    tookMs: 120 + i,
    at: T0 + i * 1000,
  }))
}

/** 一个跑中的剧集 worker。默认是最常见的形状：find_subtitle + 指定季 + 有图 + 已跑几步。 */
function running(over: Partial<WorkflowRunningWorkerDTO> = {}): WorkflowRunningWorkerDTO {
  return {
    jobId: 41,
    seriesId: 'tmdb:1396',
    movieId: null,
    taskType: 'find_subtitle',
    seasons: [12],
    seriesName: '绝命毒师',
    movieName: null,
    posterPath: '/poster.jpg',
    backdropPath: '/backdrop.jpg',
    startedAtLease: T0,
    trail: trail(['search_source', 'list_candidates']),
    ...over,
  }
}

function renderHero(
  over: Partial<WorkflowRunningWorkerDTO> = {},
  opts: { missingCount?: number | null; now?: number; lang?: Lang } = {},
) {
  const lang: Lang = opts.lang ?? 'zh'
  return render(
    <I18nProvider initialLang={lang}>
      <ActivityHero
        running={running(over)}
        missingCount={opts.missingCount}
        now={opts.now ?? T0 + 134_000}
      />
    </I18nProvider>,
  )
}

// CSS 断言的数据来源（2026-07-31 修正）：
//
// 海报 2:3、不定态动画、脉动点颜色这三条裁决的**真身在 CSS 里**，只断言类名在场不够——
// 把 CSS 改成 16/9 也不会红，那样的测试是假保护。
//
// 但取 CSS 文本有两个坑，都踩过：
//  - `import CSS from '../styles.css?raw'`：**vitest 里恒返回空字符串**（它对 CSS 走
//    css:false 的处理链，?raw 拿不到内容）。实测 CSS.length === 0，于是三条断言全部
//    变成永假——比没有测试更糟，它们看起来在保护却什么都不保护。
//  - `node:fs`：web 的 tsconfig 的 `types` 是显式白名单（只有 vitest/globals 与
//    jest-dom），引 node 模块会让 tsc 报错。
//
// 走 vitest.config.ts 的 `define` 在编译期把文件内容替换进来——那是构建期读盘，
// 不需要运行时模块，也不碰 tsconfig 的类型白名单。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明——jsdom 不加载外部 CSS，而海报比例这条裁决的真身
 *  就写在 CSS 里，必须直接读源文件才锁得住。 */
/** 从 styles.css 里读某个选择器块的某条声明——jsdom 不加载外部 CSS，而海报比例这条裁决的真身
 *  就写在 CSS 里，必须直接读源文件才锁得住。
 *
 *  先剥注释（2026-07-31 补）：原版直接扫原文，于是**声明前面隔着一条注释就读不到**——
 *  `background-position: …;` + 注释 + `filter: …` 这种（styles.css 里到处都是这个写法）会让
 *  `(?:^|;)\s*filter` 匹配不上，返回 null 被误读成"这条声明不存在"。剥注释同时也堵掉反向的
 *  坑：注释里写一句 `aspect-ratio: 16/9` 不该被当成真声明。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  // `(?:^|;)`：只认声明起始位置的属性名，避免 background 撞上 background-position 之类的前缀同名。
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

afterEach(cleanup)

describe('ActivityHero：基本渲染（剧集路径）', () => {
  it('渲染剧名', () => {
    renderHero()
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
  })

  it('剧名为 null 时降级显示 seriesId，不渲染空标题（DTO 注释的诚实兜底口径）', () => {
    renderHero({ seriesName: null })
    expect(screen.getByText('tmdb:1396')).toBeInTheDocument()
  })

  it('海报是 2:3 竖版（用户裁决 L5，明确纠正过 16:9）', () => {
    const { container } = renderHero()
    // 两头都锁：承载比例的类在 DOM 里在场，且 CSS 里那条 aspect-ratio 真的是 2/3。
    // 只锁前者的话，把 CSS 改成 16/9 测试会全绿——那正是这条裁决最可能被改坏的方式。
    expect(container.querySelector('.act-hero-poster')).toBeTruthy()
    const ratio = cssDecl('.act-hero-poster', 'aspect-ratio')
    expect(ratio).not.toBeNull()
    // 归一化空格后必须是 2/3。顺手把常见的横版比值列成显式否定，让失败信息说得清是哪种改动。
    const normalized = ratio!.replace(/\s+/g, '')
    expect(normalized).toBe('2/3')
    expect(normalized).not.toBe('16/9')
  })

  it('海报走 PosterThumb（有 posterPath → img 在场）', () => {
    const { container } = renderHero()
    const img = container.querySelector<HTMLImageElement>('.act-hero-poster img')
    expect(img).toBeTruthy()
    expect(img!.src).toContain('/poster.jpg')
  })

  it('传送带在场（role="log"），事件读成人话', () => {
    renderHero()
    expect(screen.getByRole('log')).toBeInTheDocument()
    expect(screen.getByText('正在核对候选')).toBeInTheDocument()
  })
})

describe('ActivityHero：背景大图（用户裁决 L4「必须有图」）', () => {
  it('backdropPath 有值 → 出血背景层在场，背景图 URL 走 backdropUrl（w1280）', () => {
    const { container } = renderHero()
    const bd = container.querySelector<HTMLElement>('.act-hero-backdrop')
    expect(bd).toBeTruthy()
    expect(bd!.style.backgroundImage).toContain('/backdrop.jpg')
    // w1280 是 backdropUrl 的既有档位——hero 用大图，不是缩略。
    expect(bd!.style.backgroundImage).toContain('w1280')
  })

  it('backdropPath 为 null → 不走出血层（改走模糊海报，见下一组），hero 本体完整', () => {
    const { container } = renderHero({ backdropPath: null })
    expect(container.querySelector('.act-hero-backdrop')).toBeNull()
    // 不留灰空图，且 hero 本体完整。
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByRole('log')).toBeInTheDocument()
    expect(screen.getByTestId('activity-hero-bar')).toBeInTheDocument()
  })

  it('poster 与 backdrop 同时为 null → 仍不崩（PosterThumb 走首字母占位）', () => {
    expect(() => renderHero({ posterPath: null, backdropPath: null })).not.toThrow()
    expect(screen.getByTestId('activity-hero')).toBeInTheDocument()
  })
})

// ── 任务 5：电影 hero 的降级路径（spec §8.3 缺口②）─────────────────────────────
//
// 真实约束：`movies` 表没有 backdrop_path 列（src/v2/db.ts:49/221），所以电影条目的
// backdropPath **恒为 null**。裁决是走"海报自身的模糊放大版当背景"。
//
// 这一组用例锁的核心是**判据本身**：走模糊分支的条件是 `backdropPath === null`，而不是
// "这是不是一部电影"。所以下面既有"电影 → 模糊"，也有反向的两条：
//   - 电影**有了** backdrop（将来补了列）→ 必须走正常出血，不是模糊；
//   - 剧集**没有** backdrop（TMDB 查无）→ 也走模糊，不是留一块死黑。
// 把判据改成看 movieName 的话，后两条会红——那正是这组用例存在的理由。
describe('ActivityHero：电影降级路径（模糊海报当背景，spec §8.3）', () => {
  /** 一部电影：movieId/movieName 在场，seriesId/seriesName 为 null，backdropPath 恒 null。 */
  const movie: Partial<WorkflowRunningWorkerDTO> = {
    seriesId: null,
    seriesName: null,
    movieId: 'tmdb:27205',
    movieName: '盗梦空间',
    posterPath: '/inception.jpg',
    backdropPath: null,
    seasons: null,
  }

  it('backdropPath 为 null → 走模糊海报分支（背景图是海报本身，不是 backdrop）', () => {
    const { container } = renderHero(movie)
    const blur = container.querySelector<HTMLElement>('.act-hero-blur-poster')
    expect(blur).toBeTruthy()
    expect(blur!.style.backgroundImage).toContain('/inception.jpg')
    // 走 posterUrl（w400）而不是 backdropUrl（w1280）——模糊背景不需要大图，且 movie 压根
    // 没有 backdrop 可取。
    expect(blur!.style.backgroundImage).toContain('w400')
    // 正常出血层必须**不在场**：两条路径互斥，同时渲染会叠成一团糊。
    expect(container.querySelector('.act-hero-backdrop')).toBeNull()
    expect(container.querySelector<HTMLElement>('.act-hero')!.dataset.art).toBe('blur-poster')
  })

  it('CSS 里模糊分支确有 blur 滤镜与放大（这条裁决的真身在 CSS，只锁类名是假保护）', () => {
    const filter = cssDecl('.act-hero-blur-poster', 'filter')
    expect(filter).not.toBeNull()
    expect(filter!).toContain('blur(40px)')
    expect(filter!).toContain('saturate(1.4)')
    expect(cssDecl('.act-hero-blur-poster', 'transform')).toBe('scale(1.2)')
  })

  it('电影海报仍是 2:3 竖版（L5 不因分支而变），只是更大（160px）', () => {
    const { container } = renderHero(movie)
    expect(container.querySelector('.act-hero-poster')).toBeTruthy()
    // aspect-ratio 由 .act-hero-poster 统一给，模糊分支不覆盖它——所以这里断言的是同一条规则。
    expect(cssDecl('.act-hero-poster', 'aspect-ratio')!.replace(/\s+/g, '')).toBe('2/3')
    // 模糊分支的宽度覆盖：背景不再承担叙事，主视觉重量交给海报本体。
    expect(cssDecl(".act-hero[data-art='blur-poster'] .act-hero-poster", 'width')).toBe('160px')
    // 反向锁：这条覆盖规则里**不许**出现 aspect-ratio——写了就意味着有第二个比例来源，
    // 它随时可能被改成 16/9 而上面那条 2:3 断言照绿。
    expect(cssDecl(".act-hero[data-art='blur-poster'] .act-hero-poster", 'aspect-ratio')).toBeNull()
  })

  it('电影副标题说「这部电影」，不说季（电影没有季，说「有缺口的每一季」是假话）', () => {
    const { container } = renderHero(movie)
    expect(screen.getByText('正在找这部电影的字幕')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/每一季|第 .* 季|season/i)
    cleanup()
    renderHero(movie, { lang: 'en' })
    expect(screen.getByText('Looking for subtitles for this movie')).toBeInTheDocument()
  })

  it('电影标题走 movieName（不是恒 null 的 seriesName），缺名时降级 movieId', () => {
    renderHero(movie)
    expect(screen.getByText('盗梦空间')).toBeInTheDocument()
    cleanup()
    renderHero({ ...movie, movieName: null })
    expect(screen.getByText('tmdb:27205')).toBeInTheDocument()
  })

  // ── 判据反向锁：分支条件是 backdropPath，不是「是不是电影」──────────────────
  it('电影**有** backdropPath（将来补了列）→ 自动切回正常出血，不走模糊', () => {
    // 这条是判据选择的全部理由：数据一旦补上，代码不需要有人回来改。
    const { container } = renderHero({ ...movie, backdropPath: '/inception-bd.jpg' })
    const bd = container.querySelector<HTMLElement>('.act-hero-backdrop')
    expect(bd).toBeTruthy()
    expect(bd!.style.backgroundImage).toContain('/inception-bd.jpg')
    expect(bd!.style.backgroundImage).toContain('w1280')
    expect(container.querySelector('.act-hero-blur-poster')).toBeNull()
    expect(container.querySelector<HTMLElement>('.act-hero')!.dataset.art).toBe('backdrop')
    // 文案仍走电影分族——图片判据与文案判据是**两件事**，切了图不该切文案。
    expect(screen.getByText('正在找这部电影的字幕')).toBeInTheDocument()
  })

  it('剧集**没有** backdropPath（TMDB 查无）→ 同样走模糊海报，不留一块死黑', () => {
    // 缺的是图片这个资源，不是"电影"这个种类——所以剧集查无 backdrop 时也该拿海报兜底。
    const { container } = renderHero({ backdropPath: null, posterPath: '/poster.jpg' })
    const blur = container.querySelector<HTMLElement>('.act-hero-blur-poster')
    expect(blur).toBeTruthy()
    expect(blur!.style.backgroundImage).toContain('/poster.jpg')
    // 但文案仍是剧集分族（有季）——再次证明两个判据独立。
    expect(screen.getByText('正在找第 12 季的字幕')).toBeInTheDocument()
  })

  it('poster 也为 null（图都没有）→ 不崩，不渲染任何背景层，海报框走首字母占位', () => {
    const { container } = renderHero({ ...movie, posterPath: null })
    expect(container.querySelector('.act-hero-backdrop')).toBeNull()
    // 模糊一个不存在的 URL 没有意义——background-image:url(null) 会打一个 404 请求，
    // 且模糊后是一块纯色，不如干净地不渲染。
    expect(container.querySelector('.act-hero-blur-poster')).toBeNull()
    expect(container.querySelector<HTMLElement>('.act-hero')!.dataset.art).toBe('none')
    // hero 本体完整：标题/传送带/进度条都在，海报框由 PosterThumb 走首字母占位。
    expect(screen.getByText('盗梦空间')).toBeInTheDocument()
    expect(screen.getByRole('log')).toBeInTheDocument()
    expect(screen.getByTestId('activity-hero-bar')).toBeInTheDocument()
    expect(container.querySelector('.act-hero-poster .library-poster-fallback')).toBeTruthy()
  })

  it('电影路径同样不暴露机械、不显示工程值（铁律②③在两条美术路径上都成立）', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderHero(movie, { lang })
      const text = (container.textContent ?? '').toLowerCase()
      for (const word of ['agent', 'orchestrator', 'worker', 'pass', 'asset', 'ledger']) {
        expect(text).not.toContain(word)
      }
      expect(text).not.toContain('%')
      cleanup()
    }
  })
})

describe('ActivityHero：进度条 = agent 工作阶段（用户裁决 L10）', () => {
  it('条宽来自 stageFromTrail(trail)，不是集数', () => {
    const tools = ['search_source', 'list_candidates', 'download_candidate']
    const { rerender } = renderHero({ trail: trail(tools) })
    const expected = stageFromTrail(trail(tools))
    expect(screen.getByTestId('activity-hero-bar-fill').style.width).toBe(`${expected}%`)
    // 换一条更深的 trail → 条跟着走到更靠后的阶段（证明它真的读 trail，不是个常量）。
    const deeper = ['search_source', 'install_subtitle']
    rerender(
      <I18nProvider initialLang="zh">
        <ActivityHero running={running({ trail: trail(deeper) })} now={T0 + 1000} />
      </I18nProvider>,
    )
    const deeperWidth = stageFromTrail(trail(deeper))
    expect(screen.getByTestId('activity-hero-bar-fill').style.width).toBe(`${deeperWidth}%`)
    expect(deeperWidth).toBeGreaterThan(expected)
  })

  it('空 trail（run 刚起手）→ 条在 STAGE_START，不是 0（0 读起来像卡住了）', () => {
    renderHero({ trail: [] })
    expect(screen.getByTestId('activity-hero-bar-fill').style.width).toBe(`${STAGE_START}%`)
  })

  it('条宽与集数/missingCount 无关（L10 的核心：集数不再是分母）', () => {
    // ⚠️ trail 必须含 install_subtitle：这一条是变异验证逼出来的。第一版用的是
    // ['search_source','list_candidates'] + missingCount 1 vs 97，结果"按集数算"这个变异
    // **活着通过了全部 43 条**——因为已装集数为 0 时 0/1 与 0/97 都是 0%，两边照样相等。
    // 有一集装好之后，按集数算会给出 1/1=100% 与 1/97=1%（天差地别），阶段口径则恒等。
    const tools = ['search_source', 'download_candidate', 'install_subtitle']
    const stageWidth = stageFromTrail(trail(tools))
    const { container: a } = renderHero({ trail: trail(tools) }, { missingCount: 1 })
    const wa = a.querySelector<HTMLElement>('.act-hero-bar-fill')!.style.width
    cleanup()
    const { container: b } = renderHero({ trail: trail(tools) }, { missingCount: 97 })
    const wb = b.querySelector<HTMLElement>('.act-hero-bar-fill')!.style.width
    cleanup()
    // 分母换掉 97 倍，条宽必须一模一样。
    expect(wa).toBe(wb)
    // 且两边都恰好等于阶段值——不是"碰巧相等于某个按集数算出来的数"。
    expect(wa).toBe(`${stageWidth}%`)
    // missingCount 完全缺席时同样是这个值：条压根不看这个入参。
    const { container: c } = renderHero({ trail: trail(tools) }, { missingCount: undefined })
    expect(c.querySelector<HTMLElement>('.act-hero-bar-fill')!.style.width).toBe(`${stageWidth}%`)
  })

  it('装好一集不等于条走满（install_subtitle 是阶段 88，不是 100%）', () => {
    // 另一面同一条裁决：按集数算的实现在"缺 1 集、装好 1 集"时会给 100%，而阶段口径下只有
    // finalize 才是 100。这条锁住"条不是完成度"。
    renderHero({ trail: trail(['install_subtitle']) }, { missingCount: 1 })
    expect(screen.getByTestId('activity-hero-bar-fill').style.width).not.toBe('100%')
  })

  it('DOM 里不出现百分比数字（铁律② + L10 回归锁：UI 层面消掉百分比这件事）', () => {
    const { container } = renderHero({ trail: trail(['search_source', 'install_subtitle']) }, { missingCount: 9 })
    const text = container.textContent ?? ''
    // 没有 % 号，也没有把条宽那个数字打到界面上。
    expect(text).not.toContain('%')
    const width = stageFromTrail(trail(['search_source', 'install_subtitle']))
    expect(text).not.toContain(String(width))
    // 也不许通过无障碍属性从后门念出百分比（aria-valuenow / progressbar 的契约要求可读 value）。
    expect(container.querySelector('[aria-valuenow]')).toBeNull()
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })

  it('CSS 里没有 content:attr(...) 计数器（后门把百分比加回界面的另一条路）', () => {
    const block = /\.act-hero-bar[\s\S]{0,600}?\}/.exec(CSS)?.[0] ?? ''
    expect(block).not.toMatch(/content\s*:/)
  })
})

describe('ActivityHero：stageMode 分族（§4.2.2）', () => {
  it("taskType='orchestrate'（hidden）→ 整个 hero 不渲染", () => {
    const { container } = renderHero({ taskType: 'orchestrate' })
    expect(container.querySelector('.act-hero')).toBeNull()
    expect(screen.queryByTestId('activity-hero')).toBeNull()
    // 连剧名和传送带都不在——不是"渲染了但藏起来"，是根本不渲染。
    expect(screen.queryByText('绝命毒师')).toBeNull()
    expect(screen.queryByRole('log')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it("staged（find_subtitle）→ data-mode='staged' 且有具体宽度", () => {
    renderHero({ taskType: 'find_subtitle' })
    expect(screen.getByTestId('activity-hero-bar').dataset.mode).toBe('staged')
    expect(screen.getByTestId('activity-hero-bar-fill').style.width).not.toBe('')
  })

  it.each(['realign', 'translate'])(
    "indeterminate（%s）→ 不是具体宽度的条（不谎报走到哪了）",
    (taskType) => {
      renderHero({ taskType })
      const bar = screen.getByTestId('activity-hero-bar')
      const fill = screen.getByTestId('activity-hero-bar-fill')
      expect(bar.dataset.mode).toBe('indeterminate')
      // 关键断言：inline width **不在场**。宽度由 CSS 动画驱动（.act-hero-bar[data-mode=
      // 'indeterminate'] 那条规则），给了 style.width 就等于假装知道进度。
      expect(fill.style.width).toBe('')
      expect(fill.getAttribute('style')).toBeNull()
    },
  )

  it('未知 taskType / null → 保守落到 indeterminate（新 taskType 必然先于 UI 到达）', () => {
    for (const taskType of [null, 'brand_new_backend_task']) {
      renderHero({ taskType })
      expect(screen.getByTestId('activity-hero-bar').dataset.mode).toBe('indeterminate')
      expect(screen.getByTestId('activity-hero-bar-fill').style.width).toBe('')
      cleanup()
    }
  })

  it('CSS 里 indeterminate 族确有不定态动画（不是静态细条）', () => {
    expect(CSS).toMatch(/\.act-hero-bar\[data-mode='indeterminate'\][\s\S]{0,200}animation/)
    expect(CSS).toMatch(/@keyframes act-hero-sweep/)
  })
})

describe('ActivityHero：副标题的季语义', () => {
  it('seasons=[12] → 说第 12 季（中文）', () => {
    renderHero({ seasons: [12] })
    expect(screen.getByText('正在找第 12 季的字幕')).toBeInTheDocument()
  })

  it('seasons=[12] → season 12（英文）', () => {
    renderHero({ seasons: [12] }, { lang: 'en' })
    expect(screen.getByText('Looking for subtitles for season 12')).toBeInTheDocument()
  })

  it('seasons=null → 说「有缺口的每一季」，绝不说「全部季」（语义见 orchestratorAgent.tools.ts:247）', () => {
    const { container } = renderHero({ seasons: null })
    expect(screen.getByText('正在找有缺口的每一季的字幕')).toBeInTheDocument()
    // 反向锁：null 不是"字面全季"。写成"全部季/所有季"会让用户以为在重扫已装好的季。
    expect(container.textContent).not.toMatch(/全部季|所有季|全季/)
  })

  it('seasons=null（英文）→ every season with gaps，不出现 all seasons', () => {
    const { container } = renderHero({ seasons: null }, { lang: 'en' })
    expect(screen.getByText('Looking for subtitles for every season with gaps')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/all seasons/i)
  })

  it('seasons=[] 按 null 处理（编排层省略该字段时 JSON 上可能落成空数组）', () => {
    renderHero({ seasons: [] })
    expect(screen.getByText('正在找有缺口的每一季的字幕')).toBeInTheDocument()
  })

  it('多季 → 逐季列出（中英）', () => {
    renderHero({ seasons: [1, 2, 3] })
    expect(screen.getByText('正在找第 1、2、3 季的字幕')).toBeInTheDocument()
    cleanup()
    renderHero({ seasons: [1, 2, 3] }, { lang: 'en' })
    expect(screen.getByText('Looking for subtitles for seasons 1, 2, 3')).toBeInTheDocument()
  })

  it('realign / translate 的副标题说的是各自那件事，不谎称在「找」字幕', () => {
    renderHero({ taskType: 'realign', seasons: [4] })
    expect(screen.getByText('正在校正第 4 季的字幕时间轴')).toBeInTheDocument()
    cleanup()
    renderHero({ taskType: 'translate', seasons: [4] })
    expect(screen.getByText('正在翻译第 4 季的字幕')).toBeInTheDocument()
  })

  it('副标题不写目标语言（target_languages 不在 DTO 里，硬编码"中文"会变假话）', () => {
    // DESIGN.md §8：前端只呈现事实。用户把 target_languages 改成 en 之后，写死的"中文字幕"
    // 就是错的——所以副标题里刻意没有语言定语。
    const { container } = renderHero({ seasons: [12] })
    expect(container.textContent).not.toContain('中文字幕')
  })
})

describe('ActivityHero：已进行时长（§4.4 不预测剩余时间）', () => {
  it('渲染「已进行 2 分 14 秒」', () => {
    renderHero({}, { now: T0 + 134_000 })
    expect(screen.getByText('已进行 2 分 14 秒')).toBeInTheDocument()
  })

  it('英文渲染 Running for 2m 14s', () => {
    renderHero({}, { now: T0 + 134_000, lang: 'en' })
    expect(screen.getByText('Running for 2m 14s')).toBeInTheDocument()
  })

  it('不足 1 分钟只报秒', () => {
    renderHero({}, { now: T0 + 41_000 })
    expect(screen.getByText('已进行 41 秒')).toBeInTheDocument()
  })

  it('now 早于 startedAtLease（时钟漂移）→ clamp 到 0，不显示负数', () => {
    const { container } = renderHero({}, { now: T0 - 5_000 })
    expect(screen.getByText('已进行 0 秒')).toBeInTheDocument()
    expect(container.textContent).not.toContain('-')
  })

  it('不出现任何 ETA / 剩余时间措辞（会跳的假 ETA 比不给更伤信任）', () => {
    const { container } = renderHero({}, { now: T0 + 134_000, missingCount: 9 })
    const text = container.textContent ?? ''
    for (const bad of ['剩余', '预计', '还需', '大约', 'ETA', 'remaining', 'estimated', 'left']) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase())
    }
  })
})

describe('ActivityHero：右下角集数（背景信息，不是分母）', () => {
  it('missingCount=9 → 渲染「9 集缺字幕」', () => {
    renderHero({}, { missingCount: 9 })
    expect(screen.getByText('9 集缺字幕')).toBeInTheDocument()
  })

  it('英文渲染 9 episodes missing subtitles，单数不带 s', () => {
    renderHero({}, { missingCount: 9, lang: 'en' })
    expect(screen.getByText('9 episodes missing subtitles')).toBeInTheDocument()
    cleanup()
    renderHero({}, { missingCount: 1, lang: 'en' })
    expect(screen.getByText('1 episode missing subtitles')).toBeInTheDocument()
  })

  it('missingCount 缺席 → 不渲染那行（不编一个 0 出来）', () => {
    const { container } = renderHero({}, { missingCount: undefined })
    expect(screen.queryByTestId('activity-hero-missing')).toBeNull()
    expect(container.textContent).not.toContain('缺字幕')
  })

  it('missingCount=null（显式无值）→ 同样不渲染', () => {
    renderHero({}, { missingCount: null })
    expect(screen.queryByTestId('activity-hero-missing')).toBeNull()
  })

  it('missingCount=0 → 照实渲染 0（「确实 0 集缺」与「未提供」是两件事）', () => {
    renderHero({}, { missingCount: 0 })
    expect(screen.getByText('0 集缺字幕')).toBeInTheDocument()
  })
})

describe('ActivityHero：裁决回归锁', () => {
  it('无暂停按钮（用户裁决 L11：语义想不清就别画）', () => {
    const { container } = renderHero({}, { missingCount: 9 })
    // 三重锁：没有任何 button/可点控件、文案里没有 pause/暂停、也没有 pause 类名或 aria-label。
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
    expect(container.innerHTML.toLowerCase()).not.toContain('pause')
    expect(container.textContent).not.toContain('暂停')
  })

  it('不暴露机械（铁律③）：textContent 不含 agent/orchestrator/worker/pass 等机器词', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderHero({}, { missingCount: 9, lang })
      const text = (container.textContent ?? '').toLowerCase()
      for (const word of ['agent', 'orchestrator', 'worker', 'pass', 'asset', 'ledger']) {
        expect(text).not.toContain(word)
      }
      cleanup()
    }
  })

  it('不显示工程值：jobId / seriesId（有剧名时）/ argsSummary / tookMs 都不在界面上', () => {
    const { container } = renderHero({}, { missingCount: 9 })
    const text = container.textContent ?? ''
    expect(text).not.toContain('41')          // jobId
    expect(text).not.toContain('tmdb:1396')   // seriesId（剧名在场时不该露出来）
    expect(text).not.toContain('args0')
    expect(text).not.toContain('result0')
    expect(text).not.toContain('120')         // tookMs
  })

  it('铁律①：正常运行态有脉动点，且不是黄色（黄是警示色）', () => {
    const { container } = renderHero()
    const pulse = container.querySelector<HTMLElement>('.act-hero-pulse')
    expect(pulse).toBeTruthy()
    // 卡死态转红是下一个任务——这里只留色彩钩子，组件层不写死任何颜色分支。
    expect(pulse!.dataset.tone).toBe('live')
    // 白名单而非黑名单（2026-07-31 修正）：原来这里排的是 orange|#e8a33d|red|#e11d48 几个
    // 具体色值，而黄色有无数种写法——变异验证时把它改成 #d29922（琥珀）测试照绿，
    // 那是黑名单式断言的固有缺陷。改成正面断言"必须是这一个许可色"，任何改动都会红。
    //
    // #8b7cf6 是中性的紫（"在干活"的语义），不是绿也不是红——铁律①管的是**状态色**
    // （绿=好、红=有问题），而 live 脉动不表达好坏，只表达"在动"，所以它不占那两个色位。
    const bg = cssDecl('.act-hero-pulse', 'background')
    expect(bg).toBe('#8b7cf6')
  })

  // 补一条全局黄色扫描（铁律①）：活动页命名空间内的**声明**不许出现琥珀/黄系。
  // 比逐个选择器断言更耐改——将来新增元件自动被覆盖。
  //
  // 必须先剥注释再扫（2026-07-31 踩过）：第一版直接扫原文，命中了一句中文注释
  // （"--color-text-orange，用它报'一切正常'会和真警示撞语义"）——那句话恰恰是在解释
  // 为什么**不**用橙色，把它当违规是误报。注释里提某个颜色名是正当的技术讨论。
  it('铁律①：活动页 CSS 的声明里无黄/琥珀色', () => {
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const scoped: string[] = []
    let inAct = false
    for (const line of noComments.split('\n')) {
      if (/^\.(act-|activity-|conveyor)/.test(line)) inAct = true
      else if (/^\.[a-z]/.test(line)) inAct = /^\.(act-|activity-|conveyor)/.test(line)
      if (inAct) scoped.push(line)
    }
    // 只看真正的颜色声明行，不看选择器/花括号
    const decls = scoped.filter((l) => /^\s*(background|color|border(-color)?|fill|stroke)\s*:/.test(l))
    expect(decls.length).toBeGreaterThan(0)   // 确认扫到了东西，不是空扫（否则这条永绿）
    const text = decls.join('\n')
    expect(text).not.toMatch(/#(d2|e8|f0|ff)[0-9a-f]{2}(0[0-9a-f]|1[0-9a-f]|2[0-9a-f]|3[0-9a-f])/i)
    expect(text).not.toMatch(/\b(gold|yellow|amber|orange)\b/i)
  })
})

describe('ActivityHero：双语各渲染一次（DESIGN.md §7 运行态跟随 UI 语言）', () => {
  it('中文：剧名 + 副标题 + 时长 + 集数 + 传送带人话，全中文', () => {
    renderHero({ seasons: [12] }, { missingCount: 9, now: T0 + 134_000, lang: 'zh' })
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('正在找第 12 季的字幕')).toBeInTheDocument()
    expect(screen.getByText('已进行 2 分 14 秒')).toBeInTheDocument()
    expect(screen.getByText('9 集缺字幕')).toBeInTheDocument()
    expect(screen.getByText('正在核对候选')).toBeInTheDocument()
  })

  it('英文：同一份数据全英文', () => {
    renderHero({ seasons: [12] }, { missingCount: 9, now: T0 + 134_000, lang: 'en' })
    expect(screen.getByText('Looking for subtitles for season 12')).toBeInTheDocument()
    expect(screen.getByText('Running for 2m 14s')).toBeInTheDocument()
    expect(screen.getByText('9 episodes missing subtitles')).toBeInTheDocument()
    expect(screen.getByText('Reviewing candidates')).toBeInTheDocument()
  })
})
