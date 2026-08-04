// web/src/setup/BootstrapGate.tsx：bootstrap 触发闸（spec A §5.1）。推导式无标志位——
// bootstrapComplete=false 才接管；status 拉取失败/加载中直接渲染 children（fail-open：
// wizard 不能因自己的触发探测失败把主界面锁死，观测台永远可达）。Re-run：Settings
// System 区写 sessionStorage 标记 + reload，这里首探前读标记强制 wizard 并一次性消费。
import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import type { SetupStatusDTO } from '../api/types.js'
import { BootstrapWizard } from './BootstrapWizard.js'
import { RERUN_WIZARD_KEY } from './rerun.js'

export function BootstrapGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SetupStatusDTO | null>(null)
  const [failed, setFailed] = useState(false)
  // 同步读 + 同步删：重挂载（React StrictMode 双跑）不会把 re-run 模式吞掉第二次——
  // 首次渲染时已删，第二次读到 null 是正常首跑。
  const [rerun] = useState(() => {
    const hit = sessionStorage.getItem(RERUN_WIZARD_KEY) === '1'
    if (hit) sessionStorage.removeItem(RERUN_WIZARD_KEY)
    return hit
  })

  useEffect(() => {
    let alive = true
    api
      .setupStatus()
      .then((dto) => alive && setStatus(dto))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [])

  if (failed) return <>{children}</>
  if (status === null) return <>{children}</> // 首探未回不闪 wizard（同 AuthGate 空拍纪律）
  if (status.bootstrapComplete && !rerun) return <>{children}</>
  return (
    <BootstrapWizard
      initialStatus={status}
      rerun={rerun}
      onComplete={() => {
        window.location.reload()
      }}
    />
  )
}
