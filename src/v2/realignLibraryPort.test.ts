import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRealignLibraryPort } from './realignLibraryPort.js'
import { verifyRealignedCounts, waitForJellyfinIdle } from './realignExecutor.js'
import { ingestLock } from './ingest.js'
import { openDb } from './db.js'
import { LibraryRepo } from './libraryRepo.js'

function mkLib() {
  const db = openDb(':memory:')
  return new LibraryRepo(db)
}

describe('makeRealignLibraryPort · getItem', () => {
  it('已知 series id → 返回 Name/ProductionYear/ProviderIds.Tmdb 三个被消费的字段', async () => {
    const lib = mkLib()
    lib.upsertSeries({ id: 'tmdb:120089', name: 'Spy x Family', year: 2022 })
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest: vi.fn() })

    const item = await port.getItem('tmdb:120089')

    expect(item.Name).toBe('Spy x Family')
    expect(item.ProductionYear).toBe(2022)
    expect(item.ProviderIds?.Tmdb).toBe('120089')
  })

  it('未知 id（库里没有这条 series 行）→ 抛错，不返回伪造数据', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest: vi.fn() })

    await expect(port.getItem('tmdb:no-such-id')).rejects.toThrow()
  })
})

describe('makeRealignLibraryPort · getItemsPage', () => {
  let root: string
  afterEach(() => { /* mkdtempSync dirs are in os tmp, left for OS cleanup like sibling tests */ })

  it('走盘找到 Season NN 目录下的视频文件，解析出 ParentIndexNumber', async () => {
    root = mkdtempSync(join(tmpdir(), 'realign-lib-port-'))
    const showDir = join(root, 'Spy x Family (2022) [tmdbid-120089]')
    mkdirSync(join(showDir, 'Season 01'), { recursive: true })
    mkdirSync(join(showDir, 'Season 02'), { recursive: true })
    writeFileSync(join(showDir, 'Season 01', 'ep1.mkv'), 'x')
    writeFileSync(join(showDir, 'Season 02', 'ep2.mkv'), 'x')

    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [root], runIngest: vi.fn() })
    const page = await port.getItemsPage(0, 100)

    expect(page).toHaveLength(2)
    expect(page.every(i => i.Type === 'Episode')).toBe(true)
    const bySeason = new Map(page.map(i => [i.ParentIndexNumber, i.Path]))
    expect(bySeason.get(1)).toBe(join(showDir, 'Season 01', 'ep1.mkv'))
    expect(bySeason.get(2)).toBe(join(showDir, 'Season 02', 'ep2.mkv'))
  })

  it('分页语义：对完整走盘结果做数组切片', async () => {
    root = mkdtempSync(join(tmpdir(), 'realign-lib-port-page-'))
    const showDir = join(root, 'Show (2020) [tmdbid-1]', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    for (let i = 1; i <= 5; i++) writeFileSync(join(showDir, `e${i}.mkv`), 'x')

    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [root], runIngest: vi.fn() })
    const page1 = await port.getItemsPage(0, 2)
    const page2 = await port.getItemsPage(2, 2)
    const page3 = await port.getItemsPage(4, 2)
    const page4 = await port.getItemsPage(6, 2)

    expect(page1).toHaveLength(2)
    expect(page2).toHaveLength(2)
    expect(page3).toHaveLength(1)
    expect(page4).toHaveLength(0)
  })

  it('文件不在任何 "Season NN" 目录下（尚未整理/隔离残留）→ ParentIndexNumber 为空', async () => {
    root = mkdtempSync(join(tmpdir(), 'realign-lib-port-noseason-'))
    mkdirSync(join(root, 'flat'), { recursive: true })
    writeFileSync(join(root, 'flat', 'loose.mkv'), 'x')

    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [root], runIngest: vi.fn() })
    const page = await port.getItemsPage(0, 100)

    expect(page).toHaveLength(1)
    expect(page[0].ParentIndexNumber).toBeFalsy()
  })

  it('契约测试：产出直接喂给 verifyRealignedCounts 时行为与 Jellyfin 版一致', async () => {
    root = mkdtempSync(join(tmpdir(), 'realign-lib-port-contract-'))
    const showDir = join(root, 'Show (2020) [tmdbid-1]')
    mkdirSync(join(showDir, 'Season 01'), { recursive: true })
    for (let i = 1; i <= 3; i++) writeFileSync(join(showDir, 'Season 01', `e${i}.mkv`), 'x')
    // 目标目录之外的其他视频文件——不该被计入验收统计（prefix 过滤）。
    mkdirSync(join(root, 'Other Show', 'Season 01'), { recursive: true })
    writeFileSync(join(root, 'Other Show', 'Season 01', 'x.mkv'), 'x')

    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [root], runIngest: vi.fn() })

    const result = await verifyRealignedCounts(port, showDir, new Map([[1, 3]]), { pageSize: 2 })
    expect(result.ok).toBe(true)
  })
})

describe('makeRealignLibraryPort · getScheduledTasks（D4：ingestLock 承载"扫描中不许挪文件"）', () => {
  afterEach(() => { ingestLock.held = false })

  it('ingestLock.held=false → 空数组（空闲）', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest: vi.fn() })
    ingestLock.held = false

    expect(await port.getScheduledTasks()).toEqual([])
  })

  it('ingestLock.held=true → 一个 isRunning:true 的任务（Running 态）', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest: vi.fn() })
    ingestLock.held = true

    const tasks = await port.getScheduledTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].isRunning).toBe(true)
  })

  it('契约测试：waitForJellyfinIdle 在 ingestLock 释放前一直轮询，释放后返回 true', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest: vi.fn() })
    ingestLock.held = true
    let ticks = 0
    const sleep = async () => {
      ticks++
      if (ticks === 2) ingestLock.held = false
    }

    const idle = await waitForJellyfinIdle(port, { pollMs: 1, timeoutMs: 10_000, sleep })
    expect(idle).toBe(true)
    expect(ticks).toBe(2)
  })
})

describe('makeRealignLibraryPort · getVirtualFolders', () => {
  it('每个 MEDIA_ROOTS 条目映射成一个 identity 虚拟库（locations=[root]）', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: ['/media/tv', '/media/anime'], runIngest: vi.fn() })

    const folders = await port.getVirtualFolders()

    expect(folders).toHaveLength(2)
    expect(folders[0]).toMatchObject({ name: 'tv', locations: ['/media/tv'], enableRealtimeMonitor: false })
    expect(folders[1]).toMatchObject({ name: 'anime', locations: ['/media/anime'], enableRealtimeMonitor: false })
  })
})

describe('makeRealignLibraryPort · refreshLibrary', () => {
  it('调用一次 deps.runIngest（libraryId 参数被忽略——库原生世界没有"只刷一个库"的等价操作）', async () => {
    const lib = mkLib()
    const runIngest = vi.fn(async () => ({ scanned: 1, upserted: 1, parked: 0, removed: 0, changed: true }))
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest })

    await port.refreshLibrary('root:0')

    expect(runIngest).toHaveBeenCalledTimes(1)
  })
})

describe('makeRealignLibraryPort · 无 deleteItem（D1）', () => {
  it('产出的 port 对象不含 deleteItem', () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], runIngest: vi.fn() })

    expect((port as unknown as { deleteItem?: unknown }).deleteItem).toBeUndefined()
  })
})
