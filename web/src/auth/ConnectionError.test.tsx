// web/src/auth/ConnectionError.test.tsx：Plan C Task 30 迁移锁——本屏此前零测试覆盖，
// 换栈后补这一条钉：重试钮在（可及名契约）且 DOM 无 astryx-* 类名。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { ConnectionError } from './ConnectionError.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ConnectionError：迁移锁（Astryx → shadcn，Plan C Task 30）', () => {
  it('重试钮点按调 onRetry，DOM 里不再有 astryx-* 类名', () => {
    const onRetry = vi.fn()
    render(<I18nProvider><ConnectionError onRetry={onRetry} /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: /retry|重试/i }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
