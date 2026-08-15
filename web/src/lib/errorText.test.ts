// errorText.test.ts：审计 P0-7 的映射锁。中文界面必须看到中文原因；en 和未知串必须原样。
import { describe, it, expect } from 'vitest'
import { localizeError, localizeErrorValue } from './errorText.js'

describe('localizeError', () => {
  it('en 原样返回（后端契约是英文技术串）', () => {
    expect(localizeError('path does not exist', 'en')).toBe('path does not exist')
  })

  it.each([
    ['path does not exist', '路径不存在'],
    ['path is not readable (permission denied?)', '目录不可读（权限不足？）'],
    ['not a media root', '不是守备目录'],
    ['db locked', '数据库忙，请稍后重试。'],
    ['Failed to fetch', '无法连接服务器，请确认服务正在运行。'],
  ])('zh 映射 %s', (raw, expected) => {
    expect(localizeError(raw, 'zh')).toBe(expected)
  })

  it('带 Error: 前缀的异常消息也能映射', () => {
    expect(localizeErrorValue(new Error('path is not a directory'), 'zh')).toBe('路径不是目录')
  })

  it('未知错误原样返回（诚实优先于好看）', () => {
    expect(localizeError('kaboom', 'zh')).toBe('kaboom')
  })
})
