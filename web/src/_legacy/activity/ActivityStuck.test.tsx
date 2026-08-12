// web/src/activity/ActivityStuck.test.tsx：卡死态（spec §7.2）的渲染 + L7/铁律回归锁。
//
// 这一屏的设计张力（L7 说不做展开、但问题必须看得见）在测试里表现为**两组方向相反的锁**：
//
//  正向：红点 + 红字事实必须在场。藏起来的失败就是静默失效——这个系统最不该有的东西。
//  反向：不许有任何展开入口、不许把进度条染红、不许把 reason 原文糊到界面上。
//
// 三条反向锁分别锁 L7、铁律①、铁律②③，而它们都是"顺手加一点就更有用了"型的违规——尤其
// `reason` 那条：把后端已经落库的错误原文显示出来看起来是"更透明"，实际是把 jobId / worker_task /
// payload 这些机器词直接推到用户脸上（reason 的真身是 jobs.last_error，自由文本，没有值域）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider, type Lang } from '../../i18n/useT.js'
import type { WorkflowHeldJobDTO } from '../../api/types.js'
import { ActivityStuck, type StuckItem } from './ActivityStuck.js'

const T0 = 1_700_000_000_000

// CSS 断言的取值方式同 ActivityHero.test.tsx（那里有完整论证）：`?raw` 在 vitest 里恒返回空串
// （于是断言全部变成永假），`node:fs` 会撞 tsconfig 的 types 白名单——所以走 vitest.config.ts 的
// `define` 在编译期把文件内容替换进来。
//
// 这一屏必须读 CSS 源文件的理由格外硬：铁律①"红只给点不给块"的真身**就在 CSS 里**。
// 只断言 DOM 的话，往 styles.css 加一句把 .act-hero-bar-fill 染红的规则，所有 DOM 断言照绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

/** 从 styles.css 里读某个选择器块的某条声明。先剥注释（同 ActivityHero.test.tsx 的既有实现：
 *  声明前隔着一条注释会读不到，且注释里提到的颜色名不该被当成真声明）。 */
function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

/** 一条真实形状的 reason——**逐字取自** src/v2/translateWorkerTask.ts:148 的
 *  `completeError(job.id, \`translate job ${job.id} payload 缺 videoPath\`, now())`。
 *  它同时踩中铁律②（jobId 41）与铁律③（job / payload 两个机器词），所以它是最好的探针：
 *  任何形式的透传都会被下面的锁抓住。 */
const REAL_REASON = 'translate job 41 payload 缺 videoPath'

function held(over: Partial<WorkflowHeldJobDTO> = {}): WorkflowHeldJobDTO {
  return {
    jobId: 41,
    itemId: 'tmdb:1396/s12e04',
    reason: REAL_REASON,
    nextRetryAt: T0 + 4 * 3_600_000, // 4 小时后
    errorAttempt: 3,
    // 名字与海报（2026-07-31 审计 C-3）：后端 held DTO 现在自带这四个字段，
    // 不再靠接线层去 recent[] join（那个 join 一小时后必然过期）。
    seriesName: null,
    movieName: null,
    posterPath: null,
    backdropPath: null,
    ...over,
  }
}

function item(over: Partial<StuckItem> = {}): StuckItem {
  return {
    held: held(over.held),
    title: '绝命毒师',
    posterPath: '/poster.jpg',
    backdropPath: '/backdrop.jpg',
    stageAtFailure: 66,
    ...over,
  }
}

function renderStuck(items: readonly StuckItem[] = [item()], opts: { now?: number; lang?: Lang } = {}) {
  return render(
    <I18nProvider initialLang={opts.lang ?? 'zh'}>
      <ActivityStuck items={items} now={opts.now ?? T0} />
    </I18nProvider>,
  )
}

afterEach(cleanup)

describe('ActivityStuck：问题看得见（红点 + 红字事实）', () => {
  it('held 非空 → 红点在场，且 tone=bad', () => {
    renderStuck()
    const dot = screen.getByTestId('activity-stuck-dot')
    expect(dot).toBeInTheDocument()
    expect(dot.dataset.tone).toBe('bad')
  })

  it('红字事实在场——spec §7.2 逐字要求的「遇到问题——会重试」', () => {
    renderStuck()
    expect(screen.getByTestId('activity-stuck-fact')).toBeInTheDocument()
    expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
  })

  it('那行事实确实是红的（CSS 里 .act-stuck-fact 走 --color-fn-red）', () => {
    // 这条裁决的真身在 CSS——只断言类名在场的话，把颜色改成灰会全绿。
    expect(cssDecl('.act-stuck-fact', 'color')).toBe('var(--color-fn-red)')
    const { container } = renderStuck()
    expect(container.querySelector('.act-stuck-fact')).toBeTruthy()
  })

  it('红点在 CSS 里确实转红，且脉动停掉（活停着，让它继续呼吸是假话）', () => {
    expect(cssDecl(".act-hero-pulse[data-tone='bad']", 'background')).toBe('var(--color-fn-red)')
    expect(cssDecl(".act-hero-pulse[data-tone='bad']", 'animation')).toBe('none')
  })

  it('held 为空 → 整段不渲染（不给"暂无故障"占位——那又是一句断言系统健康的话）', () => {
    const { container } = renderStuck([])
    expect(container.querySelector('.act-stuck')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('多条 held 各渲染一屏', () => {
    renderStuck([item(), item({ held: held({ jobId: 42 }), title: '风骚律师' })])
    expect(screen.getAllByTestId('activity-stuck-hero')).toHaveLength(2)
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('风骚律师')).toBeInTheDocument()
  })

  it('主语：title 在场用剧名；查无时给空占位，**绝不退回 itemId**', () => {
    const { container, rerender } = render(
      <I18nProvider initialLang="zh"><ActivityStuck items={[item({ title: '绝命毒师' })]} now={T0} /></I18nProvider>,
    )
    expect(container.textContent).toContain('绝命毒师')

    // 2026-07-31 审计 C-3：这条原本断言"查无时降级 itemId"，而那正是违反铁律③的行为——
    // 本组件自己的文件头（:85）就写着 itemId「形如 tmdb:1396/s12e04，一个技术标识符，
    // 铁律③不许直接上界面」。两句话不能同时成立，铁律那句是对的：显示那串东西不是诚实，
    // 是把内部标识符当人话糊给用户。改成空占位——屏上仍有图（L4）+ 红字事实（L7），
    // 少的只是一个用户看不懂的字符串。
    rerender(
      <I18nProvider initialLang="zh"><ActivityStuck items={[item({ title: null })]} now={T0} /></I18nProvider>,
    )
    expect(container.textContent).not.toContain('tmdb:1396')
    expect(container.textContent).not.toContain('41')      // 也不退回 jobId（铁律②工程值）
  })
})

describe('ActivityStuck：进度条保持在故障阶段（铁律① 红只给点不给块）', () => {
  it('条宽 = 故障发生时的阶段，不清零', () => {
    renderStuck([item({ stageAtFailure: 66 })])
    const fill = screen.getByTestId('activity-stuck-bar-fill')
    expect(fill.style.width).toBe('66%')
    // 反向锁：清零（0%）是 spec 明令禁止的。
    expect(fill.style.width).not.toBe('0%')
  })

  it('条走 staged 静态宽度，不是不定态扫动（那条动画的语义是"在干活"，而活停着）', () => {
    renderStuck()
    expect(screen.getByTestId('activity-stuck-bar').dataset.mode).toBe('staged')
  })

  // ── 铁律① 回归锁：进度条**不被染红** ──────────────────────────────────────
  it('进度条元素的类/内联样式里没有红（红只染那个 6px 点，不铺块）', () => {
    const { container } = renderStuck()
    const bar = screen.getByTestId('activity-stuck-bar')
    const fill = screen.getByTestId('activity-stuck-bar-fill')
    // 1) 组件层不给条任何 tone 钩子——给了它，CSS 就有地方挂红色分支。
    expect(bar.dataset.tone).toBeUndefined()
    expect(fill.dataset.tone).toBeUndefined()
    // 2) 内联样式里只有 width，没有任何颜色声明。
    expect(fill.getAttribute('style')).toBe('width: 66%;')
    expect(bar.getAttribute('style')).toBeNull()
    // 3) 没有"红条"专用类名（.act-stuck-bar-red / data-tone 之类的变体）。
    expect(container.querySelector('.act-hero-bar[data-tone]')).toBeNull()
    expect(container.innerHTML).not.toMatch(/bar[-\w]*(red|error|danger|bad)/i)
  })

  it('CSS 里没有任何把进度条填充染红的规则（这条裁决的真身在 CSS）', () => {
    // 只锁 DOM 不够：CSS 里加一句 `.act-stuck .act-hero-bar-fill{background:var(--color-text-red)}`
    // 就能把整条染红，而上面那些 DOM 断言照绿。这里扫**所有**提到 bar-fill 的规则块。
    const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    const blocks = noComments.match(/[^}]*act-hero-bar[^{]*\{[^}]*\}/g) ?? []
    expect(blocks.length).toBeGreaterThan(0) // 确认扫到了东西，不是空扫
    for (const block of blocks) {
      // ⚠️ 同时覆盖 legacy 名与新名。只写一个的话，token 改名会让这条 not.toMatch 变成
      // 永真断言——不变红，只是从此不再保护任何东西（下面那条 /\bred\b/i 才是真正兜住
      // 这一族的锁：`--color-fn-red` 里 red 前后都是非词字符，它抓得住）。
      expect(block).not.toMatch(/color-(?:fn-|text-)?red/)
      expect(block).not.toMatch(/#f8[0-9a-f]{4}/i)
      expect(block).not.toMatch(/\bred\b/i)
    }
  })

  it('stageAtFailure 为 null → 整条不渲染（空条读作 0%=清零；扫动条谎称在干活）', () => {
    const { container } = renderStuck([item({ stageAtFailure: null })])
    expect(screen.queryByTestId('activity-stuck-bar')).toBeNull()
    expect(container.querySelector('.act-hero-bar')).toBeNull()
    // 但红字事实仍完整——"问题看得见"这个目的不依赖那条装饰条。
    expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
    expect(screen.getByTestId('activity-stuck-dot')).toBeInTheDocument()
  })

  it('不同 stage 值照实渲染（证明它真读入参，不是个常量）', () => {
    renderStuck([item({ stageAtFailure: 22 })])
    expect(screen.getByTestId('activity-stuck-bar-fill').style.width).toBe('22%')
    cleanup()
    renderStuck([item({ stageAtFailure: 88 })])
    expect(screen.getByTestId('activity-stuck-bar-fill').style.width).toBe('88%')
  })

  it('条宽那个数字不进文本节点（L10 + 铁律②：界面上没有百分比）', () => {
    const { container } = renderStuck()
    const text = container.textContent ?? ''
    expect(text).not.toContain('%')
    expect(text).not.toContain('66')
    expect(container.querySelector('[aria-valuenow]')).toBeNull()
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
  })
})

describe('ActivityStuck：L7 回归锁（不提供展开入口）', () => {
  it('没有任何按钮 / 可点控件 / 链接', () => {
    const { container } = renderStuck()
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
    expect(container.querySelectorAll('a')).toHaveLength(0)
    expect(container.querySelector('[onclick]')).toBeNull()
    // details/summary 是"不用 JS 的展开"——同样是展开入口。
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('summary')).toBeNull()
  })

  it('DOM 里没有「详情/展开/查看痕迹」这一族措辞（中英）', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderStuck([item()], { lang })
      const text = container.textContent ?? ''
      for (const word of ['详情', '展开', '查看痕迹', '查看日志', '痕迹', '更多', '诊断']) {
        expect(text).not.toContain(word)
      }
      const lower = text.toLowerCase()
      for (const word of ['detail', 'expand', 'trace', 'view log', 'show more', 'diagnose', 'inspect']) {
        expect(lower).not.toContain(word)
      }
      // 也不许通过 aria-label / title 从后门给一个入口。
      expect(container.innerHTML.toLowerCase()).not.toMatch(/aria-label|aria-expanded|aria-controls/)
      cleanup()
    }
  })
})

describe('ActivityStuck：reason 原文不透传（铁律②③回归锁）', () => {
  it('reason 的原始技术字符串**不出现在 DOM 里**（textContent 与 innerHTML 都不许）', () => {
    const { container } = renderStuck()
    // 整串不在场。
    expect(container.textContent).not.toContain(REAL_REASON)
    // 逐片段也不在场——截断/切片式的"部分透传"同样违规（jobId 和机器词照样露出来）。
    for (const fragment of ['translate job 41', 'payload', '缺 videoPath', 'videoPath']) {
      expect(container.textContent).not.toContain(fragment)
    }
    // innerHTML 也扫一遍：藏进 title/data-* 属性同样是暴露（hover 就能看见）。
    expect(container.innerHTML).not.toContain('videoPath')
    expect(container.innerHTML).not.toContain('payload')
  })

  it('换任意一条真实 reason 都不透传（它是自由文本 jobs.last_error，没有值域）', () => {
    // 这四条逐字取自真实调用点：cli/index.ts:417/520、reconcileAll.ts:141、
    // translateWorkerTask.ts:182。它们的形状彼此完全不同——这正是"建不出映射表"的证据。
    const reasons = [
      'worker_task job 41 has unparseable payload: {"taskType":null}',
      'unknown worker_task taskType: undefined',
      'ECONNREFUSED 127.0.0.1:11434',
      'translate held: glossary drift over threshold',
    ]
    for (const reason of reasons) {
      const { container } = renderStuck([item({ held: held({ reason }) })])
      expect(container.textContent).not.toContain(reason)
      // 而人话句照样在场——不透传不等于不告诉用户出了事。
      expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
      cleanup()
    }
  })

  it('reason 为 null 时也不崩、不出现 "null" 字样', () => {
    const { container } = renderStuck([item({ held: held({ reason: null }) })])
    expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
    expect(container.textContent).not.toContain('null')
  })

  it('铁律③：textContent 不含 agent/orchestrator/worker/pass/asset/ledger/job', () => {
    for (const lang of ['zh', 'en'] as const) {
      const { container } = renderStuck([item()], { lang })
      const text = (container.textContent ?? '').toLowerCase()
      for (const word of ['agent', 'orchestrator', 'worker', 'pass', 'asset', 'ledger', 'job']) {
        expect(text).not.toContain(word)
      }
      cleanup()
    }
  })

  it('铁律②：不显示 errorAttempt / jobId（"第 3 次重试"对"我能不管了吗"毫无帮助）', () => {
    const { container } = renderStuck([item({ held: held({ errorAttempt: 3, jobId: 41 }) })])
    const text = container.textContent ?? ''
    expect(text).not.toContain('3 次')
    expect(text).not.toContain('41')
    // itemId 在有剧名时也不该露出来（它是 own-id，技术标识符）。
    expect(text).not.toContain('tmdb:1396')
  })
})

describe('ActivityStuck：重试时刻（那句"会重试"需要一个可核对的时刻）', () => {
  it('渲染「4 小时后重试」/ retries in 4h', () => {
    renderStuck()
    expect(screen.getByText('4 小时后重试')).toBeInTheDocument()
    cleanup()
    renderStuck([item()], { lang: 'en' })
    expect(screen.getByText('retries in 4h')).toBeInTheDocument()
  })

  it('已到点（nextRetryAt 已过，轮询间隙的正常状态）→ 不报负数，给"即将重试"', () => {
    const { container } = renderStuck([item({ held: held({ nextRetryAt: T0 - 5_000 }) })])
    expect(screen.getByText('即将重试')).toBeInTheDocument()
    expect(container.textContent).not.toContain('-')
  })

  it('nextRetryAt 为 null → 整行不渲染（不编一个时刻）', () => {
    const { container } = renderStuck([item({ held: held({ nextRetryAt: null }) })])
    expect(screen.queryByTestId('activity-stuck-retry')).toBeNull()
    expect(container.textContent).not.toContain('重试时间')
    // 红字事实仍在——那句话本身不依赖时刻。
    expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
  })
})

describe('ActivityStuck：图（L4 必须有图，复用 hero 的两条美术路径）', () => {
  it('backdropPath 有值 → 出血背景层（w1280）', () => {
    const { container } = renderStuck()
    const bd = container.querySelector<HTMLElement>('.act-hero-backdrop')
    expect(bd).toBeTruthy()
    expect(bd!.style.backgroundImage).toContain('/backdrop.jpg')
    expect(bd!.style.backgroundImage).toContain('w1280')
  })

  it('backdropPath 为 null → 模糊海报降级（判据是图片可得性，不是"是不是电影"）', () => {
    const { container } = renderStuck([item({ backdropPath: null, posterPath: '/inception.jpg' })])
    const blur = container.querySelector<HTMLElement>('.act-hero-blur-poster')
    expect(blur).toBeTruthy()
    expect(blur!.style.backgroundImage).toContain('/inception.jpg')
    expect(container.querySelector('.act-hero-backdrop')).toBeNull()
  })

  it('图都没有 → 不崩，海报框走首字母占位，红字事实仍完整', () => {
    const { container } = renderStuck([item({ posterPath: null, backdropPath: null })])
    expect(container.querySelector<HTMLElement>('.act-hero')!.dataset.art).toBe('none')
    expect(container.querySelector('.act-hero-poster .library-poster-fallback')).toBeTruthy()
    expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
  })

  it('海报仍是 2:3（L5 不因这一屏而变——几何整套复用 .act-hero-poster）', () => {
    const { container } = renderStuck()
    expect(container.querySelector('.act-hero-poster')).toBeTruthy()
    expect(cssDecl('.act-hero-poster', 'aspect-ratio')!.replace(/\s+/g, '')).toBe('2/3')
  })
})

describe('ActivityStuck：双语各渲染一次（DESIGN.md §7）', () => {
  it('中文：主语 + 红字事实 + 重试时刻，全中文', () => {
    renderStuck([item()], { lang: 'zh' })
    expect(screen.getByText('绝命毒师')).toBeInTheDocument()
    expect(screen.getByText('遇到问题——会重试')).toBeInTheDocument()
    expect(screen.getByText('4 小时后重试')).toBeInTheDocument()
  })

  it('英文：同一份数据全英文', () => {
    renderStuck([item()], { lang: 'en' })
    expect(screen.getByText('绝命毒师')).toBeInTheDocument() // 剧名是数据，不翻译
    expect(screen.getByText('hit a problem — will retry')).toBeInTheDocument()
    expect(screen.getByText('retries in 4h')).toBeInTheDocument()
  })
})

// ── 迁移锁（Astryx → Tailwind，Task 16）
//
// 这一屏的几何整套复用 .act-hero*，而那几条 CSS 规则**故意没有 display**（Astryx 的
// HStack/VStack 曾是唯一来源）。迁移后类名就是机制本身，没有别的 CSS 声明可以断言——
// 所以这里破例断言类名，并且每条都配一个"CSS 侧确实缺 display"的取证断言。
describe('ActivityStuck：迁移锁', () => {
  it('hero 几何的两个容器都带 flex（CSS 里它们没有 display，这两个类就是布局本体）', () => {
    const { container } = renderStuck()
    const body = container.querySelector('.act-hero-body')!
    const main = container.querySelector('.act-hero-main')!
    expect(body.className.split(/\s+/)).toContain('flex')
    expect(main.className.split(/\s+/)).toContain('flex')
    expect(main.className.split(/\s+/)).toContain('flex-col')
    // 配对取证：CSS 侧确实没有 display——这才是上面三条断言承重的原因。
    // 若将来有人往 CSS 补了 display:flex，这两条会红，提醒把组件层的冗余类一并收拾
    // （注意：那两个类是 hero 与本屏**共用**的，改 CSS 会同时改另一屏）。
    expect(cssDecl('.act-hero-body', 'display')).toBeNull()
    expect(cssDecl('.act-hero-main', 'display')).toBeNull()
  })

  it('红点的父级带 flex——点是 inline span，靠 blockify 才有 6px 圆形', () => {
    renderStuck()
    const parent = screen.getByTestId('activity-stuck-dot').parentElement!
    const classes = parent.className.split(/\s+/)
    expect(classes).toContain('flex')
    expect(classes).toContain('items-center')
    // .act-hero-pulse 在 CSS 里没有 display，而 inline 元素忽略 width/height。父级掉了 flex，
    // 红点整个消失，而上面那条 dataset.tone === 'bad' 照绿。
    expect(cssDecl('.act-hero-pulse', 'display')).toBeNull()
    expect(cssDecl('.act-hero-pulse', 'width')).toBe('6px')
  })

  it('DOM 里不再有 astryx-* 类名，且 L7 没被顺手破坏', () => {
    const { container } = renderStuck([
      item(),
      item({ held: held({ jobId: 42 }), title: '风骚律师' }),
    ])
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 迁移不该引入任何可点控件（换标签时最容易顺手写成 <button>）。
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[role="button"]')).toBeNull()
    // 两屏都渲染过了才算扫全（单屏扫不到"只在第二条上写错"的情况）。
    expect(screen.getAllByTestId('activity-stuck-hero')).toHaveLength(2)
    expect(screen.getAllByTestId('activity-stuck-fact')).toHaveLength(2)
  })
})
