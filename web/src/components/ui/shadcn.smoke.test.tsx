import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Badge } from './badge.js'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js'
import { Skeleton } from './skeleton.js'
import { openRadixSelect } from '../../testSupport/radix.js'

describe('shadcn copy-in smoke', () => {
  it('dialog 打开后按 Escape 关闭', async () => {
    render(
      <Dialog>
        <DialogTrigger>open</DialogTrigger>
        <DialogContent>
          <DialogTitle className="sr-only">Run detail</DialogTitle>
          body
        </DialogContent>
      </Dialog>,
    )
    fireEvent.click(screen.getByText('open'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('select 关闭时选项不可及，pointerdown 打开后可及', async () => {
    render(
      <Select>
        <SelectTrigger aria-label="Hardsub assumption">
          <SelectValue placeholder="Pick one" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">Off</SelectItem>
          <SelectItem value="agent">Agent</SelectItem>
        </SelectContent>
      </Select>,
    )
    const trigger = screen.getByRole('combobox', { name: 'Hardsub assumption' })
    expect(screen.queryByRole('option', { name: 'Off', hidden: true })).toBeNull()
    openRadixSelect(trigger)
    expect(await screen.findByRole('option', { name: 'Off', hidden: true })).toBeInTheDocument()
  })

  it('badge 出文案、skeleton 按 index 排错动画延迟', () => {
    render(
      <>
        <Badge variant="secondary">Running</Badge>
        <Skeleton className="h-3 w-1/2 rounded-sm" data-testid="sk" index={2} />
      </>,
    )
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByTestId('sk')).toHaveStyle({ animationDelay: '1200ms' })
  })
})
