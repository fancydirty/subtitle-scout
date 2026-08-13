// web/src/notifications/notifText.test.ts：纯函数层的用例。
//
// 这一层没有 DOM、没有 fetch，所以判据天生是值——不存在 Task ⑤ 那种"源码级断言被行尾
// 注释喂饱"的可能。但仍有两个真实的假绿形态，下面逐条盯着：
//  ① **恒真命题**（Task ⑧ 的教训）：喂已经排好序的输入去断言"输出有序"，删掉 sort 也绿。
//     → 分桶那组一律喂**乱序**输入。
//  ② **常量重述**：断言 groupKey 的实现（`a + '/' + b`）等于自己重写一遍那个表达式。
//     → 改成断言它与**后端聚合键的口径**一致（-1 占位、季号参与、同 work 不同季不撞）。
import { describe, it, expect } from 'vitest'
import {
  bucketByDay, dayOffset, formatClock, formatDayStamp, formatEpisodes, groupKey,
} from './notifText.js'
import type { FoundGroupDTO } from '../api/types.js'

const g = (over: Partial<FoundGroupDTO> = {}): FoundGroupDTO => ({
  workId: 'tmdb:1', title: 'W', season: 1, episodes: [1], latestAt: 0, via: 'fetch', mediaType: 'tv', ...over,
})

// 固定一个本地时刻做基准：2026-08-12 14:30 本地。用 Date 构造器（本地时区）而不是
// ISO 串（UTC）——本模块的分桶口径就是**本地日历日**，用 UTC 造基准会让用例在
// 非 UTC 机器上飘。
const NOW = new Date(2026, 7, 12, 14, 30, 0).getTime()
const DAY = 86_400_000

describe('groupKey：React key（FoundGroup 没有稳定行 id，只能拼）', () => {
  it('与后端聚合键同形：workId/season，电影用 -1 占位', () => {
    // 后端 notificationsRepo:127 是 `${r.workId}/${r.season ?? -1}`，唯一索引是
    // ON CONFLICT(work_id, ifnull(season,-1), …)。三处必须同形。
    expect(groupKey({ workId: 'tmdb:1396', season: 1 })).toBe('tmdb:1396/1')
    expect(groupKey({ workId: 'tmdb:550', season: null })).toBe('tmdb:550/-1')
  })

  it('同一作品的不同季**不撞键**（撞了会让 S01 与 S02 在 React 眼里是同一行）', () => {
    expect(groupKey({ workId: 'tmdb:1', season: 1 })).not.toBe(groupKey({ workId: 'tmdb:1', season: 2 }))
  })

  it('电影（null）与真实季号 -1 之外的任何季都不撞', () => {
    const movie = groupKey({ workId: 'tmdb:1', season: null })
    for (const s of [0, 1, 2, 99]) {
      expect(groupKey({ workId: 'tmdb:1', season: s })).not.toBe(movie)
    }
  })

  it('不同作品不撞（哪怕季号相同）', () => {
    expect(groupKey({ workId: 'a', season: 1 })).not.toBe(groupKey({ workId: 'b', season: 1 }))
  })

  it('一批真实数据里 key 两两唯一——React 的 key 唯一性是硬要求', () => {
    const rows = [
      { workId: 'tmdb:1', season: 1 }, { workId: 'tmdb:1', season: 2 },
      { workId: 'tmdb:2', season: 1 }, { workId: 'tmdb:3', season: null },
    ]
    expect(new Set(rows.map(groupKey)).size).toBe(rows.length)
  })
})

describe('formatEpisodes：集号排版（连号折叠）', () => {
  it('电影/空数组 → 空串（调用方据此不渲染那一段）', () => {
    expect(formatEpisodes([])).toBe('')
  })

  it('单集 → 裸数字', () => {
    expect(formatEpisodes([3])).toBe('3')
  })

  it('离散集号 → 斜杠分隔（R-F3 原文的「第 3/5/7 集」）', () => {
    expect(formatEpisodes([3, 5, 7])).toBe('3 / 5 / 7')
  })

  it('三个及以上连号 → 折叠成区间', () => {
    expect(formatEpisodes([1, 2, 3])).toBe('1–3')
    expect(formatEpisodes([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe('1–10')
  })

  it('恰好两个连号**不折叠**（区间号在两项时是噪音）', () => {
    expect(formatEpisodes([3, 4])).toBe('3 / 4')
  })

  it('混合：连号段与离散号并存', () => {
    expect(formatEpisodes([1, 2, 3, 5, 7, 8, 9])).toBe('1–3 / 5 / 7–9')
  })

  it('整季 24 集折叠成一段——不折叠的话一条通知占满一屏，而 R-F3 不做已读、用户无从清理', () => {
    const full = Array.from({ length: 24 }, (_, i) => i + 1)
    const out = formatEpisodes(full)
    expect(out).toBe('1–24')
    // 长度判据：真的短了（逐个列出来是 100+ 字符）
    expect(out.length).toBeLessThan(10)
    expect(full.join(' / ').length).toBeGreaterThan(80)
  })

  it('区间两端都是**真实存在**的集号（折叠不许发明数字）', () => {
    // [1,2,3,10,11,12] 绝不许输出 '1–12'（中间 4..9 并不存在）
    expect(formatEpisodes([1, 2, 3, 10, 11, 12])).toBe('1–3 / 10–12')
  })

  it('用 en dash（–）不是 hyphen（-）', () => {
    expect(formatEpisodes([1, 2, 3])).toContain('–')
    expect(formatEpisodes([1, 2, 3])).not.toContain('-')
  })
})

describe('dayOffset：按**日历日**算，不是按 24 小时', () => {
  it('同一天的任何时刻 → 0', () => {
    expect(dayOffset(new Date(2026, 7, 12, 0, 0, 1).getTime(), NOW)).toBe(0)
    expect(dayOffset(new Date(2026, 7, 12, 23, 59, 59).getTime(), NOW)).toBe(0)
  })

  it('昨天 → 1（哪怕只差 3 小时）', () => {
    // 🔴 关键用例：凌晨 1 点看昨晚 23 点的成果。按 24 小时算是 0（"今天"），
    // 按日历日算是 1（"昨天"）——后者才符合人的直觉。
    const earlyMorning = new Date(2026, 7, 12, 1, 0, 0).getTime()
    const lastNight = new Date(2026, 7, 11, 23, 0, 0).getTime()
    expect(lastNight - earlyMorning).toBeGreaterThan(-3 * 3600_000)
    expect(dayOffset(lastNight, earlyMorning)).toBe(1)
  })

  it('六天前 → 6（一周窗的边界仍在桶内，前端不自己截断）', () => {
    expect(dayOffset(NOW - 6 * DAY, NOW)).toBe(6)
  })

  it('未来时刻（时钟回拨）clamp 到 0，不产生负桶', () => {
    expect(dayOffset(NOW + 5 * DAY, NOW)).toBe(0)
  })
})

describe('formatDayStamp / formatClock：mono 读数（本地时区、不翻译）', () => {
  it('MM-DD 补零', () => {
    expect(formatDayStamp(new Date(2026, 0, 5).getTime())).toBe('01-05')
    expect(formatDayStamp(new Date(2026, 10, 30).getTime())).toBe('11-30')
  })

  it('HH:MM 补零，24 小时制', () => {
    expect(formatClock(new Date(2026, 7, 12, 9, 5).getTime())).toBe('09:05')
    expect(formatClock(new Date(2026, 7, 12, 23, 59).getTime())).toBe('23:59')
    expect(formatClock(new Date(2026, 7, 12, 0, 0).getTime())).toBe('00:00')
  })
})

describe('bucketByDay：倒序流水（R-F3）——**喂乱序输入**，否则是恒真命题', () => {
  /** 乱序输入：故意把最旧的放第一个、最新的放中间。
   *  如果 bucketByDay 里的两个 sort 被删掉，输出顺序就会原样继承这个乱序 → 用例红。 */
  const shuffled: FoundGroupDTO[] = [
    g({ workId: 'old', season: 1, latestAt: NOW - 3 * DAY }),          // 3天前
    g({ workId: 'today-early', season: 1, latestAt: NOW - 6 * 3600_000 }), // 今天 08:30
    g({ workId: 'today-late', season: 2, latestAt: NOW - 600_000 }),   // 今天 14:20（最新）
    g({ workId: 'yesterday', season: 1, latestAt: NOW - 1 * DAY }),
  ]

  it('桶间倒序：今天 → 昨天 → 更早（输入是乱的，删掉桶间 sort 会红）', () => {
    const buckets = bucketByDay(shuffled, NOW)
    expect(buckets.map((b) => b.offset)).toEqual([0, 1, 3])
  })

  it('桶内倒序：同一天里最新的在最前（输入里 today-late 排在 today-early 之后）', () => {
    const buckets = bucketByDay(shuffled, NOW)
    expect(buckets[0]!.groups.map((x) => x.workId)).toEqual(['today-late', 'today-early'])
  })

  it('🔴 正序化会红：把输入按 latestAt 升序喂进去，输出仍必须是倒序', () => {
    const ascending = [...shuffled].sort((a, b) => a.latestAt - b.latestAt)
    const buckets = bucketByDay(ascending, NOW)
    expect(buckets.map((b) => b.offset)).toEqual([0, 1, 3])
    expect(buckets[0]!.groups.map((x) => x.workId)).toEqual(['today-late', 'today-early'])
    // 全局展平后 latestAt 严格递减——这是"倒序流水"最直接的可证伪形式
    const flat = buckets.flatMap((b) => b.groups.map((x) => x.latestAt))
    for (let i = 1; i < flat.length; i++) expect(flat[i]!).toBeLessThan(flat[i - 1]!)
  })

  it('**不做任何过滤**：进多少条出多少条（一周窗是后端读窗，前端再写一份必然漂移）', () => {
    // 故意混入一条"超过一周"的（后端不该给，但若给了，前端不许偷偷吞掉——
    // 吞掉的话后端读窗坏了没有任何人看得见）
    const withAncient = [...shuffled, g({ workId: 'ancient', season: 1, latestAt: NOW - 400 * DAY })]
    const total = bucketByDay(withAncient, NOW).reduce((n, b) => n + b.groups.length, 0)
    expect(total).toBe(withAncient.length)
  })

  it('空输入 → 空桶数组（不造一个假的"今天"空段）', () => {
    expect(bucketByDay([], NOW)).toEqual([])
  })

  it('stampAt 取桶内**最新**那条（乱序输入下先进来的未必最新）', () => {
    const buckets = bucketByDay(shuffled, NOW)
    expect(buckets[0]!.stampAt).toBe(NOW - 600_000)
  })

  it('同一天的多条聚到同一个桶（不是每条一个桶）', () => {
    const buckets = bucketByDay(shuffled, NOW)
    expect(buckets).toHaveLength(3)
    expect(buckets[0]!.groups).toHaveLength(2)
  })
})
