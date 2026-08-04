// watch 启动告警纯函数测试（同 dashboardTokenWarning.test.ts 模式）
import { describe, it, expect } from 'vitest'
import { zeroRootsWarningLine, rootsMismatchWarningLine, zeroSubtitleSourcesWarningLine, setupModeWarningLine } from './watchStartupWarnings.js'

describe('watchStartupWarnings', () => {
  describe('zeroRootsWarningLine（零守备目录告警）', () => {
    it('返回固定文案（不含路径，因为 roots 为空）', () => {
      const line = zeroRootsWarningLine()
      expect(line).toContain('[watch] no media roots configured')
      expect(line).toContain('去 dashboard 加一个守备目录')
      expect(line).toContain('或设 MEDIA_ROOTS 作首启种子')
    })
  })

  describe('rootsMismatchWarningLine（env/DB roots 不一致告警）', () => {
    it('env 为空 → 不告警（清空 env 是合法操作，DB 是唯一真相）', () => {
      expect(rootsMismatchWarningLine([], ['/media/movies'])).toBeNull()
    })

    it('env 与 DB 一致 → 不告警', () => {
      expect(rootsMismatchWarningLine(['/media/movies'], ['/media/movies'])).toBeNull()
    })

    it('env 与 DB 不一致 → 告警，文案含两侧值和"以 dashboard 设置页为准"', () => {
      const line = rootsMismatchWarningLine(['/media/movies', '/media/tv'], ['/media/movies'])
      expect(line).toContain('[watch] ⚠️ MEDIA_ROOTS env (/media/movies,/media/tv)')
      expect(line).toContain('与当前生效的守备目录 (/media/movies) 不一致')
      expect(line).toContain('以 dashboard 设置页为准')
      expect(line).toContain('env 仅首启种子')
    })

    it('env 多一个 root → 告警（DB 缺 env 的 root）', () => {
      const line = rootsMismatchWarningLine(['/a', '/b'], ['/a'])
      expect(line).toContain('⚠️')
    })

    it('DB 多一个 root → 告警（env 缺 DB 的 root）', () => {
      const line = rootsMismatchWarningLine(['/a'], ['/a', '/b'])
      expect(line).toContain('⚠️')
    })

    it('顺序不同但集合相同 → 不告警（Set 判等）', () => {
      expect(rootsMismatchWarningLine(['/b', '/a'], ['/a', '/b'])).toBeNull()
    })
  })

  describe('zeroSubtitleSourcesWarningLine（零字幕源告警）', () => {
    it('全源缺失 → 告警，文案含"没有任何字幕源可用"和 ASSRT_TOKEN 提示', () => {
      const line = zeroSubtitleSourcesWarningLine({})
      expect(line).toContain('[watch] ⚠️ 没有任何字幕源可用')
      expect(line).toContain('请至少配置 ASSRT_TOKEN')
    })

    it('只配 ASSRT → 不告警', () => {
      expect(zeroSubtitleSourcesWarningLine({ ASSRT_TOKEN: 'tok' })).toBeNull()
    })

    it('只配 OpenSubtitles 三件套 → 不告警', () => {
      expect(zeroSubtitleSourcesWarningLine({
        OPENSUBTITLES_API_KEY: 'key',
        OPENSUBTITLES_USERNAME: 'user',
        OPENSUBTITLES_PASSWORD: 'pass',
      })).toBeNull()
    })

    it('OpenSubtitles 缺 username/password → 告警（三件套缺一不可）', () => {
      const line = zeroSubtitleSourcesWarningLine({ OPENSUBTITLES_API_KEY: 'key' })
      expect(line).toContain('⚠️')
    })

    it('只启用 zimuku → 不告警', () => {
      expect(zeroSubtitleSourcesWarningLine({ ZIMUKU_ENABLED: 'true' })).toBeNull()
    })

    it('只启用 subhd → 不告警', () => {
      expect(zeroSubtitleSourcesWarningLine({ SUBHD_ENABLED: 'true' })).toBeNull()
    })

    it('只配 jimaku → 不告警', () => {
      expect(zeroSubtitleSourcesWarningLine({ JIMAKU_API_KEY: 'key' })).toBeNull()
    })

    it('多源同时配置 → 不告警', () => {
      expect(zeroSubtitleSourcesWarningLine({ ASSRT_TOKEN: 'tok', JIMAKU_API_KEY: 'key' })).toBeNull()
    })
  })

  describe('setupModeWarningLine（setup 模式警告）', () => {
    it('setupModeWarningLine：含 dashboard 指路 + gated 事实', () => {
      const line = setupModeWarningLine()
      expect(line).toContain('SETUP MODE')
      expect(line).toContain('setup wizard')
      expect(line).toContain('gated')
    })
  })
})
