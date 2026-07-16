// web/src/main.tsx：真正的渲染根——Theme 包裹放这里（不是 App.tsx），因为 main.tsx 才是
// "只挂载一次"的入口，Theme 又是纯视觉层的事，跟 App 里的产品逻辑（I18nProvider/路由）分开。
// scout.css（三行全局 import 里的第三行）也在这里 import，与 Theme 的 mode="dark" 对应
// （scout.ts 是 dark-only 主题，light 位同值，见该文件注释）。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from '@astryxdesign/core/theme'
import { scoutTheme } from './theme/scout.js'
import { App } from './App.js'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={scoutTheme} mode="dark">
      <App />
    </Theme>
  </StrictMode>,
)
