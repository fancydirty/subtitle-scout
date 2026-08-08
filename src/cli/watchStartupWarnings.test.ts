// watch 启动告警纯函数测试（同 dashboardTokenWarning.test.ts 模式）
import { describe, it, expect } from 'vitest'
import { zeroRootsWarningLine, rootsMismatchWarningLine, zeroSubtitleSourcesWarningLine, setupModeWarningLine, nestedRootSkipWarning } from './watchStartupWarnings.js'

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

  // D7（2026-08-08）：env 顺序静默决定守备范围（先写的赢）。运维配 3 个根只生效 2 个时，
  // 没这行日志只能靠猜——所以文案必须说清跳了谁、为什么、后果是什么。
  describe('nestedRootSkipWarning（MEDIA_ROOTS 跳过告警）', () => {
    it('child 方向：点名被跳的路径与撞上的根，并说明方向', () => {
      const line = nestedRootSkipWarning({
        path: '/media/tv/anime', reason: 'nested',
        conflict: { root: '/media/tv', relation: 'child' },
      })
      expect(line).toContain('/media/tv/anime')
      expect(line).toContain('/media/tv')
      expect(line).toContain('子目录')
    })

    it('parent 方向：方向描述反过来', () => {
      const line = nestedRootSkipWarning({
        path: '/media', reason: 'nested',
        conflict: { root: '/media/tv', relation: 'parent' },
      })
      expect(line).toContain('包含后者')
    })

    it('说明后果——重复扫描 + 子根的行会被删除清理误清（C29 的用户可见表述）', () => {
      const line = nestedRootSkipWarning({
        path: '/a/b', reason: 'nested', conflict: { root: '/a', relation: 'child' },
      })
      expect(line).toContain('重复')
      expect(line).toContain('消失的文件')
    })

    // 审校 F6：相对路径若 resolve() 会静默落到 <cwd>/...，容器里是 /app/...
    it('not-absolute：说明会落到工作目录，且要求写绝对路径', () => {
      const line = nestedRootSkipWarning({ path: 'media/tv', reason: 'not-absolute' })
      expect(line).toContain('media/tv')
      expect(line).toContain('绝对路径')
      expect(line).toContain('/app')
    })
  })
})
