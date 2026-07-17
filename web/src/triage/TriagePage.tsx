// web/src/triage/TriagePage.tsx：甄别 tab 主体（dashboard-F5）——三箱布局 + 认领对话框。
// 数据面：GET /api/v2/triage 一次拿全 pending（park 救援清单）+ claimed（已认领 override 清单），
// 认领/翻案成功后手动 reload（useTriage 不轮询，见 api/hooks.ts 注释）。
//
// 箱位规划（spec §6 三箱）：
//   ① 待甄别（PendingBox）      ——按目录分组认领
//   ② 已排除 excluded-extra 箱（ExcludedBox）——默认折叠，逐文件 Restore 翻案
//   ③ 已认领（ClaimedBox）      ——只读展示
import { useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useTriage } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { PendingBox } from './PendingBox.js'
import { ExcludedBox } from './ExcludedBox.js'
import { ClaimedBox } from './ClaimedBox.js'
import { ClaimDialog } from './ClaimDialog.js'
import { groupPending } from './text.js'
import type { DirGroup } from './text.js'

export function TriagePage() {
  const { t } = useT()
  const triage = useTriage()
  // null=对话框关闭；非空=打开时刻的目录组快照——PendingBox 的 Claim 按钮挂在每个目录组上
  // （验收修复轮一 Task V2：不再是"选中路径快照"，是"选中哪个目录组"，见 PendingBox.tsx 文件
  // 头注释），点击时把那一组连同文件列表一起交上来。
  const [claimGroup, setClaimGroup] = useState<DirGroup | null>(null)
  // 认领成功后立即置灰的目录集合——纯前端过渡态，不是数据源真相：下一轮 ingest pass 真的把
  // 这些路径从 parked_paths 表清掉之前，triage.reload() 拉回的 pending 列表里这些行还会在，
  // 如实展示原状（诚实兜底，DESIGN.md §8），只是套上"claimed · awaiting rescan"的灰壳过渡，
  // 不假装它们已经消失。组件卸载（离开甄别 tab）后这份状态自然丢弃，不需要持久化——刷新页面后
  // 若那一轮扫描还没跑完，行会以原本未认领的样子重新出现，如实。
  const [claimedDirs, setClaimedDirs] = useState<Set<string>>(new Set())

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
  const { actionable, duplicates, excluded } = groupPending(triage.data.pending)

  const handleRestore = async (path: string) => {
    await api.unexclude(path)
    triage.reload()
  }

  return (
    <>
      <div className="triage-boxes">
        <PendingBox
          actionable={actionable}
          duplicates={duplicates}
          claimedDirs={claimedDirs}
          onClaimGroup={setClaimGroup}
        />
        <ExcludedBox excluded={excluded} onRestore={handleRestore} />
        <ClaimedBox claimed={triage.data.claimed} now={now} />
      </div>
      <ClaimDialog
        group={claimGroup}
        onClose={() => setClaimGroup(null)}
        onSuccess={(dir) => {
          setClaimedDirs((prev) => new Set(prev).add(dir))
          triage.reload()
        }}
      />
    </>
  )
}
