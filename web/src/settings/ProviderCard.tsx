// web/src/settings/ProviderCard.tsx：字幕源 keyed 卡片（spec §3.2）——env 源只读、db 源可编辑、
// 编辑/测试/lastTest。内含 ProviderSecretField（不单测，行为由本卡测试覆盖）。外壳换 SettingsCard，
// 状态判据：allConfigured → configured；hasEnvSource && !allConfigured → locked；else unconfigured。
// 空输入 = 不动该键（UI 不提供删除，防占位空串误删——删除走 TranslateCard 的显式空串提交）。
import { useMemo, useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { api } from '../api/client.js'
import type { ProviderRowDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { localizeErrorValue } from '../lib/errorText.js'
import { SettingsCard } from './SettingsCard.js'
import { SECRET_LABEL_KEY } from './secretLabels.js'

const PROVIDER_NAME: Record<ProviderRowDTO['id'], string> = {
  tmdb: 'TMDB',
  llm: 'LLM',
  translate: 'Translate',
  assrt: 'ASSRT',
  opensubtitles: 'OpenSubtitles',
  jimaku: 'Jimaku',
  subhd: 'subhd',
  zimuku: 'zimuku',
  r3sub: 'r3sub',
  subdl: 'SubDL',
}

/** 相对时长（`3h` / `12m`），与活动页状态条 relAgo 同口径同粒度——用户不必学第二套语汇。
 *  刻意不从 workbench/inspectFreshness 里 import：那是活动页的模块，设置页依赖它会把
 *  两个页面的读数语义绑死；四行的小函数，重复一次比建一条跨页依赖便宜。 */
function relDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * 🔴 配额耗尽那一行——本卡片存在配额展示位的**全部理由**。
 *
 * ── 为什么落在这里（而不是活动页顶部状态条）───────────────────────────────
 * 判据是**用户什么时候需要这个信息**：他在问"为什么 assrt 不找了"。那一刻他会去
 * 检查这个源本身——而"这个源现在什么状况"这个问题，全站只有这张卡在回答
 * （凭据配没配齐、上次测试通没通过）。配额是同一个问题的第三个侧面，跟前两者并排，
 * 用户不必在两页之间拼一个源的状态。
 * 活动页状态条已经承载六类信息（巡检/实时/守备目录/识别/巡检事件/引擎许可），
 * 而且它说的是**全局**"引擎在不在动"；配额是**单个源**的属性，塞进去既挤，
 * 又丢掉了"是哪个源"这个最要紧的部分。
 *
 * ── 渲染纪律 ──────────────────────────────────────────────────────────────
 * · **双通道**（Carbon）：① 句子自己把话说全（"配额已耗尽——此源当前不可用"），
 *   ② 标记是**空心**的（形状差异，逐字沿用 .wb-status-dot-hollow / .notif-new-dot-hollow
 *   的既有做法），③ 颜色（amber）只是第三重。灰度打印与色觉障碍下信息不丢。
 * · `role="status"` + `aria-live="polite"`：读屏器要知道这个源当前不可用，但这是
 *   一条背景事实不是错误，**不打断**用户正在听的内容（同状态条 live 行的口径）。
 * · 🔴 `resetAt === null` 画成"恢复时间未知"，**绝不**拿 observedAt 加一个猜的小时数
 *   兜底成一个看起来很确定的时刻——用户会照着那个时间来等，而我们没有这个信息。
 * · 已过期的条目根本到不了这里（后端 buildProviders 读侧就滤掉了）；这里对
 *   "resetAt 在过去"再做一次防御，退化成"未知"而不是显示一个负数倒计时。
 */
function ProviderQuotaNote({ quota }: { quota: ProviderRowDTO['quota'] }) {
  const { t } = useT()
  // 挂载时取一次即可：这一行的粒度是分/时/天，每秒重算会让整页每秒重渲染。
  const now = useMemo(() => Date.now(), [quota])
  if (!quota) return null

  const resetMs = quota.resetAt === null ? null : Date.parse(quota.resetAt)
  const resetKnown = resetMs !== null && !Number.isNaN(resetMs) && resetMs > now

  return (
    <p
      data-testid="provider-quota-note"
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 text-[11px] leading-4 text-fn-amber"
    >
      <span className="notif-new-dot-hollow inline-block shrink-0 rounded-full" aria-hidden="true" />
      <span>
        {t('settings_provider_quota_exhausted')}
        {' · '}
        {resetKnown
          ? `${t('settings_provider_quota_resets_in')} ${relDuration(resetMs - now)}`
          : t('settings_provider_quota_reset_unknown')}
        {' · '}
        {`${t('settings_provider_quota_observed')} ${relDuration(now - quota.observedAt)} ${t('settings_provider_quota_ago_suffix')}`}
      </span>
    </p>
  )
}

function ProviderSecretField({ secret, editing, draft, onDraft }: {
  secret: ProviderRowDTO['secrets'][number]
  editing: boolean
  draft: string
  onDraft: (v: string) => void
}) {
  const { t } = useT()
  if (editing && secret.source !== 'env') {
    return <Input aria-label={t(SECRET_LABEL_KEY[secret.name])} value={draft} onChange={(e) => onDraft(e.target.value)} placeholder={secret.masked ?? ''} />
  }
  return (
    <>
      <span className="text-[11px] leading-4">{secret.set ? secret.masked ?? '••••' : t('settings_provider_not_set')}</span>
    </>
  )
}

export function ProviderCard({ row, reload }: { row: ProviderRowDTO; reload: () => void }) {
  const { t, lang } = useT()
  const [editing, setEditing] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = row.secrets.some((s) => s.source !== 'env')
  // 状态判据（spec §3.2）：任意 env 源 → locked（环境变量接管，用户不可编辑，即使全 set）；
  // 否则 allConfigured → configured；else unconfigured。env 优先于 configured 是有意的——
  // env 源卡片即使全 set 也不可编辑，显示 "configured" 会误导用户以为可管理。
  const allConfigured = row.secrets.length > 0 && row.secrets.every((s) => s.set)
  // 配置来源（env/db）是实现细节，不给人类看：配齐了就是已配置。
  const status = allConfigured ? 'configured' : 'unconfigured'

  async function onSave() {
    setBusy(true); setError(null)
    try {
      for (const s of row.secrets) {
        const v = drafts[s.name] ?? ''
        if (v === '') continue
        await api.putSecret(s.name, v)
      }
      setEditing(false); setDrafts({}); reload()
    } catch (e) {
      setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang))
    } finally { setBusy(false) }
  }

  async function onTest() {
    setBusy(true); setError(null)
    try { await api.validateSetup(row.id); reload() }
    catch (e) { setError(t('settings_save_error_prefix') + localizeErrorValue(e, lang)) }
    finally { setBusy(false) }
  }

  const footer = (
    <>
      <Button size="sm" disabled={busy && !editing} onClick={() => void onTest()}>
        {t('settings_provider_test_connect')}
      </Button>
      {editable && !editing && (
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>{t('settings_provider_edit_credentials')}</Button>
      )}
      {row.lastTest && (
        <span className="ml-auto flex items-center gap-2 text-[11px] leading-4 text-muted-foreground">
          <StatusDot variant={row.lastTest.ok ? 'success' : 'error'} label={row.lastTest.ok ? t('settings_provider_last_test_ok') : t('settings_provider_last_test_fail')} />
          <span title={new Date(row.lastTest.at).toLocaleString()}>
            {row.lastTest.ok ? t('settings_provider_last_test_passed_ago') : t('settings_provider_last_test_failed_ago')}
            {' '}
            {relDuration(Date.now() - row.lastTest.at)}
            {' '}
            {t('settings_provider_last_test_ago_suffix')}
          </span>
        </span>
      )}
    </>
  )

  return (
    <SettingsCard
      title={PROVIDER_NAME[row.id]}
      status={status}
      statusDot={status === 'configured' ? 'success' : undefined}
      footer={footer}
      data-testid={`providers-${row.id}`}
    >
      <div className="flex flex-col gap-2">
        {row.lastTest && !row.lastTest.ok && row.lastTest.error && (
          <span className="text-[11px] leading-4 text-muted-foreground">{localizeErrorValue(row.lastTest.error, lang)}</span>
        )}
        {/* 配额行排在密钥清单之前：它比"上次测试"更**当下**（测试是
            用户上次手动点的，配额是引擎刚刚撞上的）。
            没有这个事实时组件自己返回 null，一个字都不占屏。 */}
        <ProviderQuotaNote quota={row.quota} />
        {/* KV 栅格：dt=label（11px muted）、dd=mono 值。三张卡（TMDB 1 行 /
            LLM 3 行 / 翻译 3 行）自动对齐——这是 B 方案的核心排版纪律。 */}
        <dl className="settings-kv">
          {row.secrets.map((s) => (
            <div key={s.name} className="settings-kv-row contents">
              <dt className="text-[11px] leading-4 text-muted-foreground" title={s.name}>
                {t(SECRET_LABEL_KEY[s.name])}
              </dt>
              <dd className="font-mono text-[12px] leading-4 text-foreground m-0">
                <ProviderSecretField secret={s} editing={editing} draft={drafts[s.name] ?? ''} onDraft={(v) => setDrafts((d) => ({ ...d, [s.name]: v }))} />
              </dd>
            </div>
          ))}
        </dl>
        {editing && (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={busy} onClick={() => void onSave()}>{t('settings_provider_save')}</Button>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDrafts({}) }}>{t('settings_provider_cancel')}</Button>
          </div>
        )}
        {error && <p role="alert" className="text-[11px] leading-4 text-fn-red">{error}</p>}
      </div>
    </SettingsCard>
  )
}