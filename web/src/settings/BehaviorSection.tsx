// web/src/settings/BehaviorSection.tsx：行为区（dashboard-F6）——五项行为级设置，逐项改动即时
// 单键 PUT（成功以响应回写本地状态；失败行内红字 error，不弹窗，见 TextInput/Selector/
// NumberInput/Switch 各自的 status 属性）。三态由这一个组件自理（DESIGN.md 铁律：Loading/
// Empty/Error 三态每屏全覆盖），local 是这份状态的唯一写手——settings hook 的 data 只作首载
// 种子，之后每次单键 PUT 成功都直接拿响应体覆盖 local，不需要重新 GET。
//
// 已知债务如实标注（DESIGN.md §8）：target_languages/scan_interval_ms/trace_retention_days 已真
// 消费；hardsub_mode/exclude_extras 已保存但执行逻辑随救援官战役上线——两条注记各自诚实，不共用一句糊弄过去。
import { useEffect, useRef, useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { TextInput } from '@astryxdesign/core/TextInput'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { Selector } from '@astryxdesign/core/Selector'
import { Switch } from '@astryxdesign/core/Switch'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { api } from '../api/client.js'
import type { Async } from '../api/hooks.js'
import type { SettingsDTO, SettingsKey } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import {
  DEFAULT_TARGET_LANGUAGES, DEFAULT_HARDSUB_MODE,
  PLACEHOLDER_TRACE_RETENTION_DAYS, PLACEHOLDER_SCAN_INTERVAL_MS,
} from './text.js'

interface RowProps {
  settings: SettingsDTO
  onUpdated: (settings: SettingsDTO) => void
}

/** 单键提交共用的 saving/error 态——每行各自持有一份，互不干扰（改 target_languages 出错不会
 *  把 hardsub_mode 行也标红）。inFlightRef 是同步去重闸：TargetLanguagesRow 把 TextInput 和
 *  Save 按钮包在同一个 onBlur 边界里（失焦或回车提交，见该行注释），点击 Save 时鼠标按下会先
 *  让输入框失焦（触发 onBlur→trySave），再是按钮 onClick（也调 trySave）——两次调用在同一个
 *  事件循环内背靠背发生，React state 还没来得及重渲染，仅凭 saving 这个 state 判断挡不住第二
 *  次调用。ref 是同步的，第一次调用内立即置位，第二次调用能立刻读到最新值，可靠去重。 */
function useFieldCommit(onUpdated: (settings: SettingsDTO) => void) {
  const { t } = useT()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef(false)
  const commit = async (key: SettingsKey, value: string) => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setSaving(true)
    setError(null)
    try {
      const result = await api.updateSettings({ [key]: value })
      onUpdated(result)
    } catch (e) {
      setError(t('settings_save_error_prefix') + String(e))
    } finally {
      inFlightRef.current = false
      setSaving(false)
    }
  }
  return { saving, error, commit }
}

function TargetLanguagesRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const committed = settings.target_languages ?? ''
  const [draft, setDraft] = useState(committed)
  const { saving, error, commit } = useFieldCommit(onUpdated)
  // 服务端值变化时重同步草稿，但不覆盖用户正在输入、尚未提交的内容——只在草稿仍等于上一个
  // 已知已提交值时才跟随刷新（同侧栏其它表单的既有谨慎口径）。
  const lastCommittedRef = useRef(committed)
  useEffect(() => {
    if (draft === lastCommittedRef.current) setDraft(committed)
    lastCommittedRef.current = committed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed])

  const trySave = () => {
    const trimmed = draft.trim()
    if (trimmed === committed) return
    void commit('target_languages', trimmed)
  }

  return (
    <VStack gap={2}>
      {/* 失焦或回车提交（原生事件冒泡：React 的 onBlur/onKeyDown 挂在外层 div 上同样能捕获
          内部 <input> 触发的 blur/keydown），旁边另配一个显式 Save 按钮——两条路径调用同一个
          trySave，值未变时是空操作，不会发多余的 PUT。 */}
      <div onBlur={trySave} onKeyDown={(e) => { if (e.key === 'Enter') trySave() }}>
        <VStack gap={2}>
          <TextInput
            label={t('settings_target_languages_label')}
            value={draft}
            onChange={setDraft}
            placeholder={DEFAULT_TARGET_LANGUAGES}
            description={t('settings_target_languages_description')}
            status={error ? { type: 'error', message: error } : undefined}
          />
          <Button
            size="sm"
            variant="secondary"
            label={t('settings_target_languages_save_label')}
            isLoading={saving}
            onClick={trySave}
          />
        </VStack>
      </div>
      <Text type="supporting" color="secondary">
        {t('settings_target_languages_restart_note')}
      </Text>
    </VStack>
  )
}

function HardsubModeRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  const value = settings.hardsub_mode ?? DEFAULT_HARDSUB_MODE

  return (
    <VStack gap={2}>
      <Selector
        label={t('settings_hardsub_mode_label')}
        value={value}
        onChange={(v) => void commit('hardsub_mode', v)}
        isDisabled={saving}
        options={[
          { value: 'off', label: t('settings_hardsub_mode_option_off') },
          { value: 'agent', label: t('settings_hardsub_mode_option_agent') },
          { value: 'aggressive', label: t('settings_hardsub_mode_option_aggressive') },
        ]}
        status={error ? { type: 'error', message: error } : undefined}
      />
      <Text type="supporting" color="secondary">
        {t('settings_hardsub_mode_note')}
      </Text>
    </VStack>
  )
}

function ExcludeExtrasRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  const value = settings.exclude_extras === 'true'

  return (
    <VStack gap={2}>
      <Switch
        label={t('settings_exclude_extras_label')}
        value={value}
        onChange={(checked) => void commit('exclude_extras', checked ? 'true' : 'false')}
        isLoading={saving}
        status={error ? { type: 'error', message: error } : undefined}
      />
      <Text type="supporting" color="secondary">
        {t('settings_exclude_extras_restart_note')}
      </Text>
    </VStack>
  )
}

function NumberSettingRow({
  settings, onUpdated, settingKey, label, placeholder, note,
}: RowProps & { settingKey: SettingsKey; label: string; placeholder: string; note: string }) {
  const committedStr = settings[settingKey] ?? ''
  const committedNum = committedStr ? Number(committedStr) : null
  const [draft, setDraft] = useState<number | null>(committedNum)
  const { saving, error, commit } = useFieldCommit(onUpdated)
  const lastCommittedRef = useRef(committedNum)

  useEffect(() => {
    if (draft === lastCommittedRef.current) setDraft(committedNum)
    lastCommittedRef.current = committedNum
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedNum])

  const trySave = () => {
    if (draft == null) return
    if (String(draft) === committedStr) return
    void commit(settingKey, String(draft))
  }

  return (
    <VStack gap={2}>
      <NumberInput
        label={label}
        value={draft}
        onChange={setDraft}
        onBlur={trySave}
        onEnter={trySave}
        isIntegerOnly
        min={1}
        placeholder={placeholder}
        hasClear
        isDisabled={saving}
        status={error ? { type: 'error', message: error } : undefined}
      />
      <Text type="supporting" color="secondary">
        {note}
      </Text>
    </VStack>
  )
}

interface Props {
  settings: Async<SettingsDTO>
}

export function BehaviorSection({ settings }: Props) {
  const { t } = useT()
  const [local, setLocal] = useState<SettingsDTO | null>(null)

  useEffect(() => {
    if (settings.data) setLocal(settings.data)
  }, [settings.data])

  if (settings.loading && !local) {
    return (
      <section className="settings-section">
        <Text type="label">{t('settings_behavior_heading')}</Text>
        <Text type="code" color="secondary">
          loading…
        </Text>
      </section>
    )
  }
  if (settings.error && !local) {
    return (
      <section className="settings-section">
        <Text type="label">{t('settings_behavior_heading')}</Text>
        <EmptyState
          isCompact
          title={t('settings_error_prefix') + settings.error}
          actions={<Button label={t('settings_retry_label')} variant="secondary" onClick={settings.reload} />}
        />
      </section>
    )
  }
  if (!local) return null

  return (
    <section className="settings-section">
      <Text type="label">{t('settings_behavior_heading')}</Text>
      <VStack gap={5}>
        <TargetLanguagesRow settings={local} onUpdated={setLocal} />
        <HardsubModeRow settings={local} onUpdated={setLocal} />
        <ExcludeExtrasRow settings={local} onUpdated={setLocal} />
        <NumberSettingRow
          settings={local}
          onUpdated={setLocal}
          settingKey="trace_retention_days"
          label={t('settings_trace_retention_label')}
          placeholder={PLACEHOLDER_TRACE_RETENTION_DAYS}
          note={t('settings_trace_retention_note')}
        />
        <NumberSettingRow
          settings={local}
          onUpdated={setLocal}
          settingKey="scan_interval_ms"
          label={t('settings_scan_interval_label')}
          placeholder={PLACEHOLDER_SCAN_INTERVAL_MS}
          note={t('settings_scan_interval_note')}
        />
      </VStack>
    </section>
  )
}
