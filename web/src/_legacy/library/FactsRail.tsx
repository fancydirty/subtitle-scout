// web/src/library/FactsRail.tsx：详情页事实栏（详情页重设计 item B）——跨季合计的 mono 技术读数：
// 覆盖计数 + 语言清单 + 内嵌集数。空段（无语言 / 零内嵌）不渲染，不留孤零零的标签。
import { useT } from '../../i18n/useT.js'

interface Props {
  covered: number
  total: number
  embedded: number
  langs: string[]
}

export function FactsRail({ covered, total, embedded, langs }: Props) {
  const { t } = useT()
  return (
    <div className="library-facts-rail flex flex-wrap gap-4">
      <span className="font-mono text-[13px] leading-5 text-muted-foreground">
        {t('library_facts_coverage')} {covered} / {total}
      </span>
      {langs.length ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">{langs.join(' · ')}</span>
      ) : null}
      {embedded > 0 ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">
          {embedded} {t('library_facts_embedded_unit')}
        </span>
      ) : null}
    </div>
  )
}
