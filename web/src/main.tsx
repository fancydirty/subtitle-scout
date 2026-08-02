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
// 新栈 token/utilities 层——必须在 styles.css 之后（Astryx 层先声明、utilities 后赢）。
//
// ⚠️ 这两行在 Astryx 卸载步（Plan C Task 31）**都保留**。那一步删的是 styles.css 里的
// 三行 `@import`（`:7-9`，reset + astryx.css + scout 主题产物）并补一个替代 preflight，
// styles.css 本体与本处的两行 import 一个都不动——`tw.css` 是新栈的 token/utilities 层，
// 删掉它等于把整套新栈连根拔了。（本注释的前一版写"连本行一起删"，语义指向不明，已改。）
import './tw.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Theme theme={scoutTheme} mode="dark">
      <App />
    </Theme>
  </StrictMode>,
)
