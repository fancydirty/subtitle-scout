// web/src/shell/rootHealth.test.ts —— `roots[]` 三态折叠的**纯函数层**。
//
// 这一层守的是后端 buildRootHealth 头注释里那条点名的渲染纪律：
// **`null` 必须画灰，绝不许 `?? true` 兜底**。三态在这里被折成两个名单，
// 折错的两种方向（`?? true` 把未知报成健康、`?? false` 把未知报成故障）
// 各有一条用例钉着。
import { describe, it, expect } from 'vitest'
import { rootHealthSummary, hasRootHealthNote } from './rootHealth.js'
import type { HealthRootDTO } from '../api/types.js'

function root(path: string, ok: boolean | null, lastError: string | null = null): HealthRootDTO {
  return { path, ok, lastError, lastCheckedAt: ok === null ? null : 1_700_000_000_000 }
}

describe('rootHealthSummary · `ok` 是三态，三个分支各去各的地方', () => {
  it('ok=false → failed（新鲜判决 + 读取失败）', () => {
    expect(rootHealthSummary([root('/media', false, '守备目录读取失败')]))
      .toEqual({ failed: ['/media'], unknown: [] })
  })

  it('ok=null → unknown（从没扫过 / 判决陈旧）', () => {
    expect(rootHealthSummary([root('/new', null)]))
      .toEqual({ failed: [], unknown: ['/new'] })
  })

  it('ok=true → **两个名单都不进**（健康的根一个字都不占屏）', () => {
    expect(rootHealthSummary([root('/ok', true)]))
      .toEqual({ failed: [], unknown: [] })
  })

  // 🔴 后端 buildRootHealth 与 api/types.ts 两处头注释点名的那条禁令。
  // 变异：把判据写成 `if (r.ok ?? true) continue; failed.push(...)` → 这一条红。
  it('🔴 `null` **绝不许**折成"健康"（`?? true` 兜底 → 本条红）', () => {
    const s = rootHealthSummary([root('/never-scanned', null)])
    expect(s.unknown, '未知被当成健康吞掉了——这正是三态设计要防的那句假话').toEqual(['/never-scanned'])
    expect(s.failed).toEqual([])
  })

  // 🔴 镜像方向：同样是拿中间量当结论量。
  // 变异：把判据写成 `if (r.ok) {} else failed.push(...)`（两分支，null 掉进 else）→ 这一条红。
  it('🔴 `null` **也不许**折成"坏了"（两分支 if/else → 本条红）', () => {
    const s = rootHealthSummary([root('/never-scanned', null)])
    expect(s.failed, '未知被报成故障——把"还没轮到扫"说成"挂载掉了"').toEqual([])
    expect(s.unknown).toEqual(['/never-scanned'])
  })

  it('🔴 陈旧的红（ok=null 但 lastError 非 null）归 unknown，不归 failed', () => {
    // 后端注释点名：`ok === null` 时 lastError 仍可能非 null，但它**不是当前结论**。
    // 拿 lastError 判 failed 就是把两周前那次失败说成"现在是坏的"。
    const s = rootHealthSummary([root('/stale', null, '守备目录读取失败，本轮跳过（已重试 2 次）')])
    expect(s.failed).toEqual([])
    expect(s.unknown).toEqual(['/stale'])
  })

  it('三态混合：各归各的，顺序保持后端给的顺序（后端 ORDER BY path）', () => {
    const s = rootHealthSummary([
      root('/a', true), root('/b', false), root('/c', null), root('/d', false),
    ])
    expect(s).toEqual({ failed: ['/b', '/d'], unknown: ['/c'] })
  })

  it('空 roots → 两个名单都空（零守备目录不是故障）', () => {
    expect(rootHealthSummary([])).toEqual({ failed: [], unknown: [] })
  })
})

describe('hasRootHealthNote · 沉默即好消息', () => {
  it('全健康 → false（整段不渲染）', () => {
    expect(hasRootHealthNote(rootHealthSummary([root('/a', true), root('/b', true)]))).toBe(false)
  })
  it('有一个坏的 → true', () => {
    expect(hasRootHealthNote(rootHealthSummary([root('/a', true), root('/b', false)]))).toBe(true)
  })
  it('只有未知 → true（"不知道"也是要说的话）', () => {
    expect(hasRootHealthNote(rootHealthSummary([root('/a', null)]))).toBe(true)
  })
})
