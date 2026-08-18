import { describe, it, expect } from 'vitest'
import { parseFilename } from './parseFilename.js'

describe('parseFilename — anime absolute episode', () => {
  it('fansub bracket + absolute episode number (no season context)', () => {
    const r = parseFilename('[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(r.title).toContain('My Hero Academia')
    expect(r.absoluteEpisode).toBe(26)
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(true)
  })

  it('CJK title + fansub bracket + absolute episode number', () => {
    // Documents real behavior on a CJK title, not just ASCII — the lib title-cleans by
    // separator tokens, not by script, so CJK passes through unmangled.
    const r = parseFilename('[SubGroup] 间谍过家家 - 05 [ABCD1234].mkv')
    expect(r.title).toBe('间谍过家家')
    expect(r.absoluteEpisode).toBe(5)
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(true)
  })
})

describe('parseFilename — standard TV', () => {
  it('SxxExx with quality tags', () => {
    const r = parseFilename('Show.Name.S01E05.1080p.WEB-DL.mkv')
    expect(r.title).toContain('Show Name')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(true)
  })

  it('multi-episode file surfaces only the first episode number', () => {
    // @ctrl/video-filename-parser reports episodeNumbers as a range ([5, 6] here); multi-episode
    // spans are out of scope for this wrapper (left for a future task if ever needed).
    const r = parseFilename('Show.Name.S01E05E06.1080p.WEB-DL.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
  })
})

describe('parseFilename — movie with quality-token digits (live NAS regression)', () => {
  // The lib's anime absolute-episode pattern eats the '10' out of '10bit', returning an
  // ABSOLUTE-ONLY tv parse (seasons empty) for what is plainly a movie — which downstream (C3)
  // sends to /search/tv where it can never match. The wrapper must prefer the movie
  // interpretation whenever the tv parse is absolute-only AND the movie parse independently
  // recovered a finite year. Genuine anime absolute files stay safe: their movie-mode parse
  // never yields a finite year (the bracketed fansub hash fails toYear's Number.isFinite guard).
  it('Kraven: "10bit" digits must not become an absolute episode when a movie year is present', () => {
    const r = parseFilename('Kraven the Hunter (2024) (2160p BluRay x265 10bit DV HDR r00t).mkv')
    expect(r.title).toBe('Kraven the Hunter')
    expect(r.year).toBe(2024)
    expect(r.isTv).toBe(false)
    expect(r.absoluteEpisode).toBeNull()
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  it('Conjuring variant: same 10bit misread, movie year wins', () => {
    const r = parseFilename('The Conjuring Last Rites (2025) (2160p BluRay x265 10bit DV HDR).mkv')
    expect(r.title).toBe('The Conjuring Last Rites')
    expect(r.year).toBe(2025)
    expect(r.isTv).toBe(false)
    expect(r.absoluteEpisode).toBeNull()
  })

  it('regression anchor: genuine anime absolute file (no finite movie year) keeps the TV-absolute path', () => {
    const r = parseFilename('[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(r.absoluteEpisode).toBe(26)
    expect(r.isTv).toBe(true)
    expect(r.year).toBeNull()
  })
})

describe('parseFilename — movie', () => {
  it('title + year, no season/episode', () => {
    const r = parseFilename('Hero.2002.1080p.BluRay.mkv')
    expect(r.title).toBe('Hero')
    expect(r.year).toBe(2002)
    expect(r.isTv).toBe(false)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  it('plain "title (year)" segment with no other release tokens', () => {
    const r = parseFilename('SPY x FAMILY (2022)')
    expect(r.title).toBe('SPY x FAMILY')
    expect(r.year).toBe(2022)
    expect(r.isTv).toBe(false)
  })

  it('bare CJK title segment, no year/quality tokens', () => {
    const r = parseFilename('间谍过家家')
    expect(r.title).toBe('间谍过家家')
    expect(r.year).toBeNull()
    expect(r.isTv).toBe(false)
  })
})

describe('parseFilename — bare directory segments (IMPORTANT: known gap, see report)', () => {
  it('bare "Season N" segment does NOT parse as a season — C2 must handle season folders itself', () => {
    // @ctrl/video-filename-parser's season-only patterns all require a title token before
    // "Season N" (e.g. "Show Name Season 2"); a bare "Season 2" folder segment matches none of
    // them, so parseSeason() returns null and the wrapper falls back to the movie parse, which
    // has no year/season concept either — it just echoes the string back as a literal title.
    const r = parseFilename('Season 2')
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(false)
    expect(r.title).toBe('Season 2')
  })
})

// 生产真名单：`Season 01/` 下 13 个日文动画文件（紫罗兰永恒花园，第01話~第13話 连续无缺）。
// **逐字节来自生产库 readdir，不是手打**——上一轮 13 个里有 10 个是编造的占位 CRC
// （`A1B2C3D4`/`11112222` 之类），还编了个生产库不存在的 ep14。危害不是"不严谨"而是实打实的：
// 编造的 ep04 用了不含 `E<数字>` 的假 CRC，**正好把病二（CRC 被当集号）盖住了**。
// 这份常量是本组测试的唯一事实源；要改只能从生产库重拉。
const LIVE_NAS_VIOLET_S01 = [
  '[DMG] ヴァイオレット・エヴァーガーデン 第01話「愛してる」と自動手記人形 [BDRip][AVC_AAC][1080P][CHS](624F1EFE).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第02話「戻って来ない」 [BDRip][AVC_AAC][1080P][CHS](C46B0638).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第03話「あなたが、良き自動手記人形になりますように」 [BDRip][AVC_AAC][1080P][CHS](447A3584).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第04話「君は道具ではなく、その名が似合う人になるんだ」 [BDRip][AVC_AAC][1080P][CHS](4FE33E90).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第05話「人を結ぶ手紙を書くのか？」 [BDRip][AVC_AAC][1080P][CHS](B89BCCAE).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第06話「どこかの星空の下で」 [BDRip][AVC_AAC][1080P][CHS](61D20692).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第07話「　　　　　　　　」 [BDRip][AVC_AAC][1080P][CHS](78C61FAF).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第08話「ヴァイオレット・エヴァーガーデン」 [BDRip][AVC_AAC][1080P][CHS](04179021).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第09話「ヴァイオレット・エヴァーガーデン」 [BDRip][AVC_AAC][1080P][CHS](ED80B9A9).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第10話「愛する人は　ずっと見守っている」 [BDRip][AVC_AAC][1080P][CHS](1B3CD430).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第11話「もう、誰も死なせたくない」 [BDRip][AVC_AAC][1080P][CHS](8DF25DE7).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第12話 自動手記人形と「愛してる」 [BDRip][AVC_AAC][1080P][CHS](157662DF).mp4',
  '[DMG] ヴァイオレット・エヴァーガーデン 第13話 自動手記人形と「愛してる」 [BDRip][AVC_AAC][1080P][CHS](11196946).mp4',
] as const

describe('parseFilename — 日文集号 第NN話（live NAS regression）', () => {
  // 生产实测：13 个躺在 `Season 01/` 里的文件全都解析错，但错法是**两种病**：
  //
  // 病一（12 个）：R7 的字符类写成 `[话集]`——只有简体「话」和「集」，漏了日文/繁体的「話」。
  //   → DB 落成 season=null/episode=null/parse_confidence='none'。这是**诚实的沉默**。
  //   同仓 src/files/libraryRealign.ts 的 CJK_EPISODE_RE 一直是 `[话話集]`，两处漂移。
  //
  // 病二（1 个，更严重）：ep04 的 CRC32 校验和 `(4FE33E90)` 里的 `E90` 被 R5（`E\d{2,3}`）命中
  //   → DB 落成 season=1/episode=90/parse_confidence='high'。这是**自信的谎话**，比沉默严重得多：
  //   下游会拿着 episode=90 去 TMDB 要一集根本不存在的剧集，且带着 high 置信度不复查。
  //
  // 两病独立，必须分别有锁——病一治好但病二没治，ep04 依然是 90（只是从 R5 换成 R5，看不出来）。

  it('🔴 日文 第05話：absoluteEpisode=5 / isTv=true / title 去掉集号段', () => {
    const r = parseFilename(LIVE_NAS_VIOLET_S01[4])
    expect(r.absoluteEpisode).toBe(5)
    expect(r.isTv).toBe(true)
    expect(r.season).toBeNull()
    expect(r.title).toBe('ヴァイオレット・エヴァーガーデン')
  })

  it('🔴 生产 13 个真文件名逐个：第01話~第13話 连续全部出集号，season 恒 null', () => {
    expect(LIVE_NAS_VIOLET_S01).toHaveLength(13)
    const actual = LIVE_NAS_VIOLET_S01.map((name) => {
      const r = parseFilename(name)
      return { ep: r.absoluteEpisode, isTv: r.isTv, season: r.season, episode: r.episode }
    })
    // 期望表逐条列出（不是 map 生成的自洽式断言——那样连"全 null"都能自我印证）。
    expect(actual).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((ep) => ({ ep, isTv: true, season: null, episode: null })),
    )
  })

  it('🔴 病二独立锁：ep04 的 CRC `(4FE33E90)` 绝不能被读成 episode=90', () => {
    // 这一条是**病二的唯一锁**。上一轮编造的 ep04 假 CRC 不含 `E<数字>`，R5 压根不命中，
    // 于是这个病在测试里彻底隐形。用真 CRC 才暴露：`4FE33E90` 里 `E90` 前一个字符是 `3`
    // （不是字母），R5 的 `(?<![a-zA-Z])` 闸放它过去 → absoluteEpisode=90。
    const ep04 = LIVE_NAS_VIOLET_S01[3]
    expect(ep04).toContain('(4FE33E90)') // 事实源自证：这个名字真的带那个 CRC
    const r = parseFilename(ep04)
    expect(r.absoluteEpisode).toBe(4)
    expect(r.absoluteEpisode).not.toBe(90)
    expect(r.episode).toBeNull()
    expect(r.season).toBeNull()
  })

  it('🔴 不补零 第5話 / 补零 第05話 / 两位 第12話 三种写法等价', () => {
    for (const [name, ep] of [['某剧 第5話.mkv', 5], ['某剧 第05話.mkv', 5], ['某剧 第12話.mkv', 12]] as const) {
      const r = parseFilename(name)
      expect({ name, ep: r.absoluteEpisode }).toEqual({ name, ep })
      expect(r.title).toBe('某剧')
    }
  })

  it('简体「话」/「集」的既有行为不变（回归锚）', () => {
    expect(parseFilename('某剧 第05话.mkv').absoluteEpisode).toBe(5)
    expect(parseFilename('某剧 第05集.mkv').absoluteEpisode).toBe(5)
  })

  it('剧名里本来带「話」但不带数字 → 不认成集号（宁可漏判不可误判）', () => {
    // 「話術のススメ」——「話」前面没有「第N」，R7 的 `第\s*\d+` 前缀要求把它挡在门外。
    const r = parseFilename('週刊少女 話術のススメ (2020).mkv')
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(false)
    expect(r.title).toBe('週刊少女 話術のススメ')
  })

  it('汉字数字「第五話」不认（只认阿拉伯数字，漏判优于误判）', () => {
    const r = parseFilename('第五話 kanji numeral.mkv')
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(false)
  })

  it('优先级：S01E05 与 第05話 同时出现时，R1（SxxExx）先赢，R7 抢不走', () => {
    // R7 排在 R1 之后，二者不互抢——季集号是更强的信号，绝对集号让位。
    const r = parseFilename('Show S01E05 第05話.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
    expect(r.absoluteEpisode).toBeNull()
  })

  it('优先级：第2季第05話 走 R4（中文季+集），不退化成绝对集号', () => {
    const r = parseFilename('某剧 第2季第05話.mkv')
    expect(r.season).toBe(2)
    expect(r.episode).toBe(5)
    expect(r.absoluteEpisode).toBeNull()
  })
})

describe('parseFilename — R5 排除 CRC32 校验和（病二：自信的谎话）', () => {
  // 判据（写死在这里，实现必须与之一致）：**括号包裹的、恰好 8 位的十六进制串**是 CRC32
  // 校验和，是 fansub/BDRip 发布命名的固定约定（AniDB/CRC32 惯例），不是集号。
  //
  // 三个限定缺一不可，每一个都在收窄误伤面：
  //   ① 括号包裹 `(...)`  —— 裸的 `4FE33E90` 不排除（没有约定支撑，宁可不动）
  //   ② 恰好 8 位        —— 7 位/9 位不是 CRC32，不排除
  //   ③ 全部是 hex 字符  —— `(1234567Z)` 不是 hex，不排除
  //
  // 方向是**宁可漏判也不要误判**：排除得越窄，正常集号被误杀的面越小。代价是某些
  // 非标准 CRC 写法（`[4FE33E90]` 方括号、无括号裸写）依然会被 R5 吃掉——那是已知残余风险，
  // 不是遗漏；扩大排除面需要新的真实样本来立论，不能凭想象。

  it('🔴 真集号 E90 必须活着——排除 CRC 不能顺手把正常集号杀了（本条是修法的反向闸）', () => {
    // 如果实现偷懒写成"凡是 E\d{2} 后面跟着 hex 就不算"或者干脆把 E90 加黑名单，这条会红。
    expect(parseFilename('Show E90.mkv').absoluteEpisode).toBe(90)
    expect(parseFilename('Show EP90 1080p.mkv').absoluteEpisode).toBe(90)
    expect(parseFilename('[SubGroup] Long Anime - E90 [1080p].mkv').absoluteEpisode).toBe(90)
  })

  it('🔴 真集号 E90 + 另一处 CRC 同时存在 → 取真集号 90，不是 CRC 里的数字', () => {
    // 排除必须是"跳过 CRC 继续找"，不是"见到 CRC 就整条规则放弃"。
    const r = parseFilename('[DMG] Show E90 [BDRip](4FE33E90).mkv')
    expect(r.absoluteEpisode).toBe(90)
  })

  it('🔴 只有 CRC 没有别的集号信号 → absoluteEpisode 为 null（诚实的沉默，不是编一个数）', () => {
    // 没有 R7 的「第N話」兜底时，排除 CRC 后 R5/R6/R8 都不该从 CRC 里刨出数字。
    const r = parseFilename('[DMG] Some Movie [BDRip][AVC_AAC][1080P][CHS](4FE33E90).mp4')
    expect(r.absoluteEpisode).toBeNull()
    expect(r.episode).toBeNull()
    expect(r.season).toBeNull()
    expect(r.isTv).toBe(false)
  })

  it('边界：7 位十六进制不是 CRC32，不在排除范围（收窄，不外扩）', () => {
    // `(4FE3E90)` 只有 7 位 → 不是 CRC32 → 不排除 → R5 照常从中取到 90。
    // 这条锁的是"排除逻辑按长度精确判定"，防止实现写成宽松的 `[0-9A-F]+`。
    expect(parseFilename('Show (4FE3E90).mkv').absoluteEpisode).toBe(90)
  })

  it('边界：9 位十六进制不是 CRC32，不在排除范围', () => {
    expect(parseFilename('Show (4FE33E901).mkv').absoluteEpisode).toBe(901)
  })

  it('边界：8 位但含非 hex 字符 → 不是 CRC32，不排除', () => {
    // `ZFE33E90` 长度是 8 但首字符 Z 不是十六进制；仍按老行为交给 R5。
    expect(parseFilename('Show (ZFE33E90).mkv').absoluteEpisode).toBe(90)
  })

  it('边界：8 位十六进制但**没有括号** → 不排除（判据要求括号包裹）', () => {
    expect(parseFilename('Show 4FE33E90.mkv').absoluteEpisode).toBe(90)
  })

  it('回归锚：既有的 [ABCD1234] 方括号 fansub hash 行为完全不变', () => {
    // 这个 hash 不含 `E<数字>`，本来就不触发 R5；本次改动不该扰动它。
    const r = parseFilename('[SubGroup] My Hero Academia - 26 [ABCD1234].mkv')
    expect(r.absoluteEpisode).toBe(26)
    expect(r.isTv).toBe(true)
  })

  it('🔴 遮蔽必须**等长**：CRC 出现在剧名之前时，title 不能被切错位', () => {
    // 实现把 CRC 替换成等长的 '#' 串，靠"同一个 [0,len) 区间在遮蔽串和原串上指向同一段内容"
    // 把 seriesname 切回原串。若替换成不等长的单个 '#'，seriesname 的长度就与原串偏移脱钩，
    // unmask 会切出一段**乱码前缀**（实测 '(624F1E'）——一个静默的 title 损坏。
    //
    // 这一条是该不变量的唯一锁。发现过程本身值得记：第一轮变异（把 '#'.repeat(m.length)
    // 改成 '#'）**零条测试变红**，说明当时全组断言都把 CRC 放在文件名尾部，够不到这个分支。
    // 补这条时特意把 CRC 挪到剧名**之前**，才让不变量进入可观测范围。
    const r = parseFilename('(624F1EFE) Show 第05話.mkv')
    expect(r.absoluteEpisode).toBe(5)
    expect(r.title).toBe('(624F1EFE) Show')
    // 关键：title 不是被切错位的乱码前缀
    expect(r.title).not.toBe('(624F1E')
    expect(r.title).toContain('Show')
  })
})

// ===========================================================================
// 2026-08-18 en 目标巡检生产事故的对抗语料（spec §4.4 / F4）。
//
// 四个病灶全部来自生产库实查（不是想象出来的合成样本）：
//   P1 R3 '1x03'：'1280x720' 的 "80x720" 被拆成 s=80 e=720（Overflow ×8，parse_confidence='high'）
//   P2 R1/R5：粘连版本后缀 'S01E04v2' 因 "4|v" 之间无词边界双双失配——Nukitashi ×8 落到
//      R8 吃掉 'AAC2.0' 的 '0' → episode=0；芬芳 Flowers ×7 季集全 NULL。点分隔 '.v2'
//      本就正常（"1|." 有词边界），只有粘连 vN 出事。
//   P3 R8：小数声道 'DDP5.1' 的 '1'（abs=1，电影变剧集）/ 'AAC2.0' 的 '0'（episode=0）
//   P4 中文数字季 / 单位数 E：spec §7 明确不修（agent 语义层兜住），下面锁现状防漂移。
// ===========================================================================
describe('parseFilename — 2026-08-18 en 巡检对抗语料（生产实案 + 合成陷阱）', () => {
  // ── 生产实案 ────────────────────────────────────────────────────────────

  it('🔴 Overflow：WxH 的宽度尾部不再是季号（s80e720 → 绝对编号 1）', () => {
    // 旧状：R3 把 '1280x720' 的 "80x720" 拆成 season=80 episode=720，isPlausibleSeason(80)
    // 放行、looksLikeYear(80,720)=80720 不是年——两道闸全漏，confidence 还落 'high'。
    // 修后：'80' 前是数字 '2'，(?<!\d) 拒收；R8 接住 ' - 01 ' 的绝对编号。
    const r = parseFilename('Overflow (TV ver.) - 01 (WebDL 1280x720 AAC).mkv')
    expect(r.absoluteEpisode).toBe(1)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
    expect(r.isTv).toBe(true)
  })

  it('🔴 Nukitashi：粘连 v2 后缀认出 s=1 e=4（不是 R8 吃 AAC2.0 的 0）', () => {
    // 双病灶合一：R1 因 "4|v" 无词边界失配 → R8 兜底吃掉 'AAC2.0' 的小数尾 '0' → episode=0。
    // 修后：R1 消化 'v2' → s=1 e=4；R8 的前置数字闸让 '2.0' 的 '0' 也不再可吃。
    const r = parseFilename('Nukitashi.the.Animation.S01E04v2.Romp.Day.1080p.UNCENSORED.AAC2.0.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(4)
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(true)
  })

  it('🔴 芬芳 Flowers：S01E05v3 → s=1 e=5（不是季集全 NULL）', () => {
    // 同 Nukitashi 的 R1 失配，但这条连 R8 都没接住（名字里无可吃的编号）→ 季集全 NULL。
    const r = parseFilename('The.Fragrant.Flower.S01E05v3.Premonition.1080p.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
    expect(r.absoluteEpisode).toBeNull()
  })

  it('点分隔 .v2 回归保持：Hi10 系列照常 s=1 e=1', () => {
    // "1|." 有词边界，R1 从来就正常——修粘连 vN 不得把这条弄坏。
    const r = parseFilename('Highschool.of.the.Dead.S01E01.v2.1080p-Hi10p.BluRay.FLAC5.1.x264-CTR.[2FC76335].mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(1)
  })

  it('🔴 DDP5.1：小数声道尾不是绝对集号（电影不被判成剧集）', () => {
    // 旧状：R8 把 'DDP5.1' 的 '1' 当编号 → absoluteEpisode=1，电影变剧集。
    // 修后：分隔符 '.' 前是数字 '5'，前置数字闸拒收。
    const r = parseFilename('Movie.2020.DDP5.1.Atmos.1080p.mkv')
    expect(r.isTv).toBe(false)
    expect(r.absoluteEpisode).toBeNull()
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  // ── 合成陷阱（每个病灶的最小复现 + 修法的反向闸）─────────────────────────

  it('🔴 Show.01.1280x720：R8 接住 01，R3 不再吃 720', () => {
    const r = parseFilename('Show.01.1280x720.x264.mkv')
    expect(r.absoluteEpisode).toBe(1)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  it('🔴 Movie.2023.3840x2160：4K 宽度尾部同样不拆季集', () => {
    const r = parseFilename('Movie.2023.3840x2160.mkv')
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(false)
  })

  it('Show.S01E01.1920x1080：正常 SxxExx 与分辨率共存（R1 优先级不降）', () => {
    const r = parseFilename('Show.S01E01.1920x1080.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(1)
  })

  it('🔴 Show.E05v3：R5 的粘连 vN 后缀（绝对集号标记形态）', () => {
    const r = parseFilename('Show.E05v3.1080p.mkv')
    expect(r.absoluteEpisode).toBe(5)
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
  })

  it('Show.S01E05E06：多集组不被 vN 组破坏', () => {
    const r = parseFilename('Show.S01E05E06.1080p.mkv')
    expect(r.season).toBe(1)
    expect(r.episode).toBe(5)
  })

  // ── 已知边界锁现状（P4：spec §7 明确不修，agent 语义层兜住）──────────────

  it('「第一季 第05話」：汉字数字季不识别（锁现状）→ abs=5 / season=null', () => {
    const r = parseFilename('第一季 第05話「标题」(2024)')
    expect(r.absoluteEpisode).toBe(5)
    expect(r.season).toBeNull()
  })

  it('「Show - E7」：单位数 E 不识别（锁现状）→ 季集 null', () => {
    const r = parseFilename('Show - E7 (2024).mkv')
    expect(r.season).toBeNull()
    expect(r.episode).toBeNull()
    expect(r.absoluteEpisode).toBeNull()
    expect(r.isTv).toBe(false)
  })
})

describe('cleanTitle 裸集数守卫 — 「第N話」必须与「第N话」行为一致', () => {
  // 这处守卫在 parseFilename.ts 的 cleanTitle 末尾（`if (/^(?:ep...|第\s*\d{1,3}\s*[话集]|\d{1,3})$/`）。
  // 上一轮它**零覆盖**——把整个 if 删掉，四判据依然全绿。这一组是它的专属锁。
  //
  // 语义：裸文件名「第05話.mkv」剥完扩展名后整段就是一个集数标记，它不是剧名，title 必须是 null，
  // 而不是把「第05話」这个字符串当剧名交给下游去 TMDB 搜索（会搜出完全无关的结果）。

  it('🔴 裸「第05話.mkv」的 title 为 null（与简体「第05话.mkv」逐字段一致）', () => {
    const ja = parseFilename('第05話.mkv')
    const zh = parseFilename('第05话.mkv')
    expect(ja.title).toBeNull()
    expect(ja).toEqual(zh)
  })

  it('🔴 三种字形（话/話/集）裸文件名全部 title=null、absoluteEpisode=5', () => {
    for (const name of ['第05话.mkv', '第05話.mkv', '第05集.mkv', '第5話.mkv', '第 5 話.mkv']) {
      const r = parseFilename(name)
      expect({ name, title: r.title, isTv: r.isTv }).toEqual({ name, title: null, isTv: true })
    }
  })

  it('守卫不误伤：带真剧名的「某剧 第05話.mkv」title 仍是「某剧」，不被整段判空', () => {
    expect(parseFilename('某剧 第05話.mkv').title).toBe('某剧')
  })
})
