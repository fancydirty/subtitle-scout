// web/src/components/Poster.tsx：海报图（直连 TMDB CDN），无 posterPath 时降级为 surface 底 + 首字母占位。
import { useState } from 'react'
import { posterUrl } from '../api/client.js'

function initial(name: string): string {
  const c = name.trim()[0]
  return c ? c.toUpperCase() : '?'
}

export function Poster({ posterPath, name }: { posterPath: string | null; name: string }) {
  const url = posterUrl(posterPath)
  const [failed, setFailed] = useState(false)
  if (!url || failed) {
    return (
      <div className="poster-fallback" aria-hidden="true">
        <span>{initial(name)}</span>
      </div>
    )
  }
  return <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
}
