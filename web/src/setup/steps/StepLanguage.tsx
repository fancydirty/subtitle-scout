// web/src/setup/steps/StepLanguage.tsx：wizard 步 1——目标字幕语言（spec A §5.2 步 1，必填）。
// 两件事：① 首选语言即时切 UI 语言（zh* → zh，其余 → en——setLang 的第一个真实调用方，
// 联动机制的现场证明）；② Continue 时 PUT target_languages（复用既有 settings 通道，
// 值格式 = 逗号分隔无空格，与 apiV2 的 target_languages 正则同口径）。
//
// 2026-08-27 用户裁决：删掉「添加其他」自由输入框，预设即 SELECTABLE_TARGET_LANGUAGES
// 全集（settings 页同一份清单）。自由输入正是 pt 静默降级实案的入口形态——放进一个码表
// 没有正式支持的码，管线不报错只降级（languages.ts C51 注释是正本）。向导是新用户的第一
// 面，只给有落地保障的选项；真要小语种，设置页里选，那里与码表有双向对账守卫。
import { useState } from 'react'
import { api } from '../../api/client.js'
import { useT } from '../../i18n/useT.js'
import { localizeErrorValue } from '../../lib/errorText.js'
import { Button } from '../../components/ui/button.js'
import { cn } from '../../lib/utils.js'
import { SELECTABLE_TARGET_LANGUAGES, TARGET_LANGUAGE_AUTONYMS } from '../../settings/text.js'
import type { WizardStepProps } from './types.js'

// 语言自称表已收拢到 settings/text.ts 的 TARGET_LANGUAGE_AUTONYMS（satisfies 钉死键集；
// 设置页多语言分组标题与这里共用一份，不再各持副本）。
const PRESET_LABELS = TARGET_LANGUAGE_AUTONYMS

export function StepLanguage({ onAdvance, setTargetLanguages }: WizardStepProps) {
  const { t, setLang, lang } = useT()
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const toggle = (code: string) => {
    // 单选：点击已选的不取消，点击其他的替换（有且只能有一个）
    setSelected([code])
    // spec：首选语言决定 UI 语言，即时生效并持久化（useT 内部写 localStorage scout-lang）。
    setLang(code.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  }

  const onContinue = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const csv = selected.join(',')
      await api.updateSettings({ target_languages: csv })
      // 外壳记账（registry spec §5.2）：后续源步据此分流，ja/en 用户的开关源步整步消失。
      setTargetLanguages(csv)
      onAdvance()
    } catch (e) {
      setSaveError(localizeErrorValue(e, lang))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('wizard_step_language_title')}>
        {SELECTABLE_TARGET_LANGUAGES.map((code) => {
          const active = selected.includes(code)
          return (
            <button
              key={code}
              type="button"
              aria-pressed={active}
              onClick={() => toggle(code)}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm transition-colors',
                active
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {PRESET_LABELS[code]}
            </button>
          )
        })}
      </div>

      {saveError && <p className="text-sm text-fn-red">{saveError}</p>}

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button disabled={selected.length === 0 || saving} onClick={() => void onContinue()}>
          {t('wizard_save_continue')}
        </Button>
      </div>
    </div>
  )
}
