// web/src/triage/ExcludedBox.tsx：excluded-extra 翻案箱——默认折叠，列出被 exclude_extras 设置
// 当作"特典"排除的停车行，每行一个文件名 + Restore 按钮，取消排除后该文件回到 pending 池重新
// 参与 ingest。
import { Button } from '@astryxdesign/core/Button'
import { Text } from '@astryxdesign/core/Text'
import { HStack } from '@astryxdesign/core/HStack'
import { VStack } from '@astryxdesign/core/VStack'
import { Collapsible } from '@astryxdesign/core/Collapsible'
import type { ParkedItemDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'
import { pathTail } from './text.js'

interface Props {
  excluded: ParkedItemDTO[]
  onRestore: (path: string) => void
}

function ExcludedRow({ row, onRestore }: { row: ParkedItemDTO; onRestore: (path: string) => void }) {
  const { t } = useT()
  return (
    <div className="triage-excluded-row">
      <span className="triage-excluded-file" title={row.path}>
        {pathTail(row.path)}
      </span>
      <Button
        size="sm"
        variant="secondary"
        label={t('triage_excluded_restore_label')}
        onClick={() => onRestore(row.path)}
      />
    </div>
  )
}

export function ExcludedBox({ excluded, onRestore }: Props) {
  const { t } = useT()
  if (excluded.length === 0) return null

  return (
    <div className="triage-box">
      <Collapsible
        defaultIsOpen={false}
        trigger={
          <HStack gap={2} vAlign="center">
            <Text type="label">{t('triage_excluded_heading')}</Text>
            <Text type="code" color="secondary">
              {excluded.length}
            </Text>
          </HStack>
        }>
        <VStack gap={2}>
          {excluded.map((row) => (
            <ExcludedRow key={row.path} row={row} onRestore={onRestore} />
          ))}
        </VStack>
      </Collapsible>
    </div>
  )
}
