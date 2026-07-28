// web/src/triage/PendingBox.tsx：待甄别箱——按目录分组渲染 park 救援清单（验收修复轮一 Task V2，
// spec §C.1）。组头=目录尾段 mono + 文件计数，组体=文件名列表只读、>5 折叠。
//
// Claim 按钮 / claimedDirs 置灰过渡态（2026-07-28 认领退役，见 src/v2/triageOps.ts 头注释）：
// 曾经每张组卡带一个 Claim 按钮打开认领对话框——零证据指派身份违反两证据红线，整体退役。
// 这一箱现在是纯只读事实呈现：用户看到哪些文件待识别，正确的修复动作是按下方命名指引改文件名，
// 改名后 ingest 自动重新识别（或由字幕 agent 在证据红线下裁决身份）。
//
// duplicates 桶已退役（P2 起 ingest 不再产 duplicate-content 停车行，见 text.ts 的 groupPending
// 头注释）：历史遗留的 duplicate-content 行（若有）随普通 actionable 行一起出现在分组区里。
import { useState } from 'react'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import { useT } from '../i18n/useT.js'
import { pathTail, fileCountLabel, moreLabel, type DirGroup } from './text.js'

// README 命名最佳实践同文（docs/design 的 dashboard 重建设计 §6）——路径形状是技术值，
// mono 且不翻译（DESIGN.md §3/§7），两种语言下原样出现。
const NAMING_PATTERN = 'Title (Year)/Season NN/Title SNNENN.mkv'

const FILES_COLLAPSE_AT = 5

function DirGroupCard({ group }: { group: DirGroup }) {
  const { lang } = useT()
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? group.files : group.files.slice(0, FILES_COLLAPSE_AT)
  const hidden = group.files.length - visible.length

  return (
    <div className="triage-dirgroup">
      <HStack gap={2} vAlign="center">
        <span className="triage-dirgroup-tail" title={group.dir}>
          {group.dirTail}
        </span>
        <Text type="code" color="secondary">
          {fileCountLabel(group.files.length, lang)}
        </Text>
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
  /** 待识别的目录组（已由 TriagePage 通过 groupPending 分桶）。 */
  actionable: DirGroup[]
}

export function PendingBox({ actionable }: Props) {
  const { t } = useT()

  const actionableCount = actionable.reduce((n, g) => n + g.files.length, 0)

  return (
    <div className="triage-box">
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Text type="label">{t('triage_pending_heading')}</Text>
          <Text type="code" color="secondary">
            {actionableCount}
          </Text>
        </HStack>

        {actionable.length === 0 ? (
          <EmptyState isCompact title={t('triage_empty_title')} description={t('triage_empty_desc')} />
        ) : (
          <div className="triage-actionable-groups">
            <VStack gap={2}>
              {actionable.map((group) => (
                <DirGroupCard key={group.dir} group={group} />
              ))}
            </VStack>
          </div>
        )}

        <div className="triage-naming-hint">
          {t('triage_naming_hint_prefix')}
          <code className="triage-naming-hint-code">{NAMING_PATTERN}</code>
        </div>
      </VStack>
    </div>
  )
}
