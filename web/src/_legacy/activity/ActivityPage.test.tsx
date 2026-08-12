// web/src/activity/ActivityPage.test.tsx：容器层——三屏优先级与 held join。
//
// 五个子组件各自的视觉/文案裁决在它们自己的测试里锁着，这里只测**容器的职责**：
// 决定渲染哪一屏、以及把 held 记录 join 上名字与海报。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../../i18n/useT.js'
import { ActivityPage } from './ActivityPage.js'
import { api } from '../../api/client.js'
import type {
  WorkflowPendingDTO, WorkflowWorkersDTO, WorkflowRunningWorkerDTO,
  WorkflowRecentRunDTO, WorkflowHeldJobDTO, SetupStatusDTO,
} from '../../api/types.js'

const META: WorkflowPendingDTO['meta'] = {
  roots: ['/media'], lastScanAt: 1_700_000_000_000, files: 100,
  lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0,
}

const PENDING = (over: Partial<WorkflowPendingDTO> = {}): WorkflowPendingDTO => ({
  series: [], movies: [], parked: 0, meta: META, ...over,
})

const runningRow = (over: Partial<WorkflowRunningWorkerDTO> = {}): WorkflowRunningWorkerDTO => ({
  jobId: 7, seriesId: 's1', movieId: null, taskType: 'find_subtitle', seasons: [2],
  seriesName: 'Silo', movieName: null, posterPath: '/p.jpg', backdropPath: '/b.jpg',
  startedAtLease: 1_700_000_000_000, trail: [], ...over,
})

const recentRow = (over: Partial<WorkflowRecentRunDTO> = {}): WorkflowRecentRunDTO => ({
  id: 1, jobId: 7, decision: 'installed', detail: null, finishedAt: 1_700_000_000_000,
  seriesId: 's1', movieId: null, seriesName: 'Silo', movieName: null,
  posterPath: '/p.jpg', backdropPath: '/b.jpg', llmCalls: null, ...over,
})

const heldRow = (over: Partial<WorkflowHeldJobDTO> = {}): WorkflowHeldJobDTO => ({
  jobId: 7, itemId: 'tmdb:1/s1e1', reason: 'translate job 41 payload 缺 videoPath',
  nextRetryAt: 1_700_000_600_000, errorAttempt: 2,
  // 名字与海报现在由后端 held DTO 自带（审计 C-3）——不再靠前端 join recent[]
  seriesName: 'Silo', movieName: null, posterPath: '/p.jpg', backdropPath: '/b.jpg',
  ...over,
})

const WORKERS = (over: Partial<WorkflowWorkersDTO> = {}): WorkflowWorkersDTO => ({
  running: [], recent: [], installedLast24h: 0, translatedLast24h: 0, held: [],
  providerQuota: [], ...over,
})

// 发动机开关的状态源。**默认给全的**，不走 stub 的 {} 兜底——那个兜底会让 setup.data 变成
// 一个真值空对象，engineEnabled 于是是 undefined，hero 那道
// `typeof engineEnabled === 'boolean'` 守卫不成立，**开关整块静默消失**，而下面 9 条断言全绿。
// 真环境里这份 DTO 永远是完整的、开关永远在场，所以让既有用例也照这个样子渲染才是保真的；
// 顺带让开关的可见文案落进 :164 那条铁律③的整页扫描里（另开一个 stubWithSetup() 就恰好漏掉它）。
// 需要「引擎关」的形状时用 { ...SETUP, engineEnabled: false }，别再加一个工厂函数。
const SETUP: SetupStatusDTO = {
  bootstrapComplete: true,
  tmdb: { satisfied: true, source: 'env', masked: 'abc••••xyz' },
  llm: { satisfied: true, source: 'db', model: 'm-1' },
  providers: {
    assrt: { satisfied: true, source: 'db', masked: 'ass••••123' },
    opensubtitles: { satisfied: false, source: 'none', hasUsername: false, masked: null },
    jimaku: { satisfied: false, source: 'none', masked: null },
    subhd: { enabled: true, source: 'db' },
    zimuku: { enabled: false, source: 'env', captchaReady: true },
  },
  roots: { count: 1 },
  engineEnabled: true,
}

function stub(
  pending: WorkflowPendingDTO | null,
  workers: WorkflowWorkersDTO | null,
  setup: SetupStatusDTO | null = SETUP,
) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const body = url.includes('/workflow/pending') ? pending
      : url.includes('/workflow/workers') ? workers
        : url.includes('/setup/status') ? setup
          : {}
    if (body === null) return new Response('nope', { status: 500 })
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; vi.restoreAllMocks() })

const renderPage = () => render(<I18nProvider initialLang="zh"><ActivityPage /></I18nProvider>)

describe('ActivityPage：三屏优先级（故障 > 在跑 > 空闲）', () => {
  // 这条是容器最要紧的裁决：有故障时先给卡死态，**即使同时有别的 job 在跑**。
  // L7 的张力是"不给排查入口，但问题必须看得见"——若一条正常运行的 hero 把故障挤到屏幕下方，
  // 那等于没看见。故障是这一屏唯一「需要用户知道」的事，其余都是「让他放心不管」。
  it('held 非空 + 同时有在跑 → 渲染卡死态，不渲染在跑 hero', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()], held: [heldRow()], recent: [recentRow()] }))
    renderPage()
    await waitFor(() => expect(screen.getByText(/遇到问题/)).toBeInTheDocument())
    // 在跑 hero 的副标题不该在场
    expect(screen.queryByText(/正在找/)).not.toBeInTheDocument()
  })

  it('无 held + 有在跑 → 渲染 hero（含剧名）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    renderPage()
    await waitFor(() => expect(screen.getByText('Silo')).toBeInTheDocument())
  })

  it('两者皆空 → 渲染空态（不写「都齐了」，给可核对的时间戳）', async () => {
    stub(PENDING(), WORKERS())
    renderPage()
    await waitFor(() => expect(screen.getByText('现在没有在处理的字幕')).toBeInTheDocument())
    // L6 回归锁
    expect(screen.queryByText(/都齐了|全部完成|一切正常/)).not.toBeInTheDocument()
  })

  it('首载两源皆未到位 → 什么都不渲染（不给骨架屏/转圈）', () => {
    stub(null, null)
    const { container } = renderPage()
    expect(container.textContent).toBe('')
  })
})

describe('ActivityPage：held 的名字与海报', () => {
  // 名字与海报由**后端 held DTO 自带**（审计 C-3 修复）。曾经是前端按 jobId 去 recent[]
  // 反查——设计假设对（同一次收官连续写入两边），但会过期：held 停留天级、recent 是 20 条
  // 滑动窗口，一小时后必然 MISS → 卡死态没图（违反 L4）+ 显示技术标识符（违反 L3）。
  it('用 held 自带的剧名，不依赖 recent', async () => {
    stub(PENDING(), WORKERS({
      held: [heldRow({ jobId: 42, seriesName: 'Peacemaker' })],
      recent: [],   // ← recent 空着：这正是一小时后的真实状态
    }))
    renderPage()
    await waitFor(() => expect(screen.getByText('Peacemaker')).toBeInTheDocument())
  })

  // L4 回归锁：recent 被挤空后仍然必须有图。这条是 C-3 的直接锁。
  it('recent 为空时海报仍在场（L4：必须有图）', async () => {
    stub(PENDING(), WORKERS({ held: [heldRow({ posterPath: '/p.jpg' })], recent: [] }))
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText(/遇到问题/)).toBeInTheDocument())
    expect(container.querySelector('img')).toBeTruthy()
  })

  // L3 回归锁：名字查无时不许把 itemId 这种技术标识符顶上界面。
  it('名字查无 → 不显示 itemId 那种技术标识符（L3）', async () => {
    stub(PENDING(), WORKERS({
      held: [heldRow({ seriesName: null, movieName: null, itemId: 'tmdb:1396/s12e04' })],
      recent: [],
    }))
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText(/遇到问题/)).toBeInTheDocument())
    expect(container.textContent).not.toContain('tmdb:1396')
  })

  // 铁律②③：reason 是 jobs.last_error 的自由文本（模板拼的，无值域），绝不透传。
  it('held.reason 的原文不出现在 DOM 里', async () => {
    stub(PENDING(), WORKERS({ held: [heldRow()], recent: [recentRow()] }))
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText(/遇到问题/)).toBeInTheDocument())
    expect(container.textContent).not.toContain('videoPath')
    expect(container.textContent).not.toContain('translate job 41')
  })
})

describe('ActivityPage：缺字幕集数汇总', () => {
  it('按 seriesId 汇总 pending.series 的逐季 missing', async () => {
    stub(
      PENDING({ series: [
        { seriesId: 's1', seriesName: 'Silo', season: 1, missing: 3, throttled: 0, nextRecheckAt: null, sampleReason: null },
        { seriesId: 's1', seriesName: 'Silo', season: 2, missing: 4, throttled: 0, nextRecheckAt: null, sampleReason: null },
      ] }),
      WORKERS({ running: [runningRow()] }),
    )
    renderPage()
    // 3 + 4 = 7 集缺字幕
    await waitFor(() => expect(screen.getByText(/7 集缺字幕/)).toBeInTheDocument())
  })

  it('该剧不在 pending 里 → 不渲染那行（不编一个 0）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    renderPage()
    await waitFor(() => expect(screen.getByText('Silo')).toBeInTheDocument())
    expect(screen.queryByText(/集缺字幕/)).not.toBeInTheDocument()
  })
})

describe('ActivityPage：铁律回归锁', () => {
  it('铁律③：整页 textContent 不含机械词汇', async () => {
    stub(
      PENDING({ series: [{ seriesId: 's1', seriesName: 'Silo', season: 1, missing: 2, throttled: 0, nextRecheckAt: null, sampleReason: null }] }),
      WORKERS({ running: [runningRow()], recent: [recentRow()] }),
    )
    const { container } = renderPage()
    // Silo 会在 hero/队列/完成段各出现一次，用 findAllByText 而非 getByText（后者要求唯一）
    await waitFor(async () => expect((await screen.findAllByText('Silo')).length).toBeGreaterThan(0))
    expect(container.textContent).not.toMatch(/agent|orchestrator|worker|\bpass\b|asset|ledger/i)
  })
})

// ── 发动机开关（Spec C §5.3 的落点在 hero，写路径归容器）
//
// hero 那边测的是「给了 prop 就渲染、拨一下就调回调」；这里测的是容器的三件事：状态从哪来、
// 拿不到状态时画成什么、拨一下之后**网络上真的发生了什么**。
//
// 每条都先 await 剧名再**同步**查开关：这样接线没做时是 getByRole 立刻抛，而不是 findByRole
// 干等 5 秒（setupTests.ts:9 把 RTL 的 asyncUtilTimeout 提到了 5000）——6 条用例的红要
// 秒回，不是等半分钟。
describe('ActivityPage：发动机开关', () => {
  /** 命中过 /api/v2/settings 的 PUT 请求（fetch 层，不看 api 层）。 */
  const puts = () => vi.mocked(globalThis.fetch).mock.calls.filter(
    ([u, init]) => String(u).includes('/api/v2/settings') && init?.method === 'PUT',
  )
  /** 命中过 setup/status 的请求次数——用来看 reload 有没有真的回读。 */
  const statusHits = () => vi.mocked(globalThis.fetch).mock.calls.filter(
    ([u]) => String(u).includes('/setup/status'),
  ).length

  it('在跑 hero 上挂着开关，且照服务端真值渲染（状态来自 setup/status，不是本地 state）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    renderPage()
    await screen.findByText('Silo')
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
  })

  it('engineEnabled=false → 开关照实渲染成关态（守 `|| true` 那类手滑）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }), { ...SETUP, engineEnabled: false })
    renderPage()
    await screen.findByText('Silo')
    // 写成 `setup.data?.engineEnabled || true` 的话这里会是 'true'——引擎真的关了也画成开，
    // 「关」这个态从此在屏上不存在，而别的锁都不会响。
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
  })

  it('setup/status 拉不到 → 开关仍在场且为开（失败开放：宁可少报也不诬告后端停工）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }), null)
    renderPage()
    await screen.findByText('Silo')
    await waitFor(() => expect(statusHits()).toBeGreaterThan(0))
    // 写成 `?? false` / `!!setup.data?.engineEnabled` 的话这里是 'false'——守卫仍成立、开关
    // 还在场，只是把「在干活」画成了「已停工」。所以必须断言 aria-checked，不能只断言在场。
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })

  it('并发两条在跑 → 全屏只有一个开关（发动机是全局的，不是每个任务一台）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow(), runningRow({ jobId: 8 })] }))
    renderPage()
    expect(await screen.findAllByText('Silo')).toHaveLength(2)
    // 两条 hero 各挂一个的话这里是 2：同一个全局状态在屏上出现两次，拨一个另一个跟着变。
    expect(screen.getAllByRole('switch')).toHaveLength(1)
    expect(screen.getAllByTestId('activity-hero-engine')).toHaveLength(1)
  })

  it('拨掉开关 → PUT /api/v2/settings body 是 { engine_enabled: "false" }，并立刻回读一次', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    renderPage()
    await screen.findByText('Silo')
    const before = statusHits()
    fireEvent.click(screen.getByRole('switch'))
    // 断在 fetch 层而不是 spy 在 api.updateSettings 上：这样连「客户端有没有把 patch 正确
    // 序列化进 body」也一起锁住了（mutate() 的 body 是 JSON.stringify(patch)）。
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(JSON.parse(String(puts()[0]![1]!.body))).toEqual({ engine_enabled: 'false' })
    // reload：不等 15 秒轮询就把新态取回来。首载那一次不算，所以比基线大才算。
    await waitFor(() => expect(statusHits()).toBeGreaterThan(before))
  })

  it('PUT 失败 → 开关纹丝不动（受控件，位移只随回读），且仍然回读（catch 不吞，把失败交给受控值表达）', async () => {
    stub(PENDING(), WORKERS({ running: [runningRow()] }))
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new Error('boom'))
    renderPage()
    await screen.findByText('Silo')
    const before = statusHits()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(statusHits()).toBeGreaterThan(before))
    // 开关是全受控件，真值只在 setup.data.engineEnabled——拇指从头到尾没动过：点击只发出 PUT，
    // 位移要等回读落地；PUT 失败后回读拿到的还是「开」，aria-checked 保持 'true'。
    // 「拨了没反应」就是诚实的失败信号（本屏无 toast 承接错误，L7）。
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  })
})
