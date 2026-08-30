// web/src/workbench/CoverageGrid.test.tsx —— 覆盖格**画出来之后**长什么样。
// 纯函数（countStates / isSingleFileGrid）由 targetState.test.ts 守；这里锁渲染纪律：
//  · 剧集流：计数行（四档数字）+ 每格一枚状态方块（data-state 供样式画色/虚线）
//  · 电影流退化：一枚状态丸（wb-grid-pill），不铺格子网格
//  · 空数组：整段不渲染（沉默不占位）
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { CoverageGrid } from './CoverageGrid.js'
import type { Target } from './targetState.js'

afterEach(cleanup)

function renderGrid(targets: Target[]) {
  return render(<I18nProvider initialLang="en"><CoverageGrid targets={targets} /></I18nProvider>)
}

/** 造 n 格某状态的 target（key 唯一，label 随 key）。 */
function make(n: number, state: Target['state'], prefix: string): Target[] {
  return Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, label: `${prefix}${i}`, state }))
}

describe('CoverageGrid · 剧集流：格子网格 + 计数行', () => {
  it('38 格按状态渲染，计数行含各档数字（31 已装 / 1 进行中 / 6 待处理）', () => {
    const targets = [
      ...make(31, 'installed', 'i'),
      ...make(1, 'active', 'a'),
      ...make(6, 'pending', 'p'),
    ]
    renderGrid(targets)
    expect(screen.getAllByTestId('wb-grid-cell')).toHaveLength(38)
    const count = screen.getByTestId('wb-grid-count').textContent ?? ''
    expect(count).toContain('31')
    expect(count).toContain('1')
    expect(count).toContain('6')
  })

  it('🔴 installed 计数正确反映在计数行（数字来自 countStates，不是写死）', () => {
    renderGrid([...make(3, 'installed', 'i'), ...make(2, 'pending', 'p')])
    expect(screen.getByTestId('wb-grid-count').textContent).toContain('3')
  })

  it('pending-source 格挂 data-state=pending-source（供样式画虚线边框）', () => {
    renderGrid([
      { key: 's01e01', label: 'E01', state: 'installed' },
      { key: 's01e02', label: 'E02', state: 'pending-source' },
    ])
    const cell = screen.getByTestId('wb-grid-cell-s01e02')
    expect(cell).toHaveAttribute('data-state', 'pending-source')
  })

  it('每格带 data-testid=wb-grid-cell-{key} 与 title=label', () => {
    renderGrid([{ key: 's01e03', label: 'Episode 3', state: 'active' }])
    const cell = screen.getByTestId('wb-grid-cell-s01e03')
    expect(cell).toHaveAttribute('data-state', 'active')
    expect(cell).toHaveAttribute('title', 'Episode 3')
  })
})

describe('CoverageGrid · 电影流退化：单枚状态丸', () => {
  it('单格 movie → wb-grid-pill 出现、wb-grid-cell 零个', () => {
    renderGrid([{ key: 'movie', label: 'Movie', state: 'active' }])
    expect(screen.getByTestId('wb-grid-pill')).toBeInTheDocument()
    expect(screen.queryAllByTestId('wb-grid-cell')).toHaveLength(0)
  })

  it('状态丸按唯一那格的 state 着色（data-state）', () => {
    renderGrid([{ key: 'movie', label: 'Movie', state: 'installed' }])
    expect(screen.getByTestId('wb-grid-pill')).toHaveAttribute('data-state', 'installed')
  })
})

describe('CoverageGrid · 空数组沉默', () => {
  it('空数组 → 容器不渲染（返回 null）', () => {
    const { container } = renderGrid([])
    expect(container.firstChild).toBeNull()
  })
})
