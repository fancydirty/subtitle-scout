// web/src/settings/SettingsCard.tsx：通用卡片容器（spec §3.1）。复用 shadcn Card 基底
// （rounded-card/p-5/bg-card/border-border 既有 token，不写 spec 散文 hex 字面量）。
// 状态 badge 三态：configured=绿（text-fn-green）、unconfigured=黄（text-fn-amber）、
// locked=灰（text-muted-foreground）。文案一律英语专业书面语。
import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card.js'
import { Badge } from '../components/ui/badge.js'

type Status = 'configured' | 'unconfigured' | 'locked'

const STATUS_LABEL: Record<Status, string> = {
  configured: '✓ Configured',
  unconfigured: '⚠ Not configured',
  locked: '🔒 Environment',
}

const STATUS_CLASS: Record<Status, string> = {
  configured: 'border-transparent bg-fn-green/15 text-fn-green',
  unconfigured: 'border-transparent bg-fn-amber/15 text-fn-amber',
  locked: 'border-transparent bg-secondary text-muted-foreground',
}

interface Props {
  title: string
  description?: string
  status?: Status
  children: ReactNode
  className?: string
  'data-testid'?: string
}

export function SettingsCard({ title, description, status, children, className, 'data-testid': dataTestId }: Props) {
  return (
    <Card className={className} data-testid={dataTestId}>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {status ? (
          <Badge variant="outline" className={STATUS_CLASS[status]} aria-label={STATUS_LABEL[status]}>
            {STATUS_LABEL[status]}
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}