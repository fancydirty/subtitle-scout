// web/src/components/Parked.tsx：去 Jellyfin 化 P6 park 救援页——刻意一次性脚手架，用户已拍板
// "丑就丑"：一个列表 + 一个输入框，不做搜索/候选推荐/批量操作/样式打磨。
// 认领只 POST 写 identify_overrides，不立即从列表移除该行——parked_paths 那一行要等下一轮
// 巡检 recognize() 命中 override 后由摄取层自己清（见 apiV2.ts claimParked 头注释）。这里认领
// 成功后只灰掉该行 + 提示"下一轮巡检生效"，不假装它已经处理完。
import { useState } from 'react'
import { useParked } from '../api/hooks.js'
import { api } from '../api/client.js'
import { relTime } from '../lib/time.js'
import { ErrorState, EmptyState } from './states.js'
import { Brand } from './Brand.js'
import { go } from '../lib/hashRoute.js'

type RowState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'claimed' }
  | { kind: 'error'; message: string }

function ParkedRow({ path, parkReason, firstSeen }: { path: string; parkReason: string; firstSeen: number }) {
  const [tmdbId, setTmdbId] = useState('')
  const [isTv, setIsTv] = useState(true)
  const [state, setState] = useState<RowState>({ kind: 'idle' })
  const now = Date.now()

  const claim = async () => {
    setState({ kind: 'submitting' })
    try {
      await api.claimParked({ path, tmdbId, isTv })
      setState({ kind: 'claimed' })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const claimed = state.kind === 'claimed'

  return (
    <tr className={claimed ? 'parked-row claimed' : 'parked-row'}>
      <td className="parked-path">{path}</td>
      <td>{parkReason}</td>
      <td>{relTime(firstSeen, now)}</td>
      <td>
        <input
          className="parked-input"
          placeholder="TMDB id"
          value={tmdbId}
          disabled={claimed || state.kind === 'submitting'}
          onChange={(e) => setTmdbId(e.target.value)}
        />
      </td>
      <td>
        <label className="parked-tv">
          <input
            type="checkbox"
            checked={isTv}
            disabled={claimed || state.kind === 'submitting'}
            onChange={(e) => setIsTv(e.target.checked)}
          />
          剧集（否则电影）
        </label>
      </td>
      <td>
        {claimed ? (
          <span className="parked-note">已认领 — 下一轮巡检生效</span>
        ) : (
          <button
            className="btn"
            disabled={!tmdbId || state.kind === 'submitting'}
            onClick={() => void claim()}
          >
            {state.kind === 'submitting' ? '认领中…' : '认领'}
          </button>
        )}
        {state.kind === 'error' && <div className="parked-err">{state.message}</div>}
      </td>
    </tr>
  )
}

export function Parked() {
  const { data, loading, error, reload } = useParked()

  return (
    <div className="frame">
      <div className="topbar">
        <Brand />
        <div className="fact">park 救援</div>
        <div className="tabs">
          <div className="tab" onClick={() => go('/')} role="link" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') go('/') }}>返回海报墙</div>
        </div>
      </div>

      {loading && !data ? (
        <div className="pad">载入中…</div>
      ) : error && !data ? (
        <div className="pad"><ErrorState message={error} onRetry={reload} /></div>
      ) : data && data.length === 0 ? (
        <EmptyState text="没有未识别的文件" />
      ) : (
        <table className="parked-table pad">
          <thead>
            <tr>
              <th>路径</th>
              <th>原因</th>
              <th>挂起于</th>
              <th>TMDB id</th>
              <th>类型</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <ParkedRow key={p.path} path={p.path} parkReason={p.parkReason} firstSeen={p.firstSeen} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
