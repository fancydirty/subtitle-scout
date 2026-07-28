// web/src/triage/TriagePage.tsx：甄别 tab 主体（dashboard-F5）——两箱布局。
// 数据面：GET /api/v2/triage 一次拿全 pending（park 救援清单），翻案成功后手动 reload
// （useTriage 不轮询，见 api/hooks.ts 注释）。
//
// 认领（ClaimDialog/ClaimedBox，2026-07-28 裁决退役，见 src/v2/triageOps.ts 头注释）：曾经
// 这一页还有第三箱"已认领"+ 每个目录组的 Claim 按钮——零证据指派身份违反两证据红线，且
// override 按目录前缀投毒整个目录。正确的用户修复动作是改文件名（见 PendingBox 的命名指引）。
//
// 箱位规划：
//   ① 待甄别（PendingBox）      ——按目录分组的只读清单 + 命名指引
//   ② 已排除 excluded-extra 箱（ExcludedBox）——默认折叠，逐文件 Restore 翻案
import { Text } from '@astryxdesign/core/Text'
import { Button } from '@astryxdesign/core/Button'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useTriage } from '../api/hooks.js'
import { api } from '../api/client.js'
import { useT } from '../i18n/useT.js'
import { PendingBox } from './PendingBox.js'
import { ExcludedBox } from './ExcludedBox.js'
import { groupPending } from './text.js'

export function TriagePage() {
  const { t } = useT()
  const triage = useTriage()

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

  const { actionable, excluded } = groupPending(triage.data.pending)

  const handleRestore = async (path: string) => {
    await api.unexclude(path)
    triage.reload()
  }

  return (
    <div className="triage-boxes">
      <PendingBox actionable={actionable} />
      <ExcludedBox excluded={excluded} onRestore={handleRestore} />
    </div>
  )
}
