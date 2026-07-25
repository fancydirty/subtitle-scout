import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 审计五轮 R5：后端套件也有同类 flaky（auth 节流、change-password、200k cue 超时等时序敏感
    // 用例在全核并行下被抢占）。与 web 同款并发限制：jsdom/node 的 event loop 本身不真并行，
    // 超过 3 个 worker 只会互相踩。scrypt 密集的 auth 用例已单独放宽超时（30s）。
    maxWorkers: 3,
    testTimeout: 10_000,
  },
})
