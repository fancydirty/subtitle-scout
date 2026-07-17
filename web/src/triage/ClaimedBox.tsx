// web/src/triage/ClaimedBox.tsx：已认领箱——identify_overrides 全行直译，只读（唯二的写扳手是
// PendingBox 的多选 + ClaimDialog 提交，这个箱子本身没有任何交互）。每行=pathPrefix（mono 截断）
// → tmdbId（mono）+ tv/movie 词 + season（有则 S{n}）+ 相对时间。
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import type { ClaimedOverrideDTO } from '../api/types.js'
import { useT, type Lang } from '../i18n/useT.js'
import { relativeClaimedAgo } from './text.js'

function ClaimedRow({ row, now, lang }: { row: ClaimedOverrideDTO; now: number; lang: Lang }) {
  const { t } = useT()
  const kindWord = row.isTv ? t('triage_type_tv') : t('triage_type_movie')
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
      <span className="triage-claimed-time">{relativeClaimedAgo(now - row.createdAt, lang)}</span>
    </div>
  )
}

interface Props {
  claimed: ClaimedOverrideDTO[]
  now: number
}

export function ClaimedBox({ claimed, now }: Props) {
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
              <ClaimedRow key={`${row.pathPrefix}-${row.createdAt}`} row={row} now={now} lang={lang} />
            ))}
          </VStack>
        )}
      </VStack>
    </div>
  )
}
