import { describe, it, expect } from 'vitest'
import { dashboardAuthStartupLines } from './dashboardTokenWarning.js'

// 鉴权 A4 Task 15：R2D-5 裸奔告警退役。DASHBOARD_TOKEN 时代结束——首启向导本身就是门，"未设账号"
// 不再是裸奔态。三态播报（cmdWatch 起 dashboard 后逐行 console 播报）：
//   ① tokenSet（无论初始化否）：legacy token 仍有效，建议迁移到账号密码
//   ② 未初始化 + 无 token：一行指路——首次访问进创建管理员向导（不是告警）
//   ③ 已初始化 + 无 token：零输出（健康态不聒噪）
// 抽成独立纯函数是因为 cli/index.ts 顶层有 main().catch(...) 的 import 时副作用（既有教训），
// 不能直接 import index.ts 来测。
describe('dashboardAuthStartupLines（三态播报）', () => {
  it('DASHBOARD_TOKEN 已设 → legacy 提示，建议迁移到账号密码', () => {
    const lines = dashboardAuthStartupLines({ tokenSet: true, initialized: false })
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const joined = lines.join('\n')
    expect(joined).toContain('DASHBOARD_TOKEN')
    expect(joined).toMatch(/迁移|账号|移除/)
  })

  it('DASHBOARD_TOKEN 已设 + 已初始化 → 同样给 legacy 迁移提示（token 与账号可共存，提示迁移）', () => {
    const lines = dashboardAuthStartupLines({ tokenSet: true, initialized: true })
    expect(lines.join('\n')).toContain('DASHBOARD_TOKEN')
  })

  it('未初始化 + 无 token → 一行指路（进创建管理员向导），不含"警告/裸奔/零鉴权"字样', () => {
    const lines = dashboardAuthStartupLines({ tokenSet: false, initialized: false })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/向导|设置|管理员/)
    expect(lines[0]).not.toMatch(/警告|裸奔|零鉴权/)
  })

  it('已初始化 + 无 token → 零输出（健康态不聒噪）', () => {
    expect(dashboardAuthStartupLines({ tokenSet: false, initialized: true })).toEqual([])
  })
})
