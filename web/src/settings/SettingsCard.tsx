// web/src/settings/SettingsCard.tsx：通用卡片容器（spec §3.1）。复用 shadcn Card 基底
// （rounded-card/p-5/bg-card/border-border 既有 token，不写 spec 散文 hex 字面量）。
// 状态 badge 三态：configured=绿（text-fn-green）、unconfigured=黄（text-fn-amber）、
// locked=灰（text-muted-foreground）。文案走 settings_status_* 键（审计 P0-3）。
//
// 2026-08-18 Vercel 风扩展：
//   · statusDot 槽——header 标题左侧贴一个 StatusDot，与右上角 badge 同语义，
//     视觉权重更平衡（用户裁决 B 方案：状态点进 header 跟标题绑定）。
//   · footer 槽——独立的操作行容器，自带 border-t hairline 与 CardContent 分隔。
//     用于「Test connection / Edit credentials + lastTest 相对时间」那一行。
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.js'
import { Badge } from '../components/ui/badge.js'
import { StatusDot } from '../components/ui/status-dot.js'
import { useT, type TKey } from '../i18n/useT.js'

type Status = 'configured' | 'unconfigured'

const STATUS_LABEL_KEY: Record<Status, TKey> = {
  configured: 'settings_status_configured',
  unconfigured: 'settings_status_unconfigured',
}

const STATUS_CLASS: Record<Status, string> = {
  configured: 'border-transparent bg-fn-green/15 text-fn-green',
  unconfigured: 'border-transparent bg-fn-amber/15 text-fn-amber',
}

interface Props {
  title: string
  description?: string
  status?: Status
  /** header 标题左侧的状态点。与 status badge 同语义但权重不同：
   *  点贴标题、徽章在右。一般 configured→success，unconfigured 时不传（黄徽章已足够）。 */
  statusDot?: 'success' | 'error'
  /** 独立操作行容器，自带 border-t hairline。 */
  footer?: ReactNode
  children: ReactNode
  className?: string
  'data-testid'?: string
}

export function SettingsCard({ title, description, status, statusDot, footer, children, className, 'data-testid': dataTestId }: Props) {
  const { t } = useT()
  return (
    <Card className={className} data-testid={dataTestId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {statusDot ? (
            <StatusDot variant={statusDot} label={status ? t(STATUS_LABEL_KEY[status]) : title} />
          ) : null}
          <div className="flex flex-col gap-1">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
        </div>
        {status ? (
          <Badge variant="outline" className={STATUS_CLASS[status]} aria-label={t(STATUS_LABEL_KEY[status])}>
            {t(STATUS_LABEL_KEY[status])}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer ? (
        <div className="border-t border-border px-5 py-3 flex items-center gap-2">
          {footer}
        </div>
      ) : null}
    </Card>
  )
}
