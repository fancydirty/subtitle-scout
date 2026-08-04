// web/src/shell/CommandK.tsx：⌘K/Ctrl+K 全局导航面板——自绘（Astryx CommandPalette/Typeahead 退役，
// useHotkeys 换 ../lib/useHotkeys.js）。F2 只做四 tab 跳转（"F2 只做导航，不做搜索"）——输入框只对
// 四个固定项做本地子串过滤，真正的全局搜索留给后续任务。
// 六条硬契约（App.test.tsx 的 ⌘K 两条集成用例与本目录 CommandK.test.tsx 压着的）：
//   ① 开时 role="dialog"、关时整棵不在 DOM（Radix Dialog 的卸载语义免费给）；
//   ② 输入框 role="combobox"（aria-expanded/aria-controls/aria-activedescendant 配套指向列表）；
//   ③ Escape 在 combobox 上按下 → 关（Radix 的 Esc 监听在 document，jsdom 里从 input 冒泡到 document 即触发）；
//   ④ 点项 → 跳转 + 关；
//   ⑤ 项渲染在侧栏之后的 DOM 序（DialogPortal 挂 document.body 末尾——天然满足）；
//   ⑥ ↑/↓ 移动高亮（wrap 不 clamp）+ Enter 激活（aria-activedescendant/aria-selected 配套，
//      逐字对齐 Astryx BaseTypeahead.js:413-428）——2026-08-04 spec 审对抗扫描抓获的 recon 漏项补入。
//
// 与被退役路径（CommandPalette → useCombobox，Selector/hooks.js:162-183）的三处有意偏离——
// 2026-08-04 plan 作者裁决：现代命令面板行为，照 BaseTypeahead 对齐，是有意识的接受而非漏判：
//   Δ1 wrap 不 clamp（useCombobox 是 Math.min/Math.max 钳位，到底/到顶停住；本件回卷）；
//   Δ2 打开即高亮首项（useCombobox 以 -1 打开，⌘K→Enter 原本是 no-op；现在会跳到 Library）；
//   Δ3 过滤变化重置高亮到首项（useCombobox 不重置，高亮跟着旧索引漂）。
import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog.js'
import { useHotkeys } from '../lib/useHotkeys.js'
import { cn } from '../lib/utils.js'
import { useT } from '../i18n/useT.js'
import { TABS } from './tabs.js'
import { go, type Tab } from './route.js'

interface Props {
  isOpen: boolean
  onOpenChange: (isOpen: boolean) => void
}

export function CommandK({ isOpen, onOpenChange }: Props) {
  const { t } = useT()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(-1)

  // 全局快捷键：mod+k 在 macOS 解析成 ⌘K，其它平台是 Ctrl+K（useHotkeys 内置的平台适配）。
  // 挂载即注册，isOpen 不参与。面板开着时焦点恒在 combobox 里，isTypingTarget 会把 mod+k
  // 吞掉（allowInInputs 默认 false）——开着再按是 no-op，不是"幂等重开"；终态一致，机制不同。
  useHotkeys([{ keys: 'mod+k', onPress: () => onOpenChange(true) }])

  const items = useMemo(() => {
    const all = TABS.map((m) => ({ id: m.id, label: t(m.labelKey) }))
    const q = query.trim().toLowerCase()
    // 过滤语义与 Astryx createStaticSource（dist/Typeahead/createStaticSource.js:40-54）
    // 逐字平价：trim + lowercase + 子串包含——它不是 fuzzy，两地实现语义逐字节相同，
    // 换自绘换来的是零依赖与可预测的测试语义，过滤结果无任何差异。
    return q === '' ? all : all.filter((it) => it.label.toLowerCase().includes(q))
  }, [query, t])

  // Astryx 默认 active 语义（BaseTypeahead.js:255/288：结果集一落地就高亮首项，空集 -1）——
  // 结果集每次变化（含打开时的 bootstrap、每次过滤）都把高亮重置回首项。
  useEffect(() => {
    setActiveIndex(items.length > 0 ? 0 : -1)
  }, [items])

  // 关面板时同时重置查询串与高亮：Astryx 版关掉即卸载、内部 query/highlight 随之销毁；
  // 自绘版组件常驻，不手动清的话重开会带着上次输入的残串与上次的高亮位。两个 set 都要：
  // 查询本已为空时 setQuery('') 是 no-op、items 引用不变、重置 effect 不触发——纯键盘路径
  // （open → ↓↓ → Esc → 重开）只靠 effect 会漏，有回归测试压着。
  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setQuery('')
      setActiveIndex(0)
    }
    onOpenChange(open)
  }

  // Enter 与点击同一条激活路径（Astryx handleSelect 也只有一份）。
  const activate = (id: Tab) => {
    go(id)
    handleOpenChange(false)
  }

  // 键盘导航逐字对齐 Astryx BaseTypeahead.js:413-428——**wrap 不 clamp**
  // （↓ 在末项回卷到 0、↑ 在首项回卷到末项）。Escape 不在这里处理：Radix Dialog 在
  // document 上监听 Esc，从 input 冒泡即关。Home/End 不搬：4 个静态项方向键最多 3 步可达，
  // Astryx 带它们是因为它服务任意长度结果集（YAGNI）。
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActiveIndex((prev) => (prev < items.length - 1 ? prev + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        setActiveIndex((prev) => (prev > 0 ? prev - 1 : items.length - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (activeIndex >= 0 && activeIndex < items.length) activate(items[activeIndex].id)
        break
    }
  }

  const activeDescendant =
    activeIndex >= 0 && activeIndex < items.length ? `cmdk-option-${items[activeIndex].id}` : undefined

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {/* 面板上移（top-[20%]，命令面板不是居中对白）；去掉默认 gap-4/p-6（input 与列表之间
          不留网格缝，输入框自己用 border-b 分面）；sm:max-w-md 覆盖默认 sm:max-w-lg（同组
          覆盖，收窄一档）；showCloseButton=false——X 会压住输入框，Esc/点遮罩已足够关。 */}
      <DialogContent showCloseButton={false} className="top-[20%] translate-y-0 gap-0 p-0 sm:max-w-md">
        <DialogTitle className="sr-only">{t('cmdk_label')}</DialogTitle>
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={activeDescendant}
          aria-autocomplete="list"
          autoComplete="off"
          aria-label={t('cmdk_label')}
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
          placeholder={t('cmdk_placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        {/* 不做 scrollIntoView（Astryx :456-462 有，这里故意不搬）：4 个静态项永远装不满
            max-h-[300px]，高亮项不会溢出可视区（YAGNI）。 */}
        <ul role="listbox" id="cmdk-list" className="max-h-[300px] overflow-y-auto p-1">
          {items.length === 0 ? (
            <li className="px-3 py-2 text-[13px] text-muted-foreground">{t('cmdk_empty')}</li>
          ) : (
            items.map((it, i) => (
              <li
                key={it.id}
                id={`cmdk-option-${it.id}`}
                role="option"
                aria-selected={i === activeIndex}
                className={cn(
                  'cursor-pointer rounded-[4px] px-3 py-2 text-[13px] leading-5 hover:bg-white/5',
                  i === activeIndex && 'bg-white/5',
                )}
                // 高亮随 hover 走（Astryx BaseTypeahead.js:543 同款 onMouseEnter 同步）。
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => activate(it.id)}
              >
                {it.label}
              </li>
            ))
          )}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
