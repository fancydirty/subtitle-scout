// web/src/workbench/ActivityTicker.test.tsx —— ticker 单行**画出来之后**长什么样。
// tickerPhrase 的纯函数逻辑由 tickerPhrase.test.ts 守；这里锁组件纪律：
//  · 组件内部调 tickerPhrase + useT 拼 `{t(key)} {obj}`（t() 不插值，见 useT.ts 头注释）
//  · tool=null → 不渲染（无正在进行的动作时 ticker 不占屏）
//  · object 缺失 → 降级到 wb_step_* 译文，**绝不吐裸 tool id**（RunCard 纪律同源）
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { ActivityTicker } from './ActivityTicker.js'

afterEach(cleanup)

function renderTicker(tool: string | null, object: string | null) {
  return render(<I18nProvider initialLang="en"><ActivityTicker tool={tool} object={object} /></I18nProvider>)
}

describe('ActivityTicker · 带对象拼具体句', () => {
  it('search_source + S01E32 → 文案含对象 + 搜索短语译文', () => {
    renderTicker('search_source', 'S01E32')
    const line = screen.getByTestId('wb-ticker').textContent ?? ''
    expect(line).toContain('S01E32')
    expect(line).toContain(en.wb_ticker_search) // 'Searching for'
  })
})

describe('ActivityTicker · 对象缺失降级，绝不吐裸 tool id', () => {
  it('object=null → 降级句（含 wb_step_search 译文，不含裸 "search_source"）', () => {
    renderTicker('search_source', null)
    const line = screen.getByTestId('wb-ticker').textContent ?? ''
    expect(line).toContain(en.wb_step_search) // 'Searching sources'
    expect(line).not.toContain('search_source')
  })
})

describe('ActivityTicker · 无动作时沉默', () => {
  it('tool=null → 组件不渲染（返回 null）', () => {
    const { container } = renderTicker(null, 'S01E32')
    expect(container.firstChild).toBeNull()
    expect(screen.queryByTestId('wb-ticker')).toBeNull()
  })
})
