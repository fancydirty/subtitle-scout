import { useEffect, useState } from 'react'
import { useDashboard } from './api/useDashboard.js'
import { api } from './api/client.js'
import type { RunDTO, StoryDTO, QueueDTO } from './api/types.js'
import { TopBar } from './components/TopBar.js'
import { SummaryHeader } from './components/SummaryHeader.js'
import { ActivityFeed } from './components/ActivityFeed.js'
import { StoryPanel } from './components/StoryPanel.js'

export function App() {
  const { summary, runs } = useDashboard()
  const [selected, setSelected] = useState<RunDTO | null>(null)
  const [story, setStory] = useState<StoryDTO | null>(null)
  const [loadingStory, setLoadingStory] = useState(false)
  const [tab, setTab] = useState<'feed' | 'queue'>('feed')
  const [queue, setQueue] = useState<QueueDTO | null>(null)
  const now = Date.now()

  const onSelect = async (r: RunDTO) => {
    setSelected(r); setStory(null); setLoadingStory(true)
    try { setStory(await api.story(r.id)) } catch { setStory(null) } finally { setLoadingStory(false) }
  }

  useEffect(() => {
    if (tab === 'queue' && !queue) api.queue().then(setQueue).catch(() => setQueue({ pending: [], dormant: [] }))
  }, [tab, queue])

  return (
    <div className="shell">
      <TopBar />
      <SummaryHeader s={summary} />

      {tab === 'feed' ? (
        <div className="grid">
          <ActivityFeed data={runs} now={now} selectedId={selected?.id ?? null} onSelect={onSelect} />
          <StoryPanel story={story} loading={loadingStory} />
        </div>
      ) : (
        <QueueView q={queue} />
      )}

      <div className="foot">
        <button className={tab === 'feed' ? 'on' : ''} onClick={() => setTab('feed')}>最近</button>
        <button className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
          队列 {summary ? summary.queuePending : ''}
        </button>
      </div>
    </div>
  )
}

function QueueView({ q }: { q: QueueDTO | null }) {
  if (!q) return <div className="qlist"><div className="slab">队列</div>读取中…</div>
  const all = [...q.pending, ...q.dormant]
  return (
    <div>
      <div className="slab" style={{ marginTop: 16 }}>队列 · {all.length} 部等待中</div>
      <div className="qlist">
        {all.length === 0 && <div className="qrow">队列是空的，一切都跟上了</div>}
        {all.map(it => (
          <div className="qrow" key={it.itemId}>
            <span>{it.name}</span><span className="qs">{it.statusLabel}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
