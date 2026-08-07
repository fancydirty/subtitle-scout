import { describe, it, expect } from 'vitest'
import {
  workRootOf, groupIntoWorkUnits,
  FLAT_BATCH_SIZE, MAX_TARGETS_PER_JOB, DEFAULT_UNIT_LIMIT,
} from './workUnit.js'

// 作品单元推导（spec 2026-08-07 §3.2/§3.3）的行为锁。
//
// 这些是**纯函数**测试：workRootOf 只做路径字符串推导 + 配置根比对，零 I/O（不 stat、不
// readdir）。所以测试用字面量路径，不建临时目录——真实文件系统行为由 ingest 层的既有测试覆盖。

const ROOTS = ['/media/Movies', '/media/TV', '/media/anime']

describe('workRootOf（作品根推导，spec §3.2）', () => {
  it('扁平剧集：配置根的直接子目录即作品根（条件 2）', () => {
    expect(workRootOf('/media/TV/Constellation/S01E03.mkv', ROOTS))
      .toBe('/media/TV/Constellation')
  })

  it('标准剧集：季目录向上穿透（条件 3 → 条件 2）', () => {
    expect(workRootOf('/media/TV/Spy x Family/Season 01/S01E03.mkv', ROOTS))
      .toBe('/media/TV/Spy x Family')
  })

  it('电影带专属目录：条件 2 命中', () => {
    expect(workRootOf('/media/Movies/Pulp Fiction (1994)/movie.mkv', ROOTS))
      .toBe('/media/Movies/Pulp Fiction (1994)')
  })

  it('文件直躺配置根下：作品根＝配置根（条件 1）', () => {
    // spec §3.2 的裁决：必须返回目录而非文件路径——findSubtitleWorker.ts:112-116 对每个
    // target 断言 isUnderRoots(dirname(videoPath), [task.mediaRoot])，取文件路径会让
    // dirname 恒不在其下 → 整任务抛 "escapes its own sandboxed mediaRoot"。
    expect(workRootOf('/media/Movies/some.movie.2024.mkv', ROOTS))
      .toBe('/media/Movies')
  })

  it('🔴 中间层不匹配任何已知形态：条件 4 继续上爬，不越界（一轮 B3）', () => {
    // Show/Season 1/Part 2/ep.mkv —— 'Part 2' 既非季目录、其父 'Season 1' 也非配置根。
    // 初稿的三条规则全不命中 → 循环无终止 → 一路爬到 /media 甚至 / （正是 §2 要修的越界
    // bug 原地重生）。条件 4 + containingRoot 硬上界共同封死。
    expect(workRootOf('/media/TV/Show/Season 1/Part 2/ep.mkv', ROOTS))
      .toBe('/media/TV/Show')
  })

  it('季目录的全部形态都能穿透（复用 detectSeasonFolder，不重写正则）', () => {
    // spec §3.2 明确不在文档里重述形态（一轮重述时漏了 Series NN / 第N集 / 第N部）
    for (const seasonDir of ['Season 02', 'Series 2', 'S02', '第2季', '第2集', '第2部', 'Specials']) {
      expect(workRootOf(`/media/TV/Show/${seasonDir}/ep.mkv`, ROOTS))
        .toBe('/media/TV/Show')
    }
  })

  it('🔴 嵌套配置根：按最长匹配归属（二轮 R2-M1）', () => {
    // 同时配了 /media 与 /media/TV 时，目录 /media/TV 同时满足条件 1（它是根）与条件 2
    // （父 /media 也是根）。必须按 containingRoot 的最长前缀语义归到 /media/TV，
    // 否则整个 TV 根会变成一个单元（与意图相反）。
    const nested = ['/media', '/media/TV']
    expect(workRootOf('/media/TV/Show/S01E01.mkv', nested)).toBe('/media/TV/Show')
    // /media 下的非 TV 内容仍按 /media 归属
    expect(workRootOf('/media/Other/S01E01.mkv', nested)).toBe('/media/Other')
  })

  it('🔴 mediaRoots 为空（开发/测试态）：退化为"文件所在目录即单元"，不抛错（二轮 R2-M1）', () => {
    // containingRoot 在空 roots 下恒返回 null（mediaContext.ts:42），硬上界会在第一次检查
    // 就触发但"从未有过在根内的目录"。既有代码在空 roots 下一律降级（isUnderRoots 把空数组
    // 当"不限制"），这里沿用同一哲学——绝不把有测试锁的降级路径改成硬失败。
    expect(workRootOf('/anywhere/Show/S01E01.mkv', [])).toBe('/anywhere/Show')
  })

  it('路径完全在配置根之外：退化为文件所在目录（不抛错，由调用方的 assertDirSafe 拦）', () => {
    // 沙盒纪律的执行点是 assertDirSafe（OUTER 门），不是本推导函数。这里只负责"给出一个
    // 不越界的答案"，越界拦截是上一层的职责——职责单一，避免两处各拦一半。
    expect(workRootOf('/etc/passwd.mkv', ROOTS)).toBe('/etc')
  })

  it('同名前缀的兄弟根不误伤（/media/TV 不吞 /media/TV2）', () => {
    const roots = ['/media/TV', '/media/TV2']
    expect(workRootOf('/media/TV2/Show/S01E01.mkv', roots)).toBe('/media/TV2/Show')
  })
})

describe('groupIntoWorkUnits（组批，spec §3.3/§3.3.2）', () => {
  // retry_count 默认 1（= 已被 agent 试过），这样退避窗测试的语义与实现一致；
  // retry_count=0 的"新 park 行无条件放行"另有专门用例。
  const mk = (path: string, lastAttempt = 0, nextRetryAt: number | null = null, retryCount = 1) =>
    ({ path, last_attempt: lastAttempt, next_retry_at: nextRetryAt, retry_count: retryCount })

  it('同一作品目录的文件归一个单元', () => {
    const units = groupIntoWorkUnits([
      mk('/media/TV/Constellation/S01E01.mkv'),
      mk('/media/TV/Constellation/S01E02.mkv'),
      mk('/media/TV/Constellation/S01E03.mkv'),
    ], ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 })

    expect(units).toHaveLength(1)
    expect(units[0].workRoot).toBe('/media/TV/Constellation')
    expect(units[0].kind).toBe('work-dir')
    expect(units[0].paths).toHaveLength(3)
  })

  it('跨季目录的文件仍归同一个单元（这是本轮的核心收益）', () => {
    const units = groupIntoWorkUnits([
      mk('/media/TV/Spy x Family/Season 01/E01.mkv'),
      mk('/media/TV/Spy x Family/Season 02/E01.mkv'),
    ], ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 })

    expect(units).toHaveLength(1)
    expect(units[0].paths).toHaveLength(2)
  })

  it('🔴 退避窗未过的路径不上车（二轮 R2-B1 活锁防线）', () => {
    const units = groupIntoWorkUnits([
      mk('/media/TV/A/E01.mkv', 500, 5000),   // next_retry_at 在未来 → 挡
      mk('/media/TV/B/E01.mkv', 500, null),   // 无退避 → 放行
      mk('/media/TV/C/E01.mkv', 500, 900),    // 退避窗已过 → 放行
    ], ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 })

    expect(units.map(u => u.workRoot).sort())
      .toEqual(['/media/TV/B', '/media/TV/C'])
  })

  it('🔴 retry_count=0 的新 park 行无条件放行，不被 ingest 的 1h 节流窗挡住', () => {
    // ingest 的 upsertParkedPath 给**新** park 行也写 next_retry_at=now+1h（libraryRepo.ts:819），
    // 那是给 ingest 自己的"别每轮重跑昂贵 recognize"节流。若组批也照它过滤，新发现的文件要等
    // 整一小时才能被识别——不可接受的行为退化（本轮实测踩到）。
    const units = groupIntoWorkUnits([
      mk('/media/TV/Fresh/E01.mkv', 500, 999_999, 0),   // 窗口在远期未来，但 retry_count=0
      mk('/media/TV/Tried/E01.mkv', 500, 999_999, 2),   // 试过 2 次 → 受窗口约束 → 挡
    ], ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 })

    expect(units.map(u => u.workRoot)).toEqual(['/media/TV/Fresh'])
  })

  it('🔴 按单元内最小 last_attempt ASC 排序（最久没被尝试的先上）', () => {
    const units = groupIntoWorkUnits([
      mk('/media/TV/Newer/E01.mkv', 900),
      mk('/media/TV/Oldest/E01.mkv', 100),
      mk('/media/TV/Middle/E01.mkv', 500),
    ], ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 })

    expect(units.map(u => u.workRoot))
      .toEqual(['/media/TV/Oldest', '/media/TV/Middle', '/media/TV/Newer'])
  })

  it('🔴 unitLimit 截断单元数（不是文件数）', () => {
    const units = groupIntoWorkUnits([
      mk('/media/TV/A/E01.mkv', 100),
      mk('/media/TV/B/E01.mkv', 200),
      mk('/media/TV/C/E01.mkv', 300),
      mk('/media/TV/D/E01.mkv', 400),
    ], ROOTS, { now: 1000, unitLimit: 2, maxTargets: 60 })

    expect(units).toHaveLength(2)
    expect(units.map(u => u.workRoot)).toEqual(['/media/TV/A', '/media/TV/B'])
  })

  it('🔴 maxTargets 到顶时整单元留到下一轮，绝不切半（二轮 R2-B3）', () => {
    // 切半会回到 §3.1 "兄弟被切散"的原始问题——那正是本轮要修的东西。
    const bigUnit = Array.from({ length: 5 }, (_, i) => mk(`/media/TV/Big/E0${i}.mkv`, 100))
    const smallUnit = [mk('/media/TV/Small/E01.mkv', 200)]

    const units = groupIntoWorkUnits([...bigUnit, ...smallUnit], ROOTS, {
      now: 1000, unitLimit: 3, maxTargets: 6,
    })

    // Big(5) 上车后剩余额度 1 < Small(1)? 不，Small 正好 1 → 两个都上
    expect(units).toHaveLength(2)

    // 把额度收到 5：Big(5) 占满，Small 留下一轮
    const tight = groupIntoWorkUnits([...bigUnit, ...smallUnit], ROOTS, {
      now: 1000, unitLimit: 3, maxTargets: 5,
    })
    expect(tight).toHaveLength(1)
    expect(tight[0].workRoot).toBe('/media/TV/Big')
    expect(tight[0].paths).toHaveLength(5)  // 整单元，没被切
  })

  it('🔴 单个单元自身超 maxTargets：单独成 job（接受超限，不切半）', () => {
    const huge = Array.from({ length: 80 }, (_, i) => mk(`/media/TV/Huge/E${i}.mkv`, 100))
    const units = groupIntoWorkUnits(huge, ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 })

    expect(units).toHaveLength(1)
    expect(units[0].paths).toHaveLength(80)  // 整单元上车，超限但不切
  })

  it('🔴 扁平文件按 FLAT_BATCH_SIZE 切成合成单元（二轮 R2-B2）', () => {
    // 扁平文件彼此没有 sibling 关系（没有共同作品目录），切分不违反"兄弟不切散"。
    // 一轮让整个配置根成一个单元会造出 200 目标的巨型 job（R2-B3 最坏情况的制造者）。
    const flat = Array.from({ length: FLAT_BATCH_SIZE + 3 }, (_, i) =>
      mk(`/media/Movies/movie${i}.2024.mkv`, 100))

    const units = groupIntoWorkUnits(flat, ROOTS, { now: 1000, unitLimit: 5, maxTargets: 60 })

    expect(units).toHaveLength(2)
    expect(units[0].kind).toBe('flat-batch')
    expect(units[0].paths).toHaveLength(FLAT_BATCH_SIZE)
    expect(units[1].paths).toHaveLength(3)
    // 合成单元的 workRoot 仍是配置根（沙盒锚点），kind 用于 prompt 措辞分支
    expect(units[0].workRoot).toBe('/media/Movies')
  })

  it('🔴 unitLimit=0 退回旧扁平语义（§9.2 回滚开关）', () => {
    const rows = [
      mk('/media/TV/A/E01.mkv', 100),
      mk('/media/TV/A/E02.mkv', 100),
      mk('/media/TV/B/E01.mkv', 200),
    ]
    const units = groupIntoWorkUnits(rows, ROOTS, { now: 1000, unitLimit: 0, maxTargets: 60 })

    // 一个"伪单元"装全部文件（不分组），语义等价改动前的扁平取 N 个文件
    expect(units).toHaveLength(1)
    expect(units[0].kind).toBe('flat-batch')
    expect(units[0].paths).toHaveLength(3)
  })

  it('🔴 unitLimit=0 在多根部署下按配置根分开（审计 B-1：否则 mediaRoot 越界必抛错）', () => {
    // 一轮实现让 workRoot 取自第一条路径却装跨全部根的 paths →
    // findSubtitleWorker.ts:112-116 断言每个 target 在 [task.mediaRoot] 之下 → 整任务抛
    // "escapes its own sandboxed mediaRoot"。而多根正是本轮故障(§0)的原始形态，
    // 唯一的运行时退路在最需要它的场景下 100% 坏掉。
    const units = groupIntoWorkUnits([
      mk('/media/TV/A/E01.mkv', 100),
      mk('/media/Movies/b.2024.mkv', 200),
      mk('/media/anime/C/E01.mkv', 300),
    ], ROOTS, { now: 1000, unitLimit: 0, maxTargets: 60 })

    // 每个单元的全部 path 必须真的在自己的 workRoot 之下
    for (const u of units) {
      for (const p of u.paths) {
        expect(p.startsWith(u.workRoot + '/')).toBe(true)
      }
    }
    expect(units.length).toBeGreaterThanOrEqual(2)
  })

  it('🔴 超限单元不在队首时仍单独成 job（审计 M-1：spec §3.3.2 的裁决是无条件的）', () => {
    // 一轮的 isFirst 守卫只在超限单元恰好排队首时兑现 §3.3.2，任何更老的小单元都能把它挤掉。
    // 且该守卫把正确性押在 B2 还没写的 bumpParkedRetry 上——若失败路径漏接线，延迟变无限。
    const small = [mk('/media/TV/Small/E01.mkv', 100)]           // 最老 → 队首
    const huge = Array.from({ length: 80 }, (_, i) =>
      mk(`/media/TV/Huge/E${i}.mkv`, 200))                        // 超限但更新

    const units = groupIntoWorkUnits([...small, ...huge], ROOTS, {
      now: 1000, unitLimit: 3, maxTargets: 60,
    })

    // Huge 必须出现（单独成 job），不能被 Small 挤掉
    const hugeUnit = units.find(u => u.workRoot === '/media/TV/Huge')
    expect(hugeUnit).toBeDefined()
    expect(hugeUnit!.paths).toHaveLength(80)
  })

  it('🔴 kind 分流：同一配置根下扁平文件与作品目录各自成组（key 设计的唯一理由）', () => {
    const units = groupIntoWorkUnits([
      mk('/media/Movies/loose1.2024.mkv', 100),
      mk('/media/Movies/loose2.2024.mkv', 100),
      mk('/media/Movies/Pulp Fiction (1994)/movie.mkv', 100),
    ], ROOTS, { now: 1000, unitLimit: 5, maxTargets: 60 })

    const flat = units.filter(u => u.kind === 'flat-batch')
    const dirs = units.filter(u => u.kind === 'work-dir')
    expect(flat).toHaveLength(1)
    expect(flat[0].paths).toHaveLength(2)          // 两个散装文件聚一起
    expect(dirs).toHaveLength(1)
    expect(dirs[0].workRoot).toBe('/media/Movies/Pulp Fiction (1994)')
  })

  it('🔴 非规范化配置根（尾斜杠/双斜杠/. 段）不导致退化成巨型单元（审计 M-2）', () => {
    // addRoot 是裸 INSERT 零规范化（settingsRepo.ts:113），seedRootsFromEnv 只 trim——
    // 根侧不干净真实可达。未 resolve 时规则 1/2 永不命中 → 整根聚成一个 work-dir 巨型单元，
    // 同时逃过 FLAT_BATCH_SIZE 切分，正是 §3.3.2 列为事故诱因的形态。
    for (const dirtyRoots of [['/media/TV/'], ['/media//TV'], ['/media/TV/.']]) {
      expect(workRootOf('/media/TV/Show/E01.mkv', dirtyRoots)).toBe('/media/TV/Show')
    }
  })

  it('默认常量即 spec §10 钉死的值（改错一个数字必须红）', () => {
    expect(FLAT_BATCH_SIZE).toBe(8)
    expect(MAX_TARGETS_PER_JOB).toBe(60)
    expect(DEFAULT_UNIT_LIMIT).toBe(3)
  })

  it('不传 unitLimit/maxTargets 时用默认值', () => {
    const rows = Array.from({ length: 5 }, (_, i) => mk(`/media/TV/U${i}/E01.mkv`, i))
    const units = groupIntoWorkUnits(rows, ROOTS, { now: 1000 })
    expect(units).toHaveLength(DEFAULT_UNIT_LIMIT)   // 5 个单元被 limit 截到 3
  })

  it('next_retry_at === now 边界：视为已过（>= 语义）', () => {
    const units = groupIntoWorkUnits(
      [mk('/media/TV/A/E01.mkv', 100, 1000)], ROOTS,
      { now: 1000, unitLimit: 3, maxTargets: 60 },
    )
    expect(units).toHaveLength(1)
  })

  it('空输入 → 空数组（幂等 no-op，调用方据此 completeDone）', () => {
    expect(groupIntoWorkUnits([], ROOTS, { now: 1000, unitLimit: 3, maxTargets: 60 }))
      .toEqual([])
  })
})
