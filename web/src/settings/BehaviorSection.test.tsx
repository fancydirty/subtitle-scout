// web/src/settings/BehaviorSection.test.tsx：行为区——五项 null 值默认占位 + 重启注记在场 +
// 单键 PUT body 断言 + 400 行内 error（不弹窗）。settings 数据面直接以 Async<SettingsDTO> prop
// 注入（同 workflow/PendingLane.test.tsx 的既有先例：组件本身只认 Async<T> 形状，不关心数据
// 从 hook 还是从测试构造），只有单键 PUT 走真的 fetch mock。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { openRadixSelect } from '../testSupport/radix.js'
import { SELECTABLE_TARGET_LANGUAGES } from '../../../src/agent/languages.js'
import { BehaviorSection } from './BehaviorSection.js'
import type { Async } from '../api/hooks.js'
import type { SettingsDTO } from '../api/types.js'

const NULL_SETTINGS: SettingsDTO = {
  target_languages: null, hardsub_mode: null,
  trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
  engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
  engineEnabled: false,
}

function asyncOf(data: SettingsDTO | null, error: string | null = null): Async<SettingsDTO> {
  return { data, loading: false, error, reload: vi.fn() }
}

function requestInfo(input: RequestInfo | URL): { path: string; method: string } {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  return { path: raw.split('?')[0], method: 'PUT' }
}

function mockPut(status: number, body: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void requestInfo(input)
    void init
    return { ok: status < 400, status, json: async () => body } as unknown as Response
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderSection(settings: Async<SettingsDTO>) {
  return render(
    <I18nProvider>
      <BehaviorSection settings={settings} />
    </I18nProvider>,
  )
}

describe('BehaviorSection：null 值默认占位', () => {
  it('target_languages 空占位=zh；hardsub_mode 默认 off（PM 审计对齐后端口径）；生效注记在场', () => {
    renderSection(asyncOf(NULL_SETTINGS))

    const select = screen.getByRole('combobox', { name: 'Target subtitle language' })
    expect(select.textContent).toContain('Chinese')
    expect(select.textContent).not.toContain('中文')

    const mode = screen.getByRole('combobox', { name: 'Hardsub assumption' })
    expect(mode.textContent).toContain('Off')

    expect(screen.queryByRole('switch', { name: 'Exclude extras' })).toBeNull()

    const traceDays = screen.getByRole('spinbutton', { name: 'Trace retention (days)' })
    expect(traceDays).toHaveAttribute('placeholder', '30')
    const scanInterval = screen.getByRole('spinbutton', { name: 'Scan interval (minutes)' })
    expect(scanInterval).toHaveAttribute('placeholder', '15')

    expect(
      screen.getAllByText('Takes effect on the next library scan.'),
    ).toHaveLength(1)
    expect(
      screen.getByText('Takes effect on the next dispatched find-subtitle task.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Takes effect at the daily trace cleanup.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Takes effect on the next scan tick.'),
    ).toBeInTheDocument()
  })

  it('已设置值原样回显（非默认占位）', () => {
    renderSection(
      asyncOf({
        target_languages: 'en', hardsub_mode: 'aggressive',
        trace_retention_days: '14', scan_interval_ms: '600000', ai_translate_enabled: 'true',
        engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
        engineEnabled: false,
      }),
    )
    expect(screen.getByRole('combobox', { name: 'Target subtitle language' }).textContent).toBe('English')
    expect(screen.getByRole('combobox', { name: 'Hardsub assumption' }).textContent).toContain('Aggressive')
    expect(screen.getByRole('spinbutton', { name: 'Trace retention (days)' })).toHaveValue(14)
    expect(screen.getByRole('spinbutton', { name: 'Scan interval (minutes)' })).toHaveValue(10)
  })

  it('ai_translate 行已迁至 TranslateSection（Wave 3），BehaviorSection 不再渲染该开关', () => {
    renderSection(asyncOf(NULL_SETTINGS))
    expect(screen.queryByRole('switch', { name: 'AI subtitle translation' })).not.toBeInTheDocument()
  })
})

// 🔴 C51 对账守卫（前端半边）：渲染出来的语言选项集必须**逐一等于**后端共享常量
// SELECTABLE_TARGET_LANGUAGES。后端 languages.test.ts 那半边守「常量里的每个码都有名字与
// 磁盘标签」，这半边守「设置页没有偷偷多出/少掉一个常量不知道的选项」——两边合起来才闭环。
// 少了这半边，将来有人直接往 JSX 里加第 11 个 <SelectItem> 仍然静默（正是 2026-08-26 pt 实案
// 的发生方式）。
describe('🔴 C51 BehaviorSection ↔ 后端语言码表对账', () => {
  it('渲染的目标语言选项集逐一等于 SELECTABLE_TARGET_LANGUAGES（不许 JSX 里偷加选项）', async () => {
    renderSection(asyncOf(NULL_SETTINGS))
    await openRadixSelect(screen.getByRole('combobox', { name: 'Target subtitle language' }))

    const rendered = (await screen.findAllByRole('option', { hidden: true }))
      .map((el) => el.getAttribute('data-lang'))
    expect(rendered).toEqual([...SELECTABLE_TARGET_LANGUAGES])
  })
})

describe('BehaviorSection：单键即时 PUT', () => {
  it('target_languages 选中即刻单键 PUT，body 只含这一个键，成功后以响应回写', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, target_languages: 'en' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    openRadixSelect(screen.getByRole('combobox', { name: 'Target subtitle language' }))
    fireEvent.click(await screen.findByRole('option', { name: 'English', hidden: true }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ target_languages: 'en' })
  })

  it('hardsub_mode 选中即刻单键 PUT', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, hardsub_mode: 'off' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    openRadixSelect(screen.getByRole('combobox', { name: 'Hardsub assumption' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Off', hidden: true }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ hardsub_mode: 'off' })
  })

  it('scan_interval 已设置值未改动时失焦不重复 PUT（换算后与存储值比较）', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, scan_interval_ms: '600000' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf({ ...NULL_SETTINGS, scan_interval_ms: '600000' }))

    const input = screen.getByRole('spinbutton', { name: 'Scan interval (minutes)' })
    expect(input).toHaveValue(10)
    fireEvent.blur(input)
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled())
  })

  it('scan_interval 按分钟显示、提交时换算成后端毫秒', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, scan_interval_ms: '1200000' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('spinbutton', { name: 'Scan interval (minutes)' })
    fireEvent.change(input, { target: { value: '20' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ scan_interval_ms: '1200000' })
  })

  it('trace_retention_days 回车提交单键 PUT', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, trace_retention_days: '14' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('spinbutton', { name: 'Trace retention (days)' })
    fireEvent.change(input, { target: { value: '14' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ trace_retention_days: '14' })
  })

  it('TargetLanguagesRow 同值重选单键提交（同步闸对齐 HardsubModeRow）', async () => {
    // Select 同值重选行为：onValueChange 去重不发，鼠标提交走 SelectItem onClick（每个 item
    // 挂了显式 onClick 调 commit），第二次被 useFieldCommit 的 inFlightRef 同步闸挡住。
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, target_languages: 'zh' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf({ ...NULL_SETTINGS, target_languages: 'zh' }))

    await openRadixSelect(screen.getByRole('combobox', { name: 'Target subtitle language' }))
    fireEvent.click(screen.getByRole('option', { name: 'Chinese' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ target_languages: 'zh' })
  })

  it('target_languages 改值提交失败 → 行内红字 error，不弹窗', async () => {
    const fetchMock = mockPut(400, { error: 'invalid language code' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    await openRadixSelect(screen.getByRole('combobox', { name: 'Target subtitle language' }))
    fireEvent.click(screen.getByRole('option', { name: 'English' }))

    expect(
      await screen.findByText(/Couldn't save: .*invalid language code/),
    ).toBeInTheDocument()
    // 没有弹出对话框——错误就地行内展示（DESIGN.md §8：不弹窗）。
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('BehaviorSection：三态', () => {
  it('loading 且无数据时不渲染表单', () => {
    render(
      <I18nProvider>
        <BehaviorSection settings={{ data: null, loading: true, error: null, reload: vi.fn() }} />
      </I18nProvider>,
    )
    expect(screen.queryByRole('textbox', { name: 'Target languages' })).not.toBeInTheDocument()
  })

  it('error 且无数据时展示重试', () => {
    const reload = vi.fn()
    render(
      <I18nProvider>
        <BehaviorSection settings={{ data: null, loading: false, error: 'boom', reload }} />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(reload).toHaveBeenCalled()
  })
})

describe('BehaviorSection：迁移锁', () => {
  it('五个控件的可及名与既有契约逐字一致（aria-label 手写对齐 Astryx label 提升）', () => {
    renderSection(asyncOf(NULL_SETTINGS))
    expect(screen.getByRole('switch', { name: 'Engine' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Target subtitle language' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Hardsub assumption' })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Exclude extras' })).toBeNull()
    expect(screen.getByRole('spinbutton', { name: 'Trace retention (days)' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: 'Scan interval (minutes)' })).toBeInTheDocument()
  })

  it('DOM 里不再有 astryx-* 类名', () => {
    const { container } = renderSection(asyncOf(NULL_SETTINGS))
    expect(container.querySelector('[class*="astryx"]')).toBeNull()
  })

  it('Selector 换成 Radix Select 后 option 语义照旧（关闭不可及、pointerdown 可开）', async () => {
    renderSection(asyncOf(NULL_SETTINGS))
    expect(screen.queryByRole('option', { name: 'Off', hidden: true })).toBeNull()
    openRadixSelect(screen.getByRole('combobox', { name: 'Hardsub assumption' }))
    expect(await screen.findByRole('option', { name: 'Off', hidden: true })).toBeInTheDocument()
  })
})
