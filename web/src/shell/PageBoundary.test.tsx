// web/src/shell/PageBoundary.test.tsx：页级错误边界的行为守卫。
//
// 这条边界存在的理由是一个**实测过的全屏白屏**（SettingsTabsPage 读 DTO 缺失字段抛
// TypeError → React 19 卸载整棵树）。所以这里的用例不测"组件长什么样"，测的是那件事
// **不再发生**：抛错之后 DOM 里还有东西、还有人话、还有一个能用的动作。
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { PageBoundary } from './PageBoundary.js'
import { en } from '../i18n/en.js'

// React 会把被边界接住的错误照样往 console.error 打一份（外加我们自己打的那份）。
// 静音是为了让测试输出可读——**不是**为了掩盖：下面有用例专门断言我们确实打了日志。
let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function Boom({ boom }: { boom: boolean }): React.ReactElement {
  if (boom) throw new Error('kaboom from page')
  return <div>page content</div>
}

describe('PageBoundary', () => {
  it('子树正常时原样透传，不加任何可见包装', () => {
    render(
      <I18nProvider initialLang="en">
        <PageBoundary name="test"><Boom boom={false} /></PageBoundary>
      </I18nProvider>,
    )
    expect(screen.getByText('page content')).toBeInTheDocument()
    expect(screen.queryByTestId('page-failed')).not.toBeInTheDocument()
  })

  it('子树抛错时**不白屏**：降级 UI 有标题、有说明、有动作', () => {
    render(
      <I18nProvider initialLang="en">
        <PageBoundary name="test"><Boom boom={true} /></PageBoundary>
      </I18nProvider>,
    )
    // 这三条断言就是"不白屏"的操作化定义。
    expect(screen.getByTestId('page-failed')).toBeInTheDocument()
    expect(screen.getByText(en.page_failed_title)).toBeInTheDocument()
    expect(screen.getByText(en.page_failed_desc)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: en.page_failed_retry })).toBeInTheDocument()
  })

  it('降级 UI 不吐技术细节（铁律②③：堆栈只进 console）', () => {
    const { container } = render(
      <I18nProvider initialLang="en">
        <PageBoundary name="test"><Boom boom={true} /></PageBoundary>
      </I18nProvider>,
    )
    expect(container.textContent).not.toContain('kaboom')
    expect(container.textContent).not.toContain('Error')
  })

  it('错误进 console 且带页面名前缀（开发者要查得到是哪一页）', () => {
    render(
      <I18nProvider initialLang="en">
        <PageBoundary name="settings"><Boom boom={true} /></PageBoundary>
      </I18nProvider>,
    )
    const logged = spy.mock.calls.some((c: unknown[]) => String(c[0]).includes('[page:settings]'))
    expect(logged).toBe(true)
  })

  it('"重新加载这一页"会真的重挂载子树——恢复后显示正常内容', () => {
    // 用一个外部开关模拟"重试时数据已经好了"。若按钮只是清了 failed 而没换 key，
    // 子树不会重新挂载、hook 不会重发请求——这条用例守的正是那个区别。
    let shouldBoom = true
    function Flaky() {
      if (shouldBoom) throw new Error('transient')
      return <div>recovered</div>
    }
    render(
      <I18nProvider initialLang="en">
        <PageBoundary name="test"><Flaky /></PageBoundary>
      </I18nProvider>,
    )
    expect(screen.getByTestId('page-failed')).toBeInTheDocument()
    shouldBoom = false
    fireEvent.click(screen.getByRole('button', { name: en.page_failed_retry }))
    expect(screen.getByText('recovered')).toBeInTheDocument()
    expect(screen.queryByTestId('page-failed')).not.toBeInTheDocument()
  })
})
