import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { AspectRatio } from './aspect-ratio.js'
import { Banner } from './banner.js'
import { EmptyState } from './empty-state.js'
import { Kbd } from './kbd.js'
import { Section } from './section.js'
import { Segmented } from './segmented.js'
import { Separator } from './separator.js'
import { StatusDot } from './status-dot.js'

describe('自绘 primitive 的 role 契约', () => {
  it('EmptyState 是 role=status，标题是 heading，描述不是 <p>', () => {
    render(<EmptyState description="Nothing parked right now." title="All clear" />)
    const region = screen.getByRole('status')
    expect(region).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'All clear' })).toBeInTheDocument()
    // 描述必须是 <div>：调用点会往 EmptyState 里塞块级内容，<p> 不能合法包块级子节点，
    // 浏览器解析器会把它拆出去，导致 SSR/hydration 结构不一致。
    expect(screen.getByText('Nothing parked right now.').tagName).toBe('DIV')
  })

  it('StatusDot 无 label 时对无障碍树隐身', () => {
    render(
      <>
        <StatusDot data-testid="dot" variant="success" />
        <span>Deployed</span>
      </>,
    )
    expect(screen.getByTestId('dot')).toHaveAttribute('aria-hidden', 'true')
  })

  it('StatusDot 传 label 时升级为 role=img（本仓三个调用点全走这条）', () => {
    render(<StatusDot variant="error" label="Failed" />)
    expect(screen.getByRole('img', { name: 'Failed' })).toBeInTheDocument()
  })

  it('Kbd 是 role=img 且可读名由按键组合拼出（jsdom 非苹果平台 → Control）', () => {
    render(<Kbd keys="mod+k" />)
    expect(screen.getByRole('img', { name: 'Control + K' })).toBeInTheDocument()
  })

  it('Kbd 单键也走同一条拼名路径', () => {
    render(<Kbd keys="escape" />)
    expect(screen.getByRole('img', { name: 'Escape' })).toBeInTheDocument()
  })

  it('Section 渲染子节点', () => {
    render(
      <Section>
        <span>panel body</span>
      </Section>,
    )
    expect(screen.getByText('panel body')).toBeInTheDocument()
  })

  it('Separator 是 role=separator 且带 aria-orientation', () => {
    render(<Separator />)
    const sep = screen.getByRole('separator')
    expect(sep).toHaveAttribute('aria-orientation', 'horizontal')
  })

  it('AspectRatio 把比例落在 style 上', () => {
    render(
      <AspectRatio data-testid="ar" fit="cover" ratio={2 / 3}>
        <img alt="" src="/p.jpg" />
      </AspectRatio>,
    )
    expect(screen.getByTestId('ar').style.aspectRatio).toBe(String(2 / 3))
  })

  it('Segmented 是 radiogroup + radio，并回调选中值', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        items={[
          { label: 'Has gaps', value: 'gaps' },
          { label: 'Fully covered', value: 'covered' },
        ]}
        label="Library filter"
        onChange={onChange}
        value="gaps"
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'Library filter' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Has gaps' })).toHaveAttribute('aria-checked', 'true')
    const other = screen.getByRole('radio', { name: 'Fully covered' })
    expect(other).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(other)
    expect(onChange).toHaveBeenCalledWith('covered')
  })

  it('Segmented 换 value 重渲染时 aria-checked 跟着翻', () => {
    const { rerender } = render(
      <Segmented items={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]} label="x" onChange={() => {}} value="a" />,
    )
    expect(screen.getByRole('radio', { name: 'A' })).toHaveAttribute('aria-checked', 'true')
    rerender(<Segmented items={[{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }]} label="x" onChange={() => {}} value="b" />)
    expect(screen.getByRole('radio', { name: 'B' })).toHaveAttribute('aria-checked', 'true')
  })

  it('Banner warning 是 role=alert 且自带状态图标', () => {
    render(<Banner status="warning" title="Translation is paused." />)
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Translation is paused.')
    // Astryx Banner 在未传 icon 时会渲染一个默认状态图标（Banner.tsx: {icon ?? <Icon …/>}），
    // 本仓唯一调用点就没传 icon——不复刻默认图标等于 Task 31 静默删掉一个屏幕上看得见的字形。
    expect(alert.querySelector('svg')).not.toBeNull()
  })

  it('Banner success 是 role=status（非警报）', () => {
    render(<Banner status="success" title="All roots reachable." />)
    expect(screen.getByRole('status')).toHaveTextContent('All roots reachable.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Banner error 是 role=alert', () => {
    render(<Banner status="error" title="Save failed." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Save failed.')
  })
})
