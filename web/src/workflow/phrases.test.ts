// web/src/workflow/phrases.test.ts：Workflow 叙事化（验收修复轮一 Task V4，design §B）的静态
// 短语映射表——纯函数，全部英文（DESIGN.md §7：Workflow 区永不本地化）。toolPhrase 把工具名
// 映射成人话动词短语（直播步骤"灵魂卖点"保留，只是不再糊脸工程名）；decisionPhrase 把 decision
// 词映射成 recent 行的人话句 + 语义 tone（铁律④：失败/等待用面向下一步的中性话，红只给点不给
// 块——tone 只是数据，是否渲染红块由消费方的 CSS 决定，这里只锁定 tone 分类本身）。
import { describe, it, expect } from 'vitest'
import { toolPhrase, decisionPhrase } from './phrases.js'

describe('toolPhrase：工具名 → 人话动词短语', () => {
  it('静态映射（键与真实注册工具名一一对应）', () => {
    expect(toolPhrase('read_doc')).toBe('Reading the playbook')
    expect(toolPhrase('search_source')).toBe('Searching providers')
    expect(toolPhrase('list_candidates')).toBe('Reviewing candidates')
    expect(toolPhrase('get_candidate')).toBe('Inspecting a candidate')
    expect(toolPhrase('download_candidate')).toBe('Downloading a subtitle')
    expect(toolPhrase('install_subtitle')).toBe('Installing a subtitle')
    expect(toolPhrase('check_episode_code_safety')).toBe('Double-checking episode numbers')
    expect(toolPhrase('finalize')).toBe('Wrapping up')
  })

  // 回归锁：表的键必须是**真实注册**的工具名。此前 probe_candidate 是死条目（非测试源码里不
  // 存在这个工具），而 get_candidate/download_candidate/check_episode_code_safety 三个真实高频
  // 工具反而漏登记、在直播里糊裸蛇形命名。这条测试锁住"死条目不许回来"。
  it('probe_candidate 不是真实工具，不许在表里（走兜底原样回显）', () => {
    expect(toolPhrase('probe_candidate')).toBe('probe_candidate')
  })

  it('src/agent/findSubtitleWorker.ts 注册的每个工具都有人话短语（中英都有）', () => {
    const registered = [
      'read_doc', 'search_source', 'list_candidates', 'get_candidate',
      'download_candidate', 'install_subtitle', 'check_episode_code_safety', 'finalize',
    ]
    for (const tool of registered) {
      expect(toolPhrase(tool, 'en'), `en 缺 ${tool}`).not.toBe(tool)
      expect(toolPhrase(tool, 'zh'), `zh 缺 ${tool}`).not.toBe(tool)
    }
  })

  it('dispatch_ 前缀（含 dispatch_find_subtitle_task/dispatch_realign_task）→ Planning work', () => {
    expect(toolPhrase('dispatch_find_subtitle_task')).toBe('Planning work')
    expect(toolPhrase('dispatch_realign_task')).toBe('Planning work')
    expect(toolPhrase('dispatch_anything_else')).toBe('Planning work')
  })

  it('spawn_sibling_orchestrator/check_series_layout/list_missing_coverage → Planning work', () => {
    expect(toolPhrase('spawn_sibling_orchestrator')).toBe('Planning work')
    expect(toolPhrase('check_series_layout')).toBe('Planning work')
    expect(toolPhrase('list_missing_coverage')).toBe('Planning work')
  })

  it('未映射工具名原样返回（mono 兜底，诚实——不许编造一个假短语；中文语境下同样不翻译，'
    + '裸工具名是技术值，§7 技术值永不翻译）', () => {
    expect(toolPhrase('some_future_tool')).toBe('some_future_tool')
    expect(toolPhrase('some_future_tool', 'zh')).toBe('some_future_tool')
  })
})

// 2026-07-30 用户裁决（DESIGN.md §7 改版）：痕迹/活动区**跟随 UI 语言**，不再恒英文。
describe('按语言返回（用户裁决：选中文走中文，选英文走英文）', () => {
  it('lang 缺省为 en——保证既有调用点行为不变', () => {
    expect(toolPhrase('search_source')).toBe(toolPhrase('search_source', 'en'))
    expect(decisionPhrase('installed')).toEqual(decisionPhrase('installed', 'en'))
  })

  it('zh 返回中文，且与 en 不同', () => {
    expect(toolPhrase('download_candidate', 'zh')).toBe('正在下载字幕')
    expect(toolPhrase('search_source', 'zh')).toBe('正在搜字幕来源')
    expect(toolPhrase('dispatch_find_subtitle_task', 'zh')).toBe('正在安排工作')
    expect(decisionPhrase('installed', 'zh').text).toBe('字幕已装好')
  })

  it('tone 与语言无关（语义分类不是文案）——同一 decision 中英 tone 必须一致', () => {
    for (const d of ['installed', 'no_safe_match', 'retry_later', 'error',
      'translate:extract-failed', 'identity_correction']) {
      expect(decisionPhrase(d, 'zh').tone, d).toBe(decisionPhrase(d, 'en').tone)
    }
  })

  it('铁律④在中文下同样成立：retry_later 不许染红', () => {
    expect(decisionPhrase('retry_later', 'zh').tone).toBe('neutral')
  })

  // 通过公开 API 探测（不为测试导出内部表）：每个已登记的 decision 在中英都必须有译文，
  // 判据是"返回的 text 不等于原词"（等于原词即落到了兜底）。防止只补一边导致另一语言糊裸词。
  it('已登记 decision 在中英两边都有译文（防止只补一边）', () => {
    const known = [
      'installed', 'no_safe_match', 'retry_later', 'error',
      'realign:done', 'realign:parked', 'realign:error',
      'translate:installed', 'translate:held', 'translate:held-parked',
      'translate:no-source', 'translate:extract-failed', 'translate:probe-failed',
      'translate:already-covered',
      'identity_correction', 'identity_correction_skipped',
    ]
    for (const d of known) {
      expect(decisionPhrase(d, 'en').text, `en 缺 ${d}`).not.toBe(d)
      expect(decisionPhrase(d, 'zh').text, `zh 缺 ${d}`).not.toBe(d)
    }
  })

  it('未知 decision 在中文下同样原样回显 + neutral', () => {
    expect(decisionPhrase('some_future_decision', 'zh'))
      .toEqual({ text: 'some_future_decision', tone: 'neutral' })
  })
})

describe('decisionPhrase：decision 词 → { text, tone }', () => {
  it('find_subtitle 四态', () => {
    expect(decisionPhrase('installed')).toEqual({ text: 'subtitles installed', tone: 'ok' })
    expect(decisionPhrase('no_safe_match')).toEqual({ text: 'no safe match found', tone: 'neutral' })
    expect(decisionPhrase('retry_later')).toEqual({ text: 'will retry later', tone: 'neutral' })
    expect(decisionPhrase('error')).toEqual({ text: 'hit a problem — will retry', tone: 'bad' })
  })

  it('realign 三态（decision 存的是 realign:前缀字符串，见 src/v2/realignWorkerTask.ts）', () => {
    expect(decisionPhrase('realign:done')).toEqual({ text: 'library realigned', tone: 'ok' })
    expect(decisionPhrase('realign:parked')).toEqual({ text: 'needs a manual look', tone: 'neutral' })
    expect(decisionPhrase('realign:error')).toEqual({ text: 'realign hit a problem', tone: 'bad' })
  })

  // 铁律④：retry_later 绝不红——tone 必须是 neutral，不是 bad。
  it('retry_later 的 tone 是 neutral，不是 bad（铁律④：等待用中性话，不许染红）', () => {
    expect(decisionPhrase('retry_later').tone).toBe('neutral')
    expect(decisionPhrase('retry_later').tone).not.toBe('bad')
  })

  it('未知 decision → 原词 + neutral（诚实兜底，不编造语气）', () => {
    expect(decisionPhrase('download')).toEqual({ text: 'download', tone: 'neutral' })
    expect(decisionPhrase('some_future_decision')).toEqual({ text: 'some_future_decision', tone: 'neutral' })
  })
})
