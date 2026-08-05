import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { SettingsCard } from './SettingsCard.js'

afterEach(cleanup)

describe('SettingsCard', () => {
  it('渲染标题与描述', () => {
    render(<SettingsCard title="Engine" description="Master switch">body</SettingsCard>)
    expect(screen.getByText('Engine')).toBeInTheDocument()
    expect(screen.getByText('Master switch')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
  })

  it('configured 状态显示绿色已配置 badge', () => {
    render(<SettingsCard title="X" status="configured">b</SettingsCard>)
    expect(screen.getByText('✓ Configured')).toBeInTheDocument()
  })

  it('unconfigured 状态显示黄色未配置 badge', () => {
    render(<SettingsCard title="X" status="unconfigured">b</SettingsCard>)
    expect(screen.getByText('⚠ Not configured')).toBeInTheDocument()
  })

  it('locked 状态显示灰色环境变量 badge', () => {
    render(<SettingsCard title="X" status="locked">b</SettingsCard>)
    expect(screen.getByText('🔒 Environment')).toBeInTheDocument()
  })

  it('无 status 不渲染 badge', () => {
    render(<SettingsCard title="X">b</SettingsCard>)
    expect(screen.queryByText('✓ Configured')).not.toBeInTheDocument()
  })
})