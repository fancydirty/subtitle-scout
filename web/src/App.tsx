// web/src/App.tsx：dashboard-F2 新外壳入口 + 鉴权 A2 Task 11 门。I18nProvider 包 AuthGate——
// AuthGate 据 /auth/status 三态分流：未初始化→SetupWizard、已初始化未登录→LoginPage、已登录→
// Shell（侧栏/顶栏/⌘K + 四 tab hash 路由）。Theme 包在 main.tsx（真正的渲染根）。
//
// 结构性白赚（调研 *arr 两 bug）：#6144 stale-cookie 死循环——AuthGate 每次读 auth/status，
// cookie 失效即 authenticated:false→LoginPage，无循环；#6454 deep-link 丢失——AuthGate 包裹
// Shell、从不改 location.hash，登录后 reload() 直接在原 hash 渲染 Shell，深链天然保留。
import { I18nProvider } from './i18n/useT.js'
import { Shell } from './shell/AppShell.js'
import { SetupWizard } from './auth/SetupWizard.js'
import { LoginPage } from './auth/LoginPage.js'
import { ConnectionError } from './auth/ConnectionError.js'
import { useAuthStatus } from './auth/useAuthStatus.js'

function AuthGate() {
  const { status, error, reload } = useAuthStatus()
  // 探测失败：如实显示连接错误 + 重试，不误导为 LoginPage、不永久白屏（correctness 审计 #2/#6）。
  if (error) return <ConnectionError onRetry={reload} />
  if (status === null) return null // 首探未回：加载空拍（<100ms），不闪任何内容
  if (!status.initialized) return <SetupWizard onDone={reload} />
  if (!status.authenticated) return <LoginPage onDone={reload} />
  return <Shell />
}

export function App() {
  return (
    <I18nProvider>
      <AuthGate />
    </I18nProvider>
  )
}
