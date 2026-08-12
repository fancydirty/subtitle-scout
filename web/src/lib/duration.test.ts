// web/src/lib/duration.test.ts：formatDuration 的阶梯与钳制。
//
// 这两条断言原本住在 `library/text.test.ts` 的 `describe('formatDuration')` 里。Task ⑪ 把
// 旧 library 页面移入 `_legacy/`，函数本体跟着提到 `lib/duration.ts`（理由见那个文件的头
// 注释：`settings/text.ts` 在用它，live → _legacy 的边会把下架卡死），**测试跟着函数走**——
// 断言逐字搬运，不是新写的、也没有被削弱。
//
// ⚠️ 留在 `_legacy/library/text.test.ts` 里那份已删除（不是注释掉）：函数已不在那个模块上，
// 留着会 import 不到。这就是本 task 报告里"用例数变化逐条解释"的其中一条：-2（旧址）
// +2（新址），净 0。
import { describe, it, expect } from 'vitest'
import { formatDuration } from './duration.js'

describe('formatDuration', () => {
  it('阶梯：s/m/h/d', () => {
    expect(formatDuration(30_000)).toBe('30s')
    expect(formatDuration(90_000)).toBe('1m')
    expect(formatDuration(2 * 3_600_000)).toBe('2h')
    expect(formatDuration(3 * 86_400_000)).toBe('3d')
  })
  it('负数钳制到 0', () => {
    expect(formatDuration(-5000)).toBe('0s')
  })
})
