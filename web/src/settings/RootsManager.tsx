// web/src/settings/RootsManager.tsx：媒体目录——普通路径输入 + 列表 + 删除。
// 目录浏览器已删除：用户知道自己磁盘上的路径，不需要点选。
import { useRef, useEffect, useState } from 'react'
import { Button } from '../components/ui/button.js'
import { EmptyState } from '../components/ui/empty-state.js'
import type { Async } from '../api/hooks.js'
import type { MediaRootDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { localizeError } from '../lib/errorText.js'
import { RootPathInput } from './RootPathInput.js'
import { RemoveRootDialog } from './RemoveRootDialog.js'
import { api } from '../api/client.js'
import { createScanDebouncer, type ScanDebouncer } from './scanDebouncer.js'

interface Props {
  roots: Async<MediaRootDTO[]>
}

export function RootsManager({ roots }: Props) {
  const { t, lang } = useT()
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  // R6：防抖器实例——useRef 保持稳定引用（组件重渲染不重建），传给 DirBrowser 和 RemoveRootDialog
  const debouncerRef = useRef<ScanDebouncer | null>(null)
  if (!debouncerRef.current) {
    debouncerRef.current = createScanDebouncer(api.triggerScan)
  }

  // 卸载清理：取消待触发的防抖扫描（语义见 scanDebouncer.ts dispose 注释）。
  // 依赖数组为空 = 只在真正卸载时跑；dispose 幂等且不打死实例，StrictMode 双跑安全。
  useEffect(() => {
    return () => {
      debouncerRef.current?.dispose()
    }
  }, [])

  const list = roots.data ?? []

  // R6：添加根成功的回调——刷新列表 + 请求防抖扫描（2 秒后无新操作才真正触发）
  const handleAdded = (path: string) => {
    roots.reload()
    debouncerRef.current?.requestScan(path)
  }

  // R6：删除根成功的回调——刷新列表 + 取消该路径的待扫请求
  const handleRemoved = (path: string) => {
    roots.reload()
    debouncerRef.current?.cancelScan(path)
  }

  if (roots.loading && !roots.data) {
    return (
      <section className="settings-section">
        <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_roots_heading')}</span>
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">
          {t('common_loading')}
        </span>
      </section>
    )
  }
  if (roots.error && !roots.data) {
    return (
      <section className="settings-section">
        <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_roots_heading')}</span>
        <EmptyState
          isCompact
          title={t('settings_roots_error_prefix') + localizeError(roots.error, lang)}
          actions={
            <Button variant="secondary" onClick={roots.reload}>
              {t('settings_roots_retry_label')}
            </Button>
          }
        />
      </section>
    )
  }

  const isEmpty = list.length === 0

  return (
    <section className="settings-section">
      <span className="text-[13px] font-medium leading-5 text-foreground">{t('settings_roots_heading')}</span>

      {isEmpty ? (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {t('settings_roots_empty_hint')}
        </span>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((root) => (
            <div className="settings-root-row" key={root.path}>
              <span className="settings-root-path" title={root.path}>
                {root.path}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRemoveTarget(root.path)}
              >
                {t('settings_roots_remove_label')}
              </Button>
            </div>
          ))}
        </div>
      )}

      <RootPathInput onAdded={handleAdded} />

      <RemoveRootDialog path={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={handleRemoved} />
    </section>
  )
}
