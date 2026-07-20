// web/src/library/SeriesHero.test.tsx：hero 头部——有 backdrop 渲染渐变压暗背景图 + 简介；
// 无 backdrop 降级纯排印（不留灰空图），无 overview 不渲染简介段。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import { I18nProvider } from '../i18n/useT.js'
import { SeriesHero } from './SeriesHero.js'

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
