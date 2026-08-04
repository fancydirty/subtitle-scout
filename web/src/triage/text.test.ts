// web/src/triage/text.test.ts：甄别区纯函数——路径处理（pathTail/dirnameOf）、目录分组
// （groupPending，验收修复轮一 Task V2）与双语动态文案（fileCountLabel/moreLabel）。
import { describe, it, expect } from 'vitest'
import {
  pathTail, dirnameOf, groupPending, fileCountLabel, moreLabel, groupParkTimeLine,
  checkedAgoLine, timingRowLabel, dormantReasonLine, type DirGroup,
} from './text.js'
import type { ParkedItemDTO } from '../api/types.js'

describe('pathTail', () => {
  it('绝对路径 → 最后一段文件名', () => {
    expect(pathTail('/media/tv/Show A/S01/ep1.mkv')).toBe('ep1.mkv')
  })
  it('无斜杠（防御性）→ 原样返回', () => {
    expect(pathTail('ep1.mkv')).toBe('ep1.mkv')
  })
})

describe('dirnameOf（POSIX dirname 语义）', () => {
  it('常规绝对路径', () => {
    expect(dirnameOf('/media/tv/Show A/S01/ep1.mkv')).toBe('/media/tv/Show A/S01')
  })
  it('根下文件 → "/"', () => {
    expect(dirnameOf('/ep1.mkv')).toBe('/')
  })
  it('裸文件名（防御性）→ "."', () => {
    expect(dirnameOf('ep1.mkv')).toBe('.')
  })
})

function row(path: string, parkReason = 'ambiguous match'): ParkedItemDTO {
  return { path, parkReason, firstSeen: 0, lastAttempt: 0 }
}

describe('groupPending——按 dirname 分组 + excluded-extra 翻案桶', () => {
  it('actionable：按目录分组，组内按 path 排序、组间按文件数降序', () => {
    const { actionable, excluded } = groupPending([
      row('/media/tv/Show B/ep1.mkv'),
      row('/media/tv/Show A/S01/ep2.mkv'),
      row('/media/tv/Show A/S01/ep1.mkv'),
    ])
    expect(excluded).toEqual([])
    expect(actionable).toEqual([
      {
        dir: '/media/tv/Show A/S01',
        dirTail: 'S01',
        files: [row('/media/tv/Show A/S01/ep1.mkv'), row('/media/tv/Show A/S01/ep2.mkv')],
      },
      {
        dir: '/media/tv/Show B',
        dirTail: 'Show B',
        files: [row('/media/tv/Show B/ep1.mkv')],
      },
    ])
  })

  // duplicates 桶已退役（P2 起 ingest 不再产 duplicate-content 停车行，见 text.ts 头注释）——
  // 历史遗留的 duplicate-content 行不再单独分桶，随其余非 excluded-extra 的行一起落进
  // actionable，跟其他待识别行同等对待，不会凭空消失于 UI。
  it('历史遗留的 duplicate-content 行 → 不再单独分桶，随其余行一起进 actionable（duplicates 桶退役）', () => {
    const { actionable, excluded } = groupPending([
      row('/media/tv/Show A/ep1.mkv', 'ambiguous match'),
      row('/media/tv/Show A/ep2.mkv', 'duplicate-content'),
    ])
    expect(excluded).toEqual([])
    expect(actionable).toEqual([
      {
        dir: '/media/tv/Show A',
        dirTail: 'Show A',
        files: [
          row('/media/tv/Show A/ep1.mkv', 'ambiguous match'),
          row('/media/tv/Show A/ep2.mkv', 'duplicate-content'),
        ],
      },
    ])
  })

  it('组间文件数并列时按 dir 名排序，结果确定不抖动', () => {
    const { actionable, excluded } = groupPending([
      row('/media/tv/Show B/ep1.mkv'),
      row('/media/tv/Show A/ep1.mkv'),
    ])
    expect(excluded).toEqual([])
    expect(actionable.map((g) => g.dir)).toEqual(['/media/tv/Show A', '/media/tv/Show B'])
  })

  it('excluded-extra 行进 excluded 桶，actionable 不收；duplicate-content 行仍进 actionable（不是 excluded）', () => {
    const { actionable, excluded } = groupPending([
      row('/media/tv/Show A/ep1.mkv', 'excluded-extra'),
      row('/media/tv/Show A/ep2.mkv', 'excluded-extra'),
      row('/media/tv/Show B/ep1.mkv', 'ambiguous match'),
      row('/media/tv/Show C/ep1.mkv', 'duplicate-content'),
    ])
    expect(actionable).toEqual([
      { dir: '/media/tv/Show B', dirTail: 'Show B', files: [row('/media/tv/Show B/ep1.mkv', 'ambiguous match')] },
      { dir: '/media/tv/Show C', dirTail: 'Show C', files: [row('/media/tv/Show C/ep1.mkv', 'duplicate-content')] },
    ])
    expect(excluded).toEqual([
      row('/media/tv/Show A/ep1.mkv', 'excluded-extra'),
      row('/media/tv/Show A/ep2.mkv', 'excluded-extra'),
    ])
  })

  it('空输入 → 两桶皆空', () => {
    expect(groupPending([])).toEqual({ actionable: [], excluded: [] })
  })
})

describe('双语动态文案', () => {
  it('fileCountLabel：en 单复数 / zh 计数', () => {
    expect(fileCountLabel(1, 'en')).toBe('1 file')
    expect(fileCountLabel(3, 'en')).toBe('3 files')
    expect(fileCountLabel(3, 'zh')).toBe('3 个文件')
  })
  it('moreLabel', () => {
    expect(moreLabel(4, 'en')).toBe('+4 more')
    expect(moreLabel(4, 'zh')).toBe('还有 4 个…')
  })
  // relativeClaimedAgo 测试已随该函数退役删除（唯一消费方是已退役的 ClaimedBox）。
})

function grp(files: Array<{ firstSeen: number; lastAttempt: number }>): DirGroup {
  return {
    dir: '/media/tv/Show',
    dirTail: 'Show',
    files: files.map((f, i) => ({ path: `/media/tv/Show/e${i}.mkv`, parkReason: 'x', firstSeen: f.firstSeen, lastAttempt: f.lastAttempt })),
  }
}

describe('groupParkTimeLine', () => {
  const NOW = 1_000_000_000_000
  it('取组内最早 firstSeen + 最晚 lastAttempt，档位同 relativeFinished（en）', () => {
    const g = grp([
      { firstSeen: NOW - 3 * 86_400_000, lastAttempt: NOW - 2 * 3_600_000 },
      { firstSeen: NOW - 1 * 86_400_000, lastAttempt: NOW - 30 * 60_000 },
    ])
    expect(groupParkTimeLine(g, NOW, 'en')).toBe('First seen 3d ago, last attempt 30m ago.')
  })
  it('zh 平移', () => {
    const g = grp([{ firstSeen: NOW - 2 * 3_600_000, lastAttempt: NOW - 1000 }])
    expect(groupParkTimeLine(g, NOW, 'zh')).toBe('首次发现 2 小时前，最近尝试 刚刚。')
  })
})

describe('checkedAgoLine', () => {
  const NOW = 1_000_000_000_000
  it('en: checked Nh ago', () => {
    expect(checkedAgoLine(NOW - 2 * 3_600_000, NOW, 'en')).toBe('checked 2h ago')
  })
  it('zh: N小时前检查', () => {
    expect(checkedAgoLine(NOW - 2 * 3_600_000, NOW, 'zh')).toBe('2 小时前检查')
  })
})

describe('timingRowLabel', () => {
  it('媒体齐 → SeriesName SxxExx（集号补零）', () => {
    expect(timingRowLabel({ seriesName: 'Peacemaker', season: 2, episode: 3, itemId: 'it-1' })).toBe('Peacemaker S2E03')
  })
  it('任一 null → 降级 mono itemId', () => {
    expect(timingRowLabel({ seriesName: null, season: 2, episode: 3, itemId: 'it-1' })).toBe('it-1')
  })
})

describe('dormantReasonLine', () => {
  it('en', () => { expect(dormantReasonLine(5, 'en')).toBe('Failed 5 times, automatic retries stopped.') })
  it('zh', () => { expect(dormantReasonLine(5, 'zh')).toBe('失败 5 次，已停止自动重试。') })
})
