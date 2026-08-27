// web/src/shell/nav.contract.test.tsx：导航拆型的**静默失效**守卫。
//
// ── 为什么这个文件存在 ──────────────────────────────────────────────────
// tabs.ts 头注释列的 6 处改动里，有两处**改错不报错**：
//   · AppShell 的 route.tab === 分支漏了 → 那个 tab 渲染一片空白（侧栏还高亮着）；
//   · i18n 的 nav_* 键漏了 → 侧栏显示键名原文（'nav_media' 而不是"媒体库"）。
// TS 管不到这两条（前者是布尔短路，后者是运行时查表）。这个文件用**遍历 TABS**的方式
// 覆盖它们：加 tab 忘了配套，用例自动变红——不需要下一个人记得回来加断言。
//
// ── 为什么是遍历而不是逐项硬写 ────────────────────────────────────────
// 逐项硬写的话，加第五个 tab 时用例数不变、全绿，正好漏掉新的那个——那就是 Task ⓪
// 「删光生产写入点测试无一变红」的同型。遍历 TABS 让守卫的覆盖面**跟着源码长**。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { Sidebar } from './Sidebar.js'
import { BottomTabBar } from './BottomTabBar.js'
import { TABS } from './tabs.js'
import { parseShellHash, legacyRedirectTarget } from './route.js'
import { en } from '../i18n/en.js'
import { zh } from '../i18n/zh.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('导航结构（Task ⑦ 四项）', () => {
  it('TABS 恰好是活动/通知/媒体库/设置四项，且顺序固定', () => {
    expect(TABS.map((m) => m.id)).toEqual(['activity', 'notifications', 'media', 'settings'])
  })

  it('旧的 library/workflow **不在导航里**', () => {
    const ids = TABS.map((m) => m.id)
    expect(ids).not.toContain('library')
    expect(ids).not.toContain('workflow')
  })

  // ⚠️ Task ⑪ 改写了这条的语义（不是删掉它）。
  // 旧版本断言的是「#/library 与 #/workflow 仍可直达」——那是 Task ⑦⑧⑨ 窗口期的裁决
  // （当时 #/workflow 渲染的旧活动页是仓里唯一能用的活动视图）。旧页面已移入 `_legacy/`，
  // 现在的裁决是**改写到功能等价的新页面**，所以这条跟着变成"改写落点对不对"。
  //
  // 🔴 **不许退化成只断言 tab 值**：id 段必须一起验。旧 `series.id` 与新 `works.id` 字面
  // 都长成 `tmdb:<n>`，把 id 带过去就是拿旧 id 打新端点（可能显示另一部剧，且不报错）。
  it('旧 hash 改写到新页面，且**丢弃 id 段**（不许把旧 id 送进新端点）', () => {
    expect(parseShellHash('#/workflow').tab).toBe('activity')
    expect(parseShellHash('#/library').tab).toBe('media')
    // 二级路由：落到媒体库**列表**，mediaWorkId 必须为空
    const detail = parseShellHash('#/library/tmdb%3A123')
    expect(detail.tab).toBe('media')
    expect(detail.mediaWorkId ?? null).toBeNull()
    const movie = parseShellHash('#/library/movies/tmdb%3A99')
    expect(movie.tab).toBe('media')
    expect(movie.mediaWorkId ?? null).toBeNull()
  })

  // 🔴 改写 ≠ 兜底，两者的地址栏行为不同（改写要自愈、兜底不许动地址栏）。
  // legacyRedirectTarget 是 useShellRoute 里那次 location.replace 的判据，单独钉住它。
  it('legacyRedirectTarget 只认旧 hash，不认兜底 hash', () => {
    expect(legacyRedirectTarget('#/library')).toBe('media')
    expect(legacyRedirectTarget('#/library/tmdb%3A123')).toBe('media')
    expect(legacyRedirectTarget('#/workflow')).toBe('activity')
    // 这几个走 DEFAULT_TAB 兜底：内容落到活动页，但**地址栏不许被改写**——
    // 用户从没访问过一个曾经存在的页面，替他改地址是越权。
    for (const h of ['', '#/', '#/nonsense', '#/triage', '#/activity', '#/media/tmdb%3A1']) {
      expect(legacyRedirectTarget(h), `${h} 不该被判为需要改写`).toBeNull()
    }
  })

  it('未识别 hash / 根路径落到 activity（不再是 library——它已下架）', () => {
    expect(parseShellHash('').tab).toBe('activity')
    expect(parseShellHash('#/').tab).toBe('activity')
    expect(parseShellHash('#/nonsense').tab).toBe('activity')
    // 旧书签 #/triage（spec §5 雪藏的甄别页）同样走兜底。它**不在** LEGACY_REDIRECTS 里：
    // 那个页面没有功能后继，编一条 triage→某页 的对应关系是无中生有。
    expect(parseShellHash('#/triage').tab).toBe('activity')
  })

  it('侧栏第一项 === 默认落点（两处不一致会让用户以为自己点错了）', () => {
    expect(TABS[0]!.id).toBe(parseShellHash('#/nonsense').tab)
  })
})

describe('i18n nav_* 键（静默失效：漏了只显示 key 原文，不报错）', () => {
  // 遍历 TABS：加 tab 忘了加键，这条自动红。
  it.each(TABS.map((m) => [m.id, m.labelKey] as const))(
    'tab %s 的 labelKey %s 在 en/zh 两侧都有真文案（不是键名原文、不是空串）',
    (_id, labelKey) => {
      for (const [name, table] of [['en', en], ['zh', zh]] as const) {
        const value = (table as Record<string, string>)[labelKey]
        expect(value, `${name}.${labelKey} 缺失`).toBeTruthy()
        // 键名原文 = 忘了加键时 t() 的表现（本仓 t() 查不到返回 undefined，
        // 但若有人给它加了"查不到回落键名"的兜底，这条能抓住）
        expect(value, `${name}.${labelKey} 是键名原文`).not.toBe(labelKey)
      }
    },
  )

  it('侧栏渲染出的是**译文**而不是 nav_* 键名（en）', () => {
    render(<I18nProvider initialLang="en"><Sidebar tab="activity" /></I18nProvider>)
    const nav = screen.getByRole('navigation')
    for (const meta of TABS) {
      // 键名不许出现在可见文本里
      expect(within(nav).queryByText(meta.labelKey)).toBeNull()
      expect(within(nav).getByText(en[meta.labelKey])).toBeInTheDocument()
    }
  })

  it('侧栏渲染出的是**译文**而不是 nav_* 键名（zh）', () => {
    render(<I18nProvider initialLang="zh"><Sidebar tab="activity" /></I18nProvider>)
    const nav = screen.getByRole('navigation')
    for (const meta of TABS) {
      expect(within(nav).queryByText(meta.labelKey)).toBeNull()
    }
    // 中文四项（nav_media 与 nav_library 中文同为"媒体库"是有意的，见 zh.ts 注释；
    // 侧栏里只有 media 那一个，所以 getByText 不会撞）
    expect(within(nav).getByText('活动')).toBeInTheDocument()
    expect(within(nav).getByText('通知')).toBeInTheDocument()
    expect(within(nav).getByText('媒体库')).toBeInTheDocument()
    expect(within(nav).getByText('设置')).toBeInTheDocument()
  })
})

describe('侧栏链接与选中态', () => {
  it.each(TABS.map((m) => m.id))('tab %s 的链接 href 是 #/<id>', (id) => {
    render(<I18nProvider initialLang="en"><Sidebar tab={id} /></I18nProvider>)
    const label = en[TABS.find((m) => m.id === id)!.labelKey]
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', `#/${id}`)
  })

  it.each(TABS.map((m) => m.id))('当前 tab %s 带 aria-current="page"，其余不带', (id) => {
    render(<I18nProvider initialLang="en"><Sidebar tab={id} /></I18nProvider>)
    for (const meta of TABS) {
      const link = screen.getByRole('link', { name: en[meta.labelKey] })
      if (meta.id === id) expect(link).toHaveAttribute('aria-current', 'page')
      else expect(link).not.toHaveAttribute('aria-current')
    }
  })

  it('每一项都渲染了图标（TAB_ICONS 漏配会让这条红）', () => {
    const { container } = render(<I18nProvider initialLang="en"><Sidebar tab="activity" /></I18nProvider>)
    const svgs = container.querySelectorAll('nav a svg')
    expect(svgs.length).toBe(TABS.length)
    // 图标规格（NavIcons 头注释的契约）：18×18 视口、继承 currentColor
    for (const svg of svgs) {
      expect(svg.getAttribute('viewBox')).toBe('0 0 18 18')
      expect(svg.getAttribute('width')).toBe('18')
    }
  })

  it('四个图标形状互不相同——复制粘贴同一个形会让导航四项长得一模一样', () => {
    const { container } = render(<I18nProvider initialLang="en"><Sidebar tab="activity" /></I18nProvider>)
    const shapes = [...container.querySelectorAll('nav a svg')].map((s) => s.innerHTML)
    expect(new Set(shapes).size).toBe(TABS.length)
  })
})

describe('🔴 移动端底部 tab bar 契约', () => {
  // ⚠️ initialLang 显式锁 zh（不用裸 <I18nProvider>）：默认语言按 navigator.language 猜，
  // jsdom 环境下是隐式依赖——本文件既有 harness 的纪律，见上方各用例。
  it('渲染的 tab 集合逐一等于 TABS 注册表（禁止另抄清单）', () => {
    render(<I18nProvider initialLang="zh"><BottomTabBar tab="activity" /></I18nProvider>)
    const links = screen.getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(TABS.map((m) => `#/${m.id}`))
    for (const m of TABS) {
      const label = zh[m.labelKey]
      expect(label).toBeTruthy()
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('选中项走 aria-current="page"，其余无', () => {
    render(<I18nProvider initialLang="zh"><BottomTabBar tab="media" /></I18nProvider>)
    const current = screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAttribute('href', '#/media')
  })

  // jsdom 无媒体查询——钉响应类名即钉断点行为（spec §测试 2）。下面两条合起来保证
  // 底部栏与侧栏靠 md 断点互斥、永不同屏。
  it('底部栏容器带 md:hidden（桌面不出现）', () => {
    render(<I18nProvider initialLang="zh"><BottomTabBar tab="activity" /></I18nProvider>)
    expect(screen.getByRole('navigation').className).toContain('md:hidden')
  })

  it('侧栏 nav 带 hidden md:flex（移动端不出现）', () => {
    render(<I18nProvider initialLang="en"><Sidebar tab="activity" /></I18nProvider>)
    const sideNavEl = screen.getByRole('navigation')
    expect(sideNavEl.className).toMatch(/\bhidden\b/)
    expect(sideNavEl.className).toContain('md:flex')
  })
})
