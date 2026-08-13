import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRealignLibraryPort } from './realignLibraryPort.js'
import { verifyRealignedCounts, waitForIngestIdle } from './realignExecutor.js'
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
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan: vi.fn(), isScanning: () => false })

    const item = await port.getItem('tmdb:120089')

    expect(item.Name).toBe('Spy x Family')
    expect(item.ProductionYear).toBe(2022)
    expect(item.ProviderIds?.Tmdb).toBe('120089')
  })

  it('未知 id（库里没有这条 series 行）→ 抛错，不返回伪造数据', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan: vi.fn(), isScanning: () => false })

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
    const port = makeRealignLibraryPort({ lib, roots: [root], requestScan: vi.fn(), isScanning: () => false })
    const page = await port.getItemsPage(0, 100)

    expect(page).toHaveLength(2)
    expect(page.every(i => i.Type === 'Episode')).toBe(true)
    const bySeason = new Map(page.map(i => [i.ParentIndexNumber, i.Path]))
    expect(bySeason.get(1)).toBe(join(showDir, 'Season 01', 'ep1.mkv'))
    expect(bySeason.get(2)).toBe(join(showDir, 'Season 02', 'ep2.mkv'))
  })

  // R6-5 修复：walkCache 打点在走盘完成后——此前用走盘开始前的 now，走盘 >100ms 时缓存写入即过期，
  // 第二页必然重新全量走盘（正是它要救的 CIFS/SMB 场景）。这条测试锁住"同一轮验收内的连续分页
  // 命中缓存（walk 只被调一次）"。
  it('同一轮验收内的连续分页命中缓存（walk 只被调一次）', async () => {
    root = mkdtempSync(join(tmpdir(), 'realign-lib-port-'))
    const showDir = join(root, 'Spy x Family (2022) [tmdbid-120089]')
    mkdirSync(join(showDir, 'Season 01'), { recursive: true })
    writeFileSync(join(showDir, 'Season 01', 'ep1.mkv'), 'x')
    writeFileSync(join(showDir, 'Season 01', 'ep2.mkv'), 'x')

    // R8-4：走盘必须真的慢（>100ms 缓存窗口）——瞬时返回的假 walk 让"走盘前打点"与"走盘后打点"
    // 完全不可区分，此前那版测试对 R6-5 的 mutation 全绿（假测试）。同步 busy-wait 模拟 CIFS/SMB。
    const walkSpy = vi.fn(() => {
      const until = Date.now() + 150
      while (Date.now() < until) { /* busy-wait：getItemsPage 是同步走盘，不能用 await */ }
      return [join(showDir, 'Season 01', 'ep1.mkv'), join(showDir, 'Season 01', 'ep2.mkv')]
    })
    const port = makeRealignLibraryPort({
      lib: mkLib(),
      roots: [root],
      requestScan: vi.fn(),
      isScanning: () => false,
      walkVideoFiles: walkSpy,
    })

    // 连续分页两次（模拟验收的 pageSize=100 场景）
    const page1 = await port.getItemsPage(0, 1)
    const page2 = await port.getItemsPage(1, 1)

    expect(page1).toHaveLength(1)
    expect(page2).toHaveLength(1)
    // 关键：walk 只被调一次（第二页命中缓存）
    expect(walkSpy).toHaveBeenCalledTimes(1)
  })

  it('分页语义：对完整走盘结果做数组切片', async () => {
    root = mkdtempSync(join(tmpdir(), 'realign-lib-port-page-'))
    const showDir = join(root, 'Show (2020) [tmdbid-1]', 'Season 01')
    mkdirSync(showDir, { recursive: true })
    for (let i = 1; i <= 5; i++) writeFileSync(join(showDir, `e${i}.mkv`), 'x')

    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [root], requestScan: vi.fn(), isScanning: () => false })
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
    const port = makeRealignLibraryPort({ lib, roots: [root], requestScan: vi.fn(), isScanning: () => false })
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
    const port = makeRealignLibraryPort({ lib, roots: [root], requestScan: vi.fn(), isScanning: () => false })

    const result = await verifyRealignedCounts(port, showDir, new Map([[1, 3]]), { pageSize: 2 })
    expect(result.ok).toBe(true)
  })
})

// 2026-08-13：本组三条原先驱动的是 `ingestLock.held`（v2/ingest.ts 的模块级单例，随 ingest
// 整体退役）。改成驱动注入的 `isScanning`——**安全属性逐字不变**（"扫描中不许挪文件"），
// 只是问的对象从 ingest 换成了真正会与 realign 抢同一批路径的 daemonV2.scanOnce。
// 顺带一个真实的改善：状态从模块级单例变成 per-port 注入，不再有跨用例泄漏的可能
// （旧写法要靠 afterEach 手动复位，漏一次就污染下一条）。
describe('makeRealignLibraryPort · getScheduledTasks（D4：isScanning 承载"扫描中不许挪文件"）', () => {
  it('isScanning()=false → 空数组（空闲）', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan: vi.fn(), isScanning: () => false })

    expect(await port.getScheduledTasks()).toEqual([])
  })

  it('isScanning()=true → 一个 isRunning:true 的任务（Running 态）', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan: vi.fn(), isScanning: () => true })

    const tasks = await port.getScheduledTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].isRunning).toBe(true)
  })

  it('契约测试：waitForIngestIdle 在扫描结束前一直轮询，结束后返回 true', async () => {
    const lib = mkLib()
    let scanning = true
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan: vi.fn(), isScanning: () => scanning })
    let ticks = 0
    const sleep = async () => {
      ticks++
      if (ticks === 2) scanning = false
    }

    const idle = await waitForIngestIdle(port, { pollMs: 1, timeoutMs: 10_000, sleep })
    expect(idle).toBe(true)
    expect(ticks).toBe(2)
  })
})

describe('makeRealignLibraryPort · getVirtualFolders', () => {
  it('每个 MEDIA_ROOTS 条目映射成一个 identity 虚拟库（locations=[root]）', async () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: ['/media/tv', '/media/anime'], requestScan: vi.fn(), isScanning: () => false })

    const folders = await port.getVirtualFolders()

    expect(folders).toHaveLength(2)
    expect(folders[0]).toMatchObject({ name: 'tv', locations: ['/media/tv'] })
    expect(folders[1]).toMatchObject({ name: 'anime', locations: ['/media/anime'] })
  })
})

describe('makeRealignLibraryPort · refreshLibrary', () => {
  it('调用一次 deps.requestScan（libraryId 参数被忽略——库原生世界没有"只刷一个库"的等价操作）', async () => {
    const lib = mkLib()
    const requestScan = vi.fn()
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan, isScanning: () => false })

    await port.refreshLibrary('root:0')

    expect(requestScan).toHaveBeenCalledTimes(1)
  })
})

describe('makeRealignLibraryPort · 无 deleteItem（D1）', () => {
  it('产出的 port 对象不含 deleteItem', () => {
    const lib = mkLib()
    const port = makeRealignLibraryPort({ lib, roots: [], requestScan: vi.fn(), isScanning: () => false })

    expect((port as unknown as { deleteItem?: unknown }).deleteItem).toBeUndefined()
  })
})
