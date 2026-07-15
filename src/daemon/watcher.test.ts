import { describe, it, expect, vi } from 'vitest'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Watcher, type WatcherDeps } from './watcher.js'
import { JellyfinSessionsSchema, JellyfinItemsResponseSchema } from '../adapters/players/jellyfin.js'
import { PrefetchQueue } from './queue.js'

const sessions = JellyfinSessionsSchema.parse(JSON.parse(readFileSync('fixtures/jellyfin/sessions-playing.json', 'utf8')))
const item = JellyfinItemsResponseSchema.parse(JSON.parse(readFileSync('fixtures/jellyfin/items-detail.json', 'utf8'))).Items[0]
// 保证确定性：无字幕流版本
const cleanItem = { ...item, MediaStreams: (item.MediaStreams ?? []).filter(s => s.Type !== 'Subtitle') }

function makeDeps(over: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    jellyfin: {
      getSessions: vi.fn(async () => sessions),
      getItem: vi.fn(async () => cleanItem),
      refreshItem: vi.fn(async () => {}),
      getRecentItems: vi.fn(async () => [cleanItem]),
      getChineseTitle: vi.fn(async () => null),
    },
    runJob: vi.fn(async () => ({ decision: 'download', subtitlePath: '/m/x.zh-Hans.ass', journalPath: '/j/decision.json' })),
    verify: vi.fn(async () => true),
    pathMappings: [],
    pathExists: () => true,
    isWritable: () => true,
    treatPgsAsMissing: true,
    cooldownMinutes: 30,
    mediaRoots: [],
    targetLanguages: ['zh'],
    skipCacheMinutes: 5,
    queue: new PrefetchQueue(join(mkdtempSync(join(tmpdir(), 'wq-')), 'q.json')),
    log: () => {},
    onRunComplete: vi.fn(),
    ...over,
  }
}

describe('Watcher.tick', () => {
  it('skips with a mapping hint (no quota burn) when media dir is not accessible', async () => {
    const logs: string[] = []
    const deps = makeDeps({ pathExists: () => false, log: m => logs.push(m) })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/MEDIA_PATH_MAPPINGS/)
  })

  it('skips (no runJob) when media dir is not writable', async () => {
    const logs: string[] = []
    const runJob = vi.fn(async () => ({ decision: 'download' as const, subtitlePath: '/m/x.zh-Hans.ass', journalPath: '/j/decision.json' }))
    const deps = makeDeps({ isWritable: () => false, runJob, log: m => logs.push(m) })
    const w = new Watcher(deps)
    await w.tick()
    expect(runJob).not.toHaveBeenCalled()
    expect(logs.some(m => m.includes('not writable'))).toBe(true)
  })

  it('triggers a job for a playing item without Chinese subs, then refresh+verify', async () => {
    const deps = makeDeps()
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.jellyfin.getItem).toHaveBeenCalled()
    expect(deps.runJob).toHaveBeenCalledTimes(1)
    expect(deps.jellyfin.refreshItem).toHaveBeenCalled()
    expect(deps.verify).toHaveBeenCalled()
  })

  it('applies cooldown after processing (second tick is a no-op)', async () => {
    const deps = makeDeps()
    const w = new Watcher(deps)
    await w.tick()
    await w.tick()
    expect(deps.runJob).toHaveBeenCalledTimes(1)
  })

  it('skips when item already has usable Chinese subtitle', async () => {
    const withZh = { ...cleanItem, MediaStreams: [{ Type: 'Subtitle', Language: 'zh-hans', Codec: 'subrip', IsExternal: true }] }
    const deps = makeDeps({ jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => withZh), refreshItem: vi.fn(async () => {}), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
  })

  it('skips non-triggerable item types', async () => {
    const trailer = { ...cleanItem, Type: 'Trailer' }
    const deps = makeDeps({ jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => trailer), refreshItem: vi.fn(async () => {}), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
  })

  it('dedupes concurrent processing of the same item (in-flight)', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runJob = vi.fn(async () => { await gate; return { decision: 'download', journalPath: 'j' } })
    const deps = makeDeps({ runJob })
    const w = new Watcher(deps)
    const t1 = w.tick()
    const t2 = w.tick()
    release()
    await Promise.all([t1, t2])
    expect(runJob).toHaveBeenCalledTimes(1)
  })

  it('does not refresh when job decides no_safe_match', async () => {
    const deps = makeDeps({ runJob: vi.fn(async () => ({ decision: 'no_safe_match', journalPath: 'j' })) })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.jellyfin.refreshItem).not.toHaveBeenCalled()
  })

  it('a failing job does not throw out of tick', async () => {
    const deps = makeDeps({ runJob: vi.fn(async () => { throw new Error('boom') }) })
    const w = new Watcher(deps)
    await expect(w.tick()).resolves.toBeUndefined()
  })

  it('a failing sessions poll does not throw out of tick', async () => {
    const deps = makeDeps({ jellyfin: { getSessions: vi.fn(async () => { throw new Error('conn refused') }), getItem: vi.fn(), refreshItem: vi.fn(), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await expect(w.tick()).resolves.toBeUndefined()
  })

  it('busy() reflects in-flight work', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runJob = vi.fn(async () => { await gate; return { decision: 'download', journalPath: 'j' } })
    const w = new Watcher(makeDeps({ runJob }))
    const t = w.tick()
    // tick 在等 runJob 时应报告 busy
    await new Promise(r => setTimeout(r, 10))
    expect(w.busy()).toBe(true)
    release()
    await t
    expect(w.busy()).toBe(false)
  })

  it('refuses items whose media dir is outside configured roots', async () => {
    const logs: string[] = []
    const deps = makeDeps({ mediaRoots: ['/some/other/root'], log: m => logs.push(m) })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
    expect(logs.join('\n')).toMatch(/MEDIA_ROOTS/)
  })

  it('ignores paused sessions', async () => {
    const paused = sessions.map(s => ({ ...s, PlayState: { IsPaused: true } }))
    const deps = makeDeps({ jellyfin: { getSessions: vi.fn(async () => paused), getItem: vi.fn(), refreshItem: vi.fn(), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.jellyfin.getItem).not.toHaveBeenCalled()
  })

  it('prunes expired cooldown entries on tick', async () => {
    const deps = makeDeps({ cooldownMinutes: -1 }) // 立即过期
    const w = new Watcher(deps)
    await w.tick() // 处理 + 设置已过期的冷却
    await w.tick() // 清扫后应再次处理
    expect(deps.runJob).toHaveBeenCalledTimes(2)
  })

  it('skips Chinese-origin items when configured', async () => {
    const zhItem = { ...cleanItem, ProductionLocations: ['China'] }
    const deps = makeDeps({ targetLanguages: ['zh'], jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => zhItem), refreshItem: vi.fn(async () => {}), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).not.toHaveBeenCalled()
  })

  it('empty originSkipLanguages (SKIP_CHINESE_ORIGIN=false compat) processes Chinese-origin items — the gate keys on originSkipLanguages, not targetLanguages', async () => {
    const zhItem = { ...cleanItem, ProductionLocations: ['China'] }
    const deps = makeDeps({ targetLanguages: ['zh'], originSkipLanguages: [], jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => zhItem), refreshItem: vi.fn(async () => {}), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).toHaveBeenCalled()
  })

  it('skip-cache suppresses repeated getItem for has-subtitle items', async () => {
    const withZh = { ...cleanItem, MediaStreams: [{ Type: 'Subtitle', Language: 'zh-hans', Codec: 'subrip', IsExternal: true }] }
    const getItem = vi.fn(async () => withZh)
    const deps = makeDeps({ skipCacheMinutes: 5, jellyfin: { getSessions: vi.fn(async () => sessions), getItem, refreshItem: vi.fn(async () => {}), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await w.tick(); await w.tick(); await w.tick()
    expect(getItem).toHaveBeenCalledTimes(1)
  })
})

describe('arrivals & queue consumption', () => {
  it('arrivalsTick enqueues new items past the watermark', async () => {
    const deps = makeDeps()
    const withDate = { ...cleanItem, DateCreated: '2026-07-06T12:00:00Z' }
    deps.jellyfin.getRecentItems = vi.fn(async () => [withDate])
    const w = new Watcher(deps)
    await w.arrivalsTick()
    expect(deps.queue.size().pending).toBe(1)
    expect(deps.queue.watermark()).toBe('2026-07-06T12:00:00Z')
    await w.arrivalsTick() // 水位线之后不再重复入队
    expect(deps.queue.size().pending).toBe(1)
  })

  it('consumeTick processes one due entry and removes it on success', async () => {
    const deps = makeDeps()
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    const w = new Watcher(deps)
    await w.consumeTick()
    expect(deps.runJob).toHaveBeenCalledTimes(1)
    expect(deps.queue.size().pending).toBe(0)
  })

  it('consumeTick records failure with decay on no_safe_match', async () => {
    const deps = makeDeps({ runJob: vi.fn(async () => ({ decision: 'no_safe_match', journalPath: 'j' })) })
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    const w = new Watcher(deps)
    await w.consumeTick()
    expect(deps.queue.size().pending).toBe(1) // 仍在队列，等衰减到期
    expect(deps.queue.due()).toBeUndefined()  // 未到期
  })

  it('consumeTick yields when a playback job is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runJob = vi.fn(async () => { await gate; return { decision: 'download', journalPath: 'j' } })
    const deps = makeDeps({ runJob })
    deps.queue.upsert('queued-item', 'Q')
    const w = new Watcher(deps)
    const playing = w.tick()            // 播放任务在途
    await new Promise(r => setTimeout(r, 10))
    await w.consumeTick()               // 应让路
    expect(runJob).toHaveBeenCalledTimes(1) // 只有播放那一次
    release(); await playing
  })

  it('playback of a dormant item activates and bypasses negative cache', async () => {
    const deps = makeDeps()
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    for (let i = 0; i < 5; i++) deps.queue.recordFailure(cleanItem.Id)
    expect(deps.queue.dormantFor(cleanItem.Id)).toBe(true)
    const w = new Watcher(deps)
    await w.tick()
    expect(deps.runJob).toHaveBeenCalledWith(expect.anything(), expect.anything(), cleanItem.Id, expect.objectContaining({ bypassNegativeCache: true }))
    expect(deps.queue.dormantFor(cleanItem.Id)).toBe(false)
  })

  it('reports run completion with source via onRunComplete', async () => {
    const onRunComplete = vi.fn()
    const deps = makeDeps({ onRunComplete })
    const w = new Watcher(deps)
    await w.tick()
    expect(onRunComplete).toHaveBeenCalledWith(expect.objectContaining({
      itemId: cleanItem.Id,
      name: cleanItem.Name,
      source: 'playback',
      result: expect.objectContaining({ decision: 'download' }),
    }))
  })

  it('reports queue-source runs', async () => {
    const onRunComplete = vi.fn()
    const deps = makeDeps({ onRunComplete })
    deps.queue.upsert(cleanItem.Id, cleanItem.Name)
    const w = new Watcher(deps)
    await w.consumeTick()
    expect(onRunComplete).toHaveBeenCalledWith(expect.objectContaining({
      source: 'queue',
      result: expect.objectContaining({ decision: 'download' }),
    }))
  })

  it('prunes journals when the day changes', async () => {
    const pruneJournals = vi.fn()
    const deps = makeDeps({ pruneJournals })
    const w = new Watcher(deps)
    await w.tick()
    await w.tick() // 同一天只清一次
    expect(pruneJournals).toHaveBeenCalledTimes(1)
  })

  it('reports real journalPath and stats even when refreshItem throws', async () => {
    const onRunComplete = vi.fn()
    const refreshItem = vi.fn(async () => { throw new Error('jellyfin refused') })
    const realResult = { decision: 'download', subtitlePath: '/m/x.ass', journalPath: '/j/decision.json', stats: { durationMs: 1000, llmCalls: 2, apiCalls: 3 } }
    const deps = makeDeps({ onRunComplete, runJob: vi.fn(async () => realResult), jellyfin: { getSessions: vi.fn(async () => sessions), getItem: vi.fn(async () => cleanItem), refreshItem, getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    await expect(w.tick()).resolves.toBeUndefined()
    expect(onRunComplete).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({ decision: 'download', journalPath: '/j/decision.json', stats: realResult.stats })
    }))
  })

  it('inFlightItems() reports currently-processing items with names', async () => {
    // 用一个会挂起的 runJob 观察 in-flight 窗口
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const runJob = vi.fn(async () => { await gate; return { decision: 'download', journalPath: '/j', stats: { durationMs: 1, llmCalls: 0, apiCalls: 0 } } })
    const getItem = vi.fn(async () => ({ ...cleanItem, Id: 'x1', Name: 'Overflow S1E1' }))
    const deps = makeDeps({ runJob, jellyfin: { getSessions: vi.fn(async () => sessions), getItem, refreshItem: vi.fn(async () => {}), getRecentItems: vi.fn(async () => [cleanItem]), getChineseTitle: vi.fn(async () => null) } })
    const w = new Watcher(deps)
    const p = (w as any).maybeProcess('x1', 'queue')
    // 让出事件循环，等 maybeProcess 进入 runJob 挂起
    await new Promise(r => setTimeout(r, 0))
    const items = w.inFlightItems()
    expect(items).toEqual([{ itemId: 'x1', name: 'Overflow S1E1', source: 'queue' }])
    release(); await p
    expect(w.inFlightItems()).toEqual([])
  })
})

describe('Watcher.consumeTick head-of-line', () => {
  it('removes a queued item that no longer needs subtitles, so the queue advances', async () => {
    const queue = new PrefetchQueue(join(mkdtempSync(join(tmpdir(), 'wq-hol-')), 'q.json'))
    queue.upsert('subbed-1', 'Show.S01E01')   // enqueued first → oldest → due()[0]
    queue.upsert('needy-2', 'Show.S01E02')
    // subbed-1 now already has a Chinese sub → needsChineseSubtitle=false → skipped at consume
    const subbedItem = { ...cleanItem, Id: 'subbed-1', MediaStreams: [{ Type: 'Subtitle', Language: 'zh-Hans', IsExternal: true, Codec: 'ass' }] }
    const runJob = vi.fn(async () => ({ decision: 'download' as const, subtitlePath: '/m/x.zh-Hans.ass', journalPath: '/j/decision.json' }))
    const deps = makeDeps({
      queue,
      runJob,
      jellyfin: {
        getSessions: vi.fn(async () => []),
        getItem: vi.fn(async (id: string) => (id === 'subbed-1' ? subbedItem : cleanItem)),
        refreshItem: vi.fn(async () => {}),
        getRecentItems: vi.fn(async () => []),
        getChineseTitle: vi.fn(async () => null),
      },
    })
    const w = new Watcher(deps)
    await w.consumeTick()               // picks due()[0] = subbed-1, finds it already subbed
    expect(runJob).not.toHaveBeenCalled()        // it was skipped, not processed
    expect(queue.size().pending).toBe(1)          // subbed-1 REMOVED; needy-2 remains
    expect(queue.due()?.itemId).toBe('needy-2')   // queue advanced past the skipped item
  })
})
