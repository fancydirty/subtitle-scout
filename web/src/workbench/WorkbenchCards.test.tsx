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
import type { Target } from './targetState.js'
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

  // 🔴 Task 9：字幕流的四步条**退役**（被覆盖格 + ticker 取代，见下面的新形态 describe）。
  // StageBar 组件本身与翻译流用法保留——上面那两条翻译流用例就是它的现行守卫。
  it('🔴 字幕流不再画四步条（stage=download 映射得进 SUBTITLE_STAGES 也不画——Task 9 退役）', () => {
    const { container } = mount({ kind: 'subtitle', stage: 'download' })
    expect(container.querySelectorAll('.wb-stage-node').length).toBe(0)
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

  // 🔴 视觉验收缺陷。实测第一个节点的标签是**空字符串**：阶段名是 'source'，而当时
  // i18n 里没有对应的节点词条 → 取不到值 → 空。节点词条现在是 wb_node_*（与阶段名
  // 一一对应），这条用例遍历两条流的全部阶段，任何一个阶段少了词条都会红。
  it('🔴 每条流的每个阶段节点都有非空标签（i18n key 齐全）', () => {
    for (const kind of ['subtitle', 'translate'] as const) {
      for (const stage of ['source', 'download', 'review', 'install', 'glossary', 'translate']) {
        cleanup()
        const { container } = mount({ kind, stage })
        const nodes = Array.from(container.querySelectorAll('.wb-stage-label'))
        // 该阶段不属于本流时不画步骤条（上一条用例的口径），跳过
        if (nodes.length === 0) continue
        for (const n of nodes) {
          expect(
            (n.textContent ?? '').trim(),
            `${kind} 流的某个阶段节点标签是空的——检查 wb_node_* 词条是否齐全`,
          ).not.toBe('')
        }
      }
    }
  })

  // 🔴 视觉验收缺陷（2026-08-26 截图实测）：一张卡片上四个节点写着
  // 「1 找源 — 2 正在… — 3 正在… — 4 正在…」，用户看不出这一轮跑到哪了。
  // 根因不是词条缺失（上一条用例全绿），是**同一族 key 同时服务两个界面**：
  // 日志行要进行句（"正在下载"），步骤条节点要短名词（"下载"）。而
  // .wb-stage-label 是 nowrap + ellipsis（styles.css 的 .wb-stage-label 段），
  // 共同前缀一被截断，三个节点就退化成同一个字符串。
  // 所以判据有两条：整串互不相同，**且截断到首字后仍互不相同**——后者才是
  // 截图上真正坏掉的那条，也是节点文案必须避开共同前缀的原因。
  // ⚠️ Task 9 起只遍历翻译流：字幕流的四步条已退役（上面那条退役用例在守），
  // RunCard 挂 kind='subtitle' 再也渲染不出 .wb-stage-label。
  it('🔴 一张卡片里的四个节点标签互不相同（截断到首字也不许撞）', () => {
    for (const [kind, stage] of [['translate', 'translate']] as const) {
      cleanup()
      const { container } = mount({ kind, stage })
      const labels = Array.from(container.querySelectorAll('.wb-stage-label')).map((n) =>
        (n.textContent ?? '').trim(),
      )
      expect(labels.length).toBe(4)
      expect(new Set(labels).size, `${kind} 流的节点标签有重复：${labels.join(' / ')}`).toBe(4)
      expect(
        new Set(labels.map((l) => l.slice(0, 1))).size,
        `${kind} 流的节点标签共用首字，被 ellipsis 截断后无法区分：${labels.join(' / ')}`,
      ).toBe(4)
    }
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

  // cue 标签已经带了 stepLabel。再画 .wb-run-step 会把同一句步骤文案印两遍。
  it('🔴 cue 条已含步骤文案时不再另画 .wb-run-step', () => {
    const { container } = mount({
      kind: 'translate', stage: 'translate',
      stepLabel: '逐句翻译',
      cueProgress: { done: 30, total: 194 },
    })
    expect(container.querySelector('.wb-cue-label')!.textContent).toContain('逐句翻译')
    expect(container.querySelector('.wb-run-step')).toBeNull()
  })

  // ⚠️ Task 9 起 .wb-run-step 是翻译台专属（字幕台的步骤句改由 ticker 承载）：
  // 翻译早段（source/glossary，cue 还没来）仍靠它上屏。
  it('无 cue 时步骤文案仍走 .wb-run-step（翻译台早段）', () => {
    const { container } = mount({
      kind: 'translate', stage: 'source', stepLabel: '正在搜源',
    })
    expect(container.querySelector('.wb-run-step')!.textContent).toBe('正在搜源')
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

// ── 🔴 Task 9：字幕分支的新形态——覆盖格 + ticker 取代四步条与 0/N 死进度条 ──
// 生产实测的那个 bug：作品级 done 在整轮装盘期间恒 0（total=N），进度条一根死条。
// targets 在场时字幕卡改画覆盖格（逐格状态）+ ticker；缺席（旧后端）回退旧进度条。
describe('🔴 RunCard 字幕分支：覆盖格 + ticker（Task 9 装配）', () => {
  const gridTargets: Target[] = [
    { key: 's01e01', label: 'E01', state: 'installed' },
    { key: 's01e02', label: 'E02', state: 'active' },
  ]

  it('🔴 targets 在场 → 覆盖格上屏，0/N 进度条与 .wb-run-step 都不画', () => {
    const { container } = mount({
      kind: 'subtitle', stage: 'install',
      progress: { done: 0, total: 2 },
      stepLabel: '正在安装', stepTool: 'install_subtitle',
      targets: gridTargets,
    })
    expect(container.querySelector('[data-testid="wb-grid-count"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-testid="wb-grid-cell"]').length).toBe(2)
    // 0/N 死条与旧步骤行都退役了
    expect(container.querySelector('[role="progressbar"]')).toBeNull()
    expect(container.querySelector('.wb-card-progress')).toBeNull()
    expect(container.querySelector('.wb-run-step')).toBeNull()
    expect(container.querySelectorAll('.wb-stage-node').length).toBe(0)
    // ticker：raw 工具 id 经 tickerPhrase 词表翻译后上屏（不是 raw 串）
    expect(container.querySelector('[data-testid="wb-ticker"]')!.textContent).toContain(zh.wb_step_install)
    expect(container.textContent).not.toContain('install_subtitle')
  })

  it('targets 缺席 → 回退旧 done/total 进度条（旧后端/识别兼容）', () => {
    const { container } = mount({ kind: 'subtitle', progress: { done: 1, total: 4 } })
    expect(container.querySelector('[role="progressbar"]')).toBeTruthy()
    expect(container.querySelector('.wb-card-progress')!.textContent).toContain('1 / 4')
    expect(container.querySelector('[data-testid="wb-grid-count"]')).toBeNull()
    expect(container.querySelector('[data-testid="wb-grid-pill"]')).toBeNull()
  })

  it('🔴 翻译分支一字不动：targets 即使误传也不画覆盖格/ticker，StageBar + cue 条照旧', () => {
    const { container } = mount({
      kind: 'translate', stage: 'translate',
      cueProgress: { done: 30, total: 194 },
      targets: gridTargets, stepTool: 'update_row',
    })
    expect(container.querySelectorAll('.wb-stage-node').length).toBe(4)
    expect(container.querySelector('[data-cue-bar]')).toBeTruthy()
    expect(container.querySelector('[data-testid="wb-grid-count"]')).toBeNull()
    expect(container.querySelector('[data-testid="wb-ticker"]')).toBeNull()
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
