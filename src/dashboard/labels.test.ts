// src/dashboard/labels.test.ts
import { describe, it, expect } from 'vitest'
import { decisionLabel, queueStatusLabel } from './labels.js'

describe('decisionLabel', () => {
  it('maps every decision to plain-language label + tone, no jargon', () => {
    expect(decisionLabel('download')).toEqual({ label: '已下好中文字幕', tone: 'ok' })
    expect(decisionLabel('adopted_local')).toEqual({ label: '整理好了本地已有的字幕', tone: 'ok' })
    expect(decisionLabel('already_exists')).toEqual({ label: '本来就有字幕，跳过', tone: 'skip' })
    expect(decisionLabel('no_safe_match')).toEqual({ label: '暂时没找到合适的中文字幕', tone: 'muted' })
    expect(decisionLabel('ask_user')).toEqual({ label: '需要你确认一下', tone: 'muted' })
    expect(decisionLabel('retry_later')).toEqual({ label: '过阵子再试', tone: 'muted' })
    expect(decisionLabel('error')).toEqual({ label: '出错，稍后重试', tone: 'fail' })
  })
  it('falls back safely on unknown decision without leaking the raw enum', () => {
    expect(decisionLabel('some_new_enum')).toEqual({ label: '已处理', tone: 'muted' })
  })
})

describe('queueStatusLabel', () => {
  it('maps queue states to plain language', () => {
    expect(queueStatusLabel('pending')).toBe('排队等待中')
    expect(queueStatusLabel('dormant')).toBe('多次没找到，暂缓')
  })
})
