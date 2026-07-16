// web/src/shell/CommandK.tsx：⌘K/Ctrl+K 全局导航面板。F2 只做四 tab 跳转（"F2 只做导航，
// 不做搜索"）——searchSource 只是对四个固定项做本地过滤，真正的全局搜索留给后续任务。
// esc 关闭 + esc 键帽角标走 CommandPalette 默认 footer（内置 Kbd 提示），不用自定义。
import { useMemo } from 'react'
import { CommandPalette, CommandPaletteInput } from '@astryxdesign/core/CommandPalette'
import { createStaticSource } from '@astryxdesign/core/Typeahead'
import { useHotkeys } from '@astryxdesign/core/hooks'
import { useT } from '../i18n/useT.js'
import { TABS } from './tabs.js'
import { go, type Tab } from './route.js'

interface Props {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
}

export function CommandK({ isOpen, onOpenChange }: Props) {
  const { t } = useT()

  // 全局快捷键：mod+k 在 macOS 解析成 ⌘K，其它平台是 Ctrl+K（useHotkeys 内置的平台适配）。
  useHotkeys([{ keys: 'mod+k', onPress: () => onOpenChange(true) }])

  const source = useMemo(
    () => createStaticSource(TABS.map((m) => ({ id: m.id, label: t(m.labelKey) }))),
    [t],
  )

  return (
    <CommandPalette
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      searchSource={source}
      label={t('cmdk_label')}
      input={<CommandPaletteInput placeholder={t('cmdk_placeholder')} />}
      emptyBootstrapText={t('cmdk_empty')}
      emptySearchText={t('cmdk_empty')}
      onValueChange={(value) => go(value as Tab)}
    />
  )
}
