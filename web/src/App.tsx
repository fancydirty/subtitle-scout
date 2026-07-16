// web/src/App.tsx：dashboard-F2 新外壳入口——I18nProvider 包 Shell（侧栏/顶栏/⌘K + 四 tab
// hash 路由）。Theme（Astryx 主题）包裹在 main.tsx（见该文件顶部注释：选了 main.tsx 而不是这里，
// 因为它是真正的渲染根，App 只管产品逻辑）。
import { I18nProvider } from './i18n/useT.js'
import { Shell } from './shell/AppShell.js'

export function App() {
  return (
    <I18nProvider>
      <Shell />
    </I18nProvider>
  )
}
