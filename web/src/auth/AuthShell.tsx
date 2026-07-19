// web/src/auth/AuthShell.tsx：鉴权 A2 Task 8′——SetupWizard / 一次性 API key 屏 / LoginPage
// 三个 auth 界面共享的外壳。居中窄列、裸画布，小 wordmark → serif <h1> → 表单。
//
// serif 的正当性（DESIGN.md §3/§4 铁律：衬线全站只出现一次）：调研（Sonarr/jellyfin-web/
// Overseerr 真源码）结论——被夸的登录页夸的是"构图/人格"，Overseerr 靠背景图，我们暗色极简语言
// 不上背景图，就把那唯一一次衬线花在这里的 <h1>，作零交互成本的仪式感。落地：web-safe serif 栈
// （Georgia），绝不引 webfont（自托管离线形态 + 无新依赖）。全站 serif 仅此 auth-shell__title 一处。
import type { ReactNode } from 'react'

export function AuthShell({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-shell__card">
        <div className="auth-shell__wordmark">subtitle-scout</div>
        <h1 className="auth-shell__title">{heading}</h1>
        {children}
      </div>
    </div>
  )
}
