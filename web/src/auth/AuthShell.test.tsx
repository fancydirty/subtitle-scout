import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AuthShell } from './AuthShell.js'

afterEach(cleanup)

describe('AuthShell（鉴权 A2 Task 8′：三 auth 屏共享外壳，全站唯一 serif 落此）', () => {
  it('heading 渲染在 <h1>', () => {
    render(<AuthShell heading="Create the admin account"><p>body</p></AuthShell>)
    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1).toHaveTextContent('Create the admin account')
  })

  it('<h1> 落在约定的 serif class 上（DESIGN 铁律：衬线全站只此一处）', () => {
    render(<AuthShell heading="Sign in"><p>body</p></AuthShell>)
    expect(screen.getByRole('heading', { level: 1 }).className).toContain('auth-shell__title')
  })

  it('children 渲染在标题之下', () => {
    render(<AuthShell heading="X"><button>the-form</button></AuthShell>)
    expect(screen.getByRole('button', { name: 'the-form' })).toBeInTheDocument()
  })
})
