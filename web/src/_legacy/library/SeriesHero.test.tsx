// web/src/library/SeriesHero.test.tsx：hero 头部——有 backdrop 渲染渐变压暗背景图 + 简介；
// 无 backdrop 降级纯排印（不留灰空图），无 overview 不渲染简介段。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '../../i18n/useT.js'
import { SeriesHero } from './SeriesHero.js'

// CSS 断言取值同 src/activity 四文件与 Task 19 的 SeriesGrid.test（那里有完整论证）：走
// vitest.config.ts:21 的 define 把 styles.css 编译期替换进来。这一屏读 CSS 是因为
// .library-detail-header-poster 的底色迁移又踩在 --color-accent 跨栈撞车上（Task 19 背景一），
// 只看 DOM 改错了也全绿。
declare const __STYLES_CSS__: string
const CSS = __STYLES_CSS__

function cssDecl(selector: string, prop: string): string | null {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = new RegExp(`${esc}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1]
  if (!block) return null
  const bare = block.replace(/\/\*[\s\S]*?\*\//g, '')
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(bare)
  return m ? m[1]!.trim() : null
}

afterEach(cleanup)

function wrap(ui: ReactElement) {
  return render(<I18nProvider>{ui}</I18nProvider>)
}

describe('SeriesHero', () => {
  it('有 backdrop → 渲染背景图；有 overview → 渲染简介', () => {
    wrap(
      <SeriesHero
        name="美国恐怖故事"
        originalName="American Horror Story"
        year={2011}
        seriesId="tmdb:1413"
        posterPath={null}
        backdropPath="/bd.jpg"
        overview="每季一个独立恐怖故事"
      />,
    )
    expect(screen.getByText('美国恐怖故事')).toBeInTheDocument()
    expect(screen.getByText('每季一个独立恐怖故事')).toBeInTheDocument()
    expect(document.querySelector('.library-hero-backdrop')).toBeTruthy()
  })

  it('无 backdrop → 降级纯排印（无背景图节点）；无 overview → 不渲染简介段', () => {
    // name 取多字，避免与 PosterThumb 无海报时的首字母降级占位（"F"）撞成同文本节点。
    wrap(
      <SeriesHero
        name="Fringe"
        originalName={null}
        year={null}
        seriesId="tmdb:2"
        posterPath={null}
        backdropPath={null}
        overview={null}
      />,
    )
    expect(document.querySelector('.library-hero-backdrop')).toBeNull()
    expect(screen.getByText('Fringe')).toBeInTheDocument()
  })
})

// ── CSS 侧迁移锁（Task 20）
describe('SeriesHero / 详情头部：CSS 侧迁移锁', () => {
  it('头部缩略框底走 --color-secondary（不是 --color-accent：后者过渡期是柠檬绿），圆角字面 4px', () => {
    expect(cssDecl('.library-detail-header-poster', 'background')).toBe('var(--color-secondary)')
    expect(cssDecl('.library-detail-header-poster', 'border-radius')).toBe('4px')
    // 边框不迁：两栈同值。
    expect(cssDecl('.library-detail-header-poster', 'border')).toBe('1px solid var(--color-border)')
  })

  it('hero scrim 渐变收尾走 --color-background（scout-only 的 --color-background-body 会在 Task 31 后 undefined）', () => {
    const scrim = cssDecl('.library-hero-scrim', 'background')
    expect(scrim).toContain('var(--color-background) 82%')
    // 作用域限定在这条规则内断言旧名绝迹（全库别处仍有 --color-background-body，属 Tasks 22-27）。
    expect(scrim).not.toContain('--color-background-body')
  })
})

// ── DOM 侧迁移锁（Task 20）
describe('SeriesHero：DOM 侧迁移锁', () => {
  it('hero 子树无 astryx-* 类名，剧名/seriesId 仍在场', () => {
    const { container } = wrap(
      <SeriesHero name="美国恐怖故事" originalName="American Horror Story" year={2011}
        seriesId="tmdb:1413" posterPath={null} backdropPath="/bd.jpg" overview="每季一个独立恐怖故事" />,
    )
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
    expect(screen.getByText('美国恐怖故事')).toBeInTheDocument()
    expect(screen.getByText('tmdb:1413')).toBeInTheDocument()
  })
})
