// 自绘，取代 @astryxdesign/core 的 Section。
// **不是纯布局件**：Astryx Section 的默认 variant 'section' 会刷 --color-background-surface
// （src/Section/Section.tsx），scout 主题把这个语义设为 #16181f（src/theme/scout.css:90）。
// 过渡期这个色**必须走 --color-secondary 拿**（tw.css:34，#16181f），不能走 --color-accent：
// scout.css:86 把 --color-accent 覆写成 light-dark(#266D00, #96DA26)，Task 31 删掉 scout.css
// 之前 bg-accent 落屏是柠檬绿。当成"透明容器"实现则会让五个调用点的面色凭空消失。
// 另外 Astryx Section **没有圆角**（dist/astryx.css 里 --_section-radius 零命中），
// 所以这里也是方角，不要顺手加 rounded-card。
// padding 写死 p-4：全仓五个调用点（SeriesGrid.tsx:56、SeriesPage.tsx:52/61/67/93）
// 全部是 <Section padding={4}>，留一个只有一个取值的 prop 是噪音。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function Section({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="section" className={cn('bg-secondary p-4', className)} {...props} />
}

export { Section }
