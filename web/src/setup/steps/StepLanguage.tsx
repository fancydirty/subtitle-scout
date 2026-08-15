// web/src/setup/steps/StepLanguage.tsx：wizard 步 1——目标字幕语言（spec A §5.2 步 1，必填）。
// 两件事：① 首选语言即时切 UI 语言（zh* → zh，其余 → en——setLang 的第一个真实调用方，
// 联动机制的现场证明）；② Continue 时 PUT target_languages（复用既有 settings 通道，
// 值格式 = 逗号分隔无空格，与 apiV2 的 target_languages 正则同口径）。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { localizeErrorValue } from '../../lib/errorText.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { cn } from '../../lib/utils.js'
import type { WizardStepProps } from './types.js'

// 语言名是语言自己的自称，不是 UI 文案——不进 i18n 表（语言选择器的通行惯例）。
const PRESETS = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
] as const

// 与 apiV2.ts SETTINGS_VALUE_SCHEMAS.target_languages 单段同形（后端那条含逗号串联，这里校单码）。
// 前后端各一份：web 不 import src/ 是既定先例，不开创。
const BCP47_SINGLE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/

export function StepLanguage({ onAdvance }: WizardStepProps) {
  const { t, setLang, lang } = useT()
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const apply = (next: string[]) => {
    setSelected(next)
    // spec：首选语言决定 UI 语言，即时生效并持久化（useT 内部写 localStorage scout-lang）。
    if (next.length > 0) setLang(next[0].toLowerCase().startsWith('zh') ? 'zh' : 'en')
  }

  const toggle = (code: string) => {
    // 单选：点击已选的不取消，点击其他的替换（有且只能有一个）
    apply([code])
  }

  const addCustom = () => {
    const code = custom.trim()
    if (!BCP47_SINGLE.test(code)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setCustom('')
    // 单选：添加自定义语言时替换当前选择
    apply([code])
  }

  const onContinue = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await api.updateSettings({ target_languages: selected.join(',') })
      onAdvance()
    } catch (e) {
      setSaveError(localizeErrorValue(e, lang))
    } finally {
      setSaving(false)
    }
  }

  const presetCodes: readonly string[] = PRESETS.map((p) => p.code)
  const customSelected = selected.filter((c) => !presetCodes.includes(c))

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('wizard_step_language_title')}>
        {PRESETS.map((p) => {
          const active = selected.includes(p.code)
          return (
            <button
              key={p.code}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(p.code)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm transition-colors',
                active
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          )
        })}
        {customSelected.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed
            onClick={() => toggle(c)}
            className="rounded-full border border-foreground bg-foreground px-4 py-1.5 text-sm text-background transition-colors"
          >
            {c}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value)
            setInvalid(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addCustom()
          }}
          placeholder={t('wizard_language_custom_placeholder')}
          aria-invalid={invalid}
          className="max-w-[260px]"
        />
        <Button variant="secondary" size="sm" onClick={addCustom}>
          {t('wizard_language_add')}
        </Button>
      </div>
      {invalid && <p className="text-sm text-fn-red">{t('wizard_language_invalid')}</p>}

      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button disabled={selected.length === 0 || saving} onClick={() => void onContinue()}>
          {t('wizard_save_continue')}
        </Button>
      </div>
    </div>
  )
}
