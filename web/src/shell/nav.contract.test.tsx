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
import { TABS } from './tabs.js'
import { parseShellHash } from './route.js'
import { en } from '../i18n/en.js'
import { zh } from '../i18n/zh.js'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('导航结构（Task ⑦ 四项）', () => {
  it('TABS 恰好是活动/通知/媒体库/设置四项，且顺序固定', () => {
    expect(TABS.map((m) => m.id)).toEqual(['activity', 'notifications', 'media', 'settings'])
  })

  it('旧的 library/workflow **不在导航里**（用户裁决：摘导航但留路由）', () => {
    const ids = TABS.map((m) => m.id)
    expect(ids).not.toContain('library')
    expect(ids).not.toContain('workflow')
  })

  // ⚠️ 这条与上一条是**互补**的，不是重复：上一条防"忘了摘"，这条防"顺手删了路由"。
  // 删路由会让 #/workflow（今天唯一能用的活动页）与用户的旧书签一起失效，
  // 且 activity/ 的 7 处 import 会编译失败。
  it('旧路由 #/library 与 #/workflow 仍然可直达（Task ⑪ 才下架）', () => {
    expect(parseShellHash('#/workflow').tab).toBe('workflow')
    expect(parseShellHash('#/library').tab).toBe('library')
    // 二级路由也得还在（剧集详情页）
    expect(parseShellHash('#/library/tmdb%3A123').libraryId).toBe('tmdb:123')
  })

  it('未识别 hash / 根路径落到 activity（不再是 library——它已不在侧栏，落它会没有高亮项）', () => {
    expect(parseShellHash('').tab).toBe('activity')
    expect(parseShellHash('#/').tab).toBe('activity')
    expect(parseShellHash('#/nonsense').tab).toBe('activity')
    // 旧书签 #/triage 的兜底路径同样改到 activity
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
