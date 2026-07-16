// web/src/shell/AppShell.tsx：新外壳组装——Astryx AppShell + Sidebar + Topbar + CommandK +
// 四 tab 路由分发。数据面只发一次 GET /api/v2/workflow/pending，顶栏新鲜度行与侧栏甄别角标
// 共享同一份响应（后端契约：meta.roots/lastScanAt/files + parked，见 api/types.ts 注释）。
import { useState } from 'react'
import { AppShell as AstryxAppShell } from '@astryxdesign/core/AppShell'
import { useWorkflowPending } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { useShellRoute } from './route.js'
import { Sidebar } from './Sidebar.js'
import { Topbar } from './Topbar.js'
import { CommandK } from './CommandK.js'
import { PlaceholderTab } from './PlaceholderTab.js'

export function Shell() {
  const tab = useShellRoute()
  const workflow = useWorkflowPending()
  const [isCmdKOpen, setCmdKOpen] = useState(false)
  const { t } = useT()

  return (
    <>
      <AstryxAppShell
        contentPadding={4}
        topNav={<Topbar tab={tab} workflow={workflow} onOpenCmdK={() => setCmdKOpen(true)} />}
        sideNav={<Sidebar tab={tab} parked={workflow.data?.parked} />}>
        {tab === 'library' && (
          <PlaceholderTab title={t('library_empty_title')} description={t('library_empty_desc')} />
        )}
        {tab === 'workflow' && (
          <PlaceholderTab title={t('workflow_empty_title')} description={t('workflow_empty_desc')} />
        )}
        {tab === 'triage' && (
          <PlaceholderTab title={t('triage_empty_title')} description={t('triage_empty_desc')} />
        )}
        {tab === 'settings' && (
          <PlaceholderTab title={t('settings_empty_title')} description={t('settings_empty_desc')} />
        )}
      </AstryxAppShell>
      <CommandK isOpen={isCmdKOpen} onOpenChange={setCmdKOpen} />
    </>
  )
}
