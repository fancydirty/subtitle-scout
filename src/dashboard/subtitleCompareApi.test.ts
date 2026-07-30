// src/dashboard/subtitleCompareApi.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SubtitleVerifyRepo, type SubtitleVerdict } from '../v2/subtitleVerifyRepo.js'
import type { Cue } from '../files/subtitleInspect.js'
import type { MountKind } from '../core/mountKind.js'
import type { ReferenceSource } from '../subtitleVerify/referenceSource.js'
import {
  buildCompareDTO, resolveDurationMs, MAX_CUE_TEXT_CHARS,
  type SubtitleCompareDeps, type SubtitleCompareDTO,
} from './subtitleCompareApi.js'

const NOW = 1_700_000_000_000
const SUB = '/media/Show/s1e1.zh.srt'
const VIDEO = '/media/Show/s1e1.mkv'

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
    path: VIDEO, subStatus: 'covered',
  })
  lib.upsertMovie({ id: 'm1', name: 'Film', path: '/media/Film/film.mkv', subStatus: 'covered' })
})

/** 落一行检测结论。内部字段（offsetMs/score/referenceTier/detail）一律给上真值——
 *  正是要证明它们**存在于库里却不出现在对照图 DTO 里**（铁律②）。 */
function seedVerdict(itemId = 'e1', verdict: SubtitleVerdict = 'shifted'): void {
  repo.upsertVerifyResult({
    itemId, verdict,
    offsetMs: 2400,
    score: 0.93,
    referenceTier: 'embedded',
    subtitlePath: SUB,
    subtitleHash: 'hash-a',
    checkedAt: NOW,
    detail: 'ref=embedded: track 3 (chi)',
  })
}

function cue(startMs: number, endMs: number, text: string): Cue {
  return { startMs, endMs, text }
}

const OUR_CUES: Cue[] = [
  cue(1000, 3000, '这是第一句'),
  cue(5000, 7000, '这是第二句'),
]

const REF_CUES: Cue[] = [
  cue(1400, 3400, 'the first line'),
  cue(5400, 7400, 'the second line'),
]

function refSource(cues: Cue[] = REF_CUES): ReferenceSource {
  return {
    tier: 'embedded',
    // spans 是剥了文本的那份；本模块只读 cues，spans 放这里是为了满足类型契约
    spans: cues.map(({ startMs, endMs }) => ({ startMs, endMs })),
    cues,
    detail: 'embedded track 3 (500 cues)',
  }
}

/**
 * 依赖桩。默认：有检测记录、待检轨两块、参考轨两块、时长 24 分钟、挂载 lan。
 * 每个字段可覆盖，用来钉各条分支。
 *
 * **一律注入**：真实实现会 spawn ffmpeg（findReference 抽内嵌轨）、spawn ffprobe
 * （probeDuration）、读 /proc/self/mountinfo（classify——macOS 开发机上恒读不到而
 * 恒判 cloud，那样 lan 那条回归锁在开发机上压根跑不起来）。
 */
function makeDeps(over?: Partial<SubtitleCompareDeps>): {
  deps: SubtitleCompareDeps
  calls: { loadCues: string[]; findReference: Array<[string, string]>; probeDuration: string[]; classify: string[] }
} {
  const calls = {
    loadCues: [] as string[],
    findReference: [] as Array<[string, string]>,
    probeDuration: [] as string[],
    classify: [] as string[],
  }
  const deps: SubtitleCompareDeps = {
    repo,
    lib,
    loadCues: async (p) => { calls.loadCues.push(p); return OUR_CUES },
    findReference: async (v, s) => { calls.findReference.push([v, s]); return refSource() },
    probeDuration: async (v) => { calls.probeDuration.push(v); return 1424 },
    classify: (p) => { calls.classify.push(p); return 'lan' },
    // 刻意接真实的 canRenderWaveform 语义（kind !== 'cloud'）而不是硬编码 true：
    // 桩里写死会让下面 cloud/lan 那两条回归锁变成自证。
    canWaveform: (kind) => kind !== 'cloud',
    ...over,
  }
  return { deps, calls }
}

/** 取成功的 DTO，失败即测试失败（省掉每个用例写一遍 ok 断言的噪声）。 */
async function dtoOf(deps: SubtitleCompareDeps, itemId = 'e1'): Promise<SubtitleCompareDTO> {
  const r = await buildCompareDTO(deps, itemId)
  if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`)
  return r.dto
}

describe('buildCompareDTO — 两条轨都带文字返回', () => {
  it('参考轨与待检轨都带台词文字（这是对照图的全部意义）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps().deps)
    expect(dto.ours).toEqual([
      { startMs: 1000, endMs: 3000, text: '这是第一句' },
      { startMs: 5000, endMs: 7000, text: '这是第二句' },
    ])
    expect(dto.reference).toEqual([
      { startMs: 1400, endMs: 3400, text: 'the first line' },
      { startMs: 5400, endMs: 7400, text: 'the second line' },
    ])
  })

  it('itemId 如实带出', async () => {
    seedVerdict()
    expect((await dtoOf(makeDeps().deps)).itemId).toBe('e1')
  })

  it('待检字幕路径取自检测记录，不接受调用方传路径（任意文件读取的口子）', async () => {
    seedVerdict()
    const { deps, calls } = makeDeps()
    await dtoOf(deps)
    expect(calls.loadCues).toEqual([SUB])
  })

  it('参考源按**片源**路径去找，不是按字幕路径', async () => {
    seedVerdict()
    const { deps, calls } = makeDeps()
    await dtoOf(deps)
    expect(calls.findReference).toEqual([[VIDEO, SUB]])
  })

  it('电影条目（movies 表）同样能画——item_id 是两表共用的一个空间', async () => {
    seedVerdict('m1')
    const { deps, calls } = makeDeps()
    const dto = await dtoOf(deps, 'm1')
    expect(dto.itemId).toBe('m1')
    expect(calls.findReference).toEqual([['/media/Film/film.mkv', SUB]])
  })
})

describe('waveformAvailable × mountKind（spec 验收判据 14）', () => {
  it("mountKind='cloud' → waveformAvailable:false（云盘每次 seek 付 CDN 延迟，抽不动）", async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ classify: () => 'cloud' }).deps)
    expect(dto.mountKind).toBe('cloud')
    expect(dto.waveformAvailable).toBe(false)
  })

  /** 这条是"cifs 不被误禁"的回归锁（spec 验收判据 14）。初稿规则是"网络挂载就禁用"，
   *  而生产库 492 个条目全在 cifs 上——那条规则会禁掉全部，实测 cifs 抽整轨只要 8 秒。
   *  任何人把规则改回"网络就禁"，这条立刻红。 */
  it("mountKind='lan' → waveformAvailable:true【cifs 不被误禁的回归锁】", async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ classify: () => 'lan' }).deps)
    expect(dto.mountKind).toBe('lan')
    expect(dto.waveformAvailable).toBe(true)
  })

  it("mountKind='local' → waveformAvailable:true", async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ classify: () => 'local' }).deps)
    expect(dto.mountKind).toBe('local')
    expect(dto.waveformAvailable).toBe(true)
  })

  it('三态逐一穷举：只有 cloud 一档为 false（不是"网络就禁"）', async () => {
    seedVerdict()
    const got: Record<string, boolean> = {}
    for (const kind of ['local', 'lan', 'cloud'] as MountKind[]) {
      got[kind] = (await dtoOf(makeDeps({ classify: () => kind }).deps)).waveformAvailable
    }
    expect(got).toEqual({ local: true, lan: true, cloud: false })
  })

  it('按**片源**判存储类型，不是按字幕文件（波形是从视频里抽的）', async () => {
    seedVerdict()
    const { deps, calls } = makeDeps()
    await dtoOf(deps)
    expect(calls.classify).toEqual([VIDEO])
  })
})

describe('铁律②回归锁：DTO 键集合封闭', () => {
  /** 键集合断言而不是逐个 `not.toHaveProperty`：将来有人往 DTO 里加字段，这条立刻红，
   *  而逐个断言只能挡住我们此刻想到的那四个名字。 */
  it('DTO 恰好只有六个键——内部诊断字段一个都不漏出去', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps().deps)
    expect(Object.keys(dto).sort()).toEqual([
      'durationMs', 'itemId', 'mountKind', 'ours', 'reference', 'waveformAvailable',
    ])
  })

  it('响应体不含 score / offsetMs / referenceTier / detail（库里有、DTO 里没有）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps().deps)
    // 先证明这些值确实存在于库里——否则这条断言可能只是在测一个空库
    const row = repo.getVerifyResult('e1')!
    expect(row.score).toBe(0.93)
    expect(row.offset_ms).toBe(2400)
    expect(row.reference_tier).toBe('embedded')
    expect(row.detail).not.toBeNull()
    for (const forbidden of ['score', 'offsetMs', 'offset_ms', 'referenceTier', 'reference_tier', 'detail', 'tier']) {
      expect(dto).not.toHaveProperty(forbidden)
    }
  })

  it('JSON 序列化后也不含任何内部字段名（端到端的字符串级回归锁）', async () => {
    seedVerdict()
    const raw = JSON.stringify(await dtoOf(makeDeps().deps))
    for (const forbidden of ['score', 'offsetMs', 'offset_ms', 'referenceTier', 'reference_tier', 'detail']) {
      expect(raw).not.toContain(forbidden)
    }
  })

  it('参考源的 tier 与 detail 不随 cues 一起漏进块里', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps().deps)
    for (const block of [...dto.reference, ...dto.ours]) {
      expect(Object.keys(block).sort()).toEqual(['endMs', 'startMs', 'text'])
    }
  })
})

describe('台词文字：截断口径', () => {
  it(`超长单条截断到 ${MAX_CUE_TEXT_CHARS} 字（歌词轨整段 staff roll / ASS 特效文本的长尾）`, async () => {
    seedVerdict()
    const long = 'x'.repeat(MAX_CUE_TEXT_CHARS + 500)
    const dto = await dtoOf(makeDeps({ loadCues: async () => [cue(0, 1000, long)] }).deps)
    expect(dto.ours[0].text).toHaveLength(MAX_CUE_TEXT_CHARS)
  })

  it('不加省略号——排版是前端的决定，后端塞进数据会让前端换样式时无从下手', async () => {
    seedVerdict()
    const long = 'x'.repeat(MAX_CUE_TEXT_CHARS + 10)
    const dto = await dtoOf(makeDeps({ loadCues: async () => [cue(0, 1000, long)] }).deps)
    expect(dto.ours[0].text).not.toContain('…')
    expect(dto.ours[0].text).not.toContain('...')
  })

  it('正常长度台词原样保留，不被无故截短', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps().deps)
    expect(dto.ours[0].text).toBe('这是第一句')
  })

  it('恰好等于上限的台词不被截（边界不多减一）', async () => {
    seedVerdict()
    const exact = 'y'.repeat(MAX_CUE_TEXT_CHARS)
    const dto = await dtoOf(makeDeps({ loadCues: async () => [cue(0, 1000, exact)] }).deps)
    expect(dto.ours[0].text).toBe(exact)
  })

  it('文本两端空白被 trim（SRT 多行 join 后常留尾空格）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ loadCues: async () => [cue(0, 1000, '  台词  ')] }).deps)
    expect(dto.ours[0].text).toBe('台词')
  })

  it('空文本/纯空白 → null，与"参考源没有文本"合流成同一个前端分支', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({
      loadCues: async () => [cue(0, 1000, '   '), cue(2000, 3000, '')],
    }).deps)
    expect(dto.ours.map((b) => b.text)).toEqual([null, null])
  })

  it('时间戳不被截断/改动——它是定位坐标，动它就画错图', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({
      loadCues: async () => [cue(1_234_567, 1_236_789, '末尾一句')],
    }).deps)
    expect(dto.ours[0]).toEqual({ startMs: 1_234_567, endMs: 1_236_789, text: '末尾一句' })
  })
})

describe('无参考源 → 200 + 空数组（不是 404）', () => {
  /** 裁决理由（见 buildCompareDTO 文件内论证）：① 404 会说谎——资源存在，缺的只是"拿什么比"；
   *  ② 单轨视图本身有用（看自己那条字幕哪里有 5 分钟空白）；③ 无参考源是**最常见**的一档，
   *  把最常见的情形做成错误响应等于让前端每天走几百次错误分支。 */
  it('findReference 返回 null → reference 是空数组，端点仍然 200', async () => {
    seedVerdict()
    const r = await buildCompareDTO(makeDeps({ findReference: async () => null }).deps, 'e1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dto.reference).toEqual([])
  })

  it('无参考源时待检轨照常完整返回（单轨视图有用）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ findReference: async () => null }).deps)
    expect(dto.ours).toHaveLength(2)
    expect(dto.ours[0].text).toBe('这是第一句')
  })

  it('无参考源时 waveformAvailable / mountKind 仍如实回报（两者与参考源无关）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ findReference: async () => null, classify: () => 'lan' }).deps)
    expect(dto.waveformAvailable).toBe(true)
    expect(dto.mountKind).toBe('lan')
  })

  it('参考源有 cues 但为空数组 → 同样是空 reference，不炸', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ findReference: async () => refSource([]) }).deps)
    expect(dto.reference).toEqual([])
  })

  it('text 为 null 的参考块能如实带出（将来 VAD 参考源没有文字）', async () => {
    seedVerdict()
    // VAD 那天参考源会给出没有文本的时段。用空文本模拟同一条通道，
    // 证明 DTO 的 null 分支是活的而不是纸面类型。
    const dto = await dtoOf(makeDeps({
      findReference: async () => refSource([cue(1000, 2000, ''), cue(3000, 4000, '')]),
    }).deps)
    expect(dto.reference).toEqual([
      { startMs: 1000, endMs: 2000, text: null },
      { startMs: 3000, endMs: 4000, text: null },
    ])
  })
})

describe('durationMs（时间轴坐标范围）', () => {
  it('ffprobe 探到 → 用它（秒 → 毫秒）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ probeDuration: async () => 1424 }).deps)
    expect(dto.durationMs).toBe(1_424_000)
  })

  it('探不到（null）→ 拿字幕最后一条 cue 兜底，端点不失败', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ probeDuration: async () => null }).deps)
    // 两条轨的最大 endMs 是参考轨的 7400；带 1.05 排版余量
    expect(dto.durationMs).toBe(Math.round(7400 * 1.05))
  })

  it('探到 0（畸形容器）→ 视作"没测出来"，走兜底（0 会让前端算块宽时除零）', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({ probeDuration: async () => 0 }).deps)
    expect(dto.durationMs).toBeGreaterThan(0)
  })

  it('兜底取两条轨的最大值——参考轨更长时不会被画到图外面去', async () => {
    seedVerdict()
    const dto = await dtoOf(makeDeps({
      probeDuration: async () => null,
      loadCues: async () => [cue(0, 1000, 'a')],
      findReference: async () => refSource([cue(0, 99_000, 'ED 曲字幕')]),
    }).deps)
    expect(dto.durationMs).toBe(Math.round(99_000 * 1.05))
  })

  it('按**片源**路径探时长', async () => {
    seedVerdict()
    const { deps, calls } = makeDeps()
    await dtoOf(deps)
    expect(calls.probeDuration).toEqual([VIDEO])
  })

  describe('resolveDurationMs（单独暴露，便于钉兜底口径）', () => {
    it('probe 命中时压根不看字幕轨', async () => {
      expect(await resolveDurationMs({ probeDuration: async () => 60 }, VIDEO, [])).toBe(60_000)
    })

    it('probe 为 null 且两条轨都空 → 0（没有可用坐标，不是抛错）', async () => {
      expect(await resolveDurationMs({ probeDuration: async () => null }, VIDEO, [])).toBe(0)
    })

    it('负数时长（不该出现但守住）→ 走兜底', async () => {
      const r = await resolveDurationMs(
        { probeDuration: async () => -5 }, VIDEO,
        [[{ startMs: 0, endMs: 1000, text: 'a' }]],
      )
      expect(r).toBe(1050)
    })
  })
})

describe('错误路径', () => {
  it('从未检测过 → 404（不知道该画哪个字幕文件）', async () => {
    const r = await buildCompareDTO(makeDeps().deps, 'e1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(404)
  })

  it('itemId 不存在于库 → 404', async () => {
    seedVerdict('nope')
    const r = await buildCompareDTO(makeDeps().deps, 'nope')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(404)
  })

  it('有结论但 item 行已被删（磁盘文件消失）→ 404，不拿空路径去 spawn ffmpeg', async () => {
    seedVerdict()
    db.prepare(`DELETE FROM episodes WHERE id = 'e1'`).run()
    const { deps, calls } = makeDeps()
    const r = await buildCompareDTO(deps, 'e1')
    expect(r.ok).toBe(false)
    expect(calls.findReference).toEqual([])
    expect(calls.probeDuration).toEqual([])
  })

  it('待检字幕读不出来 → 500（库与磁盘不一致，不是 404：itemId 是对的）', async () => {
    seedVerdict()
    const r = await buildCompareDTO(makeDeps({ loadCues: async () => null }).deps, 'e1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(500)
  })

  it('待检字幕解析出 0 条 cue → 500（没有可画的轨，与读失败是同一件事）', async () => {
    seedVerdict()
    const r = await buildCompareDTO(makeDeps({ loadCues: async () => [] }).deps, 'e1')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(500)
  })

  it('待检轨读不出时不去找参考源/不探时长（白跑几分钟的 ffmpeg）', async () => {
    seedVerdict()
    const { deps, calls } = makeDeps({ loadCues: async () => null })
    await buildCompareDTO(deps, 'e1')
    expect(calls.findReference).toEqual([])
    expect(calls.probeDuration).toEqual([])
  })

  it('失败响应体只有人话 error，不带内部 detail', async () => {
    seedVerdict()
    const r = await buildCompareDTO(makeDeps({ loadCues: async () => null }).deps, 'e1')
    if (r.ok) return
    expect(Object.keys(r).sort()).toEqual(['error', 'ok', 'status'])
    expect(r.error).not.toContain('track 3')
  })
})

describe('纯读纪律（铁律④）', () => {
  it('画一张对照图不往库里写任何行——不落新结论、不改 verdict', async () => {
    seedVerdict()
    const before = repo.getVerifyResult('e1')
    await dtoOf(makeDeps().deps)
    expect(repo.getVerifyResult('e1')).toEqual(before)
  })

  it('未检测过的条目被查询后，库里也不会凭空多出一行', async () => {
    await buildCompareDTO(makeDeps().deps, 'e1')
    expect(repo.getVerifyResult('e1')).toBeNull()
  })

  it('依赖集合封闭——新增副作用依赖会在这里被看见', () => {
    expect(Object.keys(makeDeps().deps).sort()).toEqual([
      'canWaveform', 'classify', 'findReference', 'lib', 'loadCues', 'probeDuration', 'repo',
    ])
  })
})
