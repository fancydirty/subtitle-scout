// web/src/triage/TriagePage.tsx：甄别 tab 主体（dashboard-F5）——两箱布局 + 认领对话框。
// 数据面：GET /api/v2/triage 一次拿全 pending（park 救援清单）+ claimed（已认领 override 清单），
// 认领成功后手动 reload（useTriage 不轮询，见 api/hooks.ts 注释）。
//
// 箱位规划（spec §6 三箱 / §10 non-goal）：
//   ① 待甄别（PendingBox）      ——本任务实现
//   ② 已排除 excluded-extra 箱  ——【留位不实现】救援官战役的呈现层（spec §9/§10：本战役不实现
//      救援官后端，特典三级排除的 excluded-extra 可捞回箱等那边落地后在这两箱之间插入第三箱；
//      此刻不渲染任何占位 UI——没有数据源的空壳箱是假数据诚实）。
//   ③ 已认领（ClaimedBox）      ——本任务实现
import { useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useTriage } from '../api/hooks.js'
import { useT } from '../i18n/useT.js'
import { PendingBox } from './PendingBox.js'
import { ClaimedBox } from './ClaimedBox.js'
import { ClaimDialog } from './ClaimDialog.js'

export function TriagePage() {
  const { t } = useT()
  const triage = useTriage()
  // null=对话框关闭；非空数组=打开时刻的选中路径快照（PendingBox 的选择态在它自己内部，
  // 点击 "Claim selected" 时才以数组形式交上来——同 Lanes/RerunDialog 的请求快照先例）。
  const [claimPaths, setClaimPaths] = useState<string[] | null>(null)

  if (triage.loading && !triage.data) {
    return (
      <Text type="code" color="secondary">
        loading…
      </Text>
    )
  }
  if (triage.error && !triage.data) {
    return (
      <EmptyState
        title={t('triage_error_prefix') + triage.error}
        actions={<Button label={t('triage_retry_label')} variant="secondary" onClick={triage.reload} />}
      />
    )
  }
  if (!triage.data) return null

  const now = Date.now()

  return (
    <>
      <div className="triage-boxes">
        <PendingBox pending={triage.data.pending} onClaimSelected={setClaimPaths} />
        {/* ← excluded-extra 箱留位（救援官战役）：落地后在此插入第三箱，见文件头注释。 */}
        <ClaimedBox claimed={triage.data.claimed} now={now} />
      </div>
      <ClaimDialog
        paths={claimPaths}
        onClose={() => setClaimPaths(null)}
        onSuccess={triage.reload}
      />
    </>
  )
}
