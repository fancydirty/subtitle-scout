// identifyMediaSkill 的语义锚点。2026-07-27 从 findSubtitleSkill.test.ts 拆出——识别教法
// 独立成篇（progressive disclosure）后，识别内容的锚点跟着文档搬家，一条不丢。
//
// 这些锚点的来历不是凭空拟的措辞偏好，每一条都对应 identityEval 的一次真实失败：
//  · 第三轮：文件名是纯技术 token 时模型盯着文件名瞎搜六次（"2026"/"iT"/"2026 movie"）
//    从没看目录名 → 钉死"目录名是主证据不是 fallback" + "禁搜纯 token"。
//  · 生产事故：Peacemaker 整季被装成芬兰同名剧 → 钉死 two-evidence bar 与 year 一票否决。
//  · 红线：因一集集号越界否定整部剧身份 → 钉死"What is NOT an identity problem"。
//
// 刻意**不**锚定的东西：所有强调性措辞（"not optional bookkeeping"/"is a FAILED run"/
// "no exceptions"）。那是我用 prose 修代码缺陷（工具 schema 只收 JSON null）留下的疤，
// 门修好后就该消失——锁住它们等于把错误做法固化成契约。
import { describe, it } from 'vitest'
import { makeIdentifyMediaSkill, IDENTIFY_MEDIA_SKILL } from './identifyMediaSkill.js'

describe('identify-media skill', () => {
  const skill = makeIdentifyMediaSkill()

  it('descriptor 让模型从 read_doc 索引就知道这篇是干什么的', ({ expect }) => {
    expect(skill.descriptor.name).toBe('identify-media')
    expect(skill.descriptor.description).toMatch(/two-evidence bar/i)
    expect(skill.descriptor.description).toMatch(/write_identified_media/)
    expect(skill.descriptor.description).toMatch(/year mismatch is an automatic fail/i)
  })

  it('从原始证据识别：raw evidence 前提 + 目录名是主证据', ({ expect }) => {
    // 任务只带原始证据，不带身份
    expect(skill.content).toMatch(/raw evidence only/i)
    expect(skill.content).toMatch(/directory names/)
    expect(skill.content).toMatch(/structure hints.*hints, not truth/is)
    // 第三轮血案锚点：文件名可能完全没有标题，目录名是主证据
    expect(skill.content).toMatch(/pure technical tokens/i)
    expect(skill.content).toMatch(/primary evidence, not a fallback/i)
    // 禁搜纯技术 token
    expect(skill.content).toMatch(/Never query a bare year/i)
    // 机械层的猜测口径绝迹（主识别模式不是"核验机械猜测"）
    expect(skill.content).not.toMatch(/mechanical parse|guessed identity/i)
  })

  it('四类真实误判来源作为教材留在文中', ({ expect }) => {
    expect(skill.content).toMatch(/招z魂4/)
    expect(skill.content).toMatch(/copyright-evasion/i)
    expect(skill.content).toMatch(/H）后丨室/)
    expect(skill.content).toMatch(/后室/)
    expect(skill.content).toMatch(/mojibake/i)
    expect(skill.content).toMatch(/fansub bracket tags/i)
    expect(skill.content).toMatch(/truncated Chinese title/i)
    // 搜修复后的原文标题，不只搜罗马音/英文猜测
    expect(skill.content).toMatch(/not only romanizations/i)
  })

  it('two-evidence bar：名字 + 第二独立证据，year 矛盾一票否决', ({ expect }) => {
    expect(skill.content).toMatch(/two independent lines/i)
    expect(skill.content).toMatch(/season table/i)
    expect(skill.content).toMatch(/runtime roughly matches/i)
    // 生产事故锚点（Peacemaker 芬兰同名剧）
    expect(skill.content).toMatch(/year mismatch is an automatic fail/i)
    expect(skill.content).toMatch(/never buys back a failed one/i)
    expect(skill.content).toMatch(/The Rig/)
    expect(skill.content).toMatch(/Peacemaker/)
    // 搜到的第一条只是 SUSPECT，不是答案
    expect(skill.content).toMatch(/SUSPECT/)
  })

  // Task 2（接回 [tmdbid-N] 证据通道）：标签是**起点不是判决**。这条不是措辞偏好——
  // 标签由上一轮 run 或外部整理工具写下，可能过期/写错，若教成"有标签就认领"等于给模型
  // 开一个绕过 two-evidence bar 的后门（本项目 buildTargetShowDir 自己就在产出该标签，
  // 一次误判会被下一轮当权威读回来，错误自我固化）。
  it('[tmdbid-N] 标签是起点不是判决（红线）', ({ expect }) => {
    expect(skill.content).toMatch(/\[tmdbid-N\] tag/i)
    expect(skill.content).toMatch(/starting point, not a verdict/i)
    expect(skill.content).toMatch(/stale or simply wrong/i)
    expect(skill.content).toMatch(/identify from\s+scratch/i)
    expect(skill.content).toMatch(/not claim an identity just because a number/i)
  })

  it('反脑补红线：模型知识不算证据，必须调工具', ({ expect }) => {
    expect(skill.content).toMatch(/never from memory|never from your own memory|never a verdict/i)
    expect(skill.content).toMatch(/requires a search hit plus a details check/i)
  })

  it('时长交叉印证：纯数字标题靠 runtime 锚定（2012 case）', ({ expect }) => {
    expect(skill.content).toMatch(/numeric-only name like `2012`/)
    expect(skill.content).toMatch(/158/)
  })

  it('写库 → 拿 own-id 当 itemId；识别与找字幕解耦', ({ expect }) => {
    expect(skill.content).toMatch(/write_identified_media/)
    expect(skill.content).toMatch(/once per target/i)
    // 文件名（而非绝对路径）——第七轮修复：prompt 只给相对段，索要绝对路径必然逼出幻觉
    expect(skill.content).toMatch(/file name exactly as shown\s+in the task facts/i)
    expect(skill.content).not.toMatch(/absolute path/i)
    // own-id 由工具返回，模型不能自己造
    expect(skill.content).toMatch(/cannot construct it yourself/i)
    // 识别与找字幕是两件独立的事（第五轮：空 adapters 下模型觉得"写库没意义"）
    expect(skill.content).toMatch(/separate jobs with separate outcomes/i)
    expect(skill.content).toMatch(/identity still stands/i)
    // 顺序锚点
    expect(skill.content).toMatch(/search_tmdb.*get_tmdb_details.*write_identified_media/s)
  })

  it('识别不出：no_safe_match，不许猜', ({ expect }) => {
    expect(skill.content).toMatch(/no_safe_match/)
    expect(skill.content).toMatch(/Guessing an identity is strictly worse/i)
  })

  it('边界红线：某一集对不上 ≠ 整部剧身份错', ({ expect }) => {
    expect(skill.content).toMatch(/What is NOT an identity problem/i)
    expect(skill.content).toMatch(/S04E13/)
    expect(skill.content).toMatch(/leave the identity alone/i)
    expect(skill.content).toMatch(/identity stands/i)
  })

  it('导出的单实例与工厂产物一致（识别与语言/档位无关）', ({ expect }) => {
    expect(IDENTIFY_MEDIA_SKILL.content).toBe(skill.content)
    expect(IDENTIFY_MEDIA_SKILL.descriptor.name).toBe('identify-media')
  })
})
