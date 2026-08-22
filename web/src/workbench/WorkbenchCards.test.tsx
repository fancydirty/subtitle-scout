// web/src/workbench/WorkbenchCards.test.tsx —— RunCard 的**渲染事实**守卫。
//
// ══════════════════════════════════════════════════════════════════════════════
// 判据口径：全部是"渲染真组件 + 数 DOM"，照 ActivityPage.test.tsx 的既有纪律
// ══════════════════════════════════════════════════════════════════════════════
// 不做源码级断言（读源码字符串核对），那种断言会被一行行尾注释喂饱。每条判据都配
// **阳性对照**——"改坏之前它确实是另一个样子"，否则一个恒渲染空白的组件也会全绿。
//
// 本文件的三组 🔴 用例来自 2026-08-22 的本地 e2e **视觉验收**（PLUTO S01E02，
// 194 cue 那轮真实翻译）。它们全是单元测试当时没覆盖、靠肉眼截图才抓到的形态：
//  ① 翻译跑到 get_window 时步骤条**整个消失**（stage='translate' 必须能点亮）
//  ② cue 进度条把 194 句写成 "194 集已装上"（单位说了假话）
//  ③ 相邻重复日志没折叠会把卡片刷爆
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { RunCard } from './WorkbenchCards.js'
import { zh } from '../i18n/zh.js'

afterEach(cleanup)

const face = { title: 'PLUTO', subtitle: '正在翻译', posterPath: null, backdropPath: null }

function mount(props: Partial<Parameters<typeof RunCard>[0]> = {}) {
  return render(
    <I18nProvider initialLang="zh">
      <RunCard face={face} {...props} />
    </I18nProvider>,
  )
}

describe('RunCard 步骤条（StageBar）', () => {
  it('翻译流：stage=glossary 点亮第 2 节点，前面的节点标记 done', () => {
    const { container } = mount({ kind: 'translate', stage: 'glossary' })
    const nodes = container.querySelectorAll('.wb-stage-node')
    // 翻译流固定 4 段：source → glossary → translate → install
    expect(nodes.length).toBe(4)
    expect(nodes[0]!.className).toContain('done')
    expect(nodes[1]!.getAttribute('data-stage-active')).toBe('true')
    expect(nodes[1]!.getAttribute('data-stage')).toBe('glossary')
    // 阳性对照：后面的节点**不该**被点亮
    expect(nodes[2]!.getAttribute('data-stage-active')).toBe('false')
    expect(nodes[3]!.className).not.toContain('done')
  })

  // 🔴 视觉验收缺陷 ①。生产实测：翻译跑到 get_window（stageOf → 'translate'）时整条
  // 步骤条消失。根因是当时 get_window 被归为 'review'，而 TRANSLATE_STAGES 里没有
  // review 槽位 → indexOf 返回 -1 → StageBar 提前 return null。
  // 这条用例守的是"translate 这个阶段在翻译流里必须能点亮"——即使将来有人再把
  // 某个逐句循环内的工具错归到别的阶段，只要它映射不进这 4 段就会红。
  it('🔴 翻译流：stage=translate 能点亮第 3 节点（不是整条塌掉）', () => {
    const { container } = mount({ kind: 'translate', stage: 'translate' })
    const nodes = container.querySelectorAll('.wb-stage-node')
    expect(nodes.length).toBe(4)
    expect(nodes[2]!.getAttribute('data-stage-active')).toBe('true')
    expect(nodes[2]!.getAttribute('data-stage')).toBe('translate')
  })

  it('字幕流：stage=download 点亮第 2 节点（四段与翻译流不同）', () => {
    const { container } = mount({ kind: 'subtitle', stage: 'download' })
    const nodes = container.querySelectorAll('.wb-stage-node')
    expect(nodes.length).toBe(4)
    expect(nodes[1]!.getAttribute('data-stage')).toBe('download')
    expect(nodes[1]!.getAttribute('data-stage-active')).toBe('true')
  })

  // 阳性对照 + 诚实降级：阶段不在本流的 4 段里（比如字幕流收到 glossary），
  // 宁可不画步骤条，也不许画一条**全灰没有当前位置**的假步骤条。
  it('阶段不属于本流 → 不画步骤条（而不是画一条没有高亮的）', () => {
    const { container } = mount({ kind: 'subtitle', stage: 'glossary' })
    expect(container.querySelectorAll('.wb-stage-node').length).toBe(0)
  })

  it('stage 为 null（活动刚开始还没有 step）→ 不画步骤条', () => {
    const { container } = mount({ kind: 'translate', stage: null })
    expect(container.querySelectorAll('.wb-stage-node').length).toBe(0)
  })
})

describe('RunCard cue 级进度条', () => {
  it('有 cueProgress → 画进度条，宽度与 aria 值都按 done/total 算', () => {
    const { container } = mount({
      kind: 'translate', stage: 'translate', cueProgress: { done: 30, total: 194 },
    })
    const bar = container.querySelector('[data-cue-bar]')!
    expect(bar).toBeTruthy()
    expect(bar.getAttribute('aria-valuenow')).toBe('30')
    expect(bar.getAttribute('aria-valuemax')).toBe('194')
    const fill = container.querySelector('.wb-cue-bar-fill') as HTMLElement
    // 30/194 ≈ 15.46%
    expect(fill.style.width.startsWith('15.4')).toBe(true)
  })

  // 🔴 视觉验收缺陷 ②。实测截图上写的是「30 / 194 集已装上」——194 是**句子**数，
  // 说成"集"是把一集片说成 194 集。cue 进度必须用自己的单位文案。
  it('🔴 cue 单位是"句已翻"，不是作品级的"集已装上"', () => {
    const { container } = mount({
      kind: 'translate', stage: 'translate', cueProgress: { done: 30, total: 194 },
    })
    const label = container.querySelector('.wb-cue-label')!.textContent ?? ''
    expect(label).toContain('30 / 194')
    expect(label).toContain(zh.wb_run_cues_done_suffix)
    // 阳性对照：**绝不许**出现作品级的"集已装上"
    expect(label).not.toContain(zh.wb_run_files_done_suffix)
  })

  it('cue 有值时不再画作品级进度条（两条同时在场会让用户不知道读哪条）', () => {
    const { container } = mount({
      kind: 'translate', stage: 'translate',
      progress: { done: 0, total: 1 }, cueProgress: { done: 30, total: 194 },
    })
    expect(container.querySelector('[data-cue-bar]')).toBeTruthy()
    expect(container.querySelector('.wb-card-progress')).toBeNull()
  })

  it('无 cueProgress → 退回作品级进度（0 / 1 集已装上）', () => {
    const { container } = mount({ kind: 'subtitle', stage: 'download', progress: { done: 0, total: 1 } })
    expect(container.querySelector('[data-cue-bar]')).toBeNull()
    const p = container.querySelector('.wb-card-progress')!.textContent ?? ''
    expect(p).toContain('0 / 1')
    expect(p).toContain(zh.wb_run_files_done_suffix)
  })

  // 诚实的 null：total=0 不许画成 0/0 的空条，也不许除零画出 NaN% 宽度。
  it('cueTotal=0 → 不画 cue 进度条（不编 0/0，不画 NaN 宽度）', () => {
    const { container } = mount({
      kind: 'translate', stage: 'translate', cueProgress: { done: 0, total: 0 },
    })
    expect(container.querySelector('[data-cue-bar]')).toBeNull()
  })
})

describe('RunCard 日志合并', () => {
  // 🔴 视觉验收缺陷 ③ 的正面守卫：翻译一轮里 get_window 会连着来十几次，
  // 不折叠的话卡片右栏会被同一句话刷满。
  it('🔴 相邻重复行折叠成 ×N', () => {
    const { container } = mount({
      logLines: ['正在搜源', '正在搜源', '正在搜源', '冻结术语表'],
    })
    const text = container.textContent ?? ''
    expect(text).toContain('正在搜源 ×3')
    expect(text).toContain('冻结术语表')
  })

  it('不相邻的重复不合并（A B A 仍是三行，时间顺序是真事实）', () => {
    const { container } = mount({ logLines: ['A', 'B', 'A'] })
    const text = container.textContent ?? ''
    expect(text).not.toContain('×')
  })

  it('只保留最近 5 行（长跑任务不许把卡片撑爆）', () => {
    const { container } = mount({
      logLines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'],
    })
    const text = container.textContent ?? ''
    expect(text).toContain('l7')
    expect(text).toContain('l3')
    // 阳性对照：更早的行必须已经被切掉
    expect(text).not.toContain('l1')
    expect(text).not.toContain('l2')
  })
})

describe('RunCard 基本面', () => {
  it('标题与副标题上屏', () => {
    mount({ kind: 'translate' })
    expect(screen.getByText('PLUTO')).toBeTruthy()
    expect(screen.getByText('正在翻译')).toBeTruthy()
  })

  it('staleNote 有值 → 卡片标记为陈旧', () => {
    const { container } = mount({ staleNote: '可能不是最新的' })
    const card = container.querySelector('[data-testid="wb-run-card"]')!
    expect(within(card as HTMLElement).getByText('可能不是最新的')).toBeTruthy()
  })
})
