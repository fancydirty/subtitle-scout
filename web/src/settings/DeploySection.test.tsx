// web/src/settings/DeploySection.test.tsx：部署区（只读）——secrets present/absent 圆点+同色词+
// 尾 4 位、nonSecrets 原样字符串/em dash、顶部只读注记在场、零输入控件（无 input/button/其它
// 可交互元素）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { DeploySection } from './DeploySection.js'
import type { Async } from '../api/hooks.js'
import type { DeploySettingsDTO } from '../api/types.js'

afterEach(() => cleanup())

function asyncOf(data: DeploySettingsDTO | null, error: string | null = null): Async<DeploySettingsDTO> {
  return { data, loading: false, error, reload: () => {} }
}

const DATA: DeploySettingsDTO = {
  secrets: {
    TMDB_API_KEY: { present: true, tail: 'abcd' },
    DASHBOARD_TOKEN: { present: false, tail: '' },
  },
  nonSecrets: {
    LLM_MODEL: 'gpt-5',
    DASHBOARD_PORT: null,
  },
}

describe('DeploySection：只读展示', () => {
  it('顶部只读注记在场', () => {
    render(
      <I18nProvider>
        <DeploySection deploy={asyncOf(DATA)} />
      </I18nProvider>,
    )
    expect(screen.getByText('deploy-level, read-only — edit via environment/compose')).toBeInTheDocument()
  })

  it('secrets：present 圆点+同色词+尾4位；absent 圆点+同色词+em dash', () => {
    render(
      <I18nProvider>
        <DeploySection deploy={asyncOf(DATA)} />
      </I18nProvider>,
    )
    expect(screen.getByText('TMDB_API_KEY')).toBeInTheDocument()
    expect(screen.getByText('····abcd')).toBeInTheDocument()
    expect(screen.getByText('DASHBOARD_TOKEN')).toBeInTheDocument()
    expect(screen.getAllByText('configured')).toHaveLength(1)
    expect(screen.getAllByText('not set').length).toBeGreaterThanOrEqual(1)
  })

  it('nonSecrets：原样字符串；null 显示 em dash', () => {
    render(
      <I18nProvider>
        <DeploySection deploy={asyncOf(DATA)} />
      </I18nProvider>,
    )
    expect(screen.getByText('LLM_MODEL')).toBeInTheDocument()
    expect(screen.getByText('gpt-5')).toBeInTheDocument()
    expect(screen.getByText('DASHBOARD_PORT')).toBeInTheDocument()
    // 两处 em dash：DASHBOARD_PORT 的 nonSecret 值 + DASHBOARD_TOKEN 的 absent secret tail。
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('零输入控件：加载完成后的整个区域没有任何 input/button/textbox/switch/combobox', () => {
    const { container } = render(
      <I18nProvider>
        <DeploySection deploy={asyncOf(DATA)} />
      </I18nProvider>,
    )
    expect(container.querySelectorAll('input, button, textarea, select')).toHaveLength(0)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
    expect(screen.queryAllByRole('switch')).toHaveLength(0)
    expect(screen.queryAllByRole('combobox')).toHaveLength(0)
  })

  it('loading 态：无控件，纯文字提示', () => {
    const { container } = render(
      <I18nProvider>
        <DeploySection deploy={{ data: null, loading: true, error: null, reload: () => {} }} />
      </I18nProvider>,
    )
    expect(container.querySelectorAll('input, button, textarea, select')).toHaveLength(0)
  })

  it('error 态：如实展示 error 文案，仍无控件（部署区没有重试按钮，改动只能走 env/compose）', () => {
    const { container } = render(
      <I18nProvider>
        <DeploySection deploy={{ data: null, loading: false, error: 'boom', reload: () => {} }} />
      </I18nProvider>,
    )
    expect(screen.getByText("Couldn't load deploy info: boom")).toBeInTheDocument()
    expect(container.querySelectorAll('input, button, textarea, select')).toHaveLength(0)
  })

  // 审计四轮 R4：MEDIA_ROOTS 是首启种子，真正生效的是 media_roots 表。此前这一行原样展示 env
  // 值且零注解，用户改 .env 重启后看到数值变了就以为生效（实际扫描行为不变）——dashboard 自己
  // 的证据在误导用户。这两条锁住"MEDIA_ROOTS 必须带种子注解、其它键不得误加"。
  it('MEDIA_ROOTS 行带"仅首启种子"注解（指回守备目录列表）', () => {
    render(
      <I18nProvider>
        <DeploySection deploy={asyncOf({
          secrets: {},
          nonSecrets: { MEDIA_ROOTS: '/media/movies,/media/tv', LLM_MODEL: 'gpt-5' },
        })} />
      </I18nProvider>,
    )
    expect(screen.getByText('/media/movies,/media/tv')).toBeInTheDocument()
    expect(
      screen.getByText('first-boot seed only — see the guarded directories above for what is live'),
    ).toBeInTheDocument()
  })

  it('其它 nonSecrets 键不带该注解（注解只属于 MEDIA_ROOTS）', () => {
    render(
      <I18nProvider>
        <DeploySection deploy={asyncOf({ secrets: {}, nonSecrets: { LLM_MODEL: 'gpt-5' } })} />
      </I18nProvider>,
    )
    expect(
      screen.queryByText('first-boot seed only — see the guarded directories above for what is live'),
    ).not.toBeInTheDocument()
  })
})
