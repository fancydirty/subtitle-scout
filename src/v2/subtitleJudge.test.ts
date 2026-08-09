import { describe, it, expect } from 'vitest'
import { judgeSubtitle, judgeTranslatable } from './subtitleJudge.js'

const DEPS = { targetLanguages: ['zh'] }

describe('judgeSubtitle（需字幕判定）', () => {
  it('英文影视 + 无内嵌 → 需要', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['jpn'] }, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })
  it('中文影视（国产片）→ 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'zh', embeddedLangs: null }, DEPS,
    )).toEqual({ needs: false, reason: 'origin-skip' })
  })
  it('已有内嵌中字 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['chi', 'jpn'] }, DEPS,
    )).toEqual({ needs: false, reason: 'embedded' })
  })
  it('多目标语言：origin_lang 是第二目标语言 → 跳过', () => {
    expect(judgeSubtitle(
      { originLang: 'ja', embeddedLangs: null },
      { targetLanguages: ['zh', 'ja'] },
    )).toEqual({ needs: false, reason: 'origin-skip' })
  })
  it('origin_lang null（TMDB 查不到）→ 不按国产片跳过，继续查内嵌', () => {
    expect(judgeSubtitle(
      { originLang: null, embeddedLangs: null }, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })

  // D8 职责切分（C27）：判据只有**语言事实**（origin_lang / 内嵌轨）。
  // 磁盘上当前有没有外挂字幕是 sub_status 的事，由扫描独占写入（R24）。
  // 两列都判 sidecar 会造出 needs_subtitle=0 + sub_status=NULL 的永久卡死态：
  // judge 谓词是 `needs_subtitle IS NULL`（不会重判它）、字幕工作台谓词是 `needs_subtitle=1`
  // （不会排它）→ 用户手删字幕后这一集再也不会被补。
  it('🔴 C27：judge 的入参里没有"磁盘有没有外挂字幕"这个事实', () => {
    // 类型层面已经删掉了 hasSidecarSubtitle；这条钉住**运行时**也不许从别处偷偷读到它。
    // 传一个多余字段进去（模拟未来某个调用方"顺手又塞回来"）也不得改变判决。
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: null, hasSidecarSubtitle: true } as any, DEPS,
    )).toEqual({ needs: true, reason: 'missing' })
  })
  it('🔴 C27：磁盘有外挂中字也不影响国产片/内嵌轨这两条规则', () => {
    expect(judgeSubtitle(
      { originLang: 'zh', embeddedLangs: null, hasSidecarSubtitle: true } as any, DEPS,
    )).toEqual({ needs: false, reason: 'origin-skip' })
    expect(judgeSubtitle(
      { originLang: 'en', embeddedLangs: ['chi'], hasSidecarSubtitle: true } as any, DEPS,
    )).toEqual({ needs: false, reason: 'embedded' })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// judgeTranslatable（R21 + D9 / 缺口 C24·C31·C40）：翻译救不救得了这一集的**预判**。
//
// 为什么要预判：origin_lang 识别时就已入库，即第 0 天就知道终局。把它留到翻译流内部
// （满 7 次之后）= 韩剧/法国片白烧 7 个完整付费 LLM session，第 8 天才 100ms 判出 unsupported。
//
// 为什么判据**不能只看 origin_lang**（D9 / C31，本组最重要的一条）：
// resolveSource.ts 对 `origin=ja` 且有**日文内嵌轨**的情况可以直接抽轨翻译——纯本地操作、
// 完全符合 R13/R18 的单跳原则，无任何 provider 依赖。而 MVP 的可抓源集合只有 en，
// 只看语言就会把 BD 压制的日漫（普遍带日文内嵌轨）判成 translatable=0 → 满 7 次直接
// unsolvable → **永久停牌**，而它其实一抽就能救。
// ─────────────────────────────────────────────────────────────────────────────
describe('judgeTranslatable（R21/D9 翻译可救性预判）', () => {
  // MVP 边界（R20）：**外挂抓取仅 en**；**内嵌轨抽取 en/ja 皆可**。
  const DEPS_T = { fetchableSourceLangs: ['en'], extractableSourceLangs: ['en', 'ja'] }

  it('origin=en → 1（可抓源集合内，用例 11）', () => {
    expect(judgeTranslatable({ originLang: 'en', embeddedLangs: null }, DEPS_T)).toBe(1)
  })

  it('🔴 origin=ja 且有日文内嵌轨 → 1（D9 防误判死日漫，用例 12）', () => {
    // 这条是 D9 的全部理由。ja 不在可抓源集合里，只看 origin_lang 会判 0 → 永久停牌；
    // 但它有日文内嵌轨 → 抽轨即可单跳直译，是**能救**的。
    expect(judgeTranslatable({ originLang: 'ja', embeddedLangs: ['jpn'] }, DEPS_T)).toBe(1)
  })

  it('🔴 origin=ko 且无内嵌轨 → 0（真正不可救，用例 13）', () => {
    expect(judgeTranslatable({ originLang: 'ko', embeddedLangs: [] }, DEPS_T)).toBe(0)
  })

  it('🔴 origin=ja 但内嵌轨里没有日文（只有英轨）→ 0，不许走 eng 兜底（R18/C17）', () => {
    // R18 废止了 2026-07-24 的 eng fallback 裁决：JP→EN→CN 丢义严重（R13 单跳原则）。
    // 内嵌轨"有"不等于"有同语言的"——判据必须是 embedded_langs 含**origin 同语言**文本轨。
    expect(judgeTranslatable({ originLang: 'ja', embeddedLangs: ['eng'] }, DEPS_T)).toBe(0)
  })

  it('🔴 embedded_langs 为 NULL（还没探过）→ NULL，不是 0（C40 不得判死）', () => {
    // 三态的核心分辨：NULL=暂不可判 ≠ 0=判过、不可救。
    // 这一行的判据不全（probe 还没跑到 / 探针失败留 NULL），此刻给出 0 就是拿"信息缺失"
    // 当"结论"——满 7 次时会被当成不可救直接 unsolvable，永久判死一个可能有日文轨的日漫。
    // 而留 NULL 则让它继续留在字幕流（C40），待 D17 回填补上证据后重判。
    expect(judgeTranslatable({ originLang: 'ja', embeddedLangs: null }, DEPS_T)).toBeNull()
  })

  it('🔴 origin=en 且 embedded_langs 为 NULL → 仍是 1（语言这一支已经足够定论）', () => {
    // 与上一条的分界：en 在可抓源集合内，这一支**不依赖**内嵌轨证据就能定论。
    // 若实现写成"embedded_langs 为 NULL 就一律返回 NULL"，会把一批本可立刻判定可救的
    // 英语片压成"暂不可判"，白等一轮回填。
    expect(judgeTranslatable({ originLang: 'en', embeddedLangs: null }, DEPS_T)).toBe(1)
  })

  it('🔴 origin_lang 为 NULL 且无内嵌轨证据 → NULL（不许臆断，C17）', () => {
    // resolveSource.ts:84 曾把 `origin === ''`（TMDB 未刮到语言）当英语处理——语言完全未经
    // 证实。R18/C17 明令 `origin` 未知一律不许臆断。这里同理：两个判据都不成立时返回 NULL
    // （暂不可判），不返回 0（判死）也不返回 1（臆断成英语）。
    expect(judgeTranslatable({ originLang: null, embeddedLangs: null }, DEPS_T)).toBeNull()
  })

  it('🔴 origin_lang 为 NULL 但有日文内嵌轨 → 仍是 NULL（抽轨需要知道源语言是什么）', () => {
    // 反直觉但必要：抽轨翻译是"源语言→中文单跳"，而 origin 未知时我们**不知道这条日文轨
    // 是不是源语言轨**（可能是日配的英语片）。判 1 会让翻译流按日文源去译一部英语片。
    // 留 NULL = 等识别把 origin_lang 补上，不判死也不臆断。
    expect(judgeTranslatable({ originLang: null, embeddedLangs: ['jpn'] }, DEPS_T)).toBeNull()
  })

  it('大小写与地区变体不影响判定（origin=JA / 轨标签 JPN）', () => {
    // origin_lang 来自 TMDB、轨标签来自 ffprobe，两边大小写都不受我们控制。
    expect(judgeTranslatable({ originLang: 'JA', embeddedLangs: ['JPN'] }, DEPS_T)).toBe(1)
    expect(judgeTranslatable({ originLang: 'en-US', embeddedLangs: null }, DEPS_T)).toBe(1)
  })

  it('🔴 图形字幕轨已在上游剔除，故 embedded_langs 里的值一律视为文本轨', () => {
    // 边界声明用例：PGS/DVD/DVB/XSub 是位图叠加、没法当文本比对，probe 写入前就被剔掉了
    // （daemonV2 的 probeNewOrChanged / backfillEmbeddedLangs 各有一处 filter）。
    // 本函数因此不需要、也无法再判 isImageBased——它只看语言标签。
    // 这条钉住"判据是 embedded_langs 这一列的语义"，防日后有人把原始轨列表直接塞进来。
    expect(judgeTranslatable({ originLang: 'ja', embeddedLangs: ['jpn'] }, DEPS_T)).toBe(1)
  })
})
