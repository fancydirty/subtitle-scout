import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
