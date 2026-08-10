import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { TRANSLATE_STAGING_DIRNAME, ensureWorkspaceLayout, workspacePaths, resetWorkspace, cleanupWorkspace } from './paths.js'

describe('translate workspace paths', () => {
  it('workspacePaths nests job under .subtitle-translate', () => {
    const p = workspacePaths('/media', 'job-1')
    expect(p.jobRoot).toBe(join('/media', TRANSLATE_STAGING_DIRNAME, 'job-1'))
    expect(p.canonicalDir).toBe(join(p.jobRoot, 'canonical'))
    expect(p.agentViewDir).toBe(join(p.jobRoot, 'agent_view'))
    expect(p.contextDir).toBe(join(p.jobRoot, 'context'))
    expect(p.glossaryDir).toBe(join(p.jobRoot, 'glossary'))
    expect(p.workDir).toBe(join(p.jobRoot, 'work'))
    expect(p.outDir).toBe(join(p.jobRoot, 'out'))
    expect(p.metaPath).toBe(join(p.jobRoot, 'meta.json'))
    expect(p.sourceCleanPath).toBe(join(p.agentViewDir, 'source_clean.jsonl'))
    expect(p.bilingualPath).toBe(join(p.workDir, 'bilingual.jsonl'))
    expect(p.glossaryPath).toBe(join(p.glossaryDir, 'terms.json'))
    expect(p.targetSrtPath).toBe(join(p.outDir, 'target.srt'))
  })

  it('ensureWorkspaceLayout creates the full directory tree and optional .ignore', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-paths-'))
    const p = ensureWorkspaceLayout(base, 'job-abc')
    for (const dir of [p.jobRoot, p.canonicalDir, p.agentViewDir, p.contextDir, p.glossaryDir, p.workDir, p.outDir]) {
      expect(existsSync(dir)).toBe(true)
    }
    const ignore = join(base, TRANSLATE_STAGING_DIRNAME, '.ignore')
    expect(existsSync(ignore)).toBe(true)
    expect(readFileSync(ignore, 'utf8')).toMatch(/subtitle-translate/)
  })

  // ── GC 炸弹（2026-08-08 live test 实测残留 312KB / CURRENT-STATE §八）──
  it('🔴 resetWorkspace 清掉上一次的残留后重建（稳定 jobId 的串味防线）', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-paths-reset-'))
    const p1 = ensureWorkspaceLayout(base, 'job-r')
    writeFileSync(p1.glossaryFrozenPath, 'frozen\n')                 // one-shot 标记：不清就锁死下一次
    writeFileSync(p1.bilingualPath, '{"id":"1","tgt":"陈旧"}\n')
    const p2 = resetWorkspace(base, 'job-r')
    expect(p2.jobRoot).toBe(p1.jobRoot)                              // 同一路径（幂等）
    expect(existsSync(p2.glossaryFrozenPath)).toBe(false)
    expect(existsSync(p2.bilingualPath)).toBe(false)
    expect(existsSync(p2.workDir)).toBe(true)                        // 骨架重建齐了
    expect(existsSync(join(base, TRANSLATE_STAGING_DIRNAME, '.ignore'))).toBe(true)
  })

  it('🔴 cleanupWorkspace 只删 <jobId>/ 一层，同级 .ignore 与别的 job 都不受影响', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-paths-gc-'))
    const mine = ensureWorkspaceLayout(base, 'job-a')
    const other = ensureWorkspaceLayout(base, 'job-b')
    expect(cleanupWorkspace(base, 'job-a')).toBe(true)
    expect(existsSync(mine.jobRoot)).toBe(false)
    // `.ignore` 是 `.subtitle-translate/` 一级、跨 job 共用的 Jellyfin 屏蔽标记——删了它，
    // 下一个 job 重建它之前的窗口里媒体服务器会扫到半成品 srt。
    expect(existsSync(join(base, TRANSLATE_STAGING_DIRNAME, '.ignore'))).toBe(true)
    expect(existsSync(other.jobRoot)).toBe(true)                     // 并发的另一个活不许被连坐
  })

  it('cleanupWorkspace 对不存在的 job 幂等返回 true（重复调用不抛）', () => {
    const base = mkdtempSync(join(tmpdir(), 'tw-paths-gc2-'))
    expect(cleanupWorkspace(base, 'never-existed')).toBe(true)
  })
})
