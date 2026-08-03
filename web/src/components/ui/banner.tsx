// 自绘，取代 @astryxdesign/core 的 Banner（src/Banner/Banner.tsx）。
// 逐条取自源码：
//   role        warning/error → "alert"；success → "status"
//   header      flex items-start gap-2 py-3 px-4；独立卡时 borderRadius --radius-container (12px)
//   居中        description == null && 有 actions 时改 items-center（Astryx headerCentered）
//   title       --text-label-size **13px** / semibold / leading 1.5385
//   description --text-supporting-size **11px** / normal / leading **1.4545**
//               （两个 px 与那个 leading 都走 scout.css 覆盖后的值——见本 task 开头那张表。
//                 Astryx 源码注释写的是 14 / 12 / 1.6667，那是它自己默认主题的一套。）
//   图标        **{icon ?? <Icon icon={默认状态图标} …/>}——未传 icon 时有默认图标**。
//               本仓唯一调用点（TranslateSection.tsx:88-122）就没传 icon，所以今天屏幕上
//               有一个警告三角；不复刻它，Task 31 就等于静默删掉一个可见字形。
//               图标容器 aria-hidden="true"（源码如此）。
//
// 三处有意差异：
// 1. **丢掉 info 档**：零调用点，且 §5.1 调色板没有"信息色"这一档，现造一个就是发明。
// 2. warning 底色用 Task 6 加的 --color-fn-amber-muted（#e2a4003f，逐字取自 Astryx 暗色
//    --color-warning-muted）——它是唯一活调用点，保真优先。error/success 零调用点，
//    用本仓功能色的 /25（Astryx 那两个 muted 的基色跟本仓 fn-red/fn-green 本来就不同色），
//    不为零调用点再引两个新 token。
// 3. 图标换 lucide（Astryx 的 Icon 组件随主题退役）。
import * as React from 'react'
import { CircleCheckIcon, CircleXIcon, TriangleAlertIcon } from 'lucide-react'
import { cn } from '../../lib/utils.js'

export type BannerStatus = 'warning' | 'error' | 'success'

const BANNER_ROLE: Record<BannerStatus, 'alert' | 'status'> = {
  warning: 'alert',
  error: 'alert',
  success: 'status',
}

const BANNER_SURFACE: Record<BannerStatus, string> = {
  warning: 'bg-fn-amber-muted',
  error: 'bg-fn-red/25',
  success: 'bg-fn-green/25',
}

const BANNER_ICON_COLOR: Record<BannerStatus, string> = {
  warning: 'text-fn-amber',
  error: 'text-fn-red',
  success: 'text-fn-green',
}

function defaultIcon(status: BannerStatus): React.ReactNode {
  const className = cn('size-4 shrink-0', BANNER_ICON_COLOR[status])
  if (status === 'warning') return <TriangleAlertIcon className={className} />
  if (status === 'error') return <CircleXIcon className={className} />
  return <CircleCheckIcon className={className} />
}

function Banner({
  status,
  title,
  description,
  icon,
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  status: BannerStatus
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
}) {
  const isSingleLine = description == null && children != null
  return (
    <div
      data-slot="banner"
      role={BANNER_ROLE[status]}
      className={cn(
        'flex gap-2 rounded-card px-4 py-3',
        isSingleLine ? 'items-center' : 'items-start',
        BANNER_SURFACE[status],
        className,
      )}
      {...props}
    >
      <div aria-hidden="true" className="flex shrink-0 items-center">
        {icon ?? defaultIcon(status)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="m-0 text-[13px] font-semibold leading-[1.5385] text-foreground">{title}</div>
        {description != null && (
          <div className="m-0 text-[11px] font-normal leading-[1.4545] text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

export { Banner }
