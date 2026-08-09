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

  // 路 A（2026-07-26 识别架构 → 2026-07-27 拆成独立文档）：识别的完整教法搬到
  // identifyMediaSkill.ts（progressive disclosure），本文件只保留"指路段"的锚点；识别内容
  // 本身的锚点见 identifyMediaSkill.test.ts。零误触发纪律不变：identityVerification=false
  // 时正文连"识别"概念都不出现。
  describe('Step 0 指路段（识别文档拆分后）', () => {
    it('identityVerification=true：正文交代无身份前提并指向 identify-media 文档', () => {
      const on = makeFindSubtitleSkill('zh', 'off', true)
      expect(on.content).toMatch(/Step 0: identify the media before you search/i)
      expect(on.content).toMatch(/NO identity — only raw evidence/)
      // 指路到独立文档（而不是内联 100+ 行）
      expect(on.content).toMatch(/read_doc\("identify-media"\)/)
      // 写库产出的 own-id 就是后续字幕操作的 itemId——这条衔接必须留在本篇
      expect(on.content).toMatch(/write_identified_media/)
      expect(on.content).toMatch(/itemId for every subtitle operation/i)
      // Workflow 第 0 步锚定
      expect(on.content).toMatch(/FIRST, identify the media/)
      // descriptor 让模型从索引就知道要先识别、且识别在另一篇
      expect(on.descriptor.description).toMatch(/Step 0/)
      expect(on.descriptor.description).toMatch(/identify-media/)
      // 已删除的旧 verify 模式概念绝迹（identity_verified/identity_correction 见 Task 10 删除）
      expect(on.content).not.toMatch(/identity_verified|identity_correction/)
    })

    it('默认（identityVerification 缺省=false）：内容与描述完全不提 Step 0 / 识别工具', () => {
      const def = makeFindSubtitleSkill('zh')
      expect(def.content).not.toMatch(/Step 0|identity_correction|identity_verified|get_tmdb_details|search_tmdb|write_identified_media|identify-media/)
      expect(def.descriptor.description).not.toMatch(/Step 0|identity_correction|write_identified_media|identify-media/)
    })

    it('显式 false 同缺省：零识别字样', () => {
      const off = makeFindSubtitleSkill('zh', 'off', false)
      expect(off.content).not.toMatch(/Step 0|identity_correction|identity_verified|get_tmdb_details|write_identified_media|identify-media/)
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// R9（用户裁决「找到就是找到，找不到就是找不到；只要有能找到的可能性就要尽可能找到，不能撂挑子」）
// spec §4 第 5 步：两条方向相反、必须同时成立的边界。以下测试锚这两条边界。
//
// 断言手法说明（为什么不用 `toMatch(/quota/)` 这种弱断言）：
// 一个词在这份 3000+ 词的 prompt 里出现，不等于"这条指引在场"——它可能出现在无关段落，甚至
// 出现在**错误的桶**里（而误归桶正是 R9 要防的那个误判本身）。所以下面统一先把 finalize 的
// 桶定义切成**文本跨度**，再断言某个语义只出现在**它该在的那个跨度里**、且**不出现在会造成
// 误判的那个跨度里**。这样：一个碰巧出现的词过不了（跨度外不算），一次归错桶也过不了（反向
// 断言会红）。这是"归类正确"这条契约，而不是"某个词存在"。
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** 取 finalize 桶定义的文本跨度：从 `- \`<bucket>\`:` 起，到下一个同级 `- \`` 桶项或收尾句为止。
 *  桶与桶之间的措辞不许串味，切跨度是唯一能表达"这句话属于哪个桶"的手法。 */
function bucketSpan(content: string, bucket: string): string {
  const start = content.indexOf(`- \`${bucket}\`:`)
  if (start < 0) throw new Error(`bucket ${bucket} not found in prompt`)
  const rest = content.slice(start + 1)
  const nextBucket = rest.search(/\n\s*- `\w+`:/)
  const closing = rest.indexOf('Once you have filed every target')
  const ends = [nextBucket, closing].filter(i => i >= 0)
  const end = ends.length > 0 ? Math.min(...ends) : rest.length
  return rest.slice(0, end)
}

describe('R9 边界一：不许撂挑子（限流/配额必须归 retry_later，不许算成"确实没有"）', () => {
  const c = FIND_SUBTITLE_SKILL.content

  // Peacemaker 误判根因：provider 限流时 agent 拿到的是"这次问不到"，但旧 prompt 的 retry_later
  // 只写了"a provider errored, a download timed out"——HTTP 429 是一个**正常响应**，不直观属于
  // "errored"。于是 agent 把它归进 no_safe_match（"我搜了、没找到"），而 scheduler 看到确有
  // search_source 证据 → 判为诚实的"确实没有" → sub_attempt+1。连撞 7 天就攒满 7 次 →
  // 移交翻译流或判 unsolvable 停牌，而那个字幕一直在源站上。
  // 反编造门在这里帮不上：证据是真的，错的是**结论的归类**。
  it('retry_later 桶内点名限流(429)与配额耗尽这两类"这次问不到"', () => {
    const retry = bucketSpan(c, 'retry_later')
    expect(retry).toMatch(/429/)
    expect(retry).toMatch(/rate[- ]limit/i)
    expect(retry).toMatch(/quota/i)
    // 429 不是"错误"这条反直觉必须写明，否则 agent 仍会按"errored"的字面去归类
    expect(retry).toMatch(/not an error|is a normal|normal HTTP response|even though/i)
  })

  it('retry_later 桶内同时点名认证失败与 provider 5xx（同属"这次问不到"，非"确实没有"）', () => {
    const retry = bucketSpan(c, 'retry_later')
    expect(retry).toMatch(/auth/i)
    expect(retry).toMatch(/5xx|50\d/)
  })

  // 归类正确性的**反向**断言：限流词汇绝不许出现在 no_safe_match 桶里。
  // 这条比正向断言更有鉴别力——它能抓住"两个桶都提了限流"这种自相矛盾的补法（prompt 自我
  // 矛盾比缺失更糟），而正向断言对此完全无感。
  it('no_safe_match 桶内不出现任何限流/配额措辞（防两处都说 = prompt 自相矛盾）', () => {
    const nsm = bucketSpan(c, 'no_safe_match')
    expect(nsm).not.toMatch(/429|rate[- ]limit|quota/i)
  })

  // 「确实没有」的正面判据必须在场：源站**有响应**、结果里没有能验证归属的候选。
  // 只有这条在场，agent 才有一个可与"这次问不到"对照的判据；否则它只能靠"我搜了"来自证。
  it('no_safe_match 桶内给出"确实没有"的正面判据：源站有响应但无可验证候选', () => {
    const nsm = bucketSpan(c, 'no_safe_match')
    expect(nsm).toMatch(/answered|responded|came back|healthy/i)
  })

  // 既有措辞不许被改坏：retry_later 仍须把"拿不准"推回 no_safe_match。
  // 这条是防我自己补限流时把 retry_later 扩张成"什么都往这儿扔"的兜底桶——那会翻到另一个
  // 极端：真的没有字幕的片子永远攒不到 7 次，永远进不了翻译流（C15 那条最致命的路）。
  it('retry_later 仍明确把"拿不准"排除在外（补限流不得把它扩成兜底桶）', () => {
    const retry = bucketSpan(c, 'retry_later')
    expect(retry).toMatch(/not for doubt|doubt is no_safe_match/i)
  })
})

describe('R9 边界一续：穷尽标准可操作（"这些都试过了才算穷尽"）', () => {
  const c = FIND_SUBTITLE_SKILL.content

  // 旧 prompt 只说 "genuinely exhausted"，但没说穷尽的标准是什么——agent 无从判断自己够不够
  // 努力，于是"搜一次、没有、报 no_safe_match"在字面上也算"genuinely"。这条锚的是标准的
  // **可操作性**：必须逐项点名 agent 实际有的手段，而不是笼统的"努力一点"。
  it('穷尽标准逐项点名 agent 实际有的手段：多 provider + 查询变体（原名/译名/年份/季集号）', () => {
    // 切出穷尽标准所在的跨度（Workflow 第 4 步——旧文本"你 MAY 再搜一次"正是允许撂挑子的那句）
    const start = c.indexOf('4. ')
    const end = c.indexOf('5. ', start)
    expect(start).toBeGreaterThan(0)
    const step4 = c.slice(start, end)
    // 多 provider：单一 provider 空手不等于穷尽
    expect(step4).toMatch(/provider/i)
    expect(step4).toMatch(/more than one|every|all (of )?(the )?(configured )?provider|single provider/i)
    // 查询变体：至少点名原名/译名与年份/季集号两类形变
    expect(step4).toMatch(/native|original|alternat|romaniz/i)
    expect(step4).toMatch(/year|season|episode/i)
  })

  // 已有大段讲季包/全集包与绝对集号，穷尽标准必须**指向**它们而不是重述——同一件事在两处说
  // 是 prompt 自相矛盾的温床（4-1 事故：铁律 1 禁中继、铁律 2 教怎么用兜底）。
  it('穷尽标准指向既有的季包/绝对集号段落而非重述（避免同一件事两处说）', () => {
    const start = c.indexOf('4. ')
    const step4 = c.slice(start, c.indexOf('5. ', start))
    expect(step4).toMatch(/section|above|already/i)
    // 反向：不许把季包判断规则在这里重抄一遍（fileIndex 的操作教法只属于那一段）
    expect(step4).not.toMatch(/fileIndex/)
  })

  // R9 用户原话的正面表达："只要有能找到的可能性就要尽可能找到，不能撂挑子"。
  it('明说"还有没试过的手段时报 no_safe_match 是错的"', () => {
    const nsm = bucketSpan(c, 'no_safe_match')
    expect(nsm).toMatch(/not tried|untried|still|have not|left/i)
  })
})

describe('R9 边界二：不许编造（与 scheduler 的反编造门对齐）', () => {
  const c = FIND_SUBTITLE_SKILL.content

  // scheduler 侧已实现的机械检查（subtitleScheduler.ts）：
  //   hasSearchEvidence = traceTools.includes('search_source')
  // 零证据报 no_safe_match → last_error 记 `sub:fabricated-no-match` + 告警。
  // 让 agent 知道这条检查存在，不是威胁，而是让它明白"没搜就报没有"会被识别，从而倾向真去搜。
  // 断言手法：`search_source` 这个 token 在 Workflow 里出现多次，单测它在场毫无鉴别力——
  // 所以要求它出现在 **no_safe_match 桶跨度内**，且**同一跨度内**带上"会被检查/被记为编造"
  // 这个后果。缺任一半都过不了。
  it('no_safe_match 桶内点明：报它之前必须真调过 search_source', () => {
    const nsm = bucketSpan(c, 'no_safe_match')
    expect(nsm).toMatch(/search_source/)
    expect(nsm).toMatch(/never called|without (ever )?calling|must have (actually )?called/i)
  })

  it('no_safe_match 桶内点明机械检查存在及其后果（记为编造 + 告警）', () => {
    const nsm = bucketSpan(c, 'no_safe_match')
    // 系统会检查这件事本身
    expect(nsm).toMatch(/system checks|mechanically|automatically checked|the system verifies/i)
    // 后果的具体名字——与 scheduler 写进 last_error 的标签一致，排障时人能对上
    expect(nsm).toMatch(/fabricat/i)
  })
})

describe('R9：两模式下 prompt 均可正常生成，且新增边界在两模式下都在场', () => {
  // hardsubMode='agent' 时 finalize 变四桶、且 hardsub 段自述"same bar as no_safe_match"——
  // 穷尽标准挪到 Workflow 第 4 步后，那句引用必须仍然指得到东西（不能变成悬空引用）。
  it.each(['off', 'agent'] as const)('hardsubMode=%s：桶定义完整且限流归类边界在场', (mode) => {
    const s = makeFindSubtitleSkill('zh', mode)
    expect(s.content.length).toBeGreaterThan(0)
    expect(bucketSpan(s.content, 'retry_later')).toMatch(/429|rate[- ]limit/i)
    expect(bucketSpan(s.content, 'no_safe_match')).toMatch(/search_source/)
    expect(s.content).toMatch(mode === 'agent' ? /four buckets/ : /three buckets/)
  })

  // 非中文目标同样要有这两条边界——它们与语言无关（限流是 provider 事实，不是中文生态事实）。
  it('非中文目标：两条边界同样在场（与语言无关）', () => {
    const en = makeFindSubtitleSkill('en')
    expect(bucketSpan(en.content, 'retry_later')).toMatch(/quota/i)
    expect(bucketSpan(en.content, 'no_safe_match')).toMatch(/fabricat/i)
  })
})
