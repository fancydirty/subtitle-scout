// web/src/components/ActivityFeed.tsx
import type { RunsDTO, RunDTO } from '../api/types.js'
import { relTime } from './relTime.js'

interface Props { data: RunsDTO | null; now: number; selectedId: string | null; onSelect: (r: RunDTO) => void }

export function ActivityFeed({ data, now, selectedId, onSelect }: Props) {
  if (!data) return <div className="feed"><div className="slab">最近</div></div>
  return (
    <div>
      <div className="slab">最近</div>
      <div className="feed">
        {data.inFlight.map(it => (
          <div className="item working noclick" key={`f-${it.itemId}`}>
            <div className="poster" />
            <div className="imeta">
              <div className="ititle">{it.name}</div>
              <div className="iout working"><span className="wdot" />正在找字幕…</div>
            </div>
            <div className="itime">进行中</div>
          </div>
        ))}
        {data.runs.map(r => (
          <div
            key={`r-${r.id || r.itemId}-${r.ts}`}
            className={`item${r.clickable ? '' : ' noclick'}${selectedId === r.id && r.id ? ' sel' : ''}`}
            onClick={() => r.clickable && onSelect(r)}
          >
            <div className="poster" />
            <div className="imeta">
              <div className="ititle">{r.name}</div>
              <div className={`iout ${r.tone}`}>{r.tone === 'ok' ? '✓ ' : ''}{r.outcomeLabel}</div>
            </div>
            <div className="itime">{relTime(r.ts, now)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
