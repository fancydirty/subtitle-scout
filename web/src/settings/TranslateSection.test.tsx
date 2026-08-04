import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { TranslateSection } from './TranslateSection.js'
import type { SettingsDTO, DeploySettingsDTO } from '../api/types.js'
import type { Async } from '../api/hooks.js'

vi.mock('../api/client.js', () => ({
  api: {
    updateSettings: vi.fn(async (body: Record<string, string>) => ({
      target_languages: null, hardsub_mode: null, exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null,
      ai_translate_enabled: body.ai_translate_enabled ?? null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      engineEnabled: false,
    } satisfies SettingsDTO)),
  },
}))
import { api } from '../api/client.js'

function asyncOf<T>(data: T): Async<T> {
  return { data, loading: false, error: null, reload: () => {} }
}

const baseSettings: SettingsDTO = {
  target_languages: null, hardsub_mode: null, exclude_extras: null,
  trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
  engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
  engineEnabled: false,
}

function deployWith(gate: { baseUrl?: boolean; model?: boolean; key?: boolean }): DeploySettingsDTO {
  const blank = { present: false, tail: '' }
  return {
    secrets: {
      TMDB_API_KEY: blank, LLM_API_KEY: blank, DASHBOARD_TOKEN: blank,
      ASSRT_TOKEN: blank, OPENSUBTITLES_API_KEY: blank, OPENSUBTITLES_PASSWORD: blank,
      TRANSLATE_API_KEY: gate.key ? { present: true, tail: 'abcd' } : blank,
      JIMAKU_API_KEY: blank,
    },
    nonSecrets: {
      LLM_BASE_URL: null, LLM_MODEL: null, LLM_EXTRA_BODY: null, OPENSUBTITLES_USERNAME: null,
      ZIMUKU_ENABLED: null, DASHBOARD_PORT: '8099', SUBTITLE_SCOUT_CACHE_DIR: null,
      LOG_RETAIN_DAYS: null, REALIGN_ARCHIVE_ROOT: null, FFPROBE_PATH: null,
      SCAN_INTERVAL_MS: null, MEDIA_ROOTS: null, TMDB_BASE_URL: null, TMDB_PROXY_URL: null,
      TARGET_LANGUAGES: null, SKIP_CHINESE_ORIGIN: null,
      TRANSLATE_BASE_URL: gate.baseUrl ? 'https://x/v1' : null,
      TRANSLATE_MODEL: gate.model ? 'mimo-v2.5-pro' : null,
      TRANSLATE_CRITIC: null, TRANSLATE_CRITIC_MODEL: null, TRANSLATE_TIMEOUT_MS: null,
      SUBHD_ENABLED: null,
    },
  }
}

describe('TranslateSection（AI 翻译区：部署门 + 烧钱开关确认流 + 休眠警示）', () => {
  beforeEach(() => { vi.clearAllMocks() })
  afterEach(cleanup)

  it('部署门三件套 present/absent 如实渲染', () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf(baseSettings)}
        deploy={asyncOf(deployWith({ baseUrl: true, model: true, key: false }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    expect(screen.getByTestId('translate-gate-TRANSLATE_BASE_URL')).toHaveTextContent('present')
    expect(screen.getByTestId('translate-gate-TRANSLATE_MODEL')).toHaveTextContent('present')
    expect(screen.getByTestId('translate-gate-TRANSLATE_API_KEY')).toHaveTextContent('absent')
  })

  it('off→on 弹确认流(不直接 PUT);确认后才 PUT true', async () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf(baseSettings)}
        deploy={asyncOf(deployWith({ baseUrl: true, model: true, key: true }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('switch'))
    expect(api.updateSettings).not.toHaveBeenCalled()
    expect(screen.getByText('Enable AI translation?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ ai_translate_enabled: 'true' }))
  })

  it('确认流取消 → 不 PUT', () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf(baseSettings)}
        deploy={asyncOf(deployWith({ baseUrl: true, model: true, key: true }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('switch'))
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(api.updateSettings).not.toHaveBeenCalled()
  })

  it('on→off 直存不弹窗', async () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf({ ...baseSettings, ai_translate_enabled: 'true' })}
        deploy={asyncOf(deployWith({ baseUrl: true, model: true, key: true }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ ai_translate_enabled: 'false' }))
    // 判"未打开"用 role 缺席而不是标题文本；role 是 alertdialog（Astryx/Radix 两版同），
    // Radix 关闭即整棵卸载——这条断言因此真的区分开/关两态。
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('开关开但部署门缺失 → 休眠警示 Banner', () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf({ ...baseSettings, ai_translate_enabled: 'true' })}
        deploy={asyncOf(deployWith({ baseUrl: true, model: false, key: true }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    expect(screen.getByTestId('translate-dormant-warning')).toBeInTheDocument()
  })

  it('部署门就绪 → 无休眠警示', () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf({ ...baseSettings, ai_translate_enabled: 'true' })}
        deploy={asyncOf(deployWith({ baseUrl: true, model: true, key: true }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    expect(screen.queryByTestId('translate-dormant-warning')).not.toBeInTheDocument()
  })
})

describe('TranslateSection：迁移锁', () => {
  it('DOM 里不再有 astryx-* 类名（gate 三行 + Switch 子树）', () => {
    render(
      <I18nProvider>
      <TranslateSection
        settings={asyncOf(baseSettings)}
        deploy={asyncOf(deployWith({ baseUrl: true, model: true, key: false }))}
        onUpdated={() => {}}
      />
      </I18nProvider>,
    )
    expect(document.body.querySelector('[class*="astryx"]')).toBeNull()
  })
})
