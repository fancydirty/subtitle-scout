// web/src/settings/BehaviorSection.tsx：行为区（dashboard-F6）——五项行为级设置，逐项改动即时
// 单键 PUT（成功以响应回写本地状态；失败行内红字 error（各行末尾的 <p className="text-fn-red">），
// 不弹窗）。三态由这一个组件自理（DESIGN.md 铁律：Loading/Empty/Error 三态每屏全覆盖），local 是
// 这份状态的唯一写手——settings hook 的 data 只作首载种子，之后每次单键 PUT 成功都直接拿响应体
// 覆盖 local，不需要重新 GET。
//
// 已知债务如实标注（DESIGN.md §8）：target_languages/scan_interval_ms/trace_retention_days 已真
// 消费；hardsub_mode/exclude_extras 均已保存且被消费（cli/index.ts live getter，下一轮扫描/派发
// 生效——救援官战役已上线）。ai_translate_enabled 行已迁至 TranslateSection.tsx（Wave 3）。
//
// 控件栈（Plan C Task 25 迁移）：Astryx Switch/TextInput/Selector/NumberInput/Button 全卸——
// Switch/Input/Select/Button 走 components/ui 的 shadcn copy-in（Switch 的 value/onChange 改名
// checked/onCheckedChange；Selector 换 Radix Select 五件；NumberInput 换 Input type="number"）。
// 可及名契约：Astryx 把 label prop 提升为可及名，shadcn/Radix 件没有 label prop——全部手写
// aria-label 对齐既有 12 条 role+name 测试契约（见 BehaviorSection.test.tsx 末尾迁移锁）。
import { useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button.js'
import { EmptyState } from '../components/ui/empty-state.js'
import { Input } from '../components/ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select.js'
import { Switch } from '../components/ui/switch.js'
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
 *  把 hardsub_mode 行也标红）。inFlightRef 是同步去重闸：TargetLanguagesRow 把 Input 和
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
  const { saving, error, commit } = useFieldCommit(onUpdated)
  // settings 值可 null（未设）——后端 cli/targetLanguages.ts 对未设降级 'zh'（历史默认），
  // 这里照同一口径用 DEFAULT_TARGET_LANGUAGES（='zh'）兜底显示。
  const value = settings.target_languages ?? DEFAULT_TARGET_LANGUAGES

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium leading-5 text-foreground">
        {t('settings_target_languages_label')}
      </span>
      <Select
        value={value}
        onValueChange={(v) => void commit('target_languages', v)}
        disabled={saving}
      >
        <SelectTrigger aria-label={t('settings_target_languages_label')} className="max-w-[280px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* 同值重选提交：每个 SelectItem 额外挂 onClick 提交（对齐 HardsubModeRow 的既有模式：
              Radix Select 的 onValueChange 对同值重选去重不发，鼠标提交走 item onClick 对齐
              Astryx 语义；改值时两条路径同拍各调一次 commit，第二次被 inFlightRef 同步闸挡掉）。 */}
          <SelectItem value="zh" onClick={() => void commit('target_languages', 'zh')}>
            中文 (Chinese)
          </SelectItem>
          <SelectItem value="en" onClick={() => void commit('target_languages', 'en')}>
            英语 (English)
          </SelectItem>
          <SelectItem value="ja" onClick={() => void commit('target_languages', 'ja')}>
            日语 (Japanese)
          </SelectItem>
          <SelectItem value="ko" onClick={() => void commit('target_languages', 'ko')}>
            韩语 (Korean)
          </SelectItem>
          <SelectItem value="es" onClick={() => void commit('target_languages', 'es')}>
            西班牙语 (Spanish)
          </SelectItem>
          <SelectItem value="fr" onClick={() => void commit('target_languages', 'fr')}>
            法语 (French)
          </SelectItem>
          <SelectItem value="de" onClick={() => void commit('target_languages', 'de')}>
            德语 (German)
          </SelectItem>
          <SelectItem value="pt" onClick={() => void commit('target_languages', 'pt')}>
            葡萄牙语 (Portuguese)
          </SelectItem>
          <SelectItem value="ru" onClick={() => void commit('target_languages', 'ru')}>
            俄语 (Russian)
          </SelectItem>
          <SelectItem value="it" onClick={() => void commit('target_languages', 'it')}>
            意大利语 (Italian)
          </SelectItem>
        </SelectContent>
      </Select>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_target_languages_description')}
      </span>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_target_languages_restart_note')}
      </span>
      {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
    </div>
  )
}

function HardsubModeRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  // settings 值可 null（未设）——后端 cli/index.ts 对未设/脏值一律降级 'off'，现网 Astryx 版
  // 就用 text.ts 的 DEFAULT_HARDSUB_MODE（='off'）兜底显示，这里照原口径保留同一常量。
  const value = settings.hardsub_mode ?? DEFAULT_HARDSUB_MODE

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium leading-5 text-foreground">
        {t('settings_hardsub_mode_label')}
      </span>
      <Select
        value={value}
        onValueChange={(v) => void commit('hardsub_mode', v)}
        disabled={saving}
      >
        <SelectTrigger aria-label={t('settings_hardsub_mode_label')} className="max-w-[280px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {/* 每个 SelectItem 额外挂 onClick 提交：Astryx Selector 对"重选同一个值"也照常
              onChange（既有用例就是在 null→'off' 兜底下重选 'Off' 并断言 PUT {hardsub_mode:'off'}），
              而受控 Radix Select 的 onValueChange 对同值重选去重不发——鼠标提交因此走 item onClick
              对齐 Astryx 语义；onValueChange 保留给键盘选择（Enter/Space 只触发它）。改值时两条
              路径同拍各调一次 commit，第二次被 useFieldCommit 的 inFlightRef 同步闸挡掉。键盘同值
              重选则提交零次（Enter→onValueChange 去重不发、item onClick 键盘不触发）——这条路径
              在 Astryx/Radix 两版实现里都无测试覆盖，差异良性，别为它"修"出什么来。 */}
          <SelectItem value="off" onClick={() => void commit('hardsub_mode', 'off')}>
            {t('settings_hardsub_mode_option_off')}
          </SelectItem>
          <SelectItem value="agent" onClick={() => void commit('hardsub_mode', 'agent')}>
            {t('settings_hardsub_mode_option_agent')}
          </SelectItem>
          <SelectItem value="aggressive" onClick={() => void commit('hardsub_mode', 'aggressive')}>
            {t('settings_hardsub_mode_option_aggressive')}
          </SelectItem>
        </SelectContent>
      </Select>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_hardsub_mode_note')}
      </span>
      {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
    </div>
  )
}

function ExcludeExtrasRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  const value = settings.exclude_extras === 'true'

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Switch
          aria-label={t('settings_exclude_extras_label')}
          checked={value}
          onCheckedChange={(checked) => void commit('exclude_extras', checked ? 'true' : 'false')}
          disabled={saving}
        />
        <span className="text-[13px] font-medium leading-5 text-foreground">
          {t('settings_exclude_extras_label')}
        </span>
      </div>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_exclude_extras_restart_note')}
      </span>
      {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
    </div>
  )
}

function EngineRow({ settings, onUpdated }: RowProps) {
  const { t } = useT()
  const { saving, error, commit } = useFieldCommit(onUpdated)
  // settings.engineEnabled 是后端序列化的布尔别名（apiV2 settings GET 的 engineEnabled），
  // 不经字符串解析；PUT 走 SettingsPatch 的 engine_enabled 键，响应回写同一别名。
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Switch
          aria-label={t('settings_engine_label')}
          checked={settings.engineEnabled}
          onCheckedChange={(checked) => void commit('engine_enabled', checked ? 'true' : 'false')}
          disabled={saving}
        />
        <span className="text-[13px] font-medium leading-5 text-foreground">
          {t('settings_engine_label')}
        </span>
      </div>
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_engine_desc')}
      </span>
      {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
    </div>
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
    // NaN 闸：真实浏览器 type=number 会把非法输入清成 ''（走上面的 null 早退），jsdom 不拦——
    // Number('12abc')=NaN 一旦漏进草稿，String(NaN)='NaN' 会被当成合法值发 PUT，这里永久关死。
    if (Number.isNaN(draft)) return
    if (String(draft) === committedStr) return
    void commit(settingKey, String(draft))
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium leading-5 text-foreground">{label}</span>
      {/* Input type="number"：role="spinbutton" 由 type 自动提供；空串↔null 互换保留既有
          "清空即删"语义（jsdom 不拦非数字输入，但测试只填合法值，现状语义保持）。 */}
      <Input
        type="number"
        aria-label={label}
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value === '' ? null : Number(e.target.value))}
        onBlur={trySave}
        onKeyDown={(e) => { if (e.key === 'Enter') trySave() }}
        min={1}
        step={1}
        placeholder={placeholder}
        disabled={saving}
      />
      <span className="text-[11px] leading-4 text-muted-foreground">{note}</span>
      {error ? <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p> : null}
    </div>
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
        <span className="text-[13px] font-medium leading-5 text-foreground">
          {t('settings_behavior_heading')}
        </span>
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">
          loading…
        </span>
      </section>
    )
  }
  if (settings.error && !local) {
    return (
      <section className="settings-section">
        <span className="text-[13px] font-medium leading-5 text-foreground">
          {t('settings_behavior_heading')}
        </span>
        <EmptyState
          isCompact
          title={t('settings_error_prefix') + settings.error}
          actions={<Button variant="secondary" onClick={settings.reload}>{t('settings_retry_label')}</Button>}
        />
      </section>
    )
  }
  if (!local) return null

  return (
    <section className="settings-section">
      <span className="text-[13px] font-medium leading-5 text-foreground">
        {t('settings_behavior_heading')}
      </span>
      <div className="flex flex-col gap-5">
        <EngineRow settings={local} onUpdated={setLocal} />
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
      </div>
    </section>
  )
}
