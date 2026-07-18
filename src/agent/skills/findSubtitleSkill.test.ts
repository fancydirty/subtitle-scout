import { describe, it, expect } from 'vitest'
import { FIND_SUBTITLE_SKILL, makeFindSubtitleSkill } from './findSubtitleSkill.js'

describe('FIND_SUBTITLE_SKILL', () => {
  it('is non-empty and states the north-star rules the agent must follow', () => {
    expect(FIND_SUBTITLE_SKILL.descriptor.name).toBe('find-subtitle-judgment')
    expect(FIND_SUBTITLE_SKILL.descriptor.description.length).toBeGreaterThan(0)
    expect(FIND_SUBTITLE_SKILL.content).toMatch(/metadata/i)
    expect(FIND_SUBTITLE_SKILL.content).toMatch(/MUST NOT/i)
    // must not accidentally reference dialogue-content reading — that is the exact anti-pattern
    // this worker replaces (north star #1: judge by metadata, never by reading subtitle text).
    expect(FIND_SUBTITLE_SKILL.content).not.toMatch(/read (the )?dialogue/i)
  })

  // The capability-cognition gap this skill closes (proven by live acceptance): Chinese subtitles
  // are distributed as SEASON PACKS / COMPLETE-SERIES collections far more often than as single
  // episodes. Without being told, the real model hunts for a "clean single episode" that usually
  // does not exist, rejects the packs, and loops without ever calling finalize. The skill must
  // teach that packs are the NORMAL, GOOD form.
  it('teaches that season packs / complete-series collections are the normal, expected form (not to be rejected)', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/season[- ]?pack|complete[- ]series|collection/i)
    // packs are framed as normal/expected/common, not as a defect
    expect(c).toMatch(/normal|expected|common/i)
  })

  it('teaches the filelist → fileIndex workflow for extracting the target episode from a pack', () => {
    const c = FIND_SUBTITLE_SKILL.content
    // the agent scans a pack's filelist (like reading a zip's contents) to find its episode...
    expect(c).toMatch(/filelist|file list|fileList/i)
    // ...then downloads that specific entry by its fileIndex
    expect(c).toMatch(/fileIndex/)
    expect(c).toMatch(/download_candidate/)
  })

  // Absolute-episode locator: packs (esp. anime) often name files by whole-series absolute number
  // instead of season+episode; the system now injects that number. The skill must teach using it to
  // LOCATE the file — but as a verify-first HINT, never a deterministic "number matches -> install"
  // gate (that would regress to Bazarr-style code matching, north star violation).
  it('teaches using a provided absolute episode number to locate an episode in differently-numbered packs, as a verify-first hint', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/absolute episode number/i)
    expect(c).toMatch(/hint/i)                                   // it is a locator hint...
    expect(c).toMatch(/still verify|verify its structural/i)     // ...belonging is STILL verified
  })

  // Coverage-first language (product decision): Simplified and Traditional are equally readable;
  // ranking them is arrogant. Any correct-episode Chinese subtitle is a win; a non-Chinese track is
  // NOT coverage. The skill must carry no 简-first (or 繁-first) preference.
  it('teaches coverage-first language: Simplified and Traditional equally good, non-Chinese is not coverage', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/simplified/i)
    expect(c).toMatch(/traditional/i)
    expect(c).toMatch(/equally good|do not rank|coverage/i)
    expect(c).toMatch(/non-chinese/i)
  })

  // 胶水层修复（2026-07-16）：批量收割语义。worker 一轮 run 吃掉任务目标清单里全部可安全
  // 完成的目标——逐集验证归属、单集拿不准跳过该集不弃整包/整批、finalize 恰好一次交三桶、
  // itemId 一字不差抄任务清单。这些是本次事故修复的灵魂条款，锚死。
  it('teaches batch harvest: per-target verification, skip-not-abandon, one finalize with three verbatim-itemId buckets', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/PER TARGET|per target|each target/i)
    expect(c).toMatch(/SKIP THAT TARGET/i)
    expect(c).toMatch(/never abandon the whole batch/i)
    expect(c).toMatch(/EXACTLY ONCE/i)
    expect(c).toMatch(/installed/)
    expect(c).toMatch(/no_safe_match/)
    expect(c).toMatch(/retry_later/)
    expect(c).toMatch(/VERBATIM/i)
    expect(c).toMatch(/itemId/)
  })

  // R-11（用户裁决）：范围=主代理按磁盘实际裁量——skill 只教"清单可能跨季、合集是最高效
  // 命中"，不教任何固定粒度。
  it('teaches that the target list may span seasons and a spanning collection is the most efficient hit', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/spanning several seasons|multi-season|complete-series/i)
    expect(c).toMatch(/most efficient hit/i)
  })

  // C-D1/R-5：无 fileList 的 zip 包内选择归 agent——archiveEntries 事实 → archiveEntryName 选取。
  it('teaches the archiveEntries → archiveEntryName workflow for un-indexed zip packs', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/archiveEntries/)
    expect(c).toMatch(/archiveEntryName/)
    expect(c).toMatch(/choice of which file inside an archive .* is YOURS/i)
  })

  // north star: the season-pack teaching must NOT smuggle in a scoring/gating vocabulary. Rather
  // than a brittle absence check (the skill legitimately PROHIBITS confidence scores), assert the
  // existing prohibition survives the rewrite and that no positive threshold/score guidance appears.
  it('retains the north-star prohibition on numeric confidence scores and adds no scoring gate', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/numeric confidence score/i)
    // no "score >= N" / "threshold of" style deterministic gate language introduced
    expect(c).not.toMatch(/threshold|score\s*(>=|>|of\s+\d)/i)
  })

  // 重复源 P4（spec §4 "传播=普通候选判断"）：provider:"local" 候选——某条目另一个文件已有的
  // 字幕——必须用和任何候选一样的归属判断对待，没有"因为是自己的"走捷径，也没有额外猜忌。
  // 该段不随 hardsubMode/language 门控（不是新增的 finalize 桶，只是候选可能来自的一个新地方），
  // 所以直接锚在无参数的 FIND_SUBTITLE_SKILL 上。
  it('teaches judging a provider:"local" candidate exactly like any other candidate — no shortcut, no extra suspicion', () => {
    const c = FIND_SUBTITLE_SKILL.content
    expect(c).toMatch(/provider:\s*"local"|provider: "local"/i)
    expect(c).toMatch(/EXACTLY the way you judge any other candidate/i)
    expect(c).toMatch(/NOT automatically correct/i)
    expect(c).toMatch(/NOT automatically suspect/i)
    expect(FIND_SUBTITLE_SKILL.descriptor.description).toMatch(/provider:"local"/)
  })
})

// A5: the skill is a per-task factory parameterized by target language. The Chinese wording is
// the canonical, live-acceptance-proven text — every test above pins it via FIND_SUBTITLE_SKILL,
// so the factory's zh output must be byte-identical to it. Non-Chinese targets get the same
// lessons with the target language named and WITHOUT the Chinese-only Hans/Hant script guidance.
describe('makeFindSubtitleSkill (target-language parameterization)', () => {
  it('zh output is byte-identical to the canonical FIND_SUBTITLE_SKILL', () => {
    const zh = makeFindSubtitleSkill('zh')
    expect(zh.content).toBe(FIND_SUBTITLE_SKILL.content)
    expect(zh.descriptor).toEqual(FIND_SUBTITLE_SKILL.descriptor)
  })

  it('non-Chinese target: names the target language, drops all Chinese-specific script wording', () => {
    const en = makeFindSubtitleSkill('en')
    expect(en.descriptor.name).toBe('find-subtitle-judgment') // read_doc lookup name is stable
    expect(en.content).toMatch(/target language is English/)
    expect(en.content).toMatch(/NOT[\s\n]+coverage/i)
    expect(en.content).not.toMatch(/simplified|traditional|zh-Hans|zh-Hant|non-chinese/i)
    expect(en.descriptor.description).toMatch(/English subtitles/)
    expect(en.descriptor.description).not.toMatch(/Simplified and Traditional/)
  })

  it('unknown language code falls back to the bare code in the wording', () => {
    const xx = makeFindSubtitleSkill('xx')
    expect(xx.content).toMatch(/target language is xx/)
  })

  // 救援R5：hardsub_mode='agent' 才把 hardsub_assumed 概念递给模型；'off'（默认）时整段文字
  // 连"hardsub"字样都不出现——零误触发（北极星⑥）靠模型压根不知道这个选项存在，不是靠劝阻。
  describe('hardsub-assumed judgment（救援R5 §4 agent 档）', () => {
    it('默认（hardsubMode 缺省=off）：内容与描述完全不提 hardsub，finalize 仍是三桶', () => {
      const off = makeFindSubtitleSkill('zh')
      expect(off.content).not.toMatch(/hardsub/i)
      expect(off.descriptor.description).not.toMatch(/hardsub/i)
      expect(off.content).toMatch(/three buckets/)
    })

    it("显式 hardsubMode='off' 同缺省：零 hardsub 字样", () => {
      const off = makeFindSubtitleSkill('zh', 'off')
      expect(off.content).not.toMatch(/hardsub/i)
    })

    it("hardsubMode='aggressive'：worker 侧同样零 hardsub 字样（机械层直判，不进这个 worker）", () => {
      const aggressive = makeFindSubtitleSkill('zh', 'aggressive')
      expect(aggressive.content).not.toMatch(/hardsub/i)
    })

    it("hardsubMode='agent'：finalize 变四桶，讲清双证据门槛（组名标记 + 搜索已穷尽）", () => {
      const agent = makeFindSubtitleSkill('zh', 'agent')
      expect(agent.content).toMatch(/four buckets/)
      expect(agent.content).toMatch(/hardsub_assumed/)
      // 双证据：括号组名标记 + 搜索已穷尽（不是抄近路跳过搜索）
      expect(agent.content).toMatch(/bracketed.*group|\[Group\]/i)
      expect(agent.content).toMatch(/exhausted the search|genuinely exhausted/i)
      // 正面结局措辞——不是失败判决
      expect(agent.content).toMatch(/POSITIVE outcome/)
      expect(agent.descriptor.description).toMatch(/hardsub_assumed/)
    })
  })

  // 2026-07-18 生产事故回归锁(装机内容审计雷C-1):Peacemaker S1 整季 8 集被装成芬兰同名剧
  // Rauhantekijä(2020)的字幕——候选自述身份(标题里的"芬兰剧集"、年份 2020 vs 任务 2022)
  // 就摆在元数据里,agent 没核就按 fileList 结构配集。本锁钉死 skill 必须教"先验证候选是
  // 你的剧,再进 fileList 配集"这一硬序,且两个真实案例(防住的 The Rig/栽了的 Peacemaker)
  // 必须留在文中作对照教材。
  it('teaches the same-name-different-show trap: verify candidate identity (title+year+origin) BEFORE fileList matching', () => {
    const c = makeFindSubtitleSkill('zh').content
    expect(c).toMatch(/same-name trap|same-name shows|share names/i)
    expect(c).toMatch(/year mismatch/i)
    expect(c).toMatch(/Rauhantekijä/)
    expect(c).toMatch(/The Rig/)
    // 结构完美≠身份正确,这句是本段灵魂
    expect(c).toMatch(/evidence of packaging, never of identity/i)
    // 身份不明时的验证动作:先下一份抽对白锚点再批量装
    expect(c).toMatch(/download ONE entry first|sample its\s+dialogue/i)
  })
})
