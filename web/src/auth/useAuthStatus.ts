// web/src/auth/useAuthStatus.ts：鉴权 A2 Task 11——App 层鉴权门的数据源。mount 探一次
// /auth/status；收到全局 scout:unauthorized（任意请求 401，会话过期/登出）即重探——App 自动切回
// LoginPage，无需每个数据 hook 各自处理 401。
//
// 三态区分（correctness 审计 #2/#6）：loading（首探未回，status=null && !error）/ ready（status 非
// null）/ error（探测失败，error=true）。探测失败**不**再默认成"已初始化未登录"——那会在 fresh
// install 上误显 LoginPage、并让用户对着"用户名或密码不正确"的假象（登录必然失败，因为其实没
// 初始化）。改为如实进"连接错误 + 重试"态。fetch 带超时（AbortController），避免服务器接了 socket
// 却不回包时 status 永远卡 null → 永久白屏。
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { UNAUTHORIZED_EVENT } from '../api/client.js'
import type { AuthStatusDTO } from '../api/types.js'

const PROBE_TIMEOUT_MS = 8000

export interface AuthStatusState {
  status: AuthStatusDTO | null
  error: boolean
  reload: () => void
}

export function useAuthStatus(): AuthStatusState {
  const [status, setStatus] = useState<AuthStatusDTO | null>(null)
  const [error, setError] = useState(false)

  const reload = useCallback(() => {
    setError(false)
    setStatus(null)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
    api.authStatus(ac.signal)
      .then((s) => { setStatus(s); setError(false) })
      .catch(() => { setStatus(null); setError(true) })
      .finally(() => clearTimeout(timer))
  }, [])

  useEffect(() => {
    reload()
    window.addEventListener(UNAUTHORIZED_EVENT, reload)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, reload)
  }, [reload])

  return { status, error, reload }
}
