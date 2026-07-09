// web/src/components/StoryPanel.tsx
import { useState } from 'react'
import type { StoryDTO } from '../api/types.js'

const Check = ({ fail }: { fail: boolean }) => (
  <div className={`sn${fail ? ' fail' : ''}`}>
    {fail
      ? <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
      : <svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7" /></svg>}
  </div>
)

export function StoryPanel({ story, loading }: { story: StoryDTO | null; loading: boolean }) {
  const [showRaw, setShowRaw] = useState(false)
  if (loading) return <div className="panel empty">读取运行详情…</div>
  if (!story) return <div className="panel empty">选择左侧一次运行，查看它的工作过程</div>
  return (
    <div className="panel">
      <div className="ptitle">{story.name}</div>
      <div className={`pout ${story.tone}`}>{story.tone === 'ok' ? '✓ ' : ''}{story.outcomeLabel}</div>
      <div className="steps">
        {story.steps.map((st, i) => (
          <div className="st" key={i}>
            <Check fail={st.state === 'fail'} />
            <div className="sttl">{st.title}</div>
            <div className="sre">{st.detail}</div>
          </div>
        ))}
      </div>
      <div className="peek" onClick={() => setShowRaw(v => !v)}>
        {showRaw ? '▾ 收起原始细节' : '▸ 想看它每一步的原始细节？点这里'}
      </div>
      {showRaw && (
        <div className="raw">{JSON.stringify({ steps: story.raw.pipelineSteps, llm: story.raw.llmCalls }, null, 2)}</div>
      )}
    </div>
  )
}
