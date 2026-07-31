// web/src/subtitleVerify/InspectPanel.test.tsx：检视面板的渲染。
//
// **判定已不在这里**（审计 I-B1/I-B2）：面板曾自己用 diagnose() 从两轨时间戳做几何推断，
// 既丢了符号（偏早的字幕拿到"字幕比画面慢了"这句说反的话），又按下标配对（两条完全同步
// 但开头少 3 条 cue 的轨被误判成需要平移），而且它是**第二个判定引擎**、把着写按钮的闸。
// 现在 diagnosis/fixable 由后端在 compare DTO 里给出（src/dashboard/subtitleCompareApi.ts
// 的 diagnoseRow，那里有针对符号与配对的回归锁），本文件只测"给定判读，面板渲染成什么"。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { InspectPanel } from './InspectPanel.js'
import type { SubtitleCompareDTO, CompareBlock } from '../api/types.js'

const DUR = 600_000

function blocks(n: number, shiftMs = 0, driftPerCue = 0): CompareBlock[] {
  return Array.from({ length: n }, (_, i) => ({
    startMs: i * 10_000 + shiftMs + i * driftPerCue,
    endMs: i * 10_000 + 3_000 + shiftMs + i * driftPerCue,
    text: `台词${i}`,
  }))
}

function dto(over: Partial<SubtitleCompareDTO> = {}): SubtitleCompareDTO {
  return {
    itemId: 'tmdb:1/s1e1',
    reference: blocks(20),
    ours: blocks(20, 8_300),
    durationMs: DUR,
    waveformAvailable: true,
    mountKind: 'lan',
    // 默认是"字幕偏晚、平移可修"那一档（打开面板最常见的情形）。
    // 判读来自后端，测试里显式给——这正是"前端不再自己推断"的体现。
    diagnosis: 'behind',
    fixable: true,
    ...over,
  }
}

beforeEach(() => {
  class RO {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width: 800, height: 120 } } as ResizeObserverEntry], this as unknown as ResizeObserver) }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', RO)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
    { left: 0, right: 800, top: 0, bottom: 120, width: 800, height: 120, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderPanel(over: Partial<Parameters<typeof InspectPanel>[0]> = {}, lang: 'en' | 'zh' = 'zh') {
  return render(
    <I18nProvider initialLang={lang}>
      <InspectPanel
        isOpen
        onOpenChange={() => {}}
        title="Twin Peaks S02E14"
        data={dto()}
        loading={false}
        error={null}
        onCorrect={() => {}}
        {...over}
      />
    </I18nProvider>,
  )
}

// ── 结论条与按钮 ──────────────────────────────────────────────────────────
describe('InspectPanel：结论条', () => {
  it("behind（字幕偏晚，可修）→ 显示校正按钮 + 保留原样", () => {
    renderPanel()
    expect(screen.getByText('校正时间轴')).toBeInTheDocument()
    expect(screen.getByText('保留原样')).toBeInTheDocument()
    expect(screen.getByText(/字幕比画面慢了/)).toBeInTheDocument()
  })

  // 审计 I-B1：符号是白拿的（后端 offsetMs 本来就带符号），而旧的 diagnose() 只比较
  // **绝对值**，于是一个偏早的字幕拿到"字幕比画面慢了"这句**说反了**的话。
  // 说反方向和不说一样糟：用户会按错的方向去理解那张对照图。
  it("ahead（字幕偏早，可修）→ 文案说的是'快了'而不是'慢了'【I-B1】", () => {
    renderPanel({ data: dto({ diagnosis: 'ahead', fixable: true }) })
    expect(screen.getByText(/字幕比画面快了/)).toBeInTheDocument()
    expect(screen.queryByText(/字幕比画面慢了/)).not.toBeInTheDocument()
    // 偏早同样是平移能修好的，按钮照给
    expect(screen.getByText('校正时间轴')).toBeInTheDocument()
  })

  it('两个方向的文案确实不同（不是同一句话换了个 key）【I-B1】', () => {
    const { container: behind } = renderPanel({ data: dto({ diagnosis: 'behind', fixable: true }) })
    const behindText = behind.querySelector('.vinspect-verdict')!.textContent
    cleanup()
    const { container: ahead } = renderPanel({ data: dto({ diagnosis: 'ahead', fixable: true }) })
    const aheadText = ahead.querySelector('.vinspect-verdict')!.textContent
    expect(aheadText).not.toBe(behindText)
  })

  it('点校正按钮触发 onCorrect', () => {
    const onCorrect = vi.fn()
    renderPanel({ onCorrect })
    fireEvent.click(screen.getByText('校正时间轴'))
    expect(onCorrect).toHaveBeenCalledTimes(1)
  })

  // spec §5：平移修不好的（帧率不匹配、装错剧集）如实告知，**不提供按钮**。
  it('not-a-shift → 不给校正按钮，只有"知道了"', () => {
    renderPanel({ data: dto({ diagnosis: 'not-a-shift', fixable: false }) })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
    expect(screen.getByText('知道了')).toBeInTheDocument()
    expect(screen.getByText(/越往后偏得越多/)).toBeInTheDocument()
  })

  it('unknown → 同样不给校正按钮', () => {
    renderPanel({ data: dto({ diagnosis: 'unknown', fixable: false }) })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
    expect(screen.getByText(/看不出问题在哪/)).toBeInTheDocument()
  })

  // 面板只渲染、不推断：给按钮的唯一依据是后端的 fixable，前端不再从两轨形状自己算。
  // 这条同时是 I-B2 的前端侧锁——两轨长度/条数怎么样都不影响按钮的去留。
  it('按钮只看后端的 fixable，与两轨的条数/形状无关【I-B2】', () => {
    // 两轨完全同步、且 ours 少了开头 3 条（旧 diagnose 会按下标配对误判成需要平移）
    const ref = blocks(30)
    const ours = blocks(30).slice(3)
    // 后端说不可修 → 无论形状如何，都不给按钮
    renderPanel({ data: dto({ reference: ref, ours, diagnosis: 'not-a-shift', fixable: false }) })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
    cleanup()
    // 后端说可修 → 给按钮
    renderPanel({ data: dto({ reference: ref, ours, diagnosis: 'behind', fixable: true }) })
    expect(screen.getByText('校正时间轴')).toBeInTheDocument()
  })

  it('onCorrect 缺席时不渲染校正按钮（父组件还没接线）', () => {
    renderPanel({ onCorrect: undefined })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
  })

  it('correcting 中按钮 disabled 且换文案', () => {
    renderPanel({ correcting: true })
    const btn = screen.getByText('正在校正…') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})

// ── 云盘：spec §4.2.2 ─────────────────────────────────────────────────────
describe('InspectPanel：云盘条目', () => {
  it('cloud → 不渲染时间轴，改显示说明', () => {
    const { container } = renderPanel({ data: dto({ mountKind: 'cloud' }) })
    expect(container.querySelector('.cmptl')).toBeNull()
    expect(screen.getByText('网盘上的文件没法做对照')).toBeInTheDocument()
  })

  // 文案定位（用户裁决）：这是**网盘的物理限制，不是功能没做**。
  it('cloud 说明文案传达"限制"而非"未实现"，且不含技术黑话', () => {
    renderPanel({ data: dto({ mountKind: 'cloud' }) })
    const body = screen.getByText(/读一小段都要等十几秒/)
    expect(body.textContent).not.toMatch(/WebDAV|rclone|fuse|CDN|seek|ffmpeg|未实现|不支持该功能/i)
  })

  // 云盘照样能校正——检测只读字幕文件，偏移量后端已算出。这条是"仍然可做的事"。
  it('cloud 且可修 → 校正按钮仍在，并说明没有图可看', () => {
    renderPanel({ data: dto({ mountKind: 'cloud' }) })
    expect(screen.getByText('校正时间轴')).toBeInTheDocument()
    expect(screen.getByText(/仍然可以直接校正/)).toBeInTheDocument()
  })

  it('lan → 正常渲染时间轴（cifs 不被误禁，spec 判据 14）', () => {
    const { container } = renderPanel({ data: dto({ mountKind: 'lan' }) })
    expect(container.querySelector('.cmptl')).toBeTruthy()
    expect(screen.queryByText('网盘上的文件没法做对照')).not.toBeInTheDocument()
  })

  it('local → 正常渲染时间轴', () => {
    const { container } = renderPanel({ data: dto({ mountKind: 'local' }) })
    expect(container.querySelector('.cmptl')).toBeTruthy()
  })
})

// ── 台词列表 ──────────────────────────────────────────────────────────────
describe('InspectPanel：台词列表', () => {
  it('渲染台词与时刻（装错剧时扫一眼能发现）', () => {
    renderPanel()
    expect(screen.getByText('台词0')).toBeInTheDocument()
    expect(screen.getByText('台词5')).toBeInTheDocument()
  })

  it('空字幕不渲染列表容器', () => {
    const { container } = renderPanel({ data: dto({ ours: [] }) })
    expect(container.querySelector('.vinspect-cues')).toBeNull()
  })
})

// ── 加载/错误态 ───────────────────────────────────────────────────────────
describe('InspectPanel：加载与错误', () => {
  it('loading 且无数据 → 显示读取中，不渲染时间轴', () => {
    const { container } = renderPanel({ data: null, loading: true })
    expect(screen.getByText('正在读取…')).toBeInTheDocument()
    expect(container.querySelector('.cmptl')).toBeNull()
  })

  it('error → 显示错误文案', () => {
    renderPanel({ data: null, loading: false, error: '读不到这一集的字幕' })
    expect(screen.getByText('读不到这一集的字幕')).toBeInTheDocument()
  })
})

// ── 铁律回归锁 ────────────────────────────────────────────────────────────
describe('InspectPanel：铁律回归锁', () => {
  // 铁律②：分数/偏移量/参考源层级不上界面。DTO 本身就没有这些字段，这里防的是
  // 前端自己从时间戳算一个数字显示出来（比如"偏移 8.3 秒"）。
  it('铁律②：面板不显示偏移量/分数这类内部数字', () => {
    const { container } = renderPanel()
    // 结论条与云盘说明区不许出现"N 秒/N ms/0.xx"这类量化表述
    const verdict = container.querySelector('.vinspect-verdict')!
    expect(verdict.textContent).not.toMatch(/\d+\s*(ms|毫秒)/)
    expect(verdict.textContent).not.toMatch(/0\.\d\d/)
    expect(verdict.textContent).not.toMatch(/score|offset|confidence/i)
  })

  // 铁律③：不暴露机械。
  it('铁律③：全面板文案不含 agent/参考源/内嵌轨/帧率等机械词', () => {
    const { container } = renderPanel()
    expect(container.textContent).not.toMatch(/agent|orchestrator|worker|sidecar|参考源|内嵌轨|互相关|jaccard|帧率|fps/i)
  })

  // 铁律①：只有绿和红。检查没有任何黄色类名/内联色。
  it('铁律①：没有黄色/警告样式', () => {
    const { container } = renderPanel()
    expect(container.innerHTML).not.toMatch(/amber|warning|#f0b|#d29|orange/i)
  })
})

describe('InspectPanel：i18n', () => {
  it('英文渲染结论与按钮', () => {
    renderPanel({}, 'en')
    expect(screen.getByText('Fix the timing')).toBeInTheDocument()
    expect(screen.getByText(/The subtitles run behind the picture/)).toBeInTheDocument()
  })

  it('英文的两个方向也是两句不同的话【I-B1】', () => {
    renderPanel({ data: dto({ diagnosis: 'ahead', fixable: true }) }, 'en')
    expect(screen.getByText(/The subtitles run ahead of the picture/)).toBeInTheDocument()
    expect(screen.queryByText(/run behind the picture/)).not.toBeInTheDocument()
  })
})

// ── 无参考源：单轨模式（2026-07-31）──────────────────────────────────────
// 约一半条目是这一档（PGS 位图字幕 / 无同目录参考）。后端返回 200 + 空 reference 数组，
// 不是错误。单轨视图仍有用：能看出"只翻了前半集"，且用户对着画面能自己判断偏没偏。
describe('InspectPanel：无参考源', () => {
  const noRef = () => dto({ reference: [], diagnosis: 'unknown', fixable: false })

  it('结论条说"没东西可比"，而不是含糊的"看不出问题在哪"', () => {
    renderPanel({ data: noRef() })
    expect(screen.getByText('没有可以对比的东西')).toBeInTheDocument()
    expect(screen.queryByText('这里看不出问题在哪')).not.toBeInTheDocument()
  })

  // 这条是关键：文案必须告诉用户**下一步做什么**（自己放一下看看），
  // 否则"没东西可比"只是又一句没用的话。
  it('文案给出可执行的下一步（让用户自己看画面）', () => {
    renderPanel({ data: noRef() })
    expect(screen.getByText(/放一下这集/)).toBeInTheDocument()
  })

  it('仍然渲染时间轴（单轨——自己那条字幕的分布有诊断价值）', () => {
    const { container } = renderPanel({ data: noRef() })
    expect(container.querySelector('.cmptl')).toBeTruthy()
  })

  it('不给校正按钮（没有基准，任何偏移量都是编的）', () => {
    renderPanel({ data: noRef() })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
    expect(screen.getByText('知道了')).toBeInTheDocument()
  })

  it('台词列表仍在（装错剧时扫一眼就能发现）', () => {
    renderPanel({ data: noRef() })
    expect(screen.getByText('台词0')).toBeInTheDocument()
  })

  // 有参考源时不该走这套文案。
  it('有参考源 → 用正常的判读文案', () => {
    renderPanel({ data: dto({ diagnosis: 'behind', fixable: true }) })
    expect(screen.queryByText('没有可以对比的东西')).not.toBeInTheDocument()
  })
})
