import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.ts'],
    // 审计四轮 R4：React Testing Library 的异步查询（findBy*/waitFor）在 jsdom 里依赖微任务调度，
    // vitest 默认的 CPU 核数并行 worker 在 8+ 核机器上会让这些微任务被抢占，异步 UI 断言超时
    // （实测并发 2-4 个 worker 时失败率 >30%，串行 0%）。这不是"放宽 timeout 掩盖慢"，而是
    // jsdom 的 event loop 本身不真并行，硬并行只会互相踩。把并发压到 CPU 一半且不少于 2，
    // 兼顾速度与稳定；testTimeout 给足等待时间，杜绝假失败。
    maxWorkers: Math.max(2, Math.floor((globalThis.navigator?.hardwareConcurrency ?? 4) / 2)),
    minWorkers: 1,
    testTimeout: 10_000,
  },
})
