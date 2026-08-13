import { describe, it, expect } from 'vitest'
import { isMechanicalExtra } from './extrasFilter.js'

describe('isMechanicalExtra', () => {
  it('命中 NCOP/NCED（行话档，裸词边界即可）', () => {
    expect(isMechanicalExtra('Show - NCOP01.mkv')).toBe(true)
    expect(isMechanicalExtra('[Group] Show NCED.mp4')).toBe(true)
  })

  it('命中 Menu/PV/CM/Trailer/Preview（普通词档，必须方括号包裹）', () => {
    expect(isMechanicalExtra('[Group] Show [Menu].mp4')).toBe(true)
    expect(isMechanicalExtra('Show [PV].mkv')).toBe(true)
    expect(isMechanicalExtra('Show [CM].mkv')).toBe(true)
    expect(isMechanicalExtra('Show [Trailer].mkv')).toBe(true)
    expect(isMechanicalExtra('Show [Preview].mkv')).toBe(true)
  })

  it('方括号档允许编号与空白：[PV 01] / [menu02] / [ PV ]', () => {
    // 生产库 16 个真命中里 PV/menu 全是 `[PV][01]` `[menu][03]` 这种形态。
    expect(isMechanicalExtra('[DBD-Raws][Show][PV][01][1080P].mkv')).toBe(true)
    expect(isMechanicalExtra('[DBD-Raws][Show][menu][03][1080P].mkv')).toBe(true)
    expect(isMechanicalExtra('Show [PV 01].mkv')).toBe(true)
    expect(isMechanicalExtra('Show [menu02].mkv')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isMechanicalExtra('show ncop01.mkv')).toBe(true)
    expect(isMechanicalExtra('Show [TRAILER].mkv')).toBe(true)
  })

  it('词边界负例：子串命中但不构成独立标记 → false', () => {
    expect(isMechanicalExtra('PVC_documentary.mkv')).toBe(false)
    expect(isMechanicalExtra('Comedy.mkv')).toBe(false)
    expect(isMechanicalExtra('Show S01E05.mkv')).toBe(false)
  })

  it('SP/OVA/OAD/Special 是灰区，绝不在铁案表（单独红线断言）', () => {
    expect(isMechanicalExtra('Show OVA1.mkv')).toBe(false)
    expect(isMechanicalExtra('Show SP01.mkv')).toBe(false)
    expect(isMechanicalExtra('Show OAD.mkv')).toBe(false)
    expect(isMechanicalExtra('Special.mkv')).toBe(false)
  })

  it('只看 basename：目录名里的 CM 不算', () => {
    expect(isMechanicalExtra('/media/CM Punk Show/ep1.mkv')).toBe(false)
  })

  // ── 🔴 误杀回归锁（审计抓到的六个真实反例）─────────────────────────────────────
  // 上一轮立论是「扫全库 645 命中 16，其中有季集号的 0 个 —— 零误伤」。那证明的是
  // "这批文件没被误伤"，**不是"规则不会误伤"**。下面每一行都是真实存在的命名形态，
  // 前三个还带完整季集号——直接反驳了把"有季集号的 0 个"当规则属性来用。
  // 误判方向是本表自己认定为不可接受的那个：**误杀（永久不找字幕）**，
  // 且 extras_exemptions 翻案表已删，用户没有任何界面手段翻案。
  it('🔴 不许误杀：普通英文词出现在剧名/片名/人名里（裸词，无方括号）', () => {
    expect(isMechanicalExtra('Trailer Park Boys - S01E01 - Take Your Little Gun....mkv')).toBe(false)
    expect(isMechanicalExtra('Trailer.Park.Boys.S05E03.1080p.BluRay.mkv')).toBe(false)
    expect(isMechanicalExtra('Preview.to.a.Kill.S02E04.mkv')).toBe(false)
    expect(isMechanicalExtra('The.Menu.2022.1080p.BluRay.x264.mkv')).toBe(false)
    expect(isMechanicalExtra('CM.Punk.Best.in.the.World.2012.mkv')).toBe(false)
    expect(isMechanicalExtra('Show.S01E05.PV.Cut.mkv')).toBe(false)
  })

  it('🔴 方括号里塞的是剧名而不是标记 → 不算（防 `[^\\]]*` 式过宽收紧）', () => {
    // 若把方括号档写成 `\[[^\]]*Trailer[^\]]*\]`，这一行会重新落回误杀。
    expect(isMechanicalExtra('[Trailer Park Boys] S01E01.mkv')).toBe(false)
    expect(isMechanicalExtra('[The Menu 2022] 1080p.mkv')).toBe(false)
  })

  it('🔴 收紧的代价如实记在这里：无方括号的真特典现在会被放走（漏判，可接受方向）', () => {
    // 本表开头的立论：过期方向必须是**漏判**（白找一次字幕），不是误杀（永久不找）。
    // 这一条不是"期望的好行为"，是把已知代价钉住——将来有人想放宽时先看见它。
    expect(isMechanicalExtra('Show PV.mkv')).toBe(false)
    expect(isMechanicalExtra('Show Trailer.mkv')).toBe(false)
  })

  it('🔴 生产库 16 个真命中的实际命名形态，逐个仍然命中（收紧后 16→16）', () => {
    // 2026-08-13 生产库 /cache/scout.db 实测的真实 filename（645 文件里命中的那 16 个）。
    // 收紧方括号后重跑：0 个被放走、0 个新增命中。
    const REAL_HITS = [
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][NCED1][1080P][BDRip][HEVC-10bit][FLAC].mkv',
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][NCOP1][1080P][BDRip][HEVC-10bit][FLAC].mkv',
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][PV][01][1080P][BDRip][HEVC-10bit][FLAC].mkv',
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][PV][02][1080P][BDRip][HEVC-10bit][FLAC].mkv',
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][menu][01][1080P][BDRip][HEVC-10bit][FLAC].mkv',
      '[DBD-Raws][Re Zero kara Hajimeru Isekai Seikatsu S1][menu][09][1080P][BDRip][HEVC-10bit][FLAC].mkv',
    ]
    expect(REAL_HITS.map(isMechanicalExtra)).toEqual(REAL_HITS.map(() => true))
  })

  it('🔴 同库 151s 的官方短篇 spinoff（真内容、已有中文字幕）不许命中', () => {
    // 这一条同时是"为什么不用时长下限"的锁：它 151s，落在 16 个真命中的 91–179s 带内，
    // 任何能盖住 179s 的时长下限都会连它一起误杀。它 sub_status='covered'。
    expect(isMechanicalExtra(
      '[DBD-Raws][Re Puchi Kara Hajimeru Isekai Seikatsu][01][1080P][BDRip][HEVC-10bit][FLAC].mkv',
    )).toBe(false)
  })
})
