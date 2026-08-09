import { describe, it, expect } from 'vitest'
import {
  seriesId, episodeId, tmdbIdFromOwnId,
  translateItemId, translateFileKey, workIdFromTranslateItemId, fileKeyFromTranslateItemId,
} from './ownIds.js'
// C20 红线跑**真实的** seriesKeyOf（不复述它的逻辑）：要守的正是"两个模块的隐含契约还对得上"，
// 复述等于测试自己维护第二份实现，两份一漂移就是假绿。
import { seriesKeyOf } from './glossaryRepo.js'

describe('ownIds', () => {
  describe('seriesId', () => {
    it('形状 tmdb:<id>（movies 复用同一构造器，语义相同）', () => {
      expect(seriesId('209867')).toBe('tmdb:209867')
    })
  })

  describe('episodeId', () => {
    it('形状 tmdb:<id>/s<N>e<M>，不做零填充', () => {
      expect(episodeId('209867', 1, 2)).toBe('tmdb:209867/s1e2')
    })
    it('两位数季/集同样不零填充', () => {
      expect(episodeId('209867', 12, 34)).toBe('tmdb:209867/s12e34')
    })
    it('season/episode = 0 时原样嵌入（非法值判断不是本函数的事）', () => {
      expect(episodeId('1', 0, 0)).toBe('tmdb:1/s0e0')
    })
  })

  describe('tmdbIdFromOwnId', () => {
    it('从 series/movies 形状 (tmdb:<id>) 提取 id', () => {
      expect(tmdbIdFromOwnId('tmdb:209867')).toBe('209867')
    })
    it('从 episodes 形状 (tmdb:<id>/s<N>e<M>) 提取 id（丢弃季集段）', () => {
      expect(tmdbIdFromOwnId('tmdb:209867/s1e2')).toBe('209867')
      expect(tmdbIdFromOwnId('tmdb:209867/s12e34')).toBe('209867')
    })
    it('非自有 id 形状返回 null，不抛错（如遗留合成 id self-scan-trigger）', () => {
      expect(tmdbIdFromOwnId('self-scan-trigger')).toBeNull()
    })
    it('其他不合规输入同样返回 null：空串、纯前缀、多余段、缺 tmdb: 前缀', () => {
      expect(tmdbIdFromOwnId('')).toBeNull()
      expect(tmdbIdFromOwnId('tmdb:')).toBeNull()
      expect(tmdbIdFromOwnId('tmdb:1/s1e2/extra')).toBeNull()
      expect(tmdbIdFromOwnId('jellyfin-item-id-123')).toBeNull()
    })
    it('roundtrips with seriesId/episodeId constructors', () => {
      expect(tmdbIdFromOwnId(seriesId('42'))).toBe('42')
      expect(tmdbIdFromOwnId(episodeId('42', 3, 7))).toBe('42')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C20：TranslateTask.itemId 的精确形态，必须保 seriesKeyOf 可解。
//
// 这是 spec 里最阴的一条，因为它的失效**纯静默、测试抓不到**：
// spec 把 itemId 语义改成 `work_id + path`，但有个隐藏消费者——
// `translateWorker.tools.ts:346/663` 用 `seriesKeyOf(task.itemId)` 加载/保存**剧级术语表**，
// 而 `glossaryRepo.ts:46-49` 的实现假定形如 `tmdb:123/s1e2`：
//   `const idx = itemId.indexOf('/'); return idx > 0 ? itemId.slice(0, idx) : itemId`
// 若 itemId 改成含绝对路径（`/mnt/...` 开头）→ `indexOf('/') === 0` → `idx > 0` 为假 →
// **返回整个字符串** → 每个文件一个 glossary key。
//
// 后果（db.ts:353 注释记有实案）：同剧第 2 集拿不到第 1 集冻结的术语表 → 人名地名每集换译法
// （实案：同一模型同剧两 run 分别选出"东国 / 奥斯塔尼亚"）。功能"能跑"、字幕"能出"，
// 只是质量逐集漂移，没有任何断言会红。
//
// 故形态定为 `<work_id>/<稳定file标识>`，work_id 形如 `tmdb:123`（内无 `/`）——
// 于是第一个 `/` 恰好落在 work_id 之后，`seriesKeyOf` 原样可解、glossaryRepo 一行不用改。
// 下面的用例**端到端跑真实的 seriesKeyOf**（不是复述它的逻辑）：复述等于测试自己维护一份
// 实现，两份一漂移就是假绿，而这里要守的恰恰是"两个模块的隐含契约还对得上"。
// ─────────────────────────────────────────────────────────────────────────────
describe('translateItemId · C20 glossary key 可解性红线', () => {
  it('🔴🔴 用例 10：同剧两集命中同一 glossary key（C20 红线，跑真实 seriesKeyOf）', () => {
    // 这是全套改动里最 load-bearing 的一条断言。它一红，翻译质量就开始逐集漂移，
    // 而**不会有任何别的测试红**——这正是 C20 被标成"测试抓不到"的原因。
    const e1 = translateItemId('tmdb:123', '/mnt/media/TV/Spy x Family/S01E01.mkv')
    const e2 = translateItemId('tmdb:123', '/mnt/media/TV/Spy x Family/S01E02.mkv')
    expect(e1).not.toBe(e2)                             // 两集是两个不同的 item
    expect(seriesKeyOf(e1)).toBe(seriesKeyOf(e2))        // 但共享同一份剧级术语表
    expect(seriesKeyOf(e1)).toBe('tmdb:123')             // 且那个 key 就是 work_id 本身
  })

  it('🔴 用例 11：电影的 key 也可解（单文件作品，key = work_id）', () => {
    const m = translateItemId('tmdb:9', '/mnt/media/Movies/Shelby Oaks (2025)/movie.mkv')
    expect(seriesKeyOf(m)).toBe('tmdb:9')
  })

  it('🔴 路径里带 `/` 一律不许泄进第一段（seriesKeyOf 只切第一个 `/`）', () => {
    // 深层路径、路径里有空格/中文/括号/连字符——生产上的守备目录全是这些形状。
    // 只要 file 标识落在第一个 `/` **之后**，第一段就恒等于 work_id。
    const deep = translateItemId('tmdb:1', '/mnt/115/媒体库/电视剧/Show Name (2023)/Season 01/S01E05 - Title.mkv')
    expect(seriesKeyOf(deep)).toBe('tmdb:1')
  })

  it('🔴 同 work 不同季 → 仍是同一 key（术语表是剧级而非季级，跨季继承人名地名）', () => {
    const s1 = translateItemId('tmdb:123', '/mnt/media/Show/Season 01/E01.mkv')
    const s2 = translateItemId('tmdb:123', '/mnt/media/Show/Season 02/E01.mkv')
    expect(seriesKeyOf(s1)).toBe(seriesKeyOf(s2))
  })

  it('🔴 不同 work → 不同 key（术语表不许跨作品串味）', () => {
    // 反方向的灾难：若 file 标识没进 key（比如 itemId 就等于 work_id），两集会撞成同一个
    // itemId，job identity `translate:<itemId>` 随之相同 → 同剧第二集永远派不出活。
    // 而若 key 退化成常量，两部不相干的剧会共享术语表 → 张三的名字译法污染李四的剧。
    const a = translateItemId('tmdb:123', '/mnt/media/A/E01.mkv')
    const b = translateItemId('tmdb:456', '/mnt/media/B/E01.mkv')
    expect(seriesKeyOf(a)).not.toBe(seriesKeyOf(b))
  })

  it('🔴 itemId 第一个字符不是 `/`（C20 的失效机制本身）', () => {
    // 直接钉住失效机制而不只是钉后果：`indexOf('/') === 0` 时 `idx > 0` 为假，
    // seriesKeyOf 返回整串。这条让"有人把 itemId 改成裸路径"在形态层面就红，
    // 不必依赖读者自己推导出后果。
    const id = translateItemId('tmdb:123', '/mnt/media/Show/E01.mkv')
    expect(id.startsWith('/')).toBe(false)
    expect(id.indexOf('/')).toBeGreaterThan(0)
  })

  it('🔴 同一 (work, path) 稳定可重现（跨进程/跨轮不许漂）', () => {
    // job identity 是 `translate:<itemId>`（translateWorkerTask 的 upsert 键）。
    // itemId 若含时间戳/随机量，每轮都会 upsert 出一行新 job → 同一集被反复翻译，
    // 付费 LLM 热循环。稳定性是 identity 语义的前提。
    const p = '/mnt/media/Show/E01.mkv'
    expect(translateItemId('tmdb:123', p)).toBe(translateItemId('tmdb:123', p))
  })

  it('🔴 work_id 与 path 都能从 itemId 反解回来（可追溯，不是单向哈希掉信息）', () => {
    // 排障需要：从 job payload 的 itemId 看出"这是哪部剧的哪个文件"。
    // 同时这条也钉住"file 标识不是把 path 整个 base64 掉"——那样第一段仍对，
    // 但运维在库里看到的 itemId 完全不可读（jobs 表里的 identity 是人要读的）。
    const p = '/mnt/media/Show/E01.mkv'
    const id = translateItemId('tmdb:123', p)
    expect(workIdFromTranslateItemId(id)).toBe('tmdb:123')
    expect(fileKeyFromTranslateItemId(id)).toBe(translateFileKey(p))
  })

  it('🔴 不同 path 的 file 标识不相撞（同一作品下两个文件不许折叠成一个 item）', () => {
    // 若 file 标识只取 basename，`Season 01/E01.mkv` 与 `Season 02/E01.mkv` 会撞成同一个
    // itemId → job identity 相同 → 第二季第一集永远派不出活（静默少翻一批文件）。
    const a = translateFileKey('/mnt/media/Show/Season 01/E01.mkv')
    const b = translateFileKey('/mnt/media/Show/Season 02/E01.mkv')
    expect(a).not.toBe(b)
  })

  it('🔴 file 标识内不含 `/`（否则 itemId 里会出现第二个 `/`，反解歧义）', () => {
    const k = translateFileKey('/mnt/media/Show/Season 01/E01.mkv')
    expect(k.includes('/')).toBe(false)
  })
})
