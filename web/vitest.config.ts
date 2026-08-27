import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// styles.css 的原文注入编译期常量（2026-07-31）。
//
// 为什么需要：几条产品裁决的**真身在 CSS 里**（海报 2:3、不定态动画、脉动点非黄色），
// 只断言"类名在场"锁不住它们——把 CSS 改成 16/9 不会让任何测试变红，那是假保护。
//
// 为什么走 define 而不是别的：
//  - `import '…css?raw'` 在 vitest 里**恒返回空字符串**（它对 CSS 走 css:false 的处理链）。
//    实测踩过：三条断言因此全部变成永假。
//  - 测试里 `node:fs` 会破 tsconfig 的 `types` 白名单（web 是浏览器侧工程，只放
//    vitest/globals 与 jest-dom）。
// define 在构建期完成替换，运行时不需要任何模块，也不碰类型白名单。
const STYLES_CSS = readFileSync(resolve(__dirname, 'src/styles.css'), 'utf8')

// tw.css 同样注入：**token 的定义在 tw.css，消费方在 styles.css**，只读后者的话
// `var(--color-fg)` 这种「拼错的 token 名」看起来和正确的一模一样。CSS 里未定义的
// 自定义属性不会报错也不会回退到低优先级声明，而是 IACVT → 该属性取继承值，
// 于是错误在多数元素上被 body 的 --color-foreground 掩盖掉，只在父级另设了 color
// 的地方（.wb-run-log-latest）才现形。两个文件都在手里才能机器判定「引用的 token
// 真的存在」。
const TW_CSS = readFileSync(resolve(__dirname, 'src/tw.css'), 'utf8')

// AppShell.tsx 同样注入（2026-08-27 布局体系）：main 的留白档位（p-6 xl:p-8）是布局
// spec 的计算值裁决，真身是 className 字符串。走 define 与上面同一条理由——tsx 用
// `?raw` 得给 tsconfig 的 types 白名单开例外，define 不碰任何运行时模块。
const APPSHELL_TSX = readFileSync(resolve(__dirname, 'src/shell/AppShell.tsx'), 'utf8')

export default defineConfig({
  plugins: [react()],
  define: {
    __STYLES_CSS__: JSON.stringify(STYLES_CSS),
    __TW_CSS__: JSON.stringify(TW_CSS),
    __APPSHELL_TSX__: JSON.stringify(APPSHELL_TSX),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    // 审计五轮 R5：R4 的"flaky 根治"是假根治——只调了 vitest 的 testTimeout，但失败用例死在
    // React Testing Library 的 findBy* 内部轮询（默认 1000ms 超时），vitest 的 testTimeout
    // 根本管不到。真正的解药在 setupTests.ts 的 configure({ asyncUtilTimeout: 5000 })。
    // 这里固定 3 个 worker：jsdom 的 event loop 本身不真并行，超过 3 个 worker 只会互相踩
    // （实测 5 个 worker 时失败率 >30%，3 个 worker 4 次连跑 301/301 全绿）。
    maxWorkers: 3,
    testTimeout: 10_000,
  },
})
