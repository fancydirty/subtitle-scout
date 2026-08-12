// web/src/media/MediaPoster.tsx：海报图（直连 TMDB CDN），无 posterPath 或加载失败时降级为
// surface 底 + 首字母占位。
//
// ⚠️ **不复用 library/PosterThumb.tsx**：那个文件随旧 library 页面在 Task ⑪ 移入 `_legacy`
// （同 episodeStateMeta.ts 头注释的理由③）。逻辑只有 10 行，复制的代价远小于建一条跨越
// 存活期的依赖。共享的是 api/client.ts 的 posterUrl()——那个是**基础设施**（裁决 A：复用
// 不新造），不随页面下架。
//
// §4.4 点名：`posterPath` 为 null / TMDB 图片 404 是**必然分支**，不是边缘兜底
// （DTO 注释明写可为 null）。
import { useState } from 'react'
import { posterUrl } from '../api/client.js'

function initial(name: string): string {
  const c = name.trim()[0]
  return c ? c.toUpperCase() : '?'
}

export function MediaPoster({ posterPath, name }: { posterPath: string | null; name: string }) {
  const url = posterUrl(posterPath)
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return (
      <div className="media-poster-fallback" aria-hidden="true">
        <span>{initial(name)}</span>
      </div>
    )
  }
  return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
}
