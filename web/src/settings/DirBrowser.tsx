// web/src/settings/DirBrowser.tsx：加根流程——目录浏览器（Jellyfin 同款"挂载即可见"选择器，
// spec §7/§10 用户裁决："照抄 Jellyfin 等巨人轮子，不自己发明"）。起点由父级传入（现有根的公共
// 父目录，见 text.ts 的 commonRootStart），面包屑逐级 + 子目录列表逐级下钻；不可读目录如实灰字
// error（DESIGN.md §8：诚实呈现事实，不是警报）；当前路径一行 mono + "Add this directory" 按钮
// → POST 成功后提示"已加入，下一轮扫描将自动摄取"（后端 roots 已动态化，这句是真的）。
//
// 面包屑与目录项都用自建 mono 按钮而不是现成 Breadcrumbs 组件——路径段是技术值，DESIGN.md
// §3 铁律"mono 是技术层专属声音"，自建能精确控制成 mono 且方便测试定位。
//
// 控件栈（Plan C Task 27 迁移）：Astryx Text/Button/VStack/HStack 全卸——Button children 化
// （label prop 退役；isLoading 期间 Astryx 本就 disable 按钮，故 disabled={adding} 守住同一语义，
// spinner 不迁），VStack/HStack 换裸 flex div，Text 按控件事典映射到手写 span。自绘
// breadcrumb/entry（原生 button + CSS 类）一个不动。
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/button.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { breadcrumbSegments, joinDir } from './text.js'

interface Props {
  startPath: string
  /** 加根成功后调用——父级借此刷新根列表（RootsManager 传 roots.reload）。 */
  onAdded: () => void
}

function PathBreadcrumb({ path, onNavigate }: { path: string; onNavigate: (p: string) => void }) {
  const segments = breadcrumbSegments(path)
  return (
    <div className="settings-dirbrowser-breadcrumb">
      {segments.map((seg, i) => (
        <span key={seg.path} className="settings-dirbrowser-breadcrumb-segment">
          {i > 0 ? (
            <span className="settings-dirbrowser-breadcrumb-sep" aria-hidden="true">
              /
            </span>
          ) : null}
          {i === segments.length - 1 ? (
            <span className="settings-dirbrowser-breadcrumb-current">{seg.label}</span>
          ) : (
            <button
              type="button"
              className="settings-dirbrowser-breadcrumb-item"
              onClick={() => onNavigate(seg.path)}>
              {seg.label}
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

export function DirBrowser({ startPath, onAdded }: Props) {
  const { t } = useT()
  const [currentPath, setCurrentPath] = useState(startPath)
  const [dirs, setDirs] = useState<string[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [addedMsg, setAddedMsg] = useState<string | null>(null)

  // startPath 变化（roots 列表首次加载完成、公共父目录重算）时重开一次浏览会话——同
  // ClaimDialog 对 paths 变化重置整个表单态的既有先例。
  useEffect(() => {
    setCurrentPath(startPath)
  }, [startPath])

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    setListError(null)
    setAddError(null)
    setAddedMsg(null)
    api
      .fsList(currentPath, ctrl.signal)
      .then((res) => setDirs(res.dirs))
      .catch((e) => {
        if (ctrl.signal.aborted) return
        setListError(String(e))
        setDirs(null)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [currentPath])

  const navigate = (p: string) => setCurrentPath(p)

  const handleAdd = async () => {
    setAdding(true)
    setAddError(null)
    setAddedMsg(null)
    try {
      await api.addRoot(currentPath)
      setAddedMsg(t('settings_dirbrowser_add_success'))
      onAdded()
    } catch (e) {
      setAddError(String(e))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-[11px] leading-4 text-muted-foreground">
        {t('settings_dirbrowser_description')}
      </span>

      <PathBreadcrumb path={currentPath} onNavigate={navigate} />

      {loading ? (
        <span className="font-mono text-[13px] leading-5 text-muted-foreground">
          loading…
        </span>
      ) : listError ? (
        // 不可读目录如实灰字 error（DESIGN.md §8：这是路况事实，不是告警——NAS 挂载权限拒绝
        // 是正常路况）。
        <div className="settings-dirbrowser-list-error">{t('settings_dirbrowser_error_prefix') + listError}</div>
      ) : dirs && dirs.length > 0 ? (
        <div className="flex flex-col gap-1">
          {dirs.map((name) => (
            <button
              type="button"
              key={name}
              className="settings-dirbrowser-entry"
              onClick={() => navigate(joinDir(currentPath, name))}>
              {name}
            </button>
          ))}
        </div>
      ) : (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {t('settings_dirbrowser_empty')}
        </span>
      )}

      <div className="flex items-center gap-2">
        <span className="settings-dirbrowser-current" title={currentPath}>
          {currentPath}
        </span>
        <Button
          size="sm"
          variant="default"
          disabled={adding}
          onClick={handleAdd}
        >
          {t('settings_dirbrowser_add_button')}
        </Button>
      </div>
      {addError ? <div className="settings-error-text">{t('settings_dirbrowser_add_error_prefix') + addError}</div> : null}
      {addedMsg ? (
        <span className="text-[11px] leading-4 text-muted-foreground">
          {addedMsg}
        </span>
      ) : null}
    </div>
  )
}
