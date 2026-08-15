// web/src/shell/Topbar.tsx：顶栏只做一件事——告诉用户当前在哪个页面。
// 技术读数与快捷键触发器已删除：没有对应功能的 UI 不该占人类一眼。
import { useT } from '../i18n/useT.js'
import { TABS } from './tabs.js'
import type { Tab } from './route.js'

interface Props {
  tab: Tab
}

export function Topbar({ tab }: Props) {
  const { t } = useT()
  const activeMeta = TABS.find((m) => m.id === tab)
  const rootLabel = activeMeta ? t(activeMeta.labelKey) : ''

  return (
    <div className="flex min-h-[46px] items-center border-b border-border px-4 py-2">
      <nav aria-label={t('a11y_breadcrumb')} className="min-w-0">
        <ol className="flex items-center gap-1 text-sm leading-5">
          <li aria-current="page" className="truncate text-foreground">
            {rootLabel}
          </li>
        </ol>
      </nav>
    </div>
  )
}
