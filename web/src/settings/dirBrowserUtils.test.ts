// web/src/settings/dirBrowserUtils.test.ts：目录浏览器工具函数测试（R6 UX 改进）
import { describe, it, expect } from 'vitest'
import { isSystemDir, filterSystemDirs, getDefaultStartPath } from './dirBrowserUtils.js'

describe('dirBrowserUtils', () => {
  describe('isSystemDir', () => {
    it('identifies Linux system directories', () => {
      expect(isSystemDir('/dev')).toBe(true)
      expect(isSystemDir('/proc')).toBe(true)
      expect(isSystemDir('/sys')).toBe(true)
      expect(isSystemDir('/tmp')).toBe(true)
      expect(isSystemDir('/var')).toBe(true)
      expect(isSystemDir('/boot')).toBe(true)
      expect(isSystemDir('/run')).toBe(true)
      expect(isSystemDir('/lost+found')).toBe(true)
    })

    it('identifies macOS system directories', () => {
      expect(isSystemDir('/System')).toBe(true)
      expect(isSystemDir('/System/Library')).toBe(true)
      expect(isSystemDir('/Library')).toBe(true)
      expect(isSystemDir('/Library/LaunchDaemons')).toBe(true)
      expect(isSystemDir('/private')).toBe(true)
      expect(isSystemDir('/private/var')).toBe(true)
    })

    it('allows user and media directories', () => {
      expect(isSystemDir('/home')).toBe(false)
      expect(isSystemDir('/Users')).toBe(false)
      expect(isSystemDir('/media')).toBe(false)
      expect(isSystemDir('/mnt')).toBe(false)
      expect(isSystemDir('/data')).toBe(false)
      expect(isSystemDir('/opt')).toBe(false)
      expect(isSystemDir('/srv')).toBe(false)
    })

    it('allows user home directories', () => {
      expect(isSystemDir('/home/user')).toBe(false)
      expect(isSystemDir('/Users/john')).toBe(false)
      expect(isSystemDir('/root')).toBe(false)
    })
  })

  describe('filterSystemDirs', () => {
    it('filters out system directories from list', () => {
      const input = ['/dev', '/home', '/proc', '/media', '/sys', '/mnt']
      const expected = ['/home', '/media', '/mnt']
      expect(filterSystemDirs(input)).toEqual(expected)
    })

    it('keeps all directories if none are system dirs', () => {
      const input = ['/home', '/media', '/data', '/mnt']
      expect(filterSystemDirs(input)).toEqual(input)
    })

    it('returns empty array if all are system dirs', () => {
      const input = ['/dev', '/proc', '/sys', '/tmp']
      expect(filterSystemDirs(input)).toEqual([])
    })

    it('handles macOS directories', () => {
      const input = ['/System', '/Users', '/Library', '/Applications', '/private']
      const expected = ['/Users', '/Applications']
      expect(filterSystemDirs(input)).toEqual(expected)
    })
  })

  describe('getDefaultStartPath', () => {
    it('returns a non-empty string', () => {
      const path = getDefaultStartPath()
      expect(path).toBeTruthy()
      expect(typeof path).toBe('string')
      expect(path.length).toBeGreaterThan(0)
    })

    it('returns absolute path starting with /', () => {
      const path = getDefaultStartPath()
      expect(path.startsWith('/')).toBe(true)
    })
  })
})
