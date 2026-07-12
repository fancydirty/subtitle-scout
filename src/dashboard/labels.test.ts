// src/dashboard/labels.test.ts
import { describe, it, expect } from 'vitest'
import { decisionLabel, queueStatusLabel } from './labels.js'

describe('decisionLabel', () => {
  it('maps every decision to plain-language label + tone, no jargon', () => {
    expect(decisionLabel('download')).toEqual({ label: '已下好中文字幕', tone: 'ok' })
    expect(decisionLabel('adopted_local')).toEqual({ label: '整理好了本地已有的字幕', tone: 'ok' })
    expect(decisionLabel('already_exists')).toEqual({ label: '本来就有字幕，跳过', tone: 'skip' })
    expect(decisionLabel('no_safe_match')).toEqual({ label: '暂时没找到合适的中文字幕', tone: 'muted' })
    expect(decisionLabel('retry_later')).toEqual({ label: '过阵子再试', tone: 'muted' })
    expect(decisionLabel('error')).toEqual({ label: '出错，稍后重试', tone: 'fail' })
  })
  it('falls back safely on unknown decision without leaking the raw enum', () => {
    expect(decisionLabel('some_new_enum')).toEqual({ label: '已处理', tone: 'muted' })
  })
  it('unknown/removed decision values fall back to neutral wording (e.g. the retired ask_user)', () => {
    expect(decisionLabel('ask_user')).toEqual({ label: '已处理', tone: 'muted' })
  })
})

describe('realigned 决策标签', () => {
  it('realigned → 人话标签 + ok 语气', () => {
    expect(decisionLabel('realigned')).toEqual({ label: '把乱排布的剧集整理好了', tone: 'ok' })
  })
})

describe('queueStatusLabel', () => {
  it('maps queue states to plain language', () => {
    expect(queueStatusLabel('pending')).toBe('排队等待中')
    expect(queueStatusLabel('dormant')).toBe('多次没找到，暂缓')
  })
})
