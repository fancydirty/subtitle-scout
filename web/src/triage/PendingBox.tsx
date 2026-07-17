// web/src/triage/PendingBox.tsx：待甄别箱——按目录分组渲染 park 救援清单（验收修复轮一 Task V2，
// spec §C.1）。claimParked 的 override 覆盖粒度是 dirname(path) 前缀（见 src/dashboard/apiV2.ts
// claimParked 注释），所以"目录=认领单元"：组头=目录尾段 mono + 文件计数 + 一个 Claim 按钮
// （挂在整个目录组上，不是逐文件），组体=文件名列表只读、>5 折叠。原逐行 checkbox 多选整体撤掉
// ——旧版靠用户手动跨行多选拼凑出"这些文件属于同一部剧"，新版分组函数直接把这层事实做出来，
// 多选歧义随之消灭。
//
// duplicate-content 停车行单独归入 duplicates 桶（spec §C.3）：默认折叠的 Collapsible，组头
// 说明"这类重复副本不需要人工认领"，展开后同款目录组卡但没有 Claim 按钮。
//
// 认领后的置灰过渡态（claimedDirs）是这个组件的入参而非私有状态——TriagePage 持有它，理由见
// TriagePage.tsx 的文件头注释（认领只写 override，parked_paths 那一行要等下一轮 ingest pass
// 才真的消失，这份 UI 状态桥接"写库那一刻"到"真的退户口那一刻"之间的诚实过渡）。
import { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import { StatusDot } from '@astryxdesign/core/StatusDot'
import type { ParkedItemDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { pathTail, fileCountLabel, moreLabel, type DirGroup } from './text.js'

// README 命名最佳实践同文（docs/design 的 dashboard 重建设计 §6）——路径形状是技术值，
// mono 且不翻译（DESIGN.md §3/§7），两种语言下原样出现。
const NAMING_PATTERN = 'Title (Year)/Season NN/Title SNNENN.mkv'

const FILES_COLLAPSE_AT = 5

function DirGroupCard({
  group, claimed, onClaim,
}: {
  group: DirGroup
  claimed: boolean
  /** undefined＝不给这个组渲染 Claim 按钮（duplicates 桶的组卡、或已认领的组都是这种情况）。 */
  onClaim?: () => void
}) {
  const { t, lang } = useT()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? group.files : group.files.slice(0, FILES_COLLAPSE_AT)
  const hidden = group.files.length - visible.length

  return (
    <div className={`triage-dirgroup${claimed ? ' triage-dirgroup-claimed' : ''}`}>
      <HStack gap={2} vAlign="center" justify="between">
        <HStack gap={2} vAlign="center">
          <span className="triage-dirgroup-tail" title={group.dir}>
            {group.dirTail}
          </span>
          <Text type="code" color="secondary">
            {fileCountLabel(group.files.length, lang)}
          </Text>
        </HStack>
        {claimed ? (
          // DESIGN.md §4：状态 = 6px 圆点 + 一个同色词——认领后等待重扫是排队态，灰
          // （neutral），不是错误也不是完成。
          <span className="triage-dirgroup-badge">
            <StatusDot variant="neutral" label={t('triage_claimed_badge')} />
            {t('triage_claimed_badge')}
          </span>
        ) : onClaim ? (
          <Button size="sm" variant="secondary" label={t('triage_claim_group_label')} onClick={onClaim} />
        ) : null}
      </HStack>
      <div className="triage-dirgroup-files">
        {visible.map((f) => (
          <span key={f.path} className="triage-dirgroup-file" title={f.path}>
            {pathTail(f.path)}
          </span>
        ))}
        {hidden > 0 ? (
          <button type="button" className="triage-dialog-more" onClick={() => setExpanded(true)}>
            {moreLabel(hidden, lang)}
          </button>
        ) : null}
      </div>
    </div>
  )
}

interface Props {
  /** 待人工认领的目录组（已由 TriagePage 通过 groupPending 分桶）。 */
  actionable: DirGroup[]
  /** duplicate-content 桶（已由 TriagePage 通过 groupPending 分桶）。 */
  duplicates: DirGroup[]
  /** 本次会话里已认领、正等待下一轮 ingest pass 退户口的目录集合（TriagePage 持有，见其文件头
   *  注释）——命中的组置灰、显示"claimed · awaiting rescan"角标、Claim 按钮消失、沉到组列表
   *  底部。 */
  claimedDirs: Set<string>
  onClaimGroup: (group: DirGroup) => void
}

export function PendingBox({ actionable, duplicates, claimedDirs, onClaimGroup }: Props) {
  const { t } = useT()

  // 未认领组在前（按 groupPending 已排好的文件数降序），已认领组沉到最后——组内顺序不重要，
  // 反正下一轮扫描真的退户口后这些组就会从 pending 里彻底消失。
  const notClaimed = actionable.filter((g) => !claimedDirs.has(g.dir))
  const claimedGroups = actionable.filter((g) => claimedDirs.has(g.dir))
  const orderedActionable = [...notClaimed, ...claimedGroups]
  // 箱头计数只算"还需要人工认领"的文件数——已认领但还没退户口的组不再计入（spec §C.2：
  // "actionable 计数减除"），duplicates 桶有自己的计数，不叠进这里。
  const actionableCount = notClaimed.reduce((n, g) => n + g.files.length, 0)
  const duplicatesCount = duplicates.reduce((n, g) => n + g.files.length, 0)

  return (
    <div className="triage-box">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Text type="label">{t('triage_pending_heading')}</Text>
          <Text type="code" color="secondary">
            {actionableCount}
          </Text>
        </HStack>

        {orderedActionable.length === 0 ? (
          <EmptyState isCompact title={t('triage_empty_title')} description={t('triage_empty_desc')} />
        ) : (
          <div className="triage-actionable-groups">
            <VStack gap={2}>
              {orderedActionable.map((group) => (
                <DirGroupCard
                  key={group.dir}
                  group={group}
                  claimed={claimedDirs.has(group.dir)}
                  onClaim={claimedDirs.has(group.dir) ? undefined : () => onClaimGroup(group)}
                />
              ))}
            </VStack>
          </div>
        )}

        {duplicates.length > 0 ? (
          <div className="triage-duplicates-section">
            <Collapsible
              defaultIsOpen={false}
              trigger={
                <HStack gap={2} vAlign="center">
                  <Text type="label">{t('triage_duplicates_heading')}</Text>
                  <Text type="code" color="secondary">
                    {duplicatesCount}
                  </Text>
                </HStack>
              }>
              <VStack gap={2}>
                {duplicates.map((group) => (
                  <DirGroupCard key={group.dir} group={group} claimed={false} />
                ))}
              </VStack>
            </Collapsible>
          </div>
        ) : null}

        <div className="triage-naming-hint">
          {t('triage_naming_hint_prefix')}
          <code className="triage-naming-hint-code">{NAMING_PATTERN}</code>
        </div>
      </VStack>
    </div>
  )
}
