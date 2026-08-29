// web/src/settings/EngineRow.test.tsx：Behavior 区 Engine 行——开关态直读 settings.engineEnabled
// （后端别名布尔，不经字符串解析）；翻转 = 单键 PUT engine_enabled（useFieldCommit 同管）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { api } from '../api/client.js'
import type { SettingsDTO } from '../api/types.js'
import { BehaviorSection } from './BehaviorSection.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SETTINGS: SettingsDTO = {
  target_languages: 'zh',
  ai_translate_enabled: null, translate_after_attempts: null,
  hardsub_mode: null,
  scan_interval_ms: null,
  trace_retention_days: null,
  engine_enabled: null,
  'provider:SUBHD_ENABLED': null,
  'provider:ZIMUKU_ENABLED': null,
  engineEnabled: false,
}

function renderSection(data: SettingsDTO = SETTINGS) {
  return render(
    <I18nProvider initialLang="en">
      <BehaviorSection settings={{ data, loading: false, error: null, reload: () => {} }} />
    </I18nProvider>,
  )
}

describe('EngineRow', () => {
  it('engineEnabled=false → Engine 行渲染且开关为关', () => {
    renderSection()
    expect(screen.getByText('Engine')).toBeInTheDocument()
    // 这一行的描述文案是 settings_engine_desc（Behavior 区的行说明）。
    // 注意别拿 engine_banner_off（"Engine off — polling and dispatch are paused."）来断言：
    // 那句是 Task 24 后半段那个**全局 banner** 的文案，BehaviorSection 里根本不渲染它。
    expect(
      screen.getByText('Master switch for scanning, fetching and all automatic work.'),
    ).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'Engine' })).not.toBeChecked()
  })

  it('翻转开关 → PUT { engine_enabled: "true" }，响应回写本地', async () => {
    const update = vi.spyOn(api, 'updateSettings').mockResolvedValue({ ...SETTINGS, engineEnabled: true })
    renderSection()
    // 必须带 name 限定：BehaviorSection 还有其它控件；裸 getByRole('switch') 在多开关时会炸。
    fireEvent.click(screen.getByRole('switch', { name: 'Engine' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith({ engine_enabled: 'true' }))
    // 响应回写本地：mock 响应带 engineEnabled: true，useFieldCommit 用响应体更新 settings，
    // 开关必须跟着翻成开——用例名承诺的"响应回写本地"此前没有断言兜底。
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Engine' })).toBeChecked())
  })
})
