// src/dashboard/subtitleVerifyApi.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SubtitleVerifyRepo, type SubtitleVerdict, type ShiftedMediaRow } from '../v2/subtitleVerifyRepo.js'
import type { ShiftResult } from '../subtitleVerify/shiftTiming.js'
import type { VerifyOutcome } from '../subtitleVerify/verifySubtitle.js'
import {
  toVerifyDTO, buildVerifyDTOs, parseItemIds, parseItemIdBody,
  correctSubtitle, revertSubtitle, MAX_BATCH_ITEM_IDS, buildShiftedDTOs,
  type SubtitleWriteDeps,
} from './subtitleVerifyApi.js'

const NOW = 1_700_000_000_000
const SUB = '/media/Show/s1e1.zh.srt'
const BACKUP_SUFFIX = '.scout-backup'

let db: ScoutDb
let repo: SubtitleVerifyRepo
let lib: LibraryRepo

beforeEach(() => {
  db = openDb(':memory:')
  repo = new SubtitleVerifyRepo(db)
  lib = new LibraryRepo(db)
  lib.upsertSeries({ id: 's1', name: 'Show' })
  lib.upsertEpisode({
    id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1',
    path: '/media/Show/s1e1.mkv', subStatus: 'covered',
  })
  lib.upsertMovie({ id: 'm1', name: 'Film', path: '/media/Film/film.mkv', subStatus: 'covered' })
})

/** 落一行检测结论。内部字段（offsetMs/score/referenceTier/detail）一律给上真值——
 *  正是要证明它们**存在于库里却不出现在 DTO 里**（铁律②）。 */
function seedVerdict(
  itemId: string, verdict: SubtitleVerdict,
  extra?: { offsetMs?: number | null; subtitlePath?: string },
): void {
  repo.upsertVerifyResult({
    itemId, verdict,
    offsetMs: extra?.offsetMs === undefined ? (verdict === 'shifted' ? 2400 : null) : extra.offsetMs,
    score: 0.93,
    referenceTier: 'embedded',
    subtitlePath: extra?.subtitlePath ?? SUB,
    subtitleHash: 'hash-a',
    checkedAt: NOW,
    detail: 'ref=embedded: track 3 (chi)',
  })
}

/** 写扳手的依赖桩。默认：备份不存在、shift/revert 成功、reverify 落一行 aligned 并回报。
 *  每个字段都可覆盖，用来钉住各条失败/边界路径。 */
function makeDeps(over?: Partial<SubtitleWriteDeps> & { existing?: Set<string> }): {
  deps: SubtitleWriteDeps
  calls: { shift: Array<[string, number]>; revert: string[]; reverify: Array<[string, string, string]> }
} {
  const calls = {
    shift: [] as Array<[string, number]>,
    revert: [] as string[],
    reverify: [] as Array<[string, string, string]>,
  }
  const present = over?.existing ?? new Set<string>()
  const okShift: ShiftResult = { ok: true, detail: 'shifted 812 line(s)' }
  const deps: SubtitleWriteDeps = {
    repo, lib,
    shift: async (p, off) => { calls.shift.push([p, off]); return okShift },
    revert: async (p) => { calls.revert.push(p); return okShift },
    exists: (p) => present.has(p),
    // 默认哈希与 seedVerdict 落的 subtitle_hash 一致 = "文件没被换过"（正常路径）。
    // 想模拟"用户重新下载了一份同名字幕"就覆盖成别的值（审计 C-A1）。
    hashSubtitle: async () => 'hash-a',
    // 桩要如实模仿 verifyAndRecord 的契约：**既落库又返回**。只返回不落库的桩会让
    // "校正后 DB 结论被更新"这条断言变成对桩的断言而非对被测代码的断言。
    reverify: async (itemId, videoPath, subtitlePath) => {
      calls.reverify.push([itemId, videoPath, subtitlePath])
      const outcome: VerifyOutcome = {
        verdict: 'aligned', offsetMs: null, score: 0.99,
        referenceTier: 'embedded', detail: 're-checked after correction', subtitleHash: 'hash-b',
      }
      repo.upsertVerifyResult({
        itemId, verdict: outcome.verdict, offsetMs: outcome.offsetMs, score: outcome.score,
        referenceTier: outcome.referenceTier, subtitlePath, subtitleHash: outcome.subtitleHash,
        checkedAt: NOW + 1, detail: outcome.detail,
      })
      return outcome
    },
    now: () => NOW,
    ...over,
  }
  return { deps, calls }
}

const OPTS = { backupSuffix: BACKUP_SUFFIX }

describe('toVerifyDTO：三值 → 两色（spec 铁律①③）', () => {
  it('未检测过的条目 → checked:false（UI 不显示芯片，既不是绿也不是红）', () => {
    expect(toVerifyDTO('e1', null)).toEqual({ itemId: 'e1', state: 'ok', checked: false })
  })

  it("aligned → state:'ok'", () => {
    seedVerdict('e1', 'aligned')
    expect(toVerifyDTO('e1', repo.getVerifyResult('e1'))).toEqual({
      itemId: 'e1', state: 'ok', checked: true,
    })
  })

  // 铁律③的回归锁。unverifiable=「没能验证」，产品裁决是**绿色而非黄色**：诚实体现在
  // 不假装验证过，而不是打个黄标让用户对一件我们自己都不知道有没有问题的事焦虑。
  // 且它是最常见的一档（大量片源无内嵌轨也无同目录参考字幕），误判成红/黄会让整个媒体库
  // 亮成一片，那个界面没人会再看。这条挂了就是产品破防，不是测试太严。
  it("unverifiable → state:'ok'（绿，不是黄也不是红）【铁律③】", () => {
    seedVerdict('e1', 'unverifiable')
    expect(toVerifyDTO('e1', repo.getVerifyResult('e1'))).toEqual({
      itemId: 'e1', state: 'ok', checked: true,
    })
  })

  it("shifted → state:'shifted'（红，可点校正）", () => {
    seedVerdict('e1', 'shifted')
    expect(toVerifyDTO('e1', repo.getVerifyResult('e1'))).toEqual({
      itemId: 'e1', state: 'shifted', checked: true,
    })
  })

  // 铁律②的回归锁。断言**精确的键集合**而不是 `not.toHaveProperty('score')`：后者只挡住
  // 我今天想到的那几个字段名，前者让任何新增字段（含日后有人加的 `confidence`/`tier`/
  // `offsetSeconds`）立刻变红。库里那行明明带着 offset_ms=2400 / score=0.93 /
  // reference_tier / detail，DTO 必须一个都不漏出去。
  it('DTO 恰好只有三个键——内部诊断字段一个都不漏出去【铁律②】', () => {
    seedVerdict('e1', 'shifted')
    const row = repo.getVerifyResult('e1')!
    // 前提自检：库里确实存着这些内部字段，所以下面的断言不是在一行空数据上空转。
    expect(row.offset_ms).toBe(2400)
    expect(row.score).toBe(0.93)
    expect(row.reference_tier).toBe('embedded')
    expect(row.detail).not.toBeNull()

    const dto = toVerifyDTO('e1', row)
    expect(Object.keys(dto).sort()).toEqual(['checked', 'itemId', 'state'])
  })

  it('未检测过的 DTO 同样恰好三个键', () => {
    expect(Object.keys(toVerifyDTO('e1', null)).sort()).toEqual(['checked', 'itemId', 'state'])
  })

  it('JSON 序列化后也不含任何内部字段名（端到端的字符串级回归锁）', () => {
    seedVerdict('e1', 'shifted')
    const json = JSON.stringify(toVerifyDTO('e1', repo.getVerifyResult('e1')))
    for (const banned of ['offset', 'score', 'tier', 'detail', 'hash', 'checkedAt', 'subtitlePath']) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase())
    }
  })
})

describe('buildVerifyDTOs（GET 的实现，纯读）', () => {
  it('单条查询返回长度 1 的数组', () => {
    seedVerdict('e1', 'shifted')
    const r = buildVerifyDTOs(repo, ['e1'])
    expect(r).toEqual({ ok: true, dto: { items: [{ itemId: 'e1', state: 'shifted', checked: true }] } })
  })

  it('批量查询：混合状态一次拿回，顺序与入参一致', () => {
    seedVerdict('e1', 'shifted')
    seedVerdict('m1', 'unverifiable')
    const r = buildVerifyDTOs(repo, ['e1', 'm1', 'never-checked'])
    expect(r.ok).toBe(true)
    expect(r.ok && r.dto.items).toEqual([
      { itemId: 'e1', state: 'shifted', checked: true },
      { itemId: 'm1', state: 'ok', checked: true },
      { itemId: 'never-checked', state: 'ok', checked: false },
    ])
  })

  it('空 id 列表 → 拒（400 素材）', () => {
    expect(buildVerifyDTOs(repo, [])).toEqual({
      ok: false, error: 'itemId or itemIds query param is required',
    })
  })

  it(`超过 ${MAX_BATCH_ITEM_IDS} 个 id → 拒`, () => {
    const many = Array.from({ length: MAX_BATCH_ITEM_IDS + 1 }, (_, i) => `e${i}`)
    const r = buildVerifyDTOs(repo, many)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('too many ids')
  })

  it('恰好 MAX 个 id 放行（边界不多减一）', () => {
    const many = Array.from({ length: MAX_BATCH_ITEM_IDS }, (_, i) => `e${i}`)
    expect(buildVerifyDTOs(repo, many).ok).toBe(true)
  })

  // 铁律④：GET 绝不写任何东西。这条钉住"读端点不会顺手校正/顺手落库"。
  it('纯读：查一个未检测过的条目不会往库里写行', () => {
    buildVerifyDTOs(repo, ['e1', 'm1'])
    expect(repo.getVerifyResult('e1')).toBeNull()
    expect(db.prepare('SELECT COUNT(*) as c FROM subtitle_verify').get()).toEqual({ c: 0 })
  })
})

describe('parseItemIds', () => {
  it('itemId 单参', () => {
    expect(parseItemIds({ itemId: 'e1' })).toEqual(['e1'])
  })
  it('itemIds 逗号分隔', () => {
    expect(parseItemIds({ itemIds: 'e1,e2,e3' })).toEqual(['e1', 'e2', 'e3'])
  })
  it('两者并存时合并去重', () => {
    expect(parseItemIds({ itemId: 'e1', itemIds: 'e2,e1' })).toEqual(['e1', 'e2'])
  })
  it('空片段与空白被丢弃（`a,,b` 里的空串不是一个 id）', () => {
    expect(parseItemIds({ itemIds: 'e1, ,e2,' })).toEqual(['e1', 'e2'])
  })
  it('全空 → 空数组（调用方据此 400）', () => {
    expect(parseItemIds({})).toEqual([])
    expect(parseItemIds({ itemId: '  ', itemIds: ',,' })).toEqual([])
  })
})

describe('parseItemIdBody', () => {
  it('合法 itemId', () => {
    expect(parseItemIdBody({ itemId: 'e1' })).toBe('e1')
  })
  it('缺字段 / 空 body / null → null', () => {
    expect(parseItemIdBody({})).toBeNull()
    expect(parseItemIdBody(null)).toBeNull()
    expect(parseItemIdBody(undefined)).toBeNull()
  })
  it('非字符串（含数字、对象）→ null，不做 String() 强转', () => {
    expect(parseItemIdBody({ itemId: 123 })).toBeNull()
    expect(parseItemIdBody({ itemId: { id: 'e1' } })).toBeNull()
  })
  it('空串/纯空白 → null', () => {
    expect(parseItemIdBody({ itemId: '' })).toBeNull()
    expect(parseItemIdBody({ itemId: '   ' })).toBeNull()
  })
})

describe('correctSubtitle（POST correct）', () => {
  it('shifted → 平移 → 重新检测 → 覆盖落库 → 回报新状态', async () => {
    seedVerdict('e1', 'shifted')
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'e1', OPTS)

    expect(r).toEqual({ ok: true, state: 'ok' })
    // 平移用的是**库里记录的**字幕路径与偏移量，不是前端传来的任何东西。
    expect(calls.shift).toEqual([[SUB, 2400]])
    // 重新检测拿到的片源路径来自 episodes 表。
    expect(calls.reverify).toEqual([['e1', '/media/Show/s1e1.mkv', SUB]])
  })

  // 关键回归：不重新检测落库的话，UI 会一直显示红芯片（它只读 DB），用户以为按钮没生效。
  it('校正成功后 DB 里的结论被更新，不再是 shifted【重检落库回归锁】', async () => {
    seedVerdict('e1', 'shifted')
    expect(repo.getVerifyResult('e1')!.verdict).toBe('shifted')

    const { deps } = makeDeps()
    await correctSubtitle(deps, 'e1', OPTS)

    const after = repo.getVerifyResult('e1')!
    expect(after.verdict).toBe('aligned')
    expect(after.offset_ms).toBeNull()
    expect(after.checked_at).toBe(NOW + 1)
    // 且 GET 这条现在会回报绿色——这才是用户真正看到的东西。
    expect(toVerifyDTO('e1', after).state).toBe('ok')
  })

  it('重新检测后仍判 shifted → 如实回报 shifted（不谎报成功）', async () => {
    seedVerdict('e1', 'shifted')
    const { deps } = makeDeps({
      reverify: async (itemId, _v, subtitlePath) => {
        const outcome: VerifyOutcome = {
          verdict: 'shifted', offsetMs: 400, score: 0.95,
          referenceTier: 'embedded', detail: 'still off', subtitleHash: 'hash-b',
        }
        repo.upsertVerifyResult({
          itemId, verdict: 'shifted', offsetMs: 400, score: 0.95, referenceTier: 'embedded',
          subtitlePath, subtitleHash: 'hash-b', checkedAt: NOW + 1, detail: 'still off',
        })
        return outcome
      },
    })
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r).toEqual({ ok: true, state: 'shifted' })
  })

  // 铁律④：是否校正是用户的选择，但"能不能校正"由证据决定。绿的两档都不许动用户的文件。
  it("aligned 状态下被拒（400），且**没有触碰过文件**", async () => {
    seedVerdict('e1', 'aligned')
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'e1', OPTS)

    expect(r).toEqual({
      ok: false, status: 400, error: "this subtitle isn't out of sync — nothing to correct",
    })
    expect(calls.shift).toEqual([])
    expect(calls.reverify).toEqual([])
  })

  it('unverifiable 状态下被拒（400）——没能验证时那个偏移量本就不可信', async () => {
    seedVerdict('e1', 'unverifiable')
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.status).toBe(400)
    expect(calls.shift).toEqual([])
  })

  it('从未检测过 → 404（不知道该动哪个字幕文件）', async () => {
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r).toEqual({ ok: false, status: 404, error: "this item hasn't been checked yet" })
    expect(calls.shift).toEqual([])
  })

  it('itemId 不存在于库 → 404', async () => {
    const { deps } = makeDeps()
    const r = await correctSubtitle(deps, 'ghost', OPTS)
    expect(r).toEqual({ ok: false, status: 404, error: "this item hasn't been checked yet" })
  })

  it('有结论但 item 行已被删（磁盘文件消失）→ 404，不拿空路径去平移', async () => {
    seedVerdict('gone', 'shifted')
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'gone', OPTS)
    expect(r).toEqual({ ok: false, status: 404, error: 'this item is no longer in the library' })
    expect(calls.shift).toEqual([])
  })

  it('电影条目（movies 表）同样能校正——item_id 是两表共用的一个空间', async () => {
    seedVerdict('m1', 'shifted', { subtitlePath: '/media/Film/film.zh.srt' })
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'm1', OPTS)
    expect(r).toEqual({ ok: true, state: 'ok' })
    expect(calls.reverify).toEqual([['m1', '/media/Film/film.mkv', '/media/Film/film.zh.srt']])
  })

  // 残差叠加的安全门。shiftSubtitleTiming 的基准恒为**原始文件**（它从备份重算），而 DB 里的
  // offset_ms 是对**当前磁盘文件**测出来的残差——第二次校正若直接传残差，会把一个已平移
  // 2400ms 的文件重置成只平移 400ms，比校正前更错。已应用量只在 .scout-backup.json 里，
  // 而读它的 readMeta 是 shiftTiming 的模块私有函数。所以这里拒绝、要用户走撤销→重校。
  it('已校正过一次（备份已存在）→ 409 拒绝，绝不拿残差去二次平移', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: 400 })
    const { deps, calls } = makeDeps({ existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    const r = await correctSubtitle(deps, 'e1', OPTS)

    expect(r).toEqual({
      ok: false, status: 409,
      error: 'this subtitle has already been corrected once — undo first, then correct again',
    })
    expect(calls.shift).toEqual([])
  })

  it('shifted 但 offset_ms 为 NULL（手工改库/旧数据）→ 409，不拿 0 去平移', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: null })
    const { deps, calls } = makeDeps()
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.status).toBe(409)
    expect(calls.shift).toEqual([])
  })

  it('平移失败 → 500 + 人话，且不重新检测（文件没变，重检是白跑）', async () => {
    seedVerdict('e1', 'shifted')
    const { deps, calls } = makeDeps({
      shift: async () => ({ ok: false, detail: 'refused: UTF-16/UTF-32 detected (BOM or NUL bytes)' }),
    })
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r).toEqual({
      ok: false, status: 500,
      error: "couldn't correct this subtitle — your file was left untouched",
    })
    expect(calls.reverify).toEqual([])
    // 库里那行不动：平移没发生，旧结论仍然如实描述磁盘上的文件。
    expect(repo.getVerifyResult('e1')!.verdict).toBe('shifted')
  })

  // 铁律②在失败路径上同样成立。shiftTiming 的 detail 带路径、字节数、offsetMs——
  // 把它当 error 直接回给前端等于绕过整个 DTO 防线泄露诊断数字。
  it('平移失败的 error 是人话，不含内部 detail 的任何技术痕迹【铁律②】', async () => {
    seedVerdict('e1', 'shifted')
    const leaky = 'refused: |offsetMs| 2400ms exceeds sanity bound at /media/Show/s1e1.zh.srt'
    const { deps } = makeDeps({ shift: async () => ({ ok: false, detail: leaky }) })
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r.ok).toBe(false)
    const err = r.ok === false ? r.error : ''
    expect(err).not.toContain(leaky)
    expect(err).not.toMatch(/\d/)          // 零数字
    expect(err).not.toContain('/media/')   // 不泄露路径
  })

  it('回执恰好只有 ok 与 state 两个键（成功路径的零数字锁）【铁律②】', async () => {
    seedVerdict('e1', 'shifted')
    const { deps } = makeDeps()
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(Object.keys(r).sort()).toEqual(['ok', 'state'])
  })

  it('reverify 回报 null（编排层判不必重检）→ 退回库里现有结论，不凭空断言 ok', async () => {
    seedVerdict('e1', 'shifted')
    const { deps } = makeDeps({ reverify: async () => null })
    const r = await correctSubtitle(deps, 'e1', OPTS)
    // 库里仍是 shifted（桩没落库），如实回报 shifted 而不是假装校正成功变绿。
    expect(r).toEqual({ ok: true, state: 'shifted' })
  })
})

describe('revertSubtitle（POST revert）', () => {
  it('有备份 → 还原 → 重新检测 → 覆盖落库', async () => {
    seedVerdict('e1', 'aligned')  // 校正成功后的典型状态
    const { deps, calls } = makeDeps({ existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    const r = await revertSubtitle(deps, 'e1', OPTS)

    expect(r).toEqual({ ok: true, state: 'ok' })
    expect(calls.revert).toEqual([SUB])
    expect(calls.reverify).toEqual([['e1', '/media/Show/s1e1.mkv', SUB]])
  })

  it('撤销后 DB 结论被更新【重检落库回归锁】', async () => {
    seedVerdict('e1', 'aligned')
    // 撤销把文件还原成原始（偏的）字节，所以重检应当又变回 shifted——这正是必须重检的理由：
    // 不重检，用户撤销后看到的还是绿色，而磁盘上的字幕其实又偏了。
    const { deps } = makeDeps({
      existing: new Set([`${SUB}${BACKUP_SUFFIX}`]),
      reverify: async (itemId, _v, subtitlePath) => {
        repo.upsertVerifyResult({
          itemId, verdict: 'shifted', offsetMs: 2400, score: 0.93, referenceTier: 'embedded',
          subtitlePath, subtitleHash: 'hash-a', checkedAt: NOW + 2, detail: 'back to original',
        })
        return {
          verdict: 'shifted', offsetMs: 2400, score: 0.93,
          referenceTier: 'embedded', detail: 'back to original', subtitleHash: 'hash-a',
        }
      },
    })
    const r = await revertSubtitle(deps, 'e1', OPTS)

    expect(r).toEqual({ ok: true, state: 'shifted' })
    const after = repo.getVerifyResult('e1')!
    expect(after.verdict).toBe('shifted')
    expect(after.checked_at).toBe(NOW + 2)
  })

  // 撤销刻意**不看 verdict**：校正成功后 verdict 变 aligned，而那恰恰是用户最想撤销的时刻
  // （"校正后我觉得更难看了"）。要求 shifted 才能撤销 = 把撤销做成只在校正失败时可用。
  it.each(['aligned', 'shifted', 'unverifiable'] as const)(
    'verdict=%s 都能撤销——前置条件只有"有备份"，与当前结论无关',
    async (verdict) => {
      seedVerdict('e1', verdict)
      const { deps, calls } = makeDeps({ existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
      const r = await revertSubtitle(deps, 'e1', OPTS)
      expect(r.ok).toBe(true)
      expect(calls.revert).toEqual([SUB])
    },
  )

  it('无备份 → 400（没有可撤销的操作），且不调 revert', async () => {
    seedVerdict('e1', 'aligned')
    const { deps, calls } = makeDeps()
    const r = await revertSubtitle(deps, 'e1', OPTS)
    expect(r).toEqual({
      ok: false, status: 400, error: "there's nothing to undo for this subtitle",
    })
    expect(calls.revert).toEqual([])
  })

  it('从未检测过 → 404', async () => {
    const { deps } = makeDeps({ existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    const r = await revertSubtitle(deps, 'e1', OPTS)
    expect(r).toEqual({ ok: false, status: 404, error: "this item hasn't been checked yet" })
  })

  it('item 已不在库 → 404', async () => {
    seedVerdict('gone', 'aligned')
    const { deps } = makeDeps({ existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    const r = await revertSubtitle(deps, 'gone', OPTS)
    expect(r).toEqual({ ok: false, status: 404, error: 'this item is no longer in the library' })
  })

  it('还原失败 → 500 + 人话（不含内部 detail），且不重新检测', async () => {
    seedVerdict('e1', 'aligned')
    const leaky = 'refused: backup at /media/Show/s1e1.zh.srt.scout-backup does not look like a valid .srt'
    const { deps, calls } = makeDeps({
      existing: new Set([`${SUB}${BACKUP_SUFFIX}`]),
      revert: async () => ({ ok: false, detail: leaky }),
    })
    const r = await revertSubtitle(deps, 'e1', OPTS)
    expect(r).toEqual({
      ok: false, status: 500,
      error: "couldn't undo this correction — your file was left untouched",
    })
    expect(calls.reverify).toEqual([])
    const err = r.ok === false ? r.error : ''
    expect(err).not.toContain(leaky)
    expect(err).not.toContain('/media/')
  })

  // 撤销 → 重新校正是 correctSubtitle 那道 409 门指望的出路：revertSubtitleTiming 会把
  // meta 归零（C-A1 之后改成归零而非删除），所以撤销后的校正是一次基准明确的干净首次校正。
  // 这条钉住这条出路真的通。
  it('撤销后再校正走得通（409 门的出路不是死胡同）', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const backup = `${SUB}${BACKUP_SUFFIX}`
    const present = new Set([backup])
    const { deps, calls } = makeDeps({
      existing: present,
      // 模仿 revertSubtitleTiming：备份保留不删，meta 归零 → 下次校正基准干净。
      revert: async () => ({ ok: true, detail: 'reverted' }),
    })

    // 备份在 → 校正被 409 拦下
    expect((await correctSubtitle(deps, 'e1', OPTS)).ok).toBe(false)
    // 撤销放行
    expect((await revertSubtitle(deps, 'e1', OPTS)).ok).toBe(true)
    // 清理备份后（人工/清理脚本，见 shiftTiming 注释）校正又可用
    present.delete(backup)
    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const again = await correctSubtitle(deps, 'e1', OPTS)
    expect(again).toEqual({ ok: true, state: 'ok' })
    expect(calls.shift).toEqual([[SUB, 2400]])
  })
})

/**
 * C-A1（审计 Critical）的链路修复：**系统不许把用户引向那条销毁文件的路**。
 *
 * 背景链条：字幕落盘用确定性文件名（subtitleWriter.ts）→ 用户重新下载一份同名字幕
 * → 路径不变 → 巡检永不重查已有记录的条目（verifySweep.ts 的 LEFT JOIN ... IS NULL 过滤）
 * → DB 里一直留着**旧字幕**的 shifted 判定、红芯片一直亮 → 用户点校正。
 *
 * 修复前这里回 409 "先撤销再校正"，而撤销恰恰会用旧字幕的备份覆盖用户刚下载的新字幕。
 * 判据复用既有的 repo.needsRecheck（路径 + 内容哈希），不发明第二套。
 */
describe('C-A1：字幕被换过之后，写扳手必须拒绝且给出正确指引', () => {
  /** 用户重新下载了一份同名字幕：路径不变，内容哈希与库里那行不一致。 */
  const SWAPPED = { hashSubtitle: async () => 'hash-of-the-new-file' }

  it('校正：字幕被换过 → 409，且文案绝不建议"撤销"（那会销毁新字幕）', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const { deps, calls } = makeDeps(SWAPPED)
    const r = await correctSubtitle(deps, 'e1', OPTS)

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.status).toBe(409)
    const err = r.ok === false ? r.error : ''
    // 如实说明"文件已被替换"并要求重新检测
    expect(err).toContain('has been replaced')
    // 这是本条测试的核心：**不许**再出现"先撤销"这个有害建议
    expect(err).not.toMatch(/undo/i)
    expect(err).not.toMatch(/撤销/)
    // 一个字节都没动
    expect(calls.shift).toEqual([])
    expect(calls.reverify).toEqual([])
  })

  it('撤销：字幕被换过 → 409 拒绝，绝不用旧备份覆盖新字幕（审计路径 ①）', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const { deps, calls } = makeDeps({ ...SWAPPED, existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    const r = await revertSubtitle(deps, 'e1', OPTS)

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.status).toBe(409)
    expect(r.ok === false ? r.error : '').toContain('has been replaced')
    // revert 压根没被调用 → 用户的新字幕安全
    expect(calls.revert).toEqual([])
    expect(calls.reverify).toEqual([])
  })

  it('C-A1 门在"已校正过一次"那道 409 之前（否则用户仍会收到有害的撤销建议）', async () => {
    // 两个条件同时成立：备份已存在 **且** 字幕被换过。
    // 若顺序颠倒，用户拿到的是"already been corrected once — undo first"，
    // 照做就会销毁新字幕。顺序正确时拿到的是"has been replaced"。
    seedVerdict('e1', 'shifted', { offsetMs: 400 })
    const { deps } = makeDeps({ ...SWAPPED, existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    const r = await correctSubtitle(deps, 'e1', OPTS)

    const err = r.ok === false ? r.error : ''
    expect(err).toContain('has been replaced')
    expect(err).not.toMatch(/undo/i)
  })

  it('哈希算不出（文件被删/无权限）→ 保守拒绝，不对读不动的文件动写扳手', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const { deps, calls } = makeDeps({ hashSubtitle: async () => null })
    const r = await correctSubtitle(deps, 'e1', OPTS)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.status).toBe(409)
    expect(calls.shift).toEqual([])
  })

  it('字幕没被换过 → 两个扳手都照常放行（守卫不误伤主路径）', async () => {
    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const { deps, calls } = makeDeps()
    expect(await correctSubtitle(deps, 'e1', OPTS)).toEqual({ ok: true, state: 'ok' })
    expect(calls.shift).toEqual([[SUB, 2400]])

    seedVerdict('e1', 'shifted', { offsetMs: 2400 })
    const { deps: d2, calls: c2 } = makeDeps({ existing: new Set([`${SUB}${BACKUP_SUFFIX}`]) })
    expect(await revertSubtitle(d2, 'e1', OPTS)).toEqual({ ok: true, state: 'ok' })
    expect(c2.revert).toEqual([SUB])
  })
})

describe('buildShiftedDTOs（Plan C spec §4.1）', () => {
  const row = (over: Partial<ShiftedMediaRow> = {}): ShiftedMediaRow => ({
    item_id: 'tmdb:100/s2e3',
    checked_at: 3000,
    subtitle_path: '/media/rig.s02e03.zh.srt',
    series_id: 'tmdb:100',
    series_name: 'The Rig',
    season: 2,
    episode: 3,
    ...over,
  })
  const deps = (rows: ShiftedMediaRow[], exists: (p: string) => boolean) => ({
    repo: { listShiftedWithMedia: () => rows },
    exists,
  })

  it('DTO 键集合封闭为七键——四个禁出字段一个都不许出现（铁律②回归锁）', () => {
    const dto = buildShiftedDTOs(deps([row()], () => false), { backupSuffix: '.scout-backup' })
    expect(Object.keys(dto[0]).sort()).toEqual(
      ['checkedAt', 'episode', 'hasPriorCorrection', 'itemId', 'season', 'seriesId', 'seriesName'],
    )
    // 显式再钉一遍：这四个键（以及承载它们的 snake_case 原名）永远不该在响应体里。
    // 扫的是 JSON 键形（"key":）而非裸词——裸词会被 fixture 文案里的 'Filmscore'/'detailed' 误伤。
    const serialized = JSON.stringify(dto)
    for (const forbidden of [
      '"offsetMs":', '"offset_ms":', '"score":', '"referenceTier":',
      '"reference_tier":', '"detail":', '"subtitlePath":', '"subtitle_path":',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('逐字段映射 snake_case → camelCase', () => {
    const dto = buildShiftedDTOs(deps([row()], () => false), { backupSuffix: '.scout-backup' })
    expect(dto[0]).toEqual({
      itemId: 'tmdb:100/s2e3',
      seriesId: 'tmdb:100',
      seriesName: 'The Rig',
      season: 2,
      episode: 3,
      checkedAt: 3000,
      hasPriorCorrection: false,
    })
  })

  it('hasPriorCorrection 探的是 subtitle_path + backupSuffix 这个确切路径', () => {
    const probed: string[] = []
    const dto = buildShiftedDTOs(
      deps([row()], (p) => { probed.push(p); return true }),
      { backupSuffix: '.scout-backup' },
    )
    expect(probed).toEqual(['/media/rig.s02e03.zh.srt.scout-backup'])
    expect(dto[0].hasPriorCorrection).toBe(true)
  })

  it('join 不中的行（电影 / 已删集）四个媒体字段为 null，行仍然出', () => {
    const dto = buildShiftedDTOs(
      deps([row({ item_id: 'tmdb:777', series_id: null, series_name: null, season: null, episode: null })], () => false),
      { backupSuffix: '.scout-backup' },
    )
    expect(dto).toHaveLength(1)
    expect(dto[0].seriesName).toBeNull()
    expect(dto[0].itemId).toBe('tmdb:777')
  })

  it('空表返回空数组（不是 null、不 404）', () => {
    expect(buildShiftedDTOs(deps([], () => false), { backupSuffix: '.scout-backup' })).toEqual([])
  })

  it('多行：逐行探测且行序原样透传（repo 的 checked_at DESC 不打乱）', () => {
    const probed: string[] = []
    const rows = [
      row(), // rig.s02e03，checked_at 3000（较近，排前）
      row({ item_id: 'tmdb:100/s1e1', checked_at: 1000, subtitle_path: '/media/rig.s01e01.zh.srt', season: 1, episode: 1 }),
    ]
    const dto = buildShiftedDTOs(
      deps(rows, (p) => { probed.push(p); return false }),
      { backupSuffix: '.scout-backup' },
    )
    expect(probed).toEqual([
      '/media/rig.s02e03.zh.srt.scout-backup',
      '/media/rig.s01e01.zh.srt.scout-backup',
    ])
    expect(dto[0].itemId).toBe('tmdb:100/s2e3')
    expect(dto[1].itemId).toBe('tmdb:100/s1e1')
  })

  it('backupSuffix 由调用方注入：探测路径跟着 opts 走（不硬编码 .scout-backup）', () => {
    const probed: string[] = []
    buildShiftedDTOs(
      deps([row()], (p) => { probed.push(p); return false }),
      { backupSuffix: '.bak' },
    )
    expect(probed).toEqual(['/media/rig.s02e03.zh.srt.bak'])
  })
})
