import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from './db.js'
import type { ScoutDb } from './db.js'
import { SubtitleVerifyRepo } from './subtitleVerifyRepo.js'

/**
 * subtitle_verify 持久层。
 *
 * 重点覆盖 needsRecheck 的判据（路径 + 内容哈希）——它是"字幕文件被换掉后旧结论作废"的
 * 唯一入口，漏判会让用户看到一个针对已经不存在的文件的红/绿结论。
 */
describe('SubtitleVerifyRepo', () => {
  let db: ScoutDb
  let repo: SubtitleVerifyRepo

  beforeEach(() => {
    db = openDb(':memory:')
    repo = new SubtitleVerifyRepo(db)
  })

  const shifted = {
    itemId: 'tmdb:100/s1e1',
    verdict: 'shifted' as const,
    offsetMs: 2000,
    score: 0.95,
    referenceTier: 'embedded',
    subtitlePath: '/media/ep1.zh.srt',
    subtitleHash: 'hash-a',
    checkedAt: 1000,
    detail: 'ref=embedded: track 0 (500 cues)',
  }

  describe('upsert / get', () => {
    it('落库后可原样读回（内部字段一并如实保存）', () => {
      repo.upsertVerifyResult(shifted)
      expect(repo.getVerifyResult('tmdb:100/s1e1')).toEqual({
        item_id: 'tmdb:100/s1e1',
        verdict: 'shifted',
        offset_ms: 2000,
        score: 0.95,
        reference_tier: 'embedded',
        subtitle_path: '/media/ep1.zh.srt',
        subtitle_hash: 'hash-a',
        checked_at: 1000,
        detail: 'ref=embedded: track 0 (500 cues)',
      })
    })

    it('未检测过的 item 返回 null（不是抛错，也不是空对象）', () => {
      expect(repo.getVerifyResult('tmdb:999/s1e1')).toBeNull()
    })

    it('可选字段省略时落 NULL（无参考源的 unverifiable 行形状）', () => {
      repo.upsertVerifyResult({
        itemId: 'tmdb:100/s1e2',
        verdict: 'unverifiable',
        subtitlePath: '/media/ep2.zh.srt',
        checkedAt: 2000,
      })
      const row = repo.getVerifyResult('tmdb:100/s1e2')
      expect(row).toMatchObject({
        verdict: 'unverifiable',
        offset_ms: null,
        score: null,
        reference_tier: null,
        subtitle_hash: null,
        detail: null,
      })
    })

    it('同 item 重复检测覆盖旧行，不堆历史（一行一集）', () => {
      repo.upsertVerifyResult(shifted)
      repo.upsertVerifyResult({ ...shifted, verdict: 'aligned', offsetMs: null, checkedAt: 3000 })
      expect(db.prepare(`SELECT count(*) c FROM subtitle_verify`).get()).toEqual({ c: 1 })
      expect(repo.getVerifyResult('tmdb:100/s1e1')).toMatchObject({ verdict: 'aligned', checked_at: 3000 })
    })

    it('覆盖是全列无条件的——新的 unverifiable 结论不许留着上一轮的 offset_ms/score', () => {
      // 若 upsert 用 COALESCE 保护旧值，会造出"没能验证，但偏移量是 2000ms"的自相矛盾行，
      // 且 UI 层一旦读到这个残值就会渲染出一个用户点不了的校正入口。
      repo.upsertVerifyResult(shifted)
      repo.upsertVerifyResult({
        itemId: 'tmdb:100/s1e1',
        verdict: 'unverifiable',
        subtitlePath: '/media/ep1.zh.srt',
        checkedAt: 4000,
      })
      expect(repo.getVerifyResult('tmdb:100/s1e1')).toMatchObject({
        verdict: 'unverifiable',
        offset_ms: null,
        score: null,
        reference_tier: null,
        detail: null,
      })
    })

    it('第四档 verdict 被 DB 的 CHECK 约束拒绝（铁律①：不可表达）', () => {
      expect(() =>
        repo.upsertVerifyResult({ ...shifted, verdict: 'suspect' as never }),
      ).toThrow(/CHECK constraint/)
    })
  })

  describe('listShifted', () => {
    it('只返回 shifted 一档——另两档在 UI 上都是绿色，不需要被列举', () => {
      repo.upsertVerifyResult(shifted)
      repo.upsertVerifyResult({ ...shifted, itemId: 'tmdb:100/s1e2', verdict: 'aligned', offsetMs: null })
      repo.upsertVerifyResult({ ...shifted, itemId: 'tmdb:100/s1e3', verdict: 'unverifiable', offsetMs: null })
      expect(repo.listShifted().map((r) => r.item_id)).toEqual(['tmdb:100/s1e1'])
    })

    it('多条 shifted 按 checked_at 倒序（最近检出的在前）', () => {
      repo.upsertVerifyResult({ ...shifted, itemId: 'a', checkedAt: 100 })
      repo.upsertVerifyResult({ ...shifted, itemId: 'b', checkedAt: 300 })
      repo.upsertVerifyResult({ ...shifted, itemId: 'c', checkedAt: 200 })
      expect(repo.listShifted().map((r) => r.item_id)).toEqual(['b', 'c', 'a'])
    })

    it('空库返回空数组', () => {
      expect(repo.listShifted()).toEqual([])
    })
  })

  describe('needsRecheck', () => {
    it('从未检测过 → 需要检测', () => {
      expect(repo.needsRecheck('tmdb:100/s1e1', '/media/ep1.zh.srt', 'hash-a')).toBe(true)
    })

    it('同路径同哈希 → 不需要重检（结论仍然有效）', () => {
      repo.upsertVerifyResult(shifted)
      expect(repo.needsRecheck('tmdb:100/s1e1', '/media/ep1.zh.srt', 'hash-a')).toBe(false)
    })

    it('同路径但内容哈希变了 → 需要重检（原地替换：下载新字幕覆盖旧文件，路径不变）', () => {
      // 哈希不参与判断的话这一档会返回 false，被替换过的字幕永久挂着作废结论。
      repo.upsertVerifyResult(shifted)
      expect(repo.needsRecheck('tmdb:100/s1e1', '/media/ep1.zh.srt', 'hash-B-different')).toBe(true)
    })

    it('检的是另一个字幕文件 → 需要重检', () => {
      repo.upsertVerifyResult(shifted)
      expect(repo.needsRecheck('tmdb:100/s1e1', '/media/ep1.other.srt', 'hash-a')).toBe(true)
    })

    it('本次算不出哈希（文件读不动）→ 保守判需重检，不当成"没变"', () => {
      repo.upsertVerifyResult(shifted)
      expect(repo.needsRecheck('tmdb:100/s1e1', '/media/ep1.zh.srt', null)).toBe(true)
    })

    it('上次没存下哈希 → 无从证明没变，同样判需重检', () => {
      repo.upsertVerifyResult({ ...shifted, subtitleHash: null })
      expect(repo.needsRecheck('tmdb:100/s1e1', '/media/ep1.zh.srt', 'hash-a')).toBe(true)
    })
  })

  describe('deleteForItem', () => {
    it('删除该 item 的结论行，返回删除行数', () => {
      repo.upsertVerifyResult(shifted)
      expect(repo.deleteForItem('tmdb:100/s1e1')).toBe(1)
      expect(repo.getVerifyResult('tmdb:100/s1e1')).toBeNull()
    })

    it('本就没有行时返回 0（不是错误：清理是幂等动作）', () => {
      expect(repo.deleteForItem('tmdb:999/s1e1')).toBe(0)
    })

    it('只删指定 item，不波及别人', () => {
      repo.upsertVerifyResult(shifted)
      repo.upsertVerifyResult({ ...shifted, itemId: 'tmdb:100/s1e2' })
      repo.deleteForItem('tmdb:100/s1e1')
      expect(repo.getVerifyResult('tmdb:100/s1e2')).not.toBeNull()
    })
  })
})
