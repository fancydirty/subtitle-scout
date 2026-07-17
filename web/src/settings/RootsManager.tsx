// web/src/settings/RootsManager.tsx：守备目录管理器（dashboard-F6）——现有根列表（path mono +
// type + 相对时间 + Remove）+ 删根 AlertDialog（destructive，见 RemoveRootDialog.tsx）+ 加根
// 目录浏览器（DirBrowser.tsx）。roots 为空（首启无 env 种子）时空态引导一句话并直接展开浏览器
// （spec 任务规格：不让用户先点一个"添加"按钮才能看到浏览器，空库时浏览器本来就是唯一动作）。
import { useMemo, useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import type { Async } from '../api/hooks.js'
import type { MediaRootDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { addedAgoLabel, commonRootStart } from './text.js'
import { DirBrowser } from './DirBrowser.js'
import { RemoveRootDialog } from './RemoveRootDialog.js'

interface Props {
  roots: Async<MediaRootDTO[]>
}

export function RootsManager({ roots }: Props) {
  const { t, lang } = useT()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  const list = roots.data ?? []
  const startPath = useMemo(() => commonRootStart(list.map((r) => r.path)), [list])

  if (roots.loading && !roots.data) {
    return (
      <section className="settings-section">
        <Text type="label">{t('settings_roots_heading')}</Text>
        <Text type="code" color="secondary">
          loading…
        </Text>
      </section>
    )
  }
  if (roots.error && !roots.data) {
    return (
      <section className="settings-section">
        <Text type="label">{t('settings_roots_heading')}</Text>
        <EmptyState
          isCompact
          title={t('settings_roots_error_prefix') + roots.error}
          actions={<Button label={t('settings_roots_retry_label')} variant="secondary" onClick={roots.reload} />}
        />
      </section>
    )
  }

  const isEmpty = list.length === 0
  const now = Date.now()

  return (
    <section className="settings-section">
      <Text type="label">{t('settings_roots_heading')}</Text>

      {isEmpty ? (
        <Text type="supporting" color="secondary">
          {t('settings_roots_empty_hint')}
        </Text>
      ) : (
        <VStack gap={2}>
          {list.map((root) => (
            <div className="settings-root-row" key={root.path}>
              <span className="settings-root-path" title={root.path}>
                {root.path}
              </span>
              <span className="settings-root-type">{root.type}</span>
              <span className="settings-root-added">{addedAgoLabel(now - root.addedAt, lang)}</span>
              <Button
                size="sm"
                variant="secondary"
                label={t('settings_roots_remove_label')}
                onClick={() => setRemoveTarget(root.path)}
              />
            </div>
          ))}
        </VStack>
      )}

      {!isEmpty && !browserOpen ? (
        <Button
          size="sm"
          variant="secondary"
          label={t('settings_roots_add_button_label')}
          onClick={() => setBrowserOpen(true)}
        />
      ) : null}

      {isEmpty || browserOpen ? <DirBrowser startPath={startPath} onAdded={roots.reload} /> : null}

      <RemoveRootDialog path={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={roots.reload} />
    </section>
  )
}
