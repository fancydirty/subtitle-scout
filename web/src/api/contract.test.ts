// web/src/api/contract.test.ts：契约校验层自身的用例（检查器 + 六条声明 + client 接线）。
//
// ── 这个文件守什么 ──────────────────────────────────────────────────────────
// 契约层是**防御性代码**：它在正常路径上什么都不做，只在后端违约时说话。这类代码有一个
// 特有的失效形态——**它坏了也没人知道**（正常路径照常绿）。所以这里的每一条都在问同一个
// 问题：「后端真的违约时，它到底有没有拦下来」。
//
// 三类断言，缺一不可：
//  ① 检查器本身（walk 的分支）——nullable 与"键不在"不合流、多余的键放行、数组逐项走。
//  ② 六条声明各自的**致命字段**真的在管——把那个字段删掉，必须拦。
//  ③ client 接线——没接的端点必须**零开销放行**（这是"只挡致命的、不挡 69 个"那条
//     范围裁决的可执行形式；接满了这条会红）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  checkShape, isContractViolation, ContractViolationError,
  obj, arr, str, num, bool, nullable,
} from './contract.js'
import {
  HEALTH_SHAPE, MEDIA_LIBRARY_ITEM_SHAPE, MEDIA_LIBRARY_DETAIL_SHAPE,
  ACTIVITY_SHAPE, FOUND_GROUP_SHAPE, SETUP_STATUS_SHAPE,
} from './contracts.js'
import { api } from './client.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

// ══════════════════════════════════════════════════════════════════════════════
// ① 检查器本身
// ══════════════════════════════════════════════════════════════════════════════
describe('checkShape：基本判定', () => {
  it('形状吻合 → null（不误报）', () => {
    expect(checkShape({ a: 'x', b: 1, c: true }, obj({ a: str(), b: num(), c: bool() }))).toBeNull()
  })

  it('类型不对 → 报出**路径 + 期望 + 实得**三样（少一样就不足以定位）', () => {
    const v = checkShape({ a: 1 }, obj({ a: str() }))
    expect(v).toEqual({ path: 'a', expected: 'string', got: 'number' })
  })

  it('🔴 键缺席 ≠ 值为 null：nullable 放行 null，但**不放行 undefined**', () => {
    // 这条是整个检查器最要紧的一条。放行 undefined 的话，一个全字段 nullable 的声明
    // 会让 `{}` 通过——那个声明就等于没写。
    expect(checkShape({ ok: null }, obj({ ok: nullable(bool()) }))).toBeNull()
    expect(checkShape({}, obj({ ok: nullable(bool()) })))
      .toEqual({ path: 'ok', expected: 'boolean|null', got: 'undefined' })
  })

  it('非 nullable 收到 null → 拦（null 与"类型对"是两回事）', () => {
    expect(checkShape({ a: null }, obj({ a: str() })))
      .toEqual({ path: 'a', expected: 'string', got: 'null' })
  })

  it('多余的键**放行**——后端加字段是正常演进，判它违约会让每次后端加字段都崩一页', () => {
    expect(checkShape({ a: 'x', brandNew: 42 }, obj({ a: str() }))).toBeNull()
  })

  it('数组逐项走，路径带下标（定位到是第几行坏的）', () => {
    const v = checkShape([{ n: 1 }, { n: 'bad' }], arr(obj({ n: num() })))
    expect(v).toEqual({ path: '[1].n', expected: 'number', got: 'string' })
  })

  it('该是数组却给了对象 / 该是对象却给了数组 → 都拦（typeof 分不出，describe 分得出）', () => {
    expect(checkShape({}, arr(str()))?.got).toBe('object')
    expect(checkShape([], obj({ a: str() }))?.got).toBe('array')
  })

  it('后端返回 {error:…} 顶替了正常响应体 → 拦（200 + 错误对象是真实发生过的形态）', () => {
    const v = checkShape({ error: 'db locked' }, HEALTH_SHAPE)
    expect(v).not.toBeNull()
  })

  it('嵌套路径拼全名（roots[0].ok 这种，一眼能反查后端字段）', () => {
    const v = checkShape({ roots: [{ path: '/m', ok: 'yes' }] },
      obj({ roots: arr(obj({ path: str(), ok: nullable(bool()) })) }))
    expect(v?.path).toBe('roots[0].ok')
  })
})

describe('ContractViolationError / isContractViolation', () => {
  it('消息指名道姓：端点 + 路径 + 期望 + 实得', () => {
    const e = new ContractViolationError('/api/v2/health', { path: 'workPermitted', expected: 'boolean', got: 'undefined' })
    expect(e.message).toContain('/api/v2/health')
    expect(e.message).toContain('workPermitted')
    expect(e.message).toContain('boolean')
    expect(e.message).toContain('undefined')
  })

  it('🔴 String() 压扁后仍可识别——本仓所有 hook 的 catch 都写 setError(String(e))，'
    + 'instanceof 到消费点必然失效，前缀是唯一还活着的身份标记', () => {
    const e = new ContractViolationError('/api/v2/health', { path: 'x', expected: 'boolean', got: 'undefined' })
    expect(isContractViolation(e)).toBe(true)
    expect(isContractViolation(String(e))).toBe(true)
  })

  it('普通失败**不**被认成契约违例（否则网络故障会被误报成后端违约）', () => {
    expect(isContractViolation(String(new Error('/api/v2/health → 500')))).toBe(false)
    expect(isContractViolation(null)).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// ② 六条声明各自的致命字段
// ══════════════════════════════════════════════════════════════════════════════
const HEALTH_OK = {
  lastInspectAt: 1, nextInspectAt: 1 + 24 * 60 * 60 * 1000, workPermitted: true, engineEnabled: true, setupSatisfied: true,
  roots: [{ path: '/media', ok: null, lastError: null, lastCheckedAt: null }],
  unidentified: { dirCount: 0, dirs: [] },
  current: null,
}

describe('HEALTH_SHAPE（判据①②：全局壳的判决源）', () => {
  it('完整响应放行', () => expect(checkShape(HEALTH_OK, HEALTH_SHAPE)).toBeNull())

  it('🔴 workPermitted 缺席 → 拦。不拦的话 undefined 是 falsy，横幅会说"引擎没开"'
    + '——而引擎正在跑，用户会跑去重填所有凭据（静默撒谎的最强样本）', () => {
    const { workPermitted: _drop, ...broken } = HEALTH_OK
    expect(checkShape(broken, HEALTH_SHAPE)?.path).toBe('workPermitted')
  })

  it('🔴 roots 缺席 → 拦。不拦的话 RootHealthNote 的 `if (!roots)` 静静返回 null，'
    + '挂载掉的守备目录界面上一个字都不显示', () => {
    const { roots: _drop, ...broken } = HEALTH_OK
    expect(checkShape(broken, HEALTH_SHAPE)?.path).toBe('roots')
  })

  it('roots[].ok 的**三态**全放行——null 是"不知道"这个合法值，不是缺陷', () => {
    for (const ok of [true, false, null]) {
      expect(checkShape({ ...HEALTH_OK, roots: [{ path: '/m', ok }] }, HEALTH_SHAPE)).toBeNull()
    }
  })

  it('🔴 unidentified 缺席 → 拦。不拦的话 UnidentifiedNote 的 `if (!unidentified)` 静静'
    + '返回 null，"有几个目录我认不出来"界面上一个字都不显示（病 A 第 7 例的形状）', () => {
    const { unidentified: _drop, ...broken } = HEALTH_OK
    expect(checkShape(broken, HEALTH_SHAPE)?.path).toBe('unidentified')
  })

  it('🔴 unidentified.dirCount 缺席 → 拦。undefined 走 `=== 0` 判空为 false，'
    + '整条提示照渲染但数字是 NaN——比整段消失更难排查', () => {
    const v = checkShape({ ...HEALTH_OK, unidentified: { dirs: [] } }, HEALTH_SHAPE)
    expect(v?.path).toBe('unidentified.dirCount')
  })

  it('current 是 null 时放行（合法：现在没在处理任何东西）', () => {
    expect(checkShape({ ...HEALTH_OK, current: null }, HEALTH_SHAPE)).toBeNull()
  })

  // ── 下面两条来自一次**没红的变异**（本轮实测，如实记录）──────────────────────
  // 变异 c1「把必填写成可选」（`workPermitted: bool()` → `nullable(bool())`）当时
  // **1334 条用例 0 红**。原因是上面所有"缺字段"用例删的都是**键**（→ undefined），
  // 而 `nullable` 按设计只放宽 `null`、不放宽 `undefined`——两条路径没有交叉，
  // 于是把必填改成可选，那些用例一条都感觉不到。
  //
  // 但它**不是无害的**：后端发 `"workPermitted": null`（JSON 里完全合法，且是
  // ORM/序列化层最常见的产物）时，改前拦、改后放行，而放行之后 `null` 在
  // `workPermission()` 里同样 falsy——**那句"引擎没开"的谎话原样复活**。
  // 也就是说 c1 是一个真实的削弱，只是我原来的用例集看不见它。
  //
  // 补这两条，把 null 这条路径单独钉住。判据写成 `expected` 里**没有** `|null`：
  // 那正是"这个键必填"在声明里的可观测形式。
  it('🔴 workPermitted 显式为 null → 拦。null 在 workPermission() 里同样 falsy，'
    + '放行它就是让"引擎没开"那句谎话原路复活（变异 c1 暴露的缺口）', () => {
    const v = checkShape({ ...HEALTH_OK, workPermitted: null }, HEALTH_SHAPE)
    expect(v).toEqual({ path: 'workPermitted', expected: 'boolean', got: 'null' })
  })

  it('🔴 三个布尔判决字段一个都不许是 null（钉死"必填 ≠ 可选"这条边界）', () => {
    for (const key of ['workPermitted', 'engineEnabled', 'setupSatisfied'] as const) {
      const v = checkShape({ ...HEALTH_OK, [key]: null }, HEALTH_SHAPE)
      expect(v, `${key} 被写成了可选`).toEqual({ path: key, expected: 'boolean', got: 'null' })
    }
  })
})

describe('MEDIA_LIBRARY_ITEM_SHAPE（判据③：计数字段参与算术）', () => {
  const ROW = {
    workId: 'tmdb:1', title: 'BB', expectedEpisodeCount: 62,
    onDiskEpisodeCount: 50, missingEpisodeCount: 12, subtitledEpisodeCount: 40, embeddedEpisodeCount: 0,
    originLanguageEpisodeCount: 0, readyEpisodeCount: 40, uncoveredEpisodeCount: 10,
  }
  it('完整行放行', () => expect(checkShape(ROW, MEDIA_LIBRARY_ITEM_SHAPE)).toBeNull())

  it('🔴 readyEpisodeCount 缺席 → 拦。缺席会把覆盖分子变成未知', () => {
    const { readyEpisodeCount: _drop, ...broken } = ROW
    expect(checkShape(broken, MEDIA_LIBRARY_ITEM_SHAPE)?.path).toBe('readyEpisodeCount')
  })

  it('🔴 originLanguageEpisodeCount 缺席 → 拦。缺席会吞掉原生语言原因', () => {
    const { originLanguageEpisodeCount: _drop, ...broken } = ROW
    expect(checkShape(broken, MEDIA_LIBRARY_ITEM_SHAPE)?.path).toBe('originLanguageEpisodeCount')
  })

  it('🔴 uncoveredEpisodeCount 缺席 → 拦。缺席会把缺口卡画成全齐', () => {
    const { uncoveredEpisodeCount: _drop, ...broken } = ROW
    expect(checkShape(broken, MEDIA_LIBRARY_ITEM_SHAPE)?.path).toBe('uncoveredEpisodeCount')
  })

  it('🔴 missingEpisodeCount 缺席 → 拦。不拦的话 coverageParts 算出 `undefined > 0` = false，'
    + '一部缺 12 集的剧在海报墙上显示得像齐全的', () => {
    const { missingEpisodeCount: _drop, ...broken } = ROW
    expect(checkShape(broken, MEDIA_LIBRARY_ITEM_SHAPE)?.path).toBe('missingEpisodeCount')
  })

  it('计数字段变成字符串（后端换了序列化）→ 拦，不然会做字符串拼接而不是加法', () => {
    expect(checkShape({ ...ROW, onDiskEpisodeCount: '50' }, MEDIA_LIBRARY_ITEM_SHAPE)?.got).toBe('string')
  })

  it('🔴 计数字段一个都不许是 null（同 health 那条，堵变异 c1 的缺口）。'
    + 'null 参与算术出 0 而不是 NaN——比 undefined 更隐蔽：缺 12 集会显示成"不缺"', () => {
    for (const key of ['expectedEpisodeCount', 'onDiskEpisodeCount', 'missingEpisodeCount', 'subtitledEpisodeCount', 'embeddedEpisodeCount', 'originLanguageEpisodeCount', 'readyEpisodeCount', 'uncoveredEpisodeCount'] as const) {
      const v = checkShape({ ...ROW, [key]: null }, MEDIA_LIBRARY_ITEM_SHAPE)
      expect(v, `${key} 被写成了可选`).toEqual({ path: key, expected: 'number', got: 'null' })
    }
  })
})

describe('MEDIA_LIBRARY_DETAIL_SHAPE（判据①③：两层解引用 + .map）', () => {
  const DETAIL = {
    work: { workId: 'tmdb:1', title: 'BB' },
    seasons: [{ season: 1, episodes: [{ episode: 1, onDisk: true, episodeState: 'covered', fileCount: 1, subtitledFileCount: 1 }] }],
    movie: null, unplacedFileCount: 0,
  }
  it('完整响应放行；电影形态（seasons 空、movie 在）也放行', () => {
    expect(checkShape(DETAIL, MEDIA_LIBRARY_DETAIL_SHAPE)).toBeNull()
    expect(checkShape({
      ...DETAIL, seasons: [],
      movie: { dot: 'green', episodeState: 'covered', fileCount: 1, subtitledFileCount: 1 },
    }, MEDIA_LIBRARY_DETAIL_SHAPE)).toBeNull()
  })

  it('🔴 work 缺席 → 拦。`detail.data.work.title` 是两层解引用，不拦就是整页崩', () => {
    const { work: _drop, ...broken } = DETAIL
    expect(checkShape(broken, MEDIA_LIBRARY_DETAIL_SHAPE)?.path).toBe('work')
  })

  it('🔴 seasons 不是数组 → 拦（.map 会抛 TypeError）', () => {
    expect(checkShape({ ...DETAIL, seasons: null }, MEDIA_LIBRARY_DETAIL_SHAPE)?.path).toBe('seasons')
  })

  it('集内 fileCount 缺席 → 拦（extraUnsubtitledCount 做减法，缺席出 NaN）', () => {
    const broken = { ...DETAIL, seasons: [{ season: 1, episodes: [{ episode: 1, onDisk: true, episodeState: 'covered', subtitledFileCount: 1 }] }] }
    expect(checkShape(broken, MEDIA_LIBRARY_DETAIL_SHAPE)?.path).toBe('seasons[0].episodes[0].fileCount')
  })

  it('⚠️ episodeState 只校验"是字符串"，**不校验八态枚举** —— 枚举是后端判据，'
    + '在前端复刻一份必然漂移（types.ts 头注释点名）', () => {
    const withNewState = { ...DETAIL, seasons: [{ season: 1, episodes: [{ episode: 1, onDisk: true, episodeState: 'some-future-state', fileCount: 1, subtitledFileCount: 1 }] }] }
    expect(checkShape(withNewState, MEDIA_LIBRARY_DETAIL_SHAPE)).toBeNull()
  })
})

describe('ACTIVITY_SHAPE（判据③：`?? []` 会把违约兜成"没有排队"）', () => {
  const OK = { subtitleQueue: [], translateQueue: [] }
  it('两个空队列放行（"真的没有排队"是合法事实）', () => {
    expect(checkShape(OK, ACTIVITY_SHAPE)).toBeNull()
  })
  it('🔴 subtitleQueue 缺席 → 拦。不拦就是把"接口坏了"说成"真没数据"', () => {
    expect(checkShape({ translateQueue: [] }, ACTIVITY_SHAPE)?.path).toBe('subtitleQueue')
  })
  it('队列项缺 pendingFileCount → 拦（卡片上那个数字会变 undefined）', () => {
    const broken = { subtitleQueue: [{ workId: 'w', title: 't' }], translateQueue: [] }
    expect(checkShape(broken, ACTIVITY_SHAPE)?.path).toBe('subtitleQueue[0].pendingFileCount')
  })
})

describe('FOUND_GROUP_SHAPE（判据③：通知页唯一数据源）', () => {
  const G = { workId: 'w', title: 't', season: 1, episodes: [1, 2], latestAt: 1_700_000_000_000, via: 'fetch' }
  it('完整组放行；电影形态（season=null、episodes 空）也放行', () => {
    expect(checkShape(G, FOUND_GROUP_SHAPE)).toBeNull()
    expect(checkShape({ ...G, season: null, episodes: [] }, FOUND_GROUP_SHAPE)).toBeNull()
  })
  it('🔴 latestAt 缺席 → 拦（dayOffset 出 NaN → 分桶全乱、时刻显示 NaN:NaN）', () => {
    const { latestAt: _drop, ...broken } = G
    expect(checkShape(broken, FOUND_GROUP_SHAPE)?.path).toBe('latestAt')
  })
  it('episodes 不是数组 → 拦（formatEpisodes 读 .length）', () => {
    expect(checkShape({ ...G, episodes: null }, FOUND_GROUP_SHAPE)?.path).toBe('episodes')
  })
})

describe('SETUP_STATUS_SHAPE（判据①：上一轮真崩过的三层解引用）', () => {
  const OK = { providers: { subhd: { enabled: true, source: 'db' }, zimuku: { enabled: false, source: 'none', captchaReady: false } } }
  it('完整放行', () => expect(checkShape(OK, SETUP_STATUS_SHAPE)).toBeNull())
  it('🔴 providers 整个缺席 → 拦（这就是那次整页白屏的触发形状）', () => {
    expect(checkShape({ bootstrapComplete: true }, SETUP_STATUS_SHAPE)?.path).toBe('providers')
  })
  it('🔴 providers 在但 zimuku 缺席（半截形状）→ 同样拦', () => {
    expect(checkShape({ providers: { subhd: { enabled: true } } }, SETUP_STATUS_SHAPE)?.path).toBe('providers.zimuku')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// ③ client 接线：接了的真拦，**没接的真放行**
// ══════════════════════════════════════════════════════════════════════════════
function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response))
}

describe('client.get() 接线', () => {
  it('health 少 workPermitted → **诚实报错**（不是静默 falsy 兜底）', async () => {
    const { workPermitted: _drop, ...broken } = HEALTH_OK
    stub(broken)
    await expect(api.health()).rejects.toThrow(/\[contract\].*workPermitted/s)
  })

  it('health 完整 → 原样返回（校验不改数据，只放行或拦下）', async () => {
    stub(HEALTH_OK)
    await expect(api.health()).resolves.toEqual(HEALTH_OK)
  })

  it('notifications 返回了对象而不是数组 → 拦（页面 .map 会崩）', async () => {
    stub({ error: 'oops' })
    await expect(api.notifications()).rejects.toThrow(/\[contract\]/)
  })

  it('activity 少一个队列 → 拦', async () => {
    stub({ subtitleQueue: [] })
    await expect(api.activity()).rejects.toThrow(/\[contract\].*translateQueue/s)
  })

  it('mediaLibrary 行缺计数字段 → 拦，且消息里带**下标**', async () => {
    stub([{ workId: 'tmdb:1', title: 'x', expectedEpisodeCount: 1, onDiskEpisodeCount: 1, missingEpisodeCount: 0 }])
    await expect(api.mediaLibrary()).rejects.toThrow(/\[0\]\.subtitledEpisodeCount/)
  })

  it('🔴 **没接契约的端点零开销放行**——这条钉的是"只挡致命的几个、不挡 69 个"那条'
    + '范围裁决。哪天有人给 runs/settings 也接满，这条会红。', async () => {
    // 两个刻意不接的端点，各喂一个残缺到不能再残缺的体，必须全部原样通过。
    // （第三个样本原是 api.triage，随 parked 族于 2026-08-13 删除——见
    //  web/src/triage/TriagePage.tsx 头注释 2.5 段。剩下两个足以钉住同一条范围裁决。）
    stub([{ nonsense: true }])
    await expect(api.runs(0, 10)).resolves.toEqual([{ nonsense: true }])
    stub({ nonsense: true })
    await expect(api.settings()).resolves.toEqual({ nonsense: true })
  })

  it('契约违例走的是 ContractViolationError（消费点据此与网络失败分型）', async () => {
    stub({ bootstrapComplete: true })
    await expect(api.setupStatus()).rejects.toSatisfy(isContractViolation)
  })

  it('⚠️ HTTP 失败仍走**原来那条**错误路径，不被契约层顶替'
    + '（后端给的人话消息比"形状不对"有用得多）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'TMDB_API_KEY missing' }) }) as unknown as Response))
    await expect(api.health()).rejects.toThrow('TMDB_API_KEY missing')
  })
})
