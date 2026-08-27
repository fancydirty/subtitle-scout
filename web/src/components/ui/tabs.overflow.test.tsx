// web/src/components/ui/tabs.overflow.test.tsx：钉死 Tabs 的窄屏溢出策略（2026-08-27 实案：
// 390px 下设置页四个 trigger 连徽章 ~420px > 容器 ~342px，flex 收缩后 CJK 标签按字折行，
// 「字幕源」竖排成三行）。业界口径是 Material 的 scrollable tabs：标签永不折行、列表横滚。
// jsdom 不做布局，钉类名即钉行为——这几个类少任何一个，窄屏挤压就会无声复发。
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Tabs, TabsList, TabsTrigger } from './tabs.js'

function renderTabs() {
  render(
    <Tabs defaultValue="a">
      <TabsList>
        <TabsTrigger value="a">通用</TabsTrigger>
        <TabsTrigger value="b">字幕源</TabsTrigger>
      </TabsList>
    </Tabs>,
  )
}

describe('🔴 Tabs 窄屏溢出策略（scrollable tabs）', () => {
  it('TabsList 横滚而不压缩：max-w-full + overflow-x-auto', () => {
    renderTabs()
    const list = screen.getByRole('tablist')
    expect(list.className).toContain('max-w-full')
    expect(list.className).toContain('overflow-x-auto')
  })

  it('TabsList 不许 justify-center——居中 + 溢出会让左端永远滚不到（flex 居中溢出裁切）', () => {
    renderTabs()
    const list = screen.getByRole('tablist')
    expect(list.className).not.toContain('justify-center')
    expect(list.className).toContain('justify-start')
  })

  it('TabsTrigger 永不折行也不被压缩：whitespace-nowrap + shrink-0', () => {
    renderTabs()
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.className).toContain('whitespace-nowrap')
      expect(tab.className).toContain('shrink-0')
    }
  })
})
