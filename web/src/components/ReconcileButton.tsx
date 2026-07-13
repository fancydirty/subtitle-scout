// web/src/components/ReconcileButton.tsx：v3 phase ⑦ "全仓校验" 触发器按钮——POST
// /api/v2/reconcile-all，展示运行中/结果摘要/错误三态。不轮询、不自动重试，纯点击触发。
import { useState } from 'react'
import { api } from '../api/client.js'

type ReconcileState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; summary: string }
  | { kind: 'error'; message: string }

export function ReconcileButton() {
  const [state, setState] = useState<ReconcileState>({ kind: 'idle' })

  const run = async () => {
    setState({ kind: 'running' })
    try {
      const result = await api.reconcileAll()
      setState({ kind: 'done', summary: result.summary })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <div className="reconcile">
      <button className="btn" disabled={state.kind === 'running'} onClick={() => void run()}>
        {state.kind === 'running' ? '校验中…' : '全仓校验'}
      </button>
      {state.kind === 'done' && <div className="reconcile-msg ok">{state.summary}</div>}
      {state.kind === 'error' && <div className="reconcile-msg err">{state.message}</div>}
    </div>
  )
}
