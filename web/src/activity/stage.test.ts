import { describe, it, expect } from 'vitest'
import { stageOf, advanceStage, stageFromTrail, stageModeOf, STAGE_START } from './stage.js'

describe('stageOf', () => {
  it('在认片子的三个工具都是 14', () => {
    expect(stageOf('search_tmdb')).toBe(14)
    expect(stageOf('get_tmdb_details')).toBe(14)
    expect(stageOf('write_identified_media')).toBe(14)
  })

  it('search_source 是 22', () => {
    expect(stageOf('search_source')).toBe(22)
  })

  it('核对候选的两个工具都是 44', () => {
    expect(stageOf('list_candidates')).toBe(44)
    expect(stageOf('get_candidate')).toBe(44)
  })

  it('download_candidate 是 66', () => {
    expect(stageOf('download_candidate')).toBe(66)
  })

  it('install_subtitle 是 88', () => {
    expect(stageOf('install_subtitle')).toBe(88)
  })

  it('finalize 是 100', () => {
    expect(stageOf('finalize')).toBe(100)
  })

  it('read_doc / check_episode_code_safety 不推进阶段（null）', () => {
    expect(stageOf('read_doc')).toBeNull()
    expect(stageOf('check_episode_code_safety')).toBeNull()
  })

  // 兜底的回归锁：工具表会随后端演进，新工具必然先于 UI 更新到达前端。
  it('未登记工具返回 null——不是 undefined，不抛错', () => {
    expect(stageOf('some_tool_the_backend_added_last_week')).toBeNull()
    expect(stageOf('')).toBeNull()
    expect(() => stageOf('brand_new_tool')).not.toThrow()
  })

  it('未登记工具返回的是 null 而非 undefined（严格身份）', () => {
    const v = stageOf('unknown_tool')
    expect(v).not.toBeUndefined()
    expect(v === null).toBe(true)
  })

  it('Object.prototype 上的名字不算登记项', () => {
    expect(stageOf('toString')).toBeNull()
    expect(stageOf('constructor')).toBeNull()
    expect(stageOf('hasOwnProperty')).toBeNull()
  })
})

describe('advanceStage 单调性', () => {
  it('推进到更远的阶段', () => {
    expect(advanceStage(22, 'download_candidate')).toBe(66)
  })

  it('回到更早的工具不倒退', () => {
    expect(advanceStage(66, 'search_source')).toBe(66)
  })

  it('不推进阶段的工具保持原值', () => {
    expect(advanceStage(44, 'read_doc')).toBe(44)
    expect(advanceStage(44, 'check_episode_code_safety')).toBe(44)
  })

  it('未登记工具保持原值', () => {
    expect(advanceStage(44, 'mystery_tool')).toBe(44)
  })
})

describe('stageFromTrail', () => {
  it('空列表返回起手值 6', () => {
    expect(stageFromTrail([])).toBe(6)
    expect(stageFromTrail([])).toBe(STAGE_START)
  })

  // spec 判据 2：多来源搜索时 agent 会回到 search_source，条不能倒退。
  it('search_source → download_candidate → search_source 最终是 66，不回退到 22', () => {
    const trail = [
      { tool: 'search_source' },
      { tool: 'download_candidate' },
      { tool: 'search_source' },
    ]
    expect(stageFromTrail(trail)).toBe(66)
  })

  it('完整顺序序列走到 100', () => {
    const trail = [
      { tool: 'read_doc' },
      { tool: 'search_tmdb' },
      { tool: 'get_tmdb_details' },
      { tool: 'write_identified_media' },
      { tool: 'search_source' },
      { tool: 'list_candidates' },
      { tool: 'get_candidate' },
      { tool: 'download_candidate' },
      { tool: 'check_episode_code_safety' },
      { tool: 'install_subtitle' },
      { tool: 'finalize' },
    ]
    expect(stageFromTrail(trail)).toBe(100)
  })

  it('只有 read_doc 时停在起手值', () => {
    expect(stageFromTrail([{ tool: 'read_doc' }, { tool: 'read_doc' }])).toBe(6)
  })

  it('只有未登记工具时停在起手值', () => {
    expect(stageFromTrail([{ tool: 'future_tool_a' }, { tool: 'future_tool_b' }])).toBe(6)
  })

  it('乱序事件仍取最远阶段', () => {
    const trail = [
      { tool: 'install_subtitle' },
      { tool: 'search_tmdb' },
      { tool: 'list_candidates' },
    ]
    expect(stageFromTrail(trail)).toBe(88)
  })
})

describe('stageModeOf', () => {
  it('find_subtitle 走阶段表', () => {
    expect(stageModeOf('find_subtitle')).toBe('staged')
  })

  it('realign 是不定态（工具序列未调研，不编造阶段）', () => {
    expect(stageModeOf('realign')).toBe('indeterminate')
  })

  it('translate 是不定态（工具序列未调研，不编造阶段）', () => {
    expect(stageModeOf('translate')).toBe('indeterminate')
  })

  it('orchestrate 隐藏（编排层属要隐藏的机械，不进 hero）', () => {
    expect(stageModeOf('orchestrate')).toBe('hidden')
  })

  it('null 保守回落到不定态', () => {
    expect(stageModeOf(null)).toBe('indeterminate')
  })

  it('未知 taskType 保守回落到不定态', () => {
    expect(stageModeOf('some_future_task_type')).toBe('indeterminate')
    expect(stageModeOf('')).toBe('indeterminate')
  })
})

describe('铁律②：本层不导出任何格式化函数', () => {
  it('模块导出面只有纯计算，没有 percent/format/label 之类的字符串产出', async () => {
    const mod = await import('./stage.js')
    expect(Object.keys(mod).sort()).toEqual(
      ['STAGE_START', 'advanceStage', 'stageFromTrail', 'stageModeOf', 'stageOf'].sort(),
    )
  })
})

// ── 两张表必须一致（2026-07-31 实机盯页面时发现的真 bug）────────────────────
// stage.ts 给 search_tmdb / get_tmdb_details / write_identified_media 定了 14% 的阶段权重，
// 但 phrases.ts 当时没有它们的人话映射——于是它们在传送带上**显示成裸机器名**
// （屏上真的看到了 `search_tmdb`），违反铁律③「不暴露机械」。
//
// 根因是我做阶段表时只改了一侧。这条锁住：凡是**推进阶段**的工具，必须有人话短语。
// 反向不要求（read_doc 不推进阶段但有短语，那是对的——它仍要出现在传送带上）。
describe('stage 表与 phrases 表的一致性', () => {
  it('每个推进阶段的工具都有人话短语（中英都有）', async () => {
    const { toolPhrase } = await import('../workflow/phrases.js')
    const staged = [
      'search_tmdb', 'get_tmdb_details', 'write_identified_media',
      'search_source', 'list_candidates', 'get_candidate',
      'download_candidate', 'install_subtitle', 'finalize',
    ]
    for (const tool of staged) {
      // stageOf 非 null 即"推进阶段"
      expect(stageOf(tool), `${tool} 应当推进阶段`).not.toBeNull()
      // 有短语的判据：返回值不等于工具名本身（等于就是走了兜底）
      expect(toolPhrase(tool, 'en'), `en 缺 ${tool} 的人话`).not.toBe(tool)
      expect(toolPhrase(tool, 'zh'), `zh 缺 ${tool} 的人话`).not.toBe(tool)
    }
  })

  // 不推进阶段的辅助工具同样要有短语——它们仍然出现在传送带上。
  it('不推进阶段的辅助工具也有人话短语', async () => {
    const { toolPhrase } = await import('../workflow/phrases.js')
    for (const tool of ['read_doc', 'check_episode_code_safety']) {
      expect(stageOf(tool)).toBeNull()
      expect(toolPhrase(tool, 'zh'), `zh 缺 ${tool}`).not.toBe(tool)
    }
  })
})
