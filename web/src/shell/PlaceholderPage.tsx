// web/src/shell/PlaceholderPage.tsx：三个新页面（活动/通知/媒体库）的共用占位壳。
//
// ── 为什么是"施工中"而不是画一个假 UI（任务书点名）──────────────────────────
// 占位期画骨架屏/示例卡片会让人分不清"还没做"与"做了但没数据"——本仓的病 B（把中间量
// 说成结论量）的 UI 版。这里的处置是**明说**：页面名 + 它将来回答什么问题 + 一行
// "Task ⑧⑨⑩ 填充"的施工状态。用户看得出这里将来是什么，也看得出它现在什么都不是。
//
// ── 视觉（DESIGN.md / R-F11 Linear 基准）──────────────────────────────────
// 四层 surface 阶梯 + 三层 hairline、**拒绝投影**：这里用 `bg-card` 面板 + 1px
// `border-border` 发丝线，无 box-shadow。
// ⚠️ DESIGN.md 的 token 名（surface-1 #0f1011 / hairline #23252a）在本仓**不存在**——
// 本仓 tw.css 用的是自己那套语义名（--color-card #111318 / --color-border
// rgba(255,255,255,.07)），值接近但不同名。占位页**不新增 CSS 变量**（没有资格扩色板），
// 直接消费既有 token；两套名字的对齐是 Task ⑧⑨⑩ 真正做视觉时的事，不在这里偷偷开一个
// `var(--color-surface-1, …)`——那个变量没人定义，fallback 会静默生效，谁都发现不了。
// 间距走既有 Tailwind 尺度（p-4，同 AppShell 的 contentPadding）。字号/字色沿用 Topbar
// 那套（text-sm 正文、text-muted-foreground 次要、font-mono 技术性读数）。
import type { ReactNode } from 'react'
import { useT } from '../i18n/useT.js'

interface Props {
  /** 页面名（导航标签的同一份文案，由调用方 t() 出来传进来）。 */
  title: string
  /** 这个页面将来回答什么问题——一句人话，不是功能清单。 */
  purpose: string
  /** 施工状态：哪个 task 填肉、数据源是什么。诚实到可核对的程度。 */
  buildNote: string
  children?: ReactNode
}

export function PlaceholderPage({ title, purpose, buildNote, children }: Props) {
  const { t } = useT()
  return (
    <section
      // 既有 token：bg-card（--color-card）+ border-border（--color-border 发丝线）+
      // rounded-control（--radius-control 8px）。无 shadow——DESIGN.md 拒绝投影。
      className="rounded-control border border-border bg-card p-4"
      aria-labelledby="placeholder-heading"
    >
      <div className="flex items-baseline gap-3">
        <h1 id="placeholder-heading" className="text-[17px] font-semibold leading-6 text-foreground">
          {title}
        </h1>
        {/* "施工中"标签——本地化文案，与页面名同一行。这是用户一眼看到的那句实话：
            页面在这儿、但它还不是成品。 */}
        <span className="font-mono text-[11px] uppercase leading-5 tracking-wide text-weak">
          {t('placeholder_under_construction')}
        </span>
      </div>
      <p className="mt-2 max-w-prose text-sm leading-5 text-muted-foreground">{purpose}</p>
      {/* 施工状态用 mono 灰——与 Topbar 新鲜度行同一套"技术性读数"的排印语言，
          一眼可辨它是给开发者看的状态，不是产品文案。 */}
      <p className="mt-3 font-mono text-[13px] leading-5 text-muted-foreground">{buildNote}</p>
      {children}
    </section>
  )
}
