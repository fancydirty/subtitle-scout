// web/src/settings/BehaviorSection.test.tsx：行为区——五项 null 值默认占位 + 重启注记在场 +
// 单键 PUT body 断言 + 400 行内 error（不弹窗）。settings 数据面直接以 Async<SettingsDTO> prop
// 注入（同 workflow/PendingLane.test.tsx 的既有先例：组件本身只认 Async<T> 形状，不关心数据
// 从 hook 还是从测试构造），只有单键 PUT 走真的 fetch mock。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { BehaviorSection } from './BehaviorSection.js'
import type { Async } from '../api/hooks.js'
import type { SettingsDTO } from '../api/types.js'

const NULL_SETTINGS: SettingsDTO = {
  target_languages: null, hardsub_mode: null, exclude_extras: null,
  trace_retention_days: null, scan_interval_ms: null,
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
  it('target_languages 空占位=zh；hardsub_mode 默认选中 agent；重启注记在场', () => {
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('textbox', { name: 'Target languages' })
    expect(input).toHaveAttribute('placeholder', 'zh')

    const mode = screen.getByRole('combobox', { name: 'Hardsub assumption' })
    expect(mode.textContent).toContain('Agent')

    expect(
      screen.getByText('Saved immediately, but only takes effect after the daemon restarts — it reads this setting once at startup.'),
    ).toBeInTheDocument()

    const excludeExtras = screen.getByRole('switch', { name: 'Exclude extras' })
    expect(excludeExtras).not.toBeChecked()

    const traceDays = screen.getByRole('spinbutton', { name: 'Trace retention (days)' })
    expect(traceDays).toHaveAttribute('placeholder', '30')
    const scanInterval = screen.getByRole('spinbutton', { name: 'Scan interval (ms)' })
    expect(scanInterval).toHaveAttribute('placeholder', '900000')

    // hardsub_mode/exclude_extras 共用救援官注记；trace/scan 共用"未消费"注记——各出现两次。
    expect(
      screen.getAllByText('Saved, but the execution logic ships with the rescue-officer campaign — not consumed yet.'),
    ).toHaveLength(2)
    expect(
      screen.getAllByText('Saved, but not read by the backend yet — this value has no effect currently.'),
    ).toHaveLength(2)
  })

  it('已设置值原样回显（非默认占位）', () => {
    renderSection(
      asyncOf({
        target_languages: 'zh,en', hardsub_mode: 'aggressive', exclude_extras: 'true',
        trace_retention_days: '14', scan_interval_ms: '600000',
      }),
    )
    expect(screen.getByRole('textbox', { name: 'Target languages' })).toHaveValue('zh,en')
    expect(screen.getByRole('combobox', { name: 'Hardsub assumption' }).textContent).toContain('Aggressive')
    expect(screen.getByRole('switch', { name: 'Exclude extras' })).toBeChecked()
    expect(screen.getByRole('spinbutton', { name: 'Trace retention (days)' })).toHaveValue(14)
    expect(screen.getByRole('spinbutton', { name: 'Scan interval (ms)' })).toHaveValue(600000)
  })
})

describe('BehaviorSection：单键即时 PUT', () => {
  it('target_languages 失焦提交，body 只含这一个键，成功后以响应回写', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, target_languages: 'zh,en' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('textbox', { name: 'Target languages' })
    fireEvent.change(input, { target: { value: 'zh,en' } })
    fireEvent.blur(input)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ target_languages: 'zh,en' })
  })

  it('hardsub_mode 选中即刻单键 PUT', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, hardsub_mode: 'off' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    fireEvent.click(screen.getByRole('combobox', { name: 'Hardsub assumption' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Off', hidden: true }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ hardsub_mode: 'off' })
  })

  it('exclude_extras 切换即刻单键 PUT', async () => {
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, exclude_extras: 'true' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    fireEvent.click(screen.getByRole('switch', { name: 'Exclude extras' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [RequestInfo, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ exclude_extras: 'true' })
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

  it('同一草稿背靠背触发两次失焦（未等前一次响应落地）也只发一次 PUT', async () => {
    // 复现的真实场景：真实浏览器里点击 Save 按钮时，鼠标按下会先让输入框失焦（触发 trySave
    // 调用①），React 18 的自动批处理不保证 saving=true 这次重渲染在同一个原生事件里赶在按钮
    // 自己的 click 之前提交，按钮可能还没来得及变 disabled，onClick 又调用一次 trySave（调用
    // ②）。这里不经过按钮（按钮一旦 disabled 会天然挡掉第二次点击，测不出问题），直接对同一个
    // 输入框背靠背派发两次 blur，绕开按钮的 disabled 闸门，直接施压 useFieldCommit 的
    // inFlightRef 同步去重闸本身。
    const fetchMock = mockPut(200, { ...NULL_SETTINGS, target_languages: 'zh,en' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('textbox', { name: 'Target languages' })
    fireEvent.change(input, { target: { value: 'zh,en' } })
    fireEvent.blur(input)
    fireEvent.blur(input)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('未改动直接失焦不发请求', () => {
    const fetchMock = mockPut(200, NULL_SETTINGS)
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('textbox', { name: 'Target languages' })
    fireEvent.blur(input)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('400 失败 → 行内红字 error，不弹窗', async () => {
    const fetchMock = mockPut(400, { error: 'must be comma-separated BCP-47 primary codes, e.g. "zh,en"' })
    vi.stubGlobal('fetch', fetchMock)
    renderSection(asyncOf(NULL_SETTINGS))

    const input = screen.getByRole('textbox', { name: 'Target languages' })
    fireEvent.change(input, { target: { value: 'not-valid!!' } })
    fireEvent.blur(input)

    expect(
      await screen.findByText(/Couldn't save: .*must be comma-separated BCP-47/),
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
