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
    expect(skill.descriptor.description).toMatch(/year mismatch/i)
    expect(skill.descriptor.description).toMatch(/1\s*[–-]\s*2|folder typo/i)
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
    // 电影结构线：runtime 一致是强正证据（原"roughly matches"对称门措辞已改为不对称——
    // 见下方 runtime-不合弱负证据锚点，不再锚死对称门口径）
    expect(skill.content).toMatch(/runtime agreement is a strong second/i)
    // 生产事故锚点（Peacemaker 芬兰同名剧）；十年差教材（Conjuring）仍一票否决
    expect(skill.content).toMatch(/year mismatch is an automatic fail/i)
    expect(skill.content).toMatch(/never buys back a failed one/i)
    expect(skill.content).toMatch(/The Rig/)
    expect(skill.content).toMatch(/Peacemaker/)
    expect(skill.content).toMatch(/The Conjuring/)
    // 搜到的第一条只是 SUSPECT，不是答案
    expect(skill.content).toMatch(/SUSPECT/)
  })

  // Task 2（year-folder-typo spec §4）：目录年差 1–2 且同名无第二年 → 文件夹写错年，过 bar。
  // 十年差 / 同名多部不同年仍一票否决（上面 two-evidence bar 的 automatic fail + Conjuring/Peacemaker 锚点不删）。
  it('目录年与 TMDB 年差 1–2 且同名无第二年 → 文件夹写错年，过 bar', ({ expect }) => {
    expect(skill.content).toMatch(/1\s*[–-]\s*2|one or two years/i)
    expect(skill.content).toMatch(/folder typo|directory year/i)
    expect(skill.content).toMatch(/exact title|same name/i)
    expect(skill.content).toMatch(/Casablanca|unique/i)
    expect(skill.content).toMatch(/no year filter/i)
    expect(skill.content).toMatch(/no other hit/i)
    expect(skill.content).toMatch(/Dune/)
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

  // 调研结论（docs/superpowers/research/2026-07-27-vague-naming-cases.md，Group G / M10a–M10e）：
  // "runtime agreement is meaningful positive evidence; runtime disagreement is weak negative
  // evidence and must never alone defeat a strong title match — because M10a/M10b make it fail
  // precisely on correct answers." runtime 是唯一一条会**在正确答案上失败**的第二证据线
  // （TMDB 每部电影只存一个 runtime；导演剪辑/加长版/分卷 CD1/PAL 提速都让文件时长偏离该值）。
  // 锚点锁"不对称"这个约束本身，不锁措辞：runtime 不合单独不足以否掉 title+year 双强的候选，
  // agent 要推断偏差成因；但 year 矛盾仍是一票否决（上面的 year-fail 锚点不变，此处再确认共存）。
  it('runtime 不合是弱负证据，单独不能否掉 title+year 双强（M10a/M10b 会在正确答案上失败）', ({ expect }) => {
    // runtime 一致仍是强正证据（2012/158-min 例子保留在上一条锚点，此处不重复）
    // runtime 不合单独不足以拒绝
    expect(skill.content).toMatch(/never alone/i)
    // 要 agent 推断偏差成因，而不是套阈值：标注剪辑版 / 分卷文件 / 预告样片 / 双集
    expect(skill.content).toMatch(/director.?s cut|extended|CD1|part file/i)
    expect(skill.content).toMatch(/trailer|sample|double|concat/i)
    // year 一票否决与这条不对称共存——不是"忽略 runtime"，也不是放松 year 门
    expect(skill.content).toMatch(/year mismatch is an automatic fail/i)
  })

  // 调研结论（同上，M9 / F1 + "missing evidence dimension"）：bare episode number（`102`）是
  // 绝对编号还是季内编号，单看一个文件无解——同目录 sibling 文件是唯一判据。plumbing 现状：
  // 全量未识别 run 里同目录的 parked 文件已各自作为 target 行出现（共享 dir: 段），agent 本就
  // 能横向读它们；skill 教 agent 用这份既有可见性。真不可判时归 insufficient-evidence 的 R2
  // "irreducibly two-valued"形态（skill 既有的 park 二分分类）。
  it('裸集号 → 查同目录 siblings 判绝对/季内编号（M9），不可判归 R2', ({ expect }) => {
    expect(skill.content).toMatch(/absolute/i)
    expect(skill.content).toMatch(/sibling|other files|same directory/i)
    // 与既有 R2 分类交叉引用（irreducibly two-valued → insufficient-evidence）
    expect(skill.content).toMatch(/irreducibly two-valued/i)
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

  // Task 3（park 原因二分）：识别不出后必须分类 WHY——insufficient-evidence 停止重试
  // （等用户改名），identification-failed 照常退避。最大风险是模型把"我没查到"当"证据
  // 不足"永久钉死可自愈文件——四条反例 + "不确定时选 identification-failed" 是安全阀。
  // 三种 insufficient-evidence 形态来自 vague-naming research（2026-07-27）：reason 文本
  // 会被 UI 展示给用户，错误建议（叫家庭录像的主人改名）有害。
  it('二分判据 + 三种形态 + 四条反例', ({ expect }) => {
    expect(skill.content).toMatch(/insufficient-evidence/)
    expect(skill.content).toMatch(/identification-failed/)
    expect(skill.content).toMatch(/1\.mp4/)
    // R2：改名同词无用，要指明集数或嵌 id 标签
    expect(skill.content).toMatch(/Renaming with the same words would NOT help/i)
    // R3：家庭录像不许叫用户改名（错误建议）
    expect(skill.content).toMatch(/IMG_4821\.MOV/)
    expect(skill.content).toMatch(/Do NOT tell this user to rename/i)
    // 四条反例
    expect(skill.content).toMatch(/TMDB has no entry/i)
    expect(skill.content).toMatch(/network or TMDB error/i)
    expect(skill.content).toMatch(/episode number is out of range/i)
    // 不确定时偏向重试
    expect(skill.content).toMatch(/When unsure which case applies, choose `identification-failed`/)
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
