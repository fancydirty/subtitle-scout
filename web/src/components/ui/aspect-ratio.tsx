// 自绘，取代 @astryxdesign/core 的 AspectRatio（src/AspectRatio/AspectRatio.tsx）。
// 逐字保留：外层 position:relative / width:100% / overflow:clip / min-height:0 / flex-shrink:0
// + 内联 aspect-ratio。
//
// **关键：cover/contain 的子元素裁切在 Astryx 里不在组件里，而在它的 reset.css 中**
// （组件只往内层 wrapper 挂 data-astryx-aspect-ratio-override={fit}，真正的
// object-fit 规则写在 reset.css）。Task 31 会删掉 reset.css——所以这里必须自己实现裁切，
// 否则唯一调用点（PosterCard.tsx:37 ratio={2/3} fit="cover"）的海报会在卸载那一刻悄悄变形，
// 而且是"构建通过、测试全绿、只有肉眼能看出来"的那种坏法。
// 这里把 Astryx 的内层 wrapper 拍平了（只有一个子节点，多一层 div 没有收益）。
import * as React from 'react'
import { cn } from '../../lib/utils.js'

function AspectRatio({
  ratio,
  fit = 'cover',
  className,
  style,
  ...props
}: React.ComponentProps<'div'> & { ratio: number; fit?: 'cover' | 'contain' }) {
  return (
    <div
      data-slot="aspect-ratio"
      className={cn(
        'relative min-h-0 w-full shrink-0 overflow-clip',
        '[&>*]:absolute [&>*]:inset-0 [&>*]:h-full [&>*]:w-full',
        fit === 'cover' ? '[&>img]:object-cover [&>video]:object-cover' : '[&>img]:object-contain [&>video]:object-contain',
        className,
      )}
      style={{ aspectRatio: ratio, ...style }}
      {...props}
    />
  )
}

export { AspectRatio }
