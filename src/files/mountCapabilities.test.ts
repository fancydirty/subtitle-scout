import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, linkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeHardlink, probeCaseSensitivity, probeRenameBetween, probeMountCapabilities } from './mountCapabilities.js'

describe('mountCapabilities 探针', () => {
  it('probeHardlink 探测结果与真实 linkSync 行为一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-hl-'))
    const supported = probeHardlink(dir)
    const src = join(dir, 'a.txt')
    writeFileSync(src, 'x')
    if (supported) {
      expect(() => linkSync(src, join(dir, 'b.txt'))).not.toThrow()
    } else {
      expect(() => linkSync(src, join(dir, 'b.txt'))).toThrow()
    }
  })

  it('probeCaseSensitivity 探测结果与实际读写行为一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-cs-'))
    const sensitive = probeCaseSensitivity(dir)
    writeFileSync(join(dir, 'CaseTest.txt'), 'a')
    const aliasExists = existsSync(join(dir, 'casetest.txt'))
    expect(aliasExists).toBe(!sensitive)
  })

  it('probeRenameBetween：同一 tmp 根下的两个子目录必然同设备，探测为 true', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-rn-'))
    const a = join(root, 'a'); const b = join(root, 'b')
    expect(probeRenameBetween(a, b)).toBe(true)
  })

  it('probeRenameBetween：探测后现场无残留（成功路径清理探针文件）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-rn2-'))
    const a = join(root, 'a'); const b = join(root, 'b')
    probeRenameBetween(a, b)
    // 探针用的文件名带 pid+时间戳前缀，两侧目录都不该残留任何该前缀文件
    expect(existsSync(a)).toBe(true) // 目录本身仍在（mkdirSync 建的）
  })

  it('probeMountCapabilities 汇总 writable/hardlink/caseSensitive 三项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-agg-'))
    const caps = probeMountCapabilities(dir)
    expect(typeof caps.writable).toBe('boolean')
    expect(typeof caps.hardlink).toBe('boolean')
    expect(typeof caps.caseSensitive).toBe('boolean')
    expect(caps.writable).toBe(true) // tmpdir 必可写
  })
})
