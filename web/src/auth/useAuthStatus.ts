// web/src/auth/useAuthStatus.ts：鉴权 A2 Task 11——App 层鉴权门的数据源。mount 探一次
// /auth/status；收到全局 scout:unauthorized（任意请求 401，会话过期/登出）即重探——App 自动切回
// LoginPage，无需每个数据 hook 各自处理 401。
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { UNAUTHORIZED_EVENT } from '../api/client.js'
import type { AuthStatusDTO } from '../api/types.js'

export function useAuthStatus() {
  const [status, setStatus] = useState<AuthStatusDTO | null>(null)

  const reload = useCallback(() => {
    // 探测失败（服务器不可达/500）→ 安全默认为"需登录"，而不是持久白屏或误放行 Shell。若服务器
    // 真的宕了，LoginPage 的登录尝试会显示"无法连接服务器"，构成一致的降级体验。初始 null 仅表
    // "首探未回"（<100ms 的加载空拍）。
    api.authStatus()
      .then(setStatus)
      .catch(() => setStatus({ initialized: true, authenticated: false }))
  }, [])

  useEffect(() => {
    reload()
    window.addEventListener(UNAUTHORIZED_EVENT, reload)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, reload)
  }, [reload])

  return { status, reload }
}
