import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Shimmer, shimmerSpreadPx } from './shimmer.js'
import { Queue, QueueItem, QueueList } from './queue.js'

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
