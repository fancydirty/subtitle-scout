// web/src/triage/PendingBox.tsx：待甄别箱——park 救援清单。每行=路径尾段（mono，title 属性给
// 全路径）+ park reason（灰小字）+ 行选择 checkbox（多选）。箱头=计数 + "Claim selected" 按钮
// （选中 >0 才可用）。箱底常驻一条改名指引（灰字，双语）：正确命名可免人工甄别——不是错误提示，
// 是"你本可以不用来这里"式的提示，因此不放进 loading/error/empty 三态判断里，恒定渲染。
//
// 选择态是这个组件的私有状态（同 PendingLane 的 includeThrottled 开关先例：发起方自己管临时
// UI 状态，只把最终动作通过回调交给父级）——ClaimDialog 打开后父级才需要知道"选了哪些路径"，
// 选择过程本身跟 TriagePage/ClaimedBox 无关。
import { useEffect, useState } from 'react'
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput'
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { EmptyState } from '@astryxdesign/core/EmptyState'
import type { ParkedItemDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { pathTail } from './text.js'

// README 命名最佳实践同文（docs/design 的 dashboard 重建设计 §6）——路径形状是技术值，
// mono 且不翻译（DESIGN.md §3/§7），两种语言下原样出现。
const NAMING_PATTERN = 'Title (Year)/Season NN/Title SNNENN.mkv'

function PendingRow({
  item, checked, onToggle,
}: {
  item: ParkedItemDTO
  checked: boolean
  onToggle: () => void
}) {
  const tail = pathTail(item.path)
  return (
    <div className="triage-pending-row">
      <CheckboxInput label={tail} isLabelHidden value={checked} onChange={onToggle} size="sm" />
      <VStack gap={0.5} width="100%">
        <span className="triage-pending-row-path" title={item.path}>
          {tail}
        </span>
        <span className="triage-pending-row-reason">{item.parkReason}</span>
      </VStack>
    </div>
  )
}

interface Props {
  pending: ParkedItemDTO[]
  onClaimSelected: (paths: string[]) => void
}

export function PendingBox({ pending, onClaimSelected }: Props) {
  const { t } = useT()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // pending 列表变化（认领刷新后某些路径消失）时，把选择态里已经不存在的路径清掉——不然会有
  // 勾选框"看不见但仍计入选中数"的幽灵态。
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((p) => pending.some((row) => row.path === p)))
      return next.size === prev.size ? prev : next
    })
  }, [pending])

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div className="triage-box">
      <VStack gap={3}>
        <HStack gap={3} vAlign="center" justify="between">
          <HStack gap={2} vAlign="center">
            <Text type="label">{t('triage_pending_heading')}</Text>
            <Text type="code" color="secondary">
              {pending.length}
            </Text>
          </HStack>
          <Button
            size="sm"
            variant="secondary"
            label={t('triage_claim_selected_label')}
            isDisabled={selected.size === 0}
            onClick={() => onClaimSelected([...selected])}
          />
        </HStack>

        {pending.length === 0 ? (
          <EmptyState isCompact title={t('triage_empty_title')} description={t('triage_empty_desc')} />
        ) : (
          <VStack gap={2}>
            {pending.map((item) => (
              <PendingRow key={item.path} item={item} checked={selected.has(item.path)} onToggle={() => toggle(item.path)} />
            ))}
          </VStack>
        )}

        <div className="triage-naming-hint">
          {t('triage_naming_hint_prefix')}
          <code className="triage-naming-hint-code">{NAMING_PATTERN}</code>
        </div>
      </VStack>
    </div>
  )
}
