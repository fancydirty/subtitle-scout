// web/src/main.tsx：渲染根——只挂载一次的入口，视觉层与产品逻辑（App.tsx 里的
// I18nProvider/路由）分开。import 顺序不动：先 styles.css（基础样式 + 各屏自绘规则），
// 后 tw.css（新栈 token/utilities 层，utilities 后赢）。
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'
// 新栈 token/utilities 层——必须在 styles.css 之后（具名样式先声明、utilities 后赢）。
import './tw.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
