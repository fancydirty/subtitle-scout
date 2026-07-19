// web/src/triage/ExcludedBox.tsx：excluded-extra 翻案箱——默认折叠，列出被 exclude_extras 设置
// 当作"特典"排除的停车行，每行一个文件名 + Restore 按钮，取消排除后该文件回到 pending 池重新
// 参与 ingest。
import { useState } from 'react'
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
  /** 翻案一行——返回 Promise，本组件据其成败驱动 busy/error（dashboard 审计 #2：此前 onRestore
   *  返回 void，失败被裸吞、无 loading 可双提交）。 */
  onRestore: (path: string) => Promise<void>
}

function ExcludedRow({ row, onRestore }: { row: ParkedItemDTO; onRestore: (path: string) => Promise<void> }) {
  const { t } = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    if (busy) return // 同步去重：飞行中不再触发（双提交防护）
    setBusy(true)
    setError(null)
    try {
      await onRestore(row.path)
    } catch (e) {
      setError(t('triage_restore_error_prefix') + (e instanceof Error ? e.message : String(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="triage-excluded-row">
      <span className="triage-excluded-file" title={row.path}>
        {pathTail(row.path)}
      </span>
      <Button
        size="sm"
        variant="secondary"
        label={t('triage_excluded_restore_label')}
        isLoading={busy}
        isDisabled={busy}
        onClick={restore}
      />
      {error && <span className="auth-error" role="alert">{error}</span>}
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
