// web/src/media/MediaDetailPage.test.tsx：季集网格——R-F5 实线/虚线、R-F12 集号染色、
// 以及「episodeState 是唯一染色判据、dot 不参与」这条契约。
//
// ── 这个文件为什么读 CSS ────────────────────────────────────────────────────
// R-F5 的实线/虚线**真身在 CSS 里**（.media-ep-cell 的 border-style vs
// [data-ondisk='false'] 的 dashed），R-F12 的八色同理。jsdom 不算 computed style，
// 只断言 DOM 的话把虚线规则删掉照样全绿——那正是 Task ⑤「一行行尾注释就让 4 条假绿」
// 的同型（源码级断言不锁行为）。
// 取值走 vitest.config.ts:21 的 `define`（`?raw` 在 vitest 里恒空串，`node:fs` 撞
// tsconfig types 白名单）——手法与 SeriesGrid.test.tsx 一致。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { MediaDetailPage, seasonTally, isNotFoundError } from './MediaDetailPage.js'
import { extraUnsubtitledCount } from './EpisodeCell.js'
import { en } from '../i18n/en.js'
import type { Async } from '../api/hooks.js'
import type {
  MediaLibraryDetailDTO, MediaLibraryEpisodeDTO, EpisodeState, MediaSubtitleDot,
} from '../api/types.js'

declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明（先剥注释）。同 SeriesGrid.test.tsx 的既有 helper。 */
function cssDecl(selector: string, prop: string): string | null {
  return cssDeclRe(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), prop)
}

/** 同上，但 selector 已经是**正则片段**（属性选择器要自己转义 `[` `]` `.`）。
 *  ⚠️ 分成两个函数而不是让调用方预转义再走 cssDecl：那样会被 cssDecl 再转义一遍
 *  （`\[` → `\\\[`），结果恒不命中 → `toBeTruthy()` 恒假 → 看起来是"CSS 规则没写"，
 *  实际是 helper 坏了。踩过一次，记在这里。 */
function cssDeclRe(selectorRe: string, prop: string): string | null {
  const block = new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

/** 媒体库那一段 CSS 的**代码部分**。
 *  ⚠️ 顺序是「先剥全文注释，再从代码里切段」，不能反过来：本段的头注释里就写着
 *  "拒绝投影——没有任何 box-shadow 声明"，而从段中间 slice 会切出一个**没有 `/*` 开头
 *  的半截注释**，剥注释的正则匹配不到它，扫描 box-shadow 就命中了自己的注释文字（踩过）。
 *  切点用 `.media-grid {` —— 那是本段第一条真规则。
 *
 *  ⚠️⚠️ **必须有下界**（2026-08-12 / Task ⑩ 实测踩到）：原本是 `slice(i)` 一路切到
 *  文件尾。styles.css 是**追加式**的——媒体库段后面每加一段新页面样式，都会被这个
 *  切片**静默吞进"媒体库段"**。Task ⑩ 在文件尾加了通知页样式（里面有一个合法的
 *  `border-radius: 50%` 小圆点），于是"媒体库格阵不画圆点"那条 R-F12 守卫**报了假红**：
 *  它抓到的圆点根本不在媒体库段里。
 *  假红比假绿容易发现，但成因同一个：**切片没有下界 = 守卫的作用域会随文件增长而漂移**。
 *  下界取"下一个页面段的段首标记"。找不到下一段（媒体库是最后一段）时才切到尾。 */
const MEDIA_CSS = (() => {
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const i = bare.indexOf('.media-grid {')
  if (i < 0) return ''
  // 下一个页面段的段首。新增页面段时把它的第一条选择器加进这个数组
  // （漏加的症状就是本段守卫开始扫描那一段——多半表现为假红，见上）。
  const NEXT_SECTION_MARKERS = ['.notif-day {']
  const rest = bare.slice(i)
  const ends = NEXT_SECTION_MARKERS.map((m) => rest.indexOf(m)).filter((n) => n >= 0)
  return ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest
})()

afterEach(cleanup)

function ep(overrides: Partial<MediaLibraryEpisodeDTO> & { episode: number }): MediaLibraryEpisodeDTO {
  return {
    title: null, onDisk: true, dot: 'none', episodeState: 'pending',
    fileCount: 1, subtitledFileCount: 0,
    ...overrides,
  }
}

function detail(overrides: Partial<MediaLibraryDetailDTO> = {}): MediaLibraryDetailDTO {
  return {
    work: { workId: 'tmdb:1396', title: 'Breaking Bad', chineseTitle: null, year: 2008,
            posterPath: null, mediaType: 'tv' },
    seasons: [], movie: null, unplacedFileCount: 0,
    ...overrides,
  }
}

function asyncOf(data: MediaLibraryDetailDTO | null, opts: Partial<Async<MediaLibraryDetailDTO>> = {}): Async<MediaLibraryDetailDTO> {
  return { data, loading: false, error: null, reload: () => {}, ...opts }
}

function renderDetail(d: Async<MediaLibraryDetailDTO>) {
  return render(<I18nProvider initialLang="en"><MediaDetailPage detail={d} /></I18nProvider>)
}

/** 拿到某一集的格子（按 aria-label 前缀 EnnN）。 */
function cellOf(episode: number): HTMLElement {
  const num = `E${String(episode).padStart(2, '0')}`
  const found = screen.getAllByRole('listitem').find((el) => (el.getAttribute('aria-label') ?? '').startsWith(num))
  if (!found) throw new Error(`no cell for ${num}`)
  return found
}

// ═══ R-F5：实线 = 实有集 / 虚线 = 应有集 ═══════════════════════════════════════
describe('R-F5 实线 vs 虚线（两个正交维度之一：边框）', () => {
  const seasons = [{
    season: 1,
    episodes: [
      ep({ episode: 1, onDisk: true, episodeState: 'covered' }),
      ep({ episode: 2, onDisk: false, episodeState: 'absent', fileCount: 0 }),
    ],
  }]

  it('onDisk=true 的格子 data-ondisk="true"，onDisk=false 的是 "false"', () => {
    renderDetail(asyncOf(detail({ seasons })))
    expect(cellOf(1).getAttribute('data-ondisk')).toBe('true')
    expect(cellOf(2).getAttribute('data-ondisk')).toBe('false')
  })

  // 🔴 这一条是 R-F5 的**真判据**：属性对了但 CSS 没有虚线规则，屏幕上两种格子长得一样。
  it('CSS：默认格是实线（solid 1px border），[data-ondisk="false"] 覆盖成 dashed', () => {
    // 基线：.media-ep-cell 的 border 简写里必须有 solid（不是 none、不是 dashed）
    const base = cssDecl('.media-ep-cell', 'border')
    expect(base, '.media-ep-cell 没有 border 声明——实线格没边框').toBeTruthy()
    expect(base).toMatch(/\bsolid\b/)
    // 虚线：属性选择器块里必须把 border-style 改成 dashed
    const dashed = cssDeclRe("\\.media-ep-cell\\[data-ondisk='false'\\]", 'border-style')
    expect(dashed, "[data-ondisk='false'] 没有 border-style —— 虚线格会画成实线").toBe('dashed')
  })

  it('虚线格的 aria-label 说的是"磁盘上没有"，不是某种字幕状态', () => {
    renderDetail(asyncOf(detail({ seasons })))
    expect(cellOf(2).getAttribute('aria-label')).toBe(`E02 ${en.media_state_absent}`)
  })

  it('季头的两个数字：磁盘数 = 实线格数；缺集数 = 虚线格数（不是 episodes.length）', () => {
    // 应有 2 集（E01/E02）+ 磁盘多出一集 E99（TMDB 没有）→ 并集 3 格，其中 2 实 1 虚。
    // 若有人把"应有"写成 episodes.length，这里会报 3，而真相是 TMDB 只说了 2 集。
    const t = seasonTally({
      season: 1,
      episodes: [ep({ episode: 1 }), ep({ episode: 2, onDisk: false }), ep({ episode: 99 })],
    })
    expect(t).toEqual({ onDisk: 2, missing: 1 })
  })

  it('缺集数为 0 时季头不显示"缺 0"（噪音，且会让全齐的季看起来有问题）', () => {
    renderDetail(asyncOf(detail({ seasons: [{ season: 1, episodes: [ep({ episode: 1 })] }] })))
    expect(screen.queryByText(new RegExp(en.media_season_missing))).toBeNull()
  })
})

// ═══ R-F12：集号染色（八态） ═══════════════════════════════════════════════════
describe('R-F12 集号染色：八个态各自的符号与颜色', () => {
  const ALL: readonly EpisodeState[] = [
    'covered', 'translating', 'unsolvable', 'origin-skip',
    'embedded', 'pending', 'unjudged', 'absent',
  ]

  function renderAllStates() {
    renderDetail(asyncOf(detail({
      seasons: [{
        season: 1,
        episodes: ALL.map((s, i) =>
          ep({ episode: i + 1, episodeState: s, onDisk: s !== 'absent', fileCount: s === 'absent' ? 0 : 1 })),
      }],
    })))
  }

  it('每一格的集号带 data-state = 后端给的 episodeState（CSS 上色的唯一钩子）', () => {
    renderAllStates()
    ALL.forEach((state, i) => {
      const num = cellOf(i + 1).querySelector('.media-ep-num')!
      expect(num.getAttribute('data-state'), `E0${i + 1} 的 data-state`).toBe(state)
    })
  })

  it('七个染色态各画了一个符号；**absent 一个符号都不画**（虚线格不染色）', () => {
    renderAllStates()
    ALL.forEach((state, i) => {
      const svgs = cellOf(i + 1).querySelectorAll('svg')
      if (state === 'absent') expect(svgs.length, 'absent 画了符号——虚线格不该染色').toBe(0)
      else expect(svgs.length, `${state} 没画符号`).toBe(1)
    })
  })

  // 🔴 颜色那一半的真判据。八条 data-state 规则少一条 → 那个态静默继承默认灰，
  // 屏幕上两个语义相反的态（比如 covered 与 pending）会同色。
  it('CSS：八个 data-state 各有一条颜色规则，且**七个染色态两两不同色**', () => {
    const colors = new Map<EpisodeState, string>()
    for (const s of ALL) {
      const c = cssDeclRe(`\\.media-ep-num\\[data-state='${s}'\\]`, 'color')
      expect(c, `data-state='${s}' 没有颜色规则——会静默继承默认灰`).toBeTruthy()
      // 只许用既有 token，不许在这一段里自开色板（DESIGN.md）
      expect(c, `${s} 用了硬编码色值而不是 token`).toMatch(/^var\(--color-[a-z-]+\)$/)
      colors.set(s, c!)
    }
    const painted = ALL.filter((s) => s !== 'absent' && s !== 'unjudged')
      .map((s) => colors.get(s)!)
    // unjudged 与 absent 同为最弱灰（都是"没有信息"），刻意允许同色——它们的区分靠形状
    // （unjudged 有 ? 符号、absent 什么都不画）与边框（实 vs 虚）。其余六个必须两两不同。
    expect(new Set(painted).size).toBe(painted.length)
    expect(colors.get('covered')).toBe('var(--color-fn-green)')
    expect(colors.get('embedded')).toBe('var(--color-fn-blue)')
    // ⊘ 刻意**不用红**：unsolvable 不是永久终态（复查闸每周放回一次），红=故障是谎报。
    expect(colors.get('unsolvable')).not.toBe('var(--color-fn-red)')
  })

  it('R-F12 铁律：这一屏**不画圆点、不画左竖线**', () => {
    renderAllStates()
    // 圆点方案的形态：一个独立的小圆色块（border-radius:50%）。本段 CSS 里不许有。
    const cellBlockRe = /\.media-ep-[\s\S]*?\{[^}]*border-radius:\s*50%/
    expect(cellBlockRe.test(MEDIA_CSS), '媒体库格阵里出现了圆点样式（R-F12 已否决）').toBe(false)
    // 左竖线方案的形态：border-left 单边声明。
    expect(cssDecl('.media-ep-cell', 'border-left')).toBeNull()
    // DOM 侧：格子里只有集号 span + 可选的一个 svg，没有第三个"点"元素。
    for (let i = 1; i <= 8; i++) {
      const kids = [...cellOf(i).children]
      expect(kids.length).toBeLessThanOrEqual(2)
      expect(kids[0]!.className).toContain('media-ep-num')
    }
  })

  it('R-F11：这一屏拒绝投影（整段 CSS 无 box-shadow）', () => {
    expect(MEDIA_CSS.length).toBeGreaterThan(0)
    expect(/box-shadow|drop-shadow/.test(MEDIA_CSS), '媒体库段出现了投影（DESIGN.md 拒绝投影）').toBe(false)
  })
})

// ═══ episodeState 与 dot 共存不互推 ══════════════════════════════════════════
describe('染色的唯一判据是 episodeState —— dot 不参与（两者共存不互推）', () => {
  // 🔴 这一族是任务书变异 (c) 的守卫：后端 DTO 若把 episodeState 换成 dot（或前端
  // 偷懒改用 dot 上色），下面的用例会红。判据是**给出互相矛盾的两个字段**：
  // dot 说 green（三态里的"有字幕"），episodeState 说 translating（八态里的"在翻译"）。
  // 用 dot 染色的实现会画 ✓，用 episodeState 的画 ⇄。
  it('dot=green 但 episodeState=translating → 画 ⇄，不是 ✓', () => {
    renderDetail(asyncOf(detail({
      seasons: [{ season: 1, episodes: [ep({ episode: 1, dot: 'green', episodeState: 'translating' })] }],
    })))
    const cell = cellOf(1)
    expect(cell.querySelector('.media-ep-num')!.getAttribute('data-state')).toBe('translating')
    expect(cell.querySelector('svg')!.getAttribute('data-state')).toBe('translating')
    expect(cell.getAttribute('aria-label')).toBe(`E01 ${en.media_state_translating}`)
  })

  it('dot=none 但 episodeState=covered → 画 ✓（不因为 dot 说"没有"就退成灰）', () => {
    renderDetail(asyncOf(detail({
      seasons: [{ season: 1, episodes: [ep({ episode: 1, dot: 'none', episodeState: 'covered' })] }],
    })))
    expect(cellOf(1).querySelector('.media-ep-num')!.getAttribute('data-state')).toBe('covered')
  })

  it('dot=blue 但 episodeState=unjudged → 画 ?（后端注释点名的已知口径差，如实呈现后者）', () => {
    // 这是后端 mediaLibraryApi.ts 注释里记的真实债务：embedded_langs 有目标语言轨但
    // skip_reason 尚未写入时，dot 给 blue 而 episodeState 给 unjudged。染色必须跟 episodeState
    // ——那是"还没判"的诚实说法，跟 dot 走会宣称一个 judge 还没做出的结论。
    renderDetail(asyncOf(detail({
      seasons: [{ season: 1, episodes: [ep({ episode: 1, dot: 'blue', episodeState: 'unjudged' })] }],
    })))
    expect(cellOf(1).querySelector('.media-ep-num')!.getAttribute('data-state')).toBe('unjudged')
  })

  it('三种 dot 值都不改变同一个 episodeState 的渲染（dot 完全不参与）', () => {
    const dots: MediaSubtitleDot[] = ['none', 'blue', 'green']
    const prints = dots.map((dot) => {
      renderDetail(asyncOf(detail({
        seasons: [{ season: 1, episodes: [ep({ episode: 1, dot, episodeState: 'pending' })] }],
      })))
      const html = cellOf(1).innerHTML
      cleanup()
      return html
    })
    expect(new Set(prints).size, 'dot 改变了渲染 —— 它不该参与染色').toBe(1)
  })
})

// ═══ R-F2：一集多份文件，另一处那份仍要单独去配 ═══════════════════════════════
describe('R-F2「另一处那份仍要单独去配」在详情页可见', () => {
  // 🔴 背景：`fileCount` / `subtitledFileCount`（types.ts:683 点名它们是 R-F2 的可见依据）
  // 此前**生产代码一次都没读过**——两个「绝命毒师」目录各有一份 E01、只配上一份时，
  // 界面显示纯 covered ✓，用户完全看不出"还有一份没配"。这一族钉住那个标记。
  const twoCopies = (over: Partial<MediaLibraryEpisodeDTO> = {}) => detail({
    seasons: [{
      season: 1,
      episodes: [ep({
        episode: 1, onDisk: true, episodeState: 'covered',
        fileCount: 2, subtitledFileCount: 1, ...over,
      })],
    }],
  })

  it('两份文件只配上一份 → 集号旁露出上标 "1"（还没配上的份数）', () => {
    renderDetail(asyncOf(twoCopies()))
    const extra = cellOf(1).querySelector('.media-ep-extra')
    expect(extra, '两份只配一份，但界面没有任何"还有一份没配"的标记（R-F2 不可见）').not.toBeNull()
    expect(extra!.textContent).toBe('1')
    expect(extra!.getAttribute('data-extra-unsubtitled')).toBe('1')
  })

  it('三份只配上一份 → 上标是 "2"（是**份数**，不是一个恒定的惊叹号）', () => {
    renderDetail(asyncOf(twoCopies({ fileCount: 3, subtitledFileCount: 1 })))
    expect(cellOf(1).querySelector('.media-ep-extra')!.textContent).toBe('2')
  })

  // 🔴 这条钉住"它不是第九个态"：这一格仍然是 covered，染色/符号一律不变。
  it('有这个标记时**主状态不变**——仍是 covered ✓，不降级、不改色、不换符号', () => {
    renderDetail(asyncOf(twoCopies()))
    const cell = cellOf(1)
    expect(cell.querySelector('.media-ep-num')!.getAttribute('data-state')).toBe('covered')
    expect(cell.querySelector('svg')!.getAttribute('data-state')).toBe('covered')
    // 仍然只有一枚符号——没有多出"第九个符号"与 ✓ 抢主状态。
    expect(cell.querySelectorAll('svg')).toHaveLength(1)
  })

  it('R-F12 铁律不受影响：格子的直接子元素仍是「集号 span + svg」两个（上标长在集号内部）', () => {
    renderDetail(asyncOf(twoCopies()))
    const kids = [...cellOf(1).children]
    expect(kids.length).toBeLessThanOrEqual(2)
    expect(kids[0]!.className).toContain('media-ep-num')
    // 上标在集号 span **里面**，不是格子的第三个孩子。
    expect(cellOf(1).querySelector('.media-ep-num > .media-ep-extra')).not.toBeNull()
  })

  it('两份都配上了 → 不渲染标记（"还有 0 份没配"是噪音）', () => {
    renderDetail(asyncOf(twoCopies({ fileCount: 2, subtitledFileCount: 2 })))
    expect(cellOf(1).querySelector('.media-ep-extra')).toBeNull()
  })

  it('只有一份文件且没配上 → **不渲染**标记（那件事八态已经说过了，不重复说）', () => {
    // fileCount=1/subtitled=0 时 `subtitledFileCount < fileCount` 成立，但它表达的是
    // "这一份没配上"——pending 那个态本身就是这句话。挂角标是同一事实说两遍。
    renderDetail(asyncOf(twoCopies({ episodeState: 'pending', fileCount: 1, subtitledFileCount: 0 })))
    expect(cellOf(1).querySelector('.media-ep-extra')).toBeNull()
  })

  it('虚线格（零文件）不渲染标记', () => {
    renderDetail(asyncOf(twoCopies({
      onDisk: false, episodeState: 'absent', fileCount: 0, subtitledFileCount: 0,
    })))
    expect(cellOf(1).querySelector('.media-ep-extra')).toBeNull()
  })

  // Carbon 双通道：这条事实不能只活在一个上标数字里。
  it('无障碍：R-F2 这条事实进 aria-label 整句，且上标自身 aria-hidden（不被重复读一遍）', () => {
    renderDetail(asyncOf(twoCopies()))
    const cell = cellOf(1)
    expect(cell.getAttribute('aria-label'))
      .toBe(`E01 ${en.media_state_covered} · ${en.media_extra_unsubtitled} 1`)
    expect(cell.querySelector('.media-ep-extra')!.getAttribute('aria-hidden')).toBe('true')
  })

  it('CSS：上标**不用任何状态色**（它不是第九个态），且不是徽章（无投影/背景/圆角）', () => {
    // 🔴 用状态色（红/琥珀/绿）会把它抬成与八态平级的告警——那正是"第九个符号"的病。
    const color = cssDecl('.media-ep-extra', 'color')
    expect(color, '.media-ep-extra 没有颜色声明').toBeTruthy()
    expect(color).toBe('var(--color-weak)')
    for (const banned of ['fn-red', 'fn-amber', 'fn-green', 'fn-blue', 'fn-purple']) {
      expect(color, `上标用了状态色 ${banned}——它会被读成第九个态`).not.toContain(banned)
    }
    // R-F11：它是个上标数字，不是一枚角标徽章。
    expect(cssDecl('.media-ep-extra', 'background')).toBeNull()
    expect(cssDecl('.media-ep-extra', 'border-radius')).toBeNull()
    expect(cssDecl('.media-ep-extra', 'box-shadow')).toBeNull()
  })

  it('图例不列它（它不属于那张九态颜色表）——图例仍然恰好八枚符号', () => {
    renderDetail(asyncOf(twoCopies()))
    const legend = screen.getByLabelText(en.media_legend_label)
    expect(legend.querySelectorAll('svg')).toHaveLength(8)
    expect(legend.querySelector('.media-ep-extra')).toBeNull()
  })

  it('extraUnsubtitledCount 纯函数口径（含脏数据夹 0）', () => {
    expect(extraUnsubtitledCount({ fileCount: 2, subtitledFileCount: 1 })).toBe(1)
    expect(extraUnsubtitledCount({ fileCount: 4, subtitledFileCount: 1 })).toBe(3)
    expect(extraUnsubtitledCount({ fileCount: 2, subtitledFileCount: 2 })).toBe(0)
    expect(extraUnsubtitledCount({ fileCount: 1, subtitledFileCount: 0 })).toBe(0)
    expect(extraUnsubtitledCount({ fileCount: 0, subtitledFileCount: 0 })).toBe(0)
    // 后端脏数据（subtitled > fileCount）不许渲染负数角标
    expect(extraUnsubtitledCount({ fileCount: 2, subtitledFileCount: 5 })).toBe(0)
  })
})

// ═══ 电影格 ═══════════════════════════════════════════════════════════════════
describe('电影那一格（R-F5：电影没有季集）', () => {
  it('movie 非 null → 渲染电影块，走同一套染色语言', () => {
    renderDetail(asyncOf(detail({
      work: { workId: 'tmdb:9', title: 'M', chineseTitle: null, year: 1999, posterPath: null, mediaType: 'movie' },
      movie: { dot: 'green', episodeState: 'covered', fileCount: 1, subtitledFileCount: 1, filename: 'M.mkv' },
    })))
    const cell = screen.getByRole('listitem')
    expect(cell.querySelector('.media-ep-num')!.getAttribute('data-state')).toBe('covered')
    expect(cell.getAttribute('data-ondisk')).toBe('true')
  })

  it('电影格露出文件名，不是空的拉宽集号格', () => {
    renderDetail(asyncOf(detail({
      work: { workId: 'tmdb:539972', title: 'Kraven the Hunter', chineseTitle: '猎人克莱文',
              year: 2024, posterPath: null, mediaType: 'movie' },
      movie: {
        dot: 'blue', episodeState: 'embedded', fileCount: 1, subtitledFileCount: 0,
        filename: 'Kraven the Hunter (2024).mkv',
      },
    })))
    expect(screen.getByText('Kraven the Hunter (2024).mkv')).toBeInTheDocument()
    expect(screen.getByRole('listitem').className).not.toMatch(/media-ep-cell-wide/)
  })

  it('**零文件的电影**（空壳 works 直达详情端点）→ absent + 虚线，不假设电影格必有文件', () => {
    // 后端注释点名证伪过"电影格恒有文件"：详情端点没有列表页那个 INNER JOIN。
    renderDetail(asyncOf(detail({
      work: { workId: 'tmdb:9', title: 'M', chineseTitle: null, year: null, posterPath: null, mediaType: 'movie' },
      movie: { dot: 'none', episodeState: 'absent', fileCount: 0, subtitledFileCount: 0, filename: null },
    })))
    const cell = screen.getByRole('listitem')
    expect(cell.getAttribute('data-ondisk')).toBe('false')
    expect(cell.querySelectorAll('svg')).toHaveLength(0)
  })
})

// ═══ 其余契约 ═════════════════════════════════════════════════════════════════
describe('图例 / unplaced / 异常态', () => {
  it('图例列出八个染色态（absent 不在其中——它是边框维度不是颜色维度）', () => {
    renderDetail(asyncOf(detail()))
    const legend = screen.getByLabelText(en.media_legend_label)
    expect(within(legend).getAllByText(/./).length).toBeGreaterThan(0)
    for (const label of [
      en.media_state_covered, en.media_state_origin_skip, en.media_state_embedded,
      en.media_state_extra,
      en.media_state_translating, en.media_state_unsolvable, en.media_state_pending,
      en.media_state_unjudged,
    ]) {
      expect(within(legend).getByText(label)).toBeInTheDocument()
    }
    expect(within(legend).queryByText(en.media_state_absent)).toBeNull()
    // 八枚符号（2026-08-13 加了 ▭ extra）
    expect(legend.querySelectorAll('svg')).toHaveLength(8)
  })

  it('unplacedFileCount > 0 时如实报（不报的话用户会以为文件被弄丢了）', () => {
    renderDetail(asyncOf(detail({ unplacedFileCount: 3 })))
    expect(screen.getByText(new RegExp(`${en.media_unplaced_prefix} 3`))).toBeInTheDocument()
  })

  it('unplacedFileCount === 0 时不渲染那一行', () => {
    renderDetail(asyncOf(detail({ unplacedFileCount: 0 })))
    expect(screen.queryByText(new RegExp(en.media_unplaced_prefix))).toBeNull()
  })

  it('404 → "没有这部作品"，且**不给重试按钮**（重试一个不存在的 id 是骗人）', () => {
    renderDetail(asyncOf(null, { error: 'not found' }))
    expect(screen.getByText(en.media_detail_not_found_title)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: en.media_retry })).toBeNull()
  })

  it('非 404 错误 → 错误态 + 重试按钮，**绝不显示空态文案**（§4.4：那是谎报）', () => {
    renderDetail(asyncOf(null, { error: 'boom' }))
    expect(screen.getByText(en.media_error_title)).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.media_retry })).toBeInTheDocument()
    expect(screen.queryByText(en.media_detail_no_seasons_title)).toBeNull()
  })

  it('isNotFoundError 只认后端那两种 404 信号', () => {
    expect(isNotFoundError('not found')).toBe(true)
    expect(isNotFoundError('/api/v2/mediaLibrary/tmdb:1 → 404')).toBe(true)
    expect(isNotFoundError('bad id')).toBe(false)
    expect(isNotFoundError('/api/v2/mediaLibrary/tmdb:1 → 500')).toBe(false)
  })

  it('loading 且无数据 → 骨架屏，不白屏（§4.4）', () => {
    renderDetail(asyncOf(null, { loading: true }))
    expect(screen.getByLabelText('loading media detail')).toBeInTheDocument()
  })

  it('en：有中文名时**只**显示原名（副标题槽不渲染）；相同则只显示一次', () => {
    renderDetail(asyncOf(detail({
      work: { workId: 'w', title: 'Breaking Bad', chineseTitle: '绝命毒师', year: 2008,
              posterPath: null, mediaType: 'tv' },
    })))
    // 2026-08-18 裁决：英文 UI 下外国人不需要知道中文名，副标题槽整体不渲染
    expect(screen.getByRole('heading', { name: 'Breaking Bad' })).toBeInTheDocument()
    expect(screen.queryByText('绝命毒师')).not.toBeInTheDocument()
  })
})
