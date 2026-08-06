// web/src/settings/RootsManager.tsx：守备目录管理器（dashboard-F6）——现有根列表（path mono +
// type + 相对时间 + Remove）+ 删根 AlertDialog（destructive，见 RemoveRootDialog.tsx）+ 加根
// 目录浏览器（DirBrowser.tsx）。roots 为空（首启无 env 种子）时空态引导一句话并直接展开浏览器
// （spec 任务规格：不让用户先点一个"添加"按钮才能看到浏览器，空库时浏览器本来就是唯一动作）。
//
// R6：集成扫描防抖器（DIRBROWSER_RESEARCH.md 推荐方案）——添加目录后 2 秒防抖触发扫描、
// 删除目录时取消该路径的待扫请求。DirBrowser 的 onAdded 回调现在会调 debouncer.requestScan，
// RemoveRootDialog 成功删除后调 debouncer.cancelScan。
//
// R6 UX 改进：移除 commonRootStart 动态计算（导致"添加 /media 后无法回到 / 再添加 /data"），
// 改用固定起点（用户主目录）+ 自由向上导航 + 系统目录过滤（见 dirBrowserUtils.ts）。
//
// 控件栈（Plan C Task 27 迁移）：Astryx Text/Button/VStack/EmptyState 全卸——Button children 化
// （label prop 退役），EmptyState 走 components/ui 同名零改件，VStack 换裸 flex div，Text 按
// 控件事典映射到手写 span。
import { useMemo, useState, useRef, useEffect } from 'react'
import { Button } from '../components/ui/button.js'
import { EmptyState } from '../components/ui/empty-state.js'
import type { Async } from '../api/hooks.js'
import type { MediaRootDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { addedAgoLabel } from './text.js'
import { DirBrowser } from './DirBrowser.js'
import { RemoveRootDialog } from './RemoveRootDialog.js'
import { api } from '../api/client.js'
import { createScanDebouncer, type ScanDebouncer } from './scanDebouncer.js'
import { getDefaultStartPath } from './dirBrowserUtils.js'

interface Props {
  roots: Async<MediaRootDTO[]>
}

export function RootsManager({ roots }: Props) {
  const { t, lang } = useT()
  const [browserOpen, setBrowserOpen] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)

  // R6：防抖器实例——useRef 保持稳定引用（组件重渲染不重建），传给 DirBrowser 和 RemoveRootDialog
  const debouncerRef = useRef<ScanDebouncer | null>(null)
  if (!debouncerRef.current) {
    debouncerRef.current = createScanDebouncer(api.triggerScan)
  }

  const list = roots.data ?? []
  // R6 UX 改进：固定起点（用户主目录），不再用 commonRootStart 动态计算——那会导致
  // "添加 /media 后只能浏览其子目录，无法回到 / 再添加 /data"的 UX 问题。
  const startPath = useMemo(() => getDefaultStartPath(), [])

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
          loading…
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
          title={t('settings_roots_error_prefix') + roots.error}
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
  const now = Date.now()

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
              <span className="settings-root-type">{root.type}</span>
              <span className="settings-root-added">{addedAgoLabel(now - root.addedAt, lang)}</span>
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

      {!isEmpty && !browserOpen ? (
        <div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setBrowserOpen(true)}
          >
            {t('settings_roots_add_button_label')}
          </Button>
        </div>
      ) : null}

      {isEmpty || browserOpen ? <DirBrowser startPath={startPath} onAdded={handleAdded} /> : null}

      <RemoveRootDialog path={removeTarget} onClose={() => setRemoveTarget(null)} onRemoved={handleRemoved} />
    </section>
  )
}
