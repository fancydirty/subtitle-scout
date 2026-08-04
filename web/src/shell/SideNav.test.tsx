// web/src/shell/SideNav.test.tsx：自绘 SideNav 件的契约测试（Task 28 新档）——
// 选中态（aria-current="page"）与行尾徽标槽是本件的两个规格锚点；链接契约
// （<a href> + 可及名 = label）是 App.test.tsx findByRole('link', {name}) 的底层保证。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from './SideNav.js'

afterEach(() => cleanup())

describe('SideNavItem（自绘导航项）', () => {
  it('渲染为 <a href>，可及名 = label', () => {
    render(<SideNavItem href="#/library" label="Library" />)
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('href', '#/library')
  })

  it('selected → aria-current="page"', () => {
    render(<SideNavItem href="#/library" label="Library" selected />)
    expect(screen.getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page')
  })

  it('未 selected → 无 aria-current 属性（不是 aria-current="false"）', () => {
    render(<SideNavItem href="#/library" label="Library" />)
    expect(screen.getByRole('link', { name: 'Library' })).not.toHaveAttribute('aria-current')
  })

  it('endContent 徽标渲染在链接内部（计入可及名，/^Triage/ 前缀匹配仍成立）', () => {
    render(
      <SideNavItem
        href="#/triage"
        label="Triage"
        endContent={<span className="text-xs text-muted-foreground">3</span>}
      />,
    )
    const link = screen.getByRole('link', { name: /^Triage/ })
    expect(link).toHaveTextContent('3')
  })
})

describe('SideNav 骨架（自绘）', () => {
  it('nav 地标 + wordmark + 分区 group（aria-labelledby 指向分区标题）', () => {
    render(
      <SideNav header={<SideNavHeading heading="subtitle-scout" />}>
        <SideNavSection title="LIBRARY">
          <SideNavItem href="#/library" label="Library" selected />
        </SideNavSection>
      </SideNav>,
    )
    expect(screen.getByRole('navigation', { name: 'Side navigation' })).toBeInTheDocument()
    expect(screen.getByText('subtitle-scout')).toBeInTheDocument()
    const group = screen.getByRole('group')
    const title = screen.getByText('LIBRARY')
    expect(group).toHaveAttribute('aria-labelledby', title.id)
  })
})
