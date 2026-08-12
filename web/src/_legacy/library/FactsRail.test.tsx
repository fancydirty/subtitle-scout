// web/src/library/FactsRail.test.tsx：详情页事实栏——mono 覆盖计数 / 语言 / 内嵌集数。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { FactsRail } from './FactsRail.js'

afterEach(cleanup)

describe('FactsRail', () => {
  it('渲染覆盖计数与来源（mono 技术读数）', () => {
    render(
      <I18nProvider>
        <FactsRail covered={8} total={8} embedded={8} langs={['zh-Hans', 'en']} />
      </I18nProvider>,
    )
    // 文本节点整体是"covered 8 / 8"，用正则子串匹配
    expect(screen.getByText(/8 \/ 8/)).toBeInTheDocument()
    expect(screen.getByText('zh-Hans · en')).toBeInTheDocument()
  })

  it('langs 为空 → 不渲染语言段；embedded 为 0 → 不渲染内嵌段', () => {
    render(
      <I18nProvider>
        <FactsRail covered={0} total={4} embedded={0} langs={[]} />
      </I18nProvider>,
    )
    expect(screen.getByText(/0 \/ 4/)).toBeInTheDocument()
    expect(screen.queryByText(/embedded/)).not.toBeInTheDocument()
  })
})

// ── DOM 侧迁移锁（Task 20）
describe('FactsRail：DOM 侧迁移锁', () => {
  it('读数走 font-mono、子树无 astryx-* 类名', () => {
    const { container } = render(
      <I18nProvider>
        <FactsRail covered={8} total={8} embedded={8} langs={['zh-Hans', 'en']} />
      </I18nProvider>,
    )
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    // 三段 mono 读数（覆盖/语言/内嵌）都在场且带 font-mono。
    const monos = container.querySelectorAll('.library-facts-rail > span.font-mono')
    expect(monos.length).toBe(3)
  })
})
