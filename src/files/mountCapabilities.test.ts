import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync, linkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeHardlink, probeCaseSensitivity, probeRenameBetween, probeMountCapabilities } from './mountCapabilities.js'

describe('mountCapabilities 探针', () => {
  it('probeHardlink 探测结果与真实 linkSync 行为一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-hl-'))
    const supported = probeHardlink(dir)
    const src = join(dir, 'a.txt')
    writeFileSync(src, 'x')
    if (supported === true) {
      expect(() => linkSync(src, join(dir, 'b.txt'))).not.toThrow()
    } else if (supported === false) {
      expect(() => linkSync(src, join(dir, 'b.txt'))).toThrow()
    } else {
      throw new Error('可写的 tmp 目录不该探出 unknown')
    }
  })

  it('probeCaseSensitivity 探测结果与实际读写行为一致', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-cs-'))
    const sensitive = probeCaseSensitivity(dir)
    expect(sensitive === 'unknown').toBe(false)
    writeFileSync(join(dir, 'CaseTest.txt'), 'a')
    const aliasExists = existsSync(join(dir, 'casetest.txt'))
    expect(aliasExists).toBe(!sensitive)
  })

  it('probeRenameBetween：同一 tmp 根下的两个已存在子目录必然同设备，探测为 true', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-rn-'))
    const a = join(root, 'a'); const b = join(root, 'b')
    mkdirSync(a); mkdirSync(b)
    expect(probeRenameBetween(a, b)).toBe(true)
  })

  it('probeRenameBetween：探测后两侧目录都不残留任何探针文件（真查目录内容）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-rn2-'))
    const a = join(root, 'a'); const b = join(root, 'b')
    mkdirSync(a); mkdirSync(b)
    probeRenameBetween(a, b)
    expect(readdirSync(a)).toEqual([])
    expect(readdirSync(b)).toEqual([])
  })

  it('probeHardlink / probeCaseSensitivity：探测后现场无残留（真查目录内容）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-clean-'))
    probeHardlink(dir)
    probeCaseSensitivity(dir)
    expect(readdirSync(dir)).toEqual([])
  })

  it('探针绝不创建不存在的目录——那是死挂载哨兵要抓的场景，返回 unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-miss-'))
    const missing = join(root, 'not-mounted', 'tv')
    expect(probeHardlink(missing)).toBe('unknown')
    expect(probeCaseSensitivity(missing)).toBe('unknown')
    expect(probeRenameBetween(missing, root)).toBe('unknown')
    expect(probeRenameBetween(root, missing)).toBe('unknown')
    expect(existsSync(missing)).toBe(false)
    expect(existsSync(join(root, 'not-mounted'))).toBe(false)
  })

  it('只读目录：写探针进不去 → 报 unknown 而非假 false（minor #9）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-ro-'))
    chmodSync(dir, 0o555)
    try {
      expect(probeHardlink(dir)).toBe('unknown')
      expect(probeCaseSensitivity(dir)).toBe('unknown')
    } finally {
      chmodSync(dir, 0o755)
    }
  })

  it('probeMountCapabilities 汇总 writable/hardlink/caseSensitive 三项', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mount-cap-agg-'))
    const caps = probeMountCapabilities(dir)
    expect(typeof caps.writable).toBe('boolean')
    expect(caps.writable).toBe(true) // tmpdir 必可写
    expect(typeof caps.hardlink === 'boolean').toBe(true) // 可写目录上不该是 unknown
    expect(typeof caps.caseSensitive === 'boolean').toBe(true)
  })

  it('probeMountCapabilities：目录不存在 → writable=false 且两能力 unknown，不创建目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'mount-cap-agg2-'))
    const missing = join(root, 'dead-mount')
    const caps = probeMountCapabilities(missing)
    expect(caps).toEqual({ writable: false, hardlink: 'unknown', caseSensitive: 'unknown' })
    expect(existsSync(missing)).toBe(false)
  })
})
