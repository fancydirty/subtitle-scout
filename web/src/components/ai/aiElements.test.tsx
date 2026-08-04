import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Shimmer, shimmerSpreadPx } from './shimmer.js'
import { Queue, QueueItem, QueueList } from './queue.js'
import { Task, TaskContent, TaskTrigger } from './task.js'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from './tool.js'

describe('AI Elements copy-in · shimmer', () => {
  it('高光宽度按字符数摊开', () => {
    // 'Planning work' 13 字符 × 每字符 2px。这是 shimmer 里唯一的真实逻辑，直接断言纯函数，
    // 不去读 motion 写进 DOM 的 --spread 内联变量（那是第三方 style 合并的实现细节）。
    expect(shimmerSpreadPx('Planning work')).toBe(26)
    expect(shimmerSpreadPx('')).toBe(0)
  })

  it('渲染成行内 span，文本原样出现', () => {
    render(<Shimmer>Planning work</Shimmer>)
    // 固定 span（不是官方源默认的 <p>）：传送带行自己是块级容器，shimmer 只负责那段字。
    expect(screen.getByText('Planning work').tagName).toBe('SPAN')
  })
})

describe('AI Elements copy-in · queue', () => {
  it('Queue/QueueList/QueueItem 给出真正的列表语义', () => {
    render(
      <Queue>
        <QueueList>
          <QueueItem>The Rig, Season 2</QueueItem>
          <QueueItem>Peacemaker, Season 2</QueueItem>
        </QueueList>
      </Queue>,
    )

    expect(screen.getByRole('list')).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

describe('AI Elements copy-in · task', () => {
  it('默认展开，点区头收起内容', () => {
    render(
      <Task>
        <TaskTrigger title="8 files" />
        <TaskContent>Peacemaker.S02E03.mkv</TaskContent>
      </Task>,
    )

    // Task 的 defaultOpen 默认为 true（官方源如此，与 Tool 不同）。
    expect(screen.getByText('Peacemaker.S02E03.mkv')).toBeInTheDocument()

    // 不能用 getByRole('button') 找区头：官方源的默认触发器是 CollapsibleTrigger asChild 套一个
    // <div>，Radix 只把 props 合并上去，不会补 role="button"。这个 a11y wart 原样保留——
    // Task 22-24 接线时会传自己的 <button> 当 children（§5.5 的组头有三段信息）。
    fireEvent.click(screen.getByText('8 files'))
    expect(screen.queryByText('Peacemaker.S02E03.mkv')).not.toBeInTheDocument()
  })
})

describe('AI Elements copy-in · tool', () => {
  it('展开时给出工具名、状态徽标、入参与结果', () => {
    render(
      <Tool defaultOpen>
        <ToolHeader state="completed" title="find_subtitle" />
        <ToolContent>
          <ToolInput input="series=The Rig, season=2" />
          <ToolOutput errorText={null} output="installed 3 subtitles" />
        </ToolContent>
      </Tool>,
    )

    // 回放路径显示的是原始工具名（技术值），不套人话短语——见 tool.tsx 里的注释。
    expect(screen.getByText('find_subtitle')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.getByText('series=The Rig, season=2')).toBeInTheDocument()
    expect(screen.getByText('Result')).toBeInTheDocument()
    expect(screen.getByText('installed 3 subtitles')).toBeInTheDocument()
  })

  it('running 态用官方那个词', () => {
    render(
      <Tool defaultOpen>
        <ToolHeader state="running" title="find_subtitle" />
      </Tool>,
    )

    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('不传 defaultOpen 时默认收起（与 Task 的刻意不对称）', () => {
    render(
      <Tool>
        <ToolHeader state="completed" title="find_subtitle" />
        <ToolContent>
          <ToolInput input="x=1" />
        </ToolContent>
      </Tool>,
    )
    expect(screen.getByText('find_subtitle')).toBeInTheDocument()
    expect(screen.queryByText('Parameters')).not.toBeInTheDocument()
  })

  it('结果与错误双空时整块不渲染', () => {
    // resultSummary 允许是空串。没有这条短路，界面上会多出一个只有 "Result" 标题的空块。
    const { container } = render(<ToolOutput errorText={null} output="" />)

    expect(container).toBeEmptyDOMElement()
  })

  it('有 errorText 时标题词换成 Error，结果块让位', () => {
    render(<ToolOutput errorText="provider timed out" output="" />)

    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.queryByText('Result')).not.toBeInTheDocument()
    expect(screen.getByText('provider timed out')).toBeInTheDocument()
  })
})
