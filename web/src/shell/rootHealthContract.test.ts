// web/src/shell/rootHealthContract.test.ts —— 三态在**两侧之间**不漂移。
//
// ══════════════════════════════════════════════════════════════════════════════
// 这个文件补的是 🔴-1 那条链上**最后一道缝**
// ══════════════════════════════════════════════════════════════════════════════
// 链条有三段，改完之后每段各有各的测试：
//   ① 后端两列 → 三态 `ok`     src/dashboard/health.test.ts（buildRootHealth 的纯函数层）
//   ② 三态 → 两个名单          rootHealth.test.ts
//   ③ 两个名单 → DOM           RootHealthNote.test.tsx / rootHealthWiring.test.tsx
// 三段全绿，**中间那道缝仍然可以断**：①产出的三态语义与②认的三态语义可以对不上，
// 而两边的测试各自都只证明"我这段自洽"。②的输入在它自己的测试里是**手写的**
// `{ path, ok, lastError, lastCheckedAt }`——手写的那份永远只会证明"我抄对了"。
//
// 处置逐字照 events/sseWireContract.e2e.test.ts 的既有做法：**直接 import 后端真身**，
// 把 `buildRootHealth` 的真实输出喂给前端的 `rootHealthSummary`。整条链上没有一行
// 是为测试手抄的。跨工程 import 只在**测试**里做（生产代码仍各自独立，见
// api/types.ts 全文件的论证）。
//
// ⚠️ 这个文件**不能**替代后端 server.ts 里那条 `roots: buildRootHealth(...)` 接线的守卫
// ——那一行由 src/dashboard/health.test.ts 的三条端到端用例钉着（实测变异 `roots: []`
// → 后端 3 红）。本文件守的是**语义**，那三条守的是**接线**，两者不互相替代。
import { describe, it, expect } from 'vitest'
// ⭐ 后端真身。
import { buildRootHealth } from '../../../src/dashboard/server.js'
import { rootHealthSummary } from './rootHealth.js'

/** 后端 media_roots 的行形状（buildRootHealth 的入参）。 */
function row(path: string, last_error: string | null, last_checked_at: number | null) {
  return { path, last_error, last_checked_at }
}

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
/** 后端的陈旧门是 2 × INSPECT_INTERVAL_MS = 48h。这里**不复刻那个常量**——
 *  用远超/远低于它的值，这样后端调整周期时本文件不会假红。 */
const FRESH = NOW - HOUR
const ANCIENT = NOW - 400 * HOUR

describe('三态契约：后端 buildRootHealth 的真实输出 → 前端 rootHealthSummary', () => {
  it('🔴 新鲜 + 无错 → 前端认成"健康"，两个名单都不进', () => {
    const dto = buildRootHealth([row('/ok', null, FRESH)], NOW)
    expect(dto[0]!.ok, '后端这一支不再产出 true 了？').toBe(true)
    expect(rootHealthSummary(dto)).toEqual({ failed: [], unknown: [] })
  })

  it('🔴 新鲜 + 有错 → 前端认成 failed', () => {
    const dto = buildRootHealth([row('/bad', '守备目录读取失败，本轮跳过（已重试 2 次）', FRESH)], NOW)
    expect(dto[0]!.ok).toBe(false)
    expect(rootHealthSummary(dto)).toEqual({ failed: ['/bad'], unknown: [] })
  })

  it('🔴 从没扫过（last_checked_at IS NULL）→ 后端给 null，前端认成 unknown（**不是** healthy）', () => {
    // 这是 db.ts v41 那条迁移 entry 预言的坑："折叠成 NOT NULL DEFAULT 0 会让『刚加的根』
    // 与『扫过且健康的根』不可区分，未来的读取方会把前者当成绿的"。
    // 前端就是那个"未来的读取方"，本条钉住它没上当。
    const dto = buildRootHealth([row('/just-added', null, null)], NOW)
    expect(dto[0]!.ok).toBeNull()
    expect(rootHealthSummary(dto)).toEqual({ failed: [], unknown: ['/just-added'] })
  })

  it('🔴 判决陈旧（超 2 个巡检周期）→ 后端给 null，前端认成 unknown', () => {
    const dto = buildRootHealth([row('/stale', null, ANCIENT)], NOW)
    expect(dto[0]!.ok).toBeNull()
    expect(rootHealthSummary(dto)).toEqual({ failed: [], unknown: ['/stale'] })
  })

  it('🔴 **陈旧的红**也归 unknown——两个方向都不许拿中间量当结论量', () => {
    // 后端注释：一个两周前失败、此后再没被扫过的根，说它"现在是坏的"与说它"现在是好的"
    // 同样没有依据。前端必须跟着这个裁决走，不许自己看 lastError 翻案。
    const dto = buildRootHealth([row('/stale-bad', '守备目录扫出 0 个媒体文件', ANCIENT)], NOW)
    expect(dto[0]!.ok).toBeNull()
    expect(dto[0]!.lastError, '后端仍会带出原文（它不是当前结论）').not.toBeNull()
    expect(rootHealthSummary(dto)).toEqual({ failed: [], unknown: ['/stale-bad'] })
  })

  it('🔴 三态在同一次响应里各归各的（这就是 /health 的真实形态）', () => {
    const dto = buildRootHealth([
      row('/ok', null, FRESH),
      row('/bad', 'boom', FRESH),
      row('/unknown', null, null),
    ], NOW)
    expect(dto.map((r) => r.ok)).toEqual([true, false, null])
    expect(rootHealthSummary(dto)).toEqual({ failed: ['/bad'], unknown: ['/unknown'] })
  })

  it('🔴 `ok` 的值域**恰好是三个**——后端换成 status 字符串时本条红', () => {
    // 前端的三分支恒等判定（=== false / === null）在值域变化时会静默把所有根都
    // 归成"健康"（既不 === false 也不 === null）。那是一个不会有任何断言变红的
    // 灾难，除非有人在这里钉住值域本身。
    const dto = buildRootHealth([
      row('/a', null, FRESH), row('/b', 'x', FRESH), row('/c', null, null),
    ], NOW)
    for (const r of dto) {
      expect([true, false, null], `ok 出现了预期外的值：${String(r.ok)}`).toContain(r.ok)
    }
    expect(new Set(dto.map((r) => r.ok)).size).toBe(3)
  })

  it('🔴 DTO 的四个键都在，且 lastError/lastCheckedAt 是 null 而不是缺席', () => {
    // 后端头注释：undefined 会让字段整个消失，前端就分不清"没有这个事实"与
    // "这版后端还没这个字段"。前端的 HealthRootDTO 手抄件靠这条与真身对齐。
    const [r] = buildRootHealth([row('/a', null, null)], NOW)
    expect(Object.keys(r!).sort()).toEqual(['lastCheckedAt', 'lastError', 'ok', 'path'])
    expect(r!.lastError).toBeNull()
    expect(r!.lastCheckedAt).toBeNull()
  })
})
