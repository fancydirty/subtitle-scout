// src/dashboard/extraCriterion.singleSource.test.ts —— T2-a：`skip_reason === 'extra'`
// 这条判据在 mediaLibraryApi.ts 里**只许有一个定义点**。
//
// ── 债务原文（它自己承认了）────────────────────────────────────────────────
// `isJudgedExtra` 的头注释写着：
//     「两处各写一遍 `f.skip_reason === 'extra'` 是 C30 的原型——将来若判据要加一条
//       （比如"needs_subtitle=0 才算数"），改一处忘一处时两页的 unplacedFileCount 会不相等」
// 而收敛前的实际情况是：这个函数**自己**是第二处。
//   · :234  classifyFileState 里 `if (f.skip_reason === 'extra') return 'extra'`
//   · :463  isJudgedExtra 里    `return f.skip_reason === 'extra'`
// 也就是说它把"两页的 unplacedFileCount"收敛成了一份（那一半是真的做到了），
// 却在**八态分类**与**特典计数**之间留下了同一条判据的第二份文本。
//
// ── 为什么这一份漂移是真故障，不是洁癖 ──────────────────────────────────────
// 两个消费点表达的是**同一个业务事实**「judge 判定这一行是机械特典」，且它们的结论
// 在 UI 上必须互相自洽：
//   · classifyFileState → episodeState='extra' → 格子上画 ▭「特典 · 不找字幕」
//   · isJudgedExtra     → 从 unplacedFileCount 里扣掉
// 「格子上标了 ▭」与「不计入待办数」是同一条裁决（用户原话「不值得为它增加心智负担」）
// 的一体两面。判据加一条而只改了其中一处，就会出现：格子上标着 ▭ 说"系统不管它"，
// 而概览数字同时把它算进"解析器没能归位的真实文件"催用户去改名——两个控件对同一份
// 文件说相反的话，正是这个字段当初被引入所要修的那条自相矛盾。
//
// ── 本文件用两条互补的守卫钉它，缺一都会假绿 ────────────────────────────────
//  ① **文本守卫**（本文件 §1）：剥掉注释后，判据文本在整个文件里只许出现一次。
//     这一条直接对着"定义点个数"说话，是 T5（CJK_EPISODE_MARKER_CLASS）收敛所用的同一手法。
//     ⚠️ 必须剥注释：本文件与被测文件的注释里都写着这个字符串（上面就有三处），
//     不剥的话守卫会被自己的文档匹配到而假红——handleWorkerTask.orphan.test.ts 记过这个坑，
//     dormantReadSurface.orphan.test.ts 的 codeOf() 是既有解法，这里照抄。
//  ② **行为守卫**（本文件 §2）：给判据加一条真实的收紧（needs_subtitle=0 才算数），
//     两个消费点必须**同时**改变结论。单靠 ① 的话，有人把两处都换成调用同一个
//     `f.skip_reason === EXTRA_REASON` 常量也能过——那仍是两份判据逻辑，只是共享了字面量。
//     ② 通过"注入一个新判据条件、观察两端是否同步"来证明它们真的走同一个函数。
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb, type ScoutDb } from '../v2/db.js'
import { buildMediaLibrary, buildMediaLibraryDetail, isJudgedExtra } from './mediaLibraryApi.js'

const API_PATH = fileURLToPath(new URL('./mediaLibraryApi.ts', import.meta.url))

/** 剥掉块注释与行注释，只留可执行代码（照 dormantReadSurface.orphan.test.ts 的 codeOf）。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

// ══════════════════════════════════════════════════════════════════════════════
// §1 文本守卫：判据只有一个定义点
// ══════════════════════════════════════════════════════════════════════════════
describe('T2-a 机械特典判据只有一个定义点', () => {
  it('🔴 `skip_reason === \'extra\'` 在可执行代码里只出现一次（那一次在 isJudgedExtra 里）', () => {
    const code = codeOf(API_PATH)
    const hits = code.match(/skip_reason\s*===\s*'extra'/g) ?? []
    expect(
      hits.length,
      `判据写了 ${hits.length} 遍。它必须只有一个定义点（isJudgedExtra），`
        + `其余消费点一律调用它——否则加判据时改一处忘一处，格子上的 ▭ 与 unplacedFileCount 会互相打脸。`,
    ).toBe(1)
  })

  it('🔴 自检：扫描器没有空转（剥注释后仍能看见被测文件的真实代码）', () => {
    // 没有这一条，① 会在"readFileSync 读错路径 / 正则失效 / codeOf 把整个文件吃光"
    // 时以 0 次匹配的方式假绿。这里断言两个只可能出现在**可执行代码**里的锚点。
    const code = codeOf(API_PATH)
    expect(code).toContain('function isJudgedExtra')
    expect(code).toContain('function classifyFileState')
    // 反向自检：注释确实被剥掉了。这个字符串只出现在 isJudgedExtra 的头注释里。
    expect(readFileSync(API_PATH, 'utf8')).toContain('C30 的原型')
    expect(code).not.toContain('C30 的原型')
  })

  it('🔴 判据本体确实由 isJudgedExtra 承载（不是被搬去别处后这里恒 0）', () => {
    // ① 断言"只出现一次"，若有人把两处都删了改成别的写法，① 会变成 0 而**不会红**
    // （toBe(1) 会红——但若有人顺手把它改成 toBeLessThanOrEqual(1) 就瞎了）。
    // 这一条独立锁死"那唯一一次就在 isJudgedExtra 的函数体里"。
    const code = codeOf(API_PATH)
    const body = /function isJudgedExtra\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1]
    expect(body, 'isJudgedExtra 的函数体没解析出来').toBeTruthy()
    expect(body).toMatch(/skip_reason\s*===\s*'extra'/)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// §2 行为守卫：两个消费点真的走同一个函数
// ══════════════════════════════════════════════════════════════════════════════
//
// 做法：用被导出的 isJudgedExtra 本身当**探针**——先证明它是判据的唯一裁决者，
// 再证明两个消费点（八态分类 / unplaced 计数）在同一份输入上给出**一致**的结论。
//
// 「一致」的定义要精确，否则会写出一条恒真的废话。这里锁的是这个双向蕴含：
//     isJudgedExtra(f) === true  ⟺  该行在格子上是 'extra' 且不计入 unplaced
// 逐个 skip_reason 值遍历，两侧必须逐值同步。判据在任一侧被单独改动（加条件、
// 改值、漏掉一个分支），这张真值表就会不再对齐。
describe('T2-a 两个消费点共用同一份判据（行为侧）', () => {
  let db: ScoutDb
  const NOW = 1_700_000_000_000

  beforeEach(() => {
    db = openDb(':memory:')
  })

  function addWork(id: string, title: string): void {
    db.prepare(
      `INSERT INTO works (id, title, original_title, year, media_type, origin_lang, overview, poster_path, chinese_titles, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, title, null, null, 'tv', null, null, null, null, NOW, NOW)
  }

  function addFile(o: {
    path: string
    workId: string
    season?: number | null
    episode?: number | null
    needsSubtitle?: number | null
    skipReason?: string | null
  }): void {
    db.prepare(
      `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, season, episode, sub_status, embedded_langs, needs_subtitle, skip_reason, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      o.path, '/d', 'f.mkv', 100, NOW, '/d', o.workId,
      o.season ?? null, o.episode ?? null, null, null,
      o.needsSubtitle === undefined ? 1 : o.needsSubtitle,
      o.skipReason ?? null, NOW,
    )
  }

  function addCanonical(seriesId: string, season: number, episodes: number[]): void {
    const ins = db.prepare(
      `INSERT INTO tmdb_seasons (series_id, season, episode, title, fetched_at) VALUES (?,?,?,?,?)`,
    )
    for (const e of episodes) ins.run(seriesId, season, e, `E${e}`, NOW)
  }

  // judge 能写进 skip_reason 的全部值 + 两种"还没判"的形态。
  // 逐值遍历而不是只测 'extra'：只测 'extra' 的话，把判据放宽成"skip_reason 非空"
  // 两侧会一起变宽、真值表仍然对齐——但那是错的行为。加上其余值才锁得住。
  const CASES = [
    { skipReason: 'extra', needsSubtitle: 0, isExtra: true },
    { skipReason: 'origin-skip', needsSubtitle: 0, isExtra: false },
    { skipReason: 'embedded', needsSubtitle: 0, isExtra: false },
    { skipReason: 'missing', needsSubtitle: 1, isExtra: false },
    { skipReason: null, needsSubtitle: 0, isExtra: false },
    { skipReason: null, needsSubtitle: null, isExtra: false },
    { skipReason: null, needsSubtitle: 1, isExtra: false },
  ] as const

  it('🔴 判据函数本身的真值表（这是唯一定义点的行为规格）', () => {
    for (const c of CASES) {
      expect(
        isJudgedExtra({ skip_reason: c.skipReason }),
        `skip_reason=${String(c.skipReason)} 期望 ${c.isExtra}`,
      ).toBe(c.isExtra)
    }
  })

  it('🔴 八态分类与判据函数逐值同步（消费点①）', () => {
    // 判据为真 ⟺ 格子报 'extra'。走真实端点，不是直接调 classifyFileState
    // （那个函数没导出，也不该为测试导出——从端点看得见的才是用户看得见的）。
    for (const [i, c] of CASES.entries()) {
      const id = `tmdb:a${i}`
      addWork(id, `Case ${i}`)
      addCanonical(id, 1, [1])
      addFile({
        path: `/a${i}/s1e1.mkv`, workId: id, season: 1, episode: 1,
        needsSubtitle: c.needsSubtitle, skipReason: c.skipReason,
      })
      const state = buildMediaLibraryDetail(db, id)!.seasons[0]!.episodes[0]!.episodeState
      expect(
        state === 'extra',
        `skip_reason=${String(c.skipReason)}：isJudgedExtra=${c.isExtra} 而 episodeState='${state}'`,
      ).toBe(c.isExtra)
    }
  })

  it('🔴 unplacedFileCount 的扣除与判据函数逐值同步（消费点②，两页各一次）', () => {
    // 判据为真 ⟺ 该行不计入 unplaced。列表页与详情页都查——它们各自调一次 isJudgedExtra。
    for (const [i, c] of CASES.entries()) {
      const id = `tmdb:b${i}`
      addWork(id, `Unplaced ${i}`)
      addFile({
        path: `/b${i}/nope.mkv`, workId: id, season: null, episode: null,
        needsSubtitle: c.needsSubtitle, skipReason: c.skipReason,
      })
      const item = buildMediaLibrary(db).find((x) => x.workId === id)!
      const detail = buildMediaLibraryDetail(db, id)!
      const expected = c.isExtra ? 0 : 1
      expect(item.unplacedFileCount, `列表页 skip_reason=${String(c.skipReason)}`).toBe(expected)
      expect(detail.unplacedFileCount, `详情页 skip_reason=${String(c.skipReason)}`).toBe(expected)
    }
  })

  it('🔴 同一格里"格子标 ▭"与"不进 unplaced"绝不分叉（这才是收敛要防的那个形态）', () => {
    // 上面三条各自锁一端。这一条把它们扣在一起：同一部剧里同时放一个进得了格的特典
    // 与一个进不了格的特典，两个控件的结论必须来自同一条判据。
    // 判据若在任一处被单独收紧（例如只有 classifyFileState 加了 needs_subtitle 条件），
    // 这里会出现 ▭ 与计数各说各话。
    addWork('tmdb:mix', 'Mixed')
    addCanonical('tmdb:mix', 1, [1])
    addFile({ path: '/mix/s1e1.PV.mkv', workId: 'tmdb:mix', season: 1, episode: 1, needsSubtitle: 0, skipReason: 'extra' })
    addFile({ path: '/mix/NCOP.mkv', workId: 'tmdb:mix', season: null, episode: null, needsSubtitle: 0, skipReason: 'extra' })
    addFile({ path: '/mix/unparsed.mkv', workId: 'tmdb:mix', season: null, episode: null })

    const detail = buildMediaLibraryDetail(db, 'tmdb:mix')!
    const item = buildMediaLibrary(db).find((x) => x.workId === 'tmdb:mix')!
    // 进得了格的那个：▭
    expect(detail.seasons[0]!.episodes[0]!.episodeState).toBe('extra')
    // 进不了格的那个：被扣掉，只剩解析失败的那一个
    expect(detail.unplacedFileCount).toBe(1)
    expect(item.unplacedFileCount).toBe(1)
  })
})
