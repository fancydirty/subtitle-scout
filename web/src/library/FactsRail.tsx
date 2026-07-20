// web/src/library/FactsRail.tsx：详情页事实栏（详情页重设计 item B）——跨季合计的 mono 技术读数：
// 覆盖计数 + 语言清单 + 内嵌集数。空段（无语言 / 零内嵌）不渲染，不留孤零零的标签。
import { HStack } from '@astryxdesign/core/HStack'
import { Text } from '@astryxdesign/core/Text'
import { useT } from '../i18n/useT.js'

interface Props {
  covered: number
  total: number
  embedded: number
  langs: string[]
}

export function FactsRail({ covered, total, embedded, langs }: Props) {
  const { t } = useT()
  return (
    <HStack gap={4} wrap="wrap" className="library-facts-rail">
      <Text type="code" color="secondary">{t('library_facts_coverage')} {covered} / {total}</Text>
      {langs.length ? <Text type="code" color="secondary">{langs.join(' · ')}</Text> : null}
      {embedded > 0 ? <Text type="code" color="secondary">{embedded} {t('library_facts_embedded_unit')}</Text> : null}
    </HStack>
  )
}
