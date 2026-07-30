// web/src/subtitleVerify/InspectPanel.test.tsx：检视面板 + diagnose() 的形状判据。
//
// diagnose 是这个面板最要紧的逻辑：它决定**给不给校正按钮**。判错的代价是让用户点一个
// 修不好的按钮（drift 被当成 shift），或者藏起一个本该有的按钮（反之）。所以它的测试
// 直接用两轨时间戳构造四种真实形态，不 mock。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { InspectPanel, diagnose } from './InspectPanel.js'
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

// ── diagnose：决定给不给校正按钮 ────────────────────────────────────────────
describe('diagnose：从两轨形状判断平移能否修好', () => {
  it('整体等量偏移 → shift（可校正）', () => {
    expect(diagnose(blocks(20), blocks(20, 8_300))).toBe('shift')
  })

  it('负向整体偏移（字幕偏早）同样是 shift', () => {
    expect(diagnose(blocks(20), blocks(20, -5_000))).toBe('shift')
  })

  // 帧率不匹配的形态：偏移随集数线性增长。平移修不好，所以必须判 drift 而不是 shift——
  // 判错会让用户点一个修不好的按钮。
  it('偏移越往后越大 → drift（平移修不好，不给按钮）', () => {
    expect(diagnose(blocks(30), blocks(30, 1_000, 400))).toBe('drift')
  })

  it('cue 太少（< 6）→ unknown，不敢判', () => {
    expect(diagnose(blocks(3), blocks(3, 8_300))).toBe('unknown')
  })

  it('两端都几乎无偏移 → unknown（数据可能已过期，不谎报有问题）', () => {
    expect(diagnose(blocks(20), blocks(20, 50))).toBe('unknown')
  })

  it('空数组不崩', () => {
    expect(diagnose([], [])).toBe('unknown')
  })

  it('两轨长度不等时按较短的算，不崩', () => {
    expect(diagnose(blocks(20), blocks(8, 8_300))).toBe('shift')
  })

  // 阈值留了余量（1.5 倍 + 200ms）：字幕组手工微调会让单条 cue 有噪声，
  // 一两条不该翻转整体结论。
  it('轻微噪声不足以从 shift 翻成 drift', () => {
    const ours = blocks(20, 8_300)
    ours[7] = { ...ours[7]!, startMs: ours[7]!.startMs + 900 }   // 单条抖 900ms
    expect(diagnose(blocks(20), ours)).toBe('shift')
  })
})

// ── 结论条与按钮 ──────────────────────────────────────────────────────────
describe('InspectPanel：结论条', () => {
  it('shift → 显示校正按钮 + 保留原样', () => {
    renderPanel()
    expect(screen.getByText('校正时间轴')).toBeInTheDocument()
    expect(screen.getByText('保留原样')).toBeInTheDocument()
  })

  it('点校正按钮触发 onCorrect', () => {
    const onCorrect = vi.fn()
    renderPanel({ onCorrect })
    fireEvent.click(screen.getByText('校正时间轴'))
    expect(onCorrect).toHaveBeenCalledTimes(1)
  })

  // spec §5：帧率不匹配检出后如实告知"平移修不了"，**不提供按钮**。
  it('drift → 不给校正按钮，只有"知道了"', () => {
    renderPanel({ data: dto({ reference: blocks(30), ours: blocks(30, 1_000, 400) }) })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
    expect(screen.getByText('知道了')).toBeInTheDocument()
    expect(screen.getByText(/越往后偏得越多/)).toBeInTheDocument()
  })

  it('unknown → 同样不给校正按钮', () => {
    renderPanel({ data: dto({ reference: blocks(3), ours: blocks(3, 8_300) }) })
    expect(screen.queryByText('校正时间轴')).not.toBeInTheDocument()
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
  it('cloud 且 shift → 校正按钮仍在，并说明没有图可看', () => {
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
})
