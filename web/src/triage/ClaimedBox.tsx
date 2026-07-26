// web/src/triage/ClaimedBox.tsx：已认领箱——identify_overrides 全行直译。每行=pathPrefix
// （mono 截断）→ tmdbId（mono）+ tv/movie 词 + season（有则 S{n}）+ 来源角标 + 相对时间 +
// 撤销按钮。
//
// 识别架构路 A（2026-07-26 审计 A-3/A-5）：这个箱子此前是纯只读的，写入方也只有人（甄别页
// 手动认领）。现在字幕 agent 核验身份后也会写认领，带来两个必须的改动：
// ① 来源角标——agent 的判断是会出错的启发式，用户必须能看出哪些行是它写的才能审阅；同时
//    也标示了哪些行受"agent 不许覆盖人工认领"规则保护。
// ② 撤销按钮——这是 agent 写权限的唯一逃生阀。认错了的话那条错误身份会每轮被 ingest 拿去
//    重建行、删掉正确的旧行，此前用户除了手动改库没有任何出路。
import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import type { ClaimedOverrideDTO } from '../api/types.js'
import { useT, type Lang } from '../i18n/useT.js'
import { relativeClaimedAgo } from './text.js'

function ClaimedRow({
  row, now, lang, onUnclaim,
}: {
  row: ClaimedOverrideDTO
  now: number
  lang: Lang
  onUnclaim: (pathPrefix: string) => Promise<void>
}) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kindWord = row.isTv ? t('triage_type_tv') : t('triage_type_movie')

  async function unclaim() {
    if (busy) return // 同步去重：飞行中不再触发（双提交防护，同 ExcludedRow 先例）
    setBusy(true)
    setError(null)
    try {
      await onUnclaim(row.pathPrefix)
    } catch (e) {
      setError(t('triage_unclaim_error_prefix') + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="triage-claimed-row">
      <span className="triage-claimed-prefix" title={row.pathPrefix}>
        {row.pathPrefix}
      </span>
      <span className="triage-claimed-arrow" aria-hidden="true">
        →
      </span>
      <span className="triage-claimed-tmdbid">{row.tmdbId}</span>
      <span className="triage-claimed-kind">{kindWord}</span>
      {row.season != null ? <span className="triage-claimed-season">{`S${row.season}`}</span> : null}
      <span className="triage-claimed-source">
        {row.source === 'agent' ? t('triage_claimed_source_agent') : t('triage_claimed_source_human')}
      </span>
      <span className="triage-claimed-time">{relativeClaimedAgo(now - row.createdAt, lang)}</span>
      <Button
        size="sm"
        variant="secondary"
        label={t('triage_claimed_unclaim_label')}
        isLoading={busy}
        isDisabled={busy}
        onClick={unclaim}
      />
      {error && <span className="auth-error" role="alert">{error}</span>}
    </div>
  )
}

interface Props {
  claimed: ClaimedOverrideDTO[]
  now: number
  /** 撤销一条认领——返回 Promise，本组件据其成败驱动 busy/error（同 ExcludedBox.onRestore
   *  的既有约定：不返回 void，否则失败被裸吞、无 loading 可双提交）。 */
  onUnclaim: (pathPrefix: string) => Promise<void>
}

export function ClaimedBox({ claimed, now, onUnclaim }: Props) {
  const { t, lang } = useT()

  return (
    <div className="triage-box">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Text type="label">{t('triage_claimed_heading')}</Text>
          <Text type="code" color="secondary">
            {claimed.length}
          </Text>
        </HStack>

        {claimed.length === 0 ? (
          <EmptyState isCompact title={t('triage_claimed_empty_title')} description={t('triage_claimed_empty_desc')} />
        ) : (
          <VStack gap={2}>
            {claimed.map((row) => (
              <ClaimedRow
                key={`${row.pathPrefix}-${row.createdAt}`}
                row={row}
                now={now}
                lang={lang}
                onUnclaim={onUnclaim}
              />
            ))}
          </VStack>
        )}
      </VStack>
    </div>
  )
}
