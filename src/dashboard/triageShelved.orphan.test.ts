// src/dashboard/triageShelved.orphan.test.ts
// ═══════════════════════════════════════════════════════════════════════════
// 2026-08-13「TriagePage 去留」裁决的承载物：把**雪藏保留**这件事从三份互相打架的
// 散文，升级成一条会红的断言。
// ═══════════════════════════════════════════════════════════════════════════
//
// 背景（完整论证在 `web/src/triage/TriagePage.tsx` 头注释，本文件只承载判据）：
// TriagePage 于 2026-08-07 雪藏。此前两份材料给了相反处置——
//   · `docs/design/2026-08-11-FRONTEND-IMPL-DESIGN.md` 的清点表判「删」；
//   · `src/v2/subtitleVerifyRepo.ts` 头注释（2026-08-12，更新）把「把 TriagePage
//     挂回 AppShell」写成 verify 族的**恢复路径**——即判「留」。
// 用户裁决：留。本文件是那次裁决的机器载体。
//
// ⚠️ 为什么这条守卫值得存在（而不是"注释写清楚就够了"）：
// TriagePage 的去留被**三族**牵着，而三族的判据此前只有一条有机器载体：
//   · verify 族（TimingBox）—— 判据是 `runVerifySweep` 未接进 daemonV2，**零载体**；
//   · jobs 族（DormantBox）—— 已有 `dormantReadSurface.orphan.test.ts`，本文件**不重复
//     实现它**（重复实现两份判据必然漂移，C30 老教训），只在失败信息里指过去；
//   · parked 族（Pending/Excluded）—— 数据面是**活的**，判据零载体。
// 缺载体的两条正是下一个人最容易考古错的两条。
//
// ⚠️ 为什么解析 import 而不是裸 grep：grep 会被注释与散文喂饱。实测：文件头写着
//    `rg -l "from './handleWorkerTask.js'" src` 的那条判据，今天裸跑会命中
//    `apiV2.ts`（它头注释里引用了同一个字符串）——假红。本文件照抄
//    `handleWorkerTask.orphan.test.ts` 的 `codeOf()` 剥注释手法，并自带阳性对照。
//
// ── TriagePage.tsx §3 那三条判据的**可执行版本**（复制即可跑，注释里的版本因块注释
//    转义带了零宽字符，以这里为准）────────────────────────────────────────────
//
//   rg 'runVerifySweep\(' src/v2/daemonV2.ts
//   rg -l "^import .*from '\./handleWorkerTask\.js'" src -g '!*.test.ts' -g '!cli/handleWorkerTask.ts'
//   rg -l 'useTriage\(' web/src -g '!**/triage/**' -g '!**/api/**'
//
// 三条全部 exit=1（无输出）= 判据未触发 = 不许删。下面 ③④ 是第 1、3 条的断言化；
// 第 2 条不在这里重复实现（见上）。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WEB_SRC = fileURLToPath(new URL('../../web/src', import.meta.url))
const TRIAGE_DIR = join(WEB_SRC, 'triage')

/** 某个根下所有**非测试**源文件（测试里的 import 不是"接线"，生产 import 才是）。 */
function productionSources(root: string, exts: readonly string[]): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (exts.some((e) => p.endsWith(e)) && !/\.test\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(root)
  return out
}

/** 剥掉块注释与行注释，只留可执行代码。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** TriagePage 的四个区 + 共用纯函数库。缺一个 = 有人在删一半。 */
const TRIAGE_FILES = [
  'TriagePage.tsx', 'PendingBox.tsx', 'ExcludedBox.tsx', 'TimingBox.tsx', 'DormantBox.tsx', 'text.ts',
] as const

describe('TriagePage 的雪藏保留（2026-08-13 裁决的机器可查载体）', () => {
  it('① 阳性对照：四区仍然完整——六个源文件在场，且 TriagePage 确实挂着四个区', () => {
    // 先立这条。没有它，②③④会在"文件被删/改坏"时以假绿的方式通过：
    // 页面整个没了，"没人 import 它"照样成立。
    // 🔴 这条也是「不许只删一半」的文件级靶子——删掉 TimingBox 留 DormantBox（或反过来）
    //    会在这里当场变红。渲染层面的四区顺序锁在 web 侧
    //    （`web/src/triage/TriagePage.test.tsx`「四区收件箱集成」），两边分工不重叠。
    for (const f of TRIAGE_FILES) {
      expect(existsSync(join(TRIAGE_DIR, f)), `web/src/triage/${f} 不见了——有人在删一半`).toBe(true)
    }
    const page = codeOf(join(TRIAGE_DIR, 'TriagePage.tsx'))
    for (const box of ['PendingBox', 'ExcludedBox', 'TimingBox', 'DormantBox']) {
      expect(page, `TriagePage 不再挂 ${box}——四区被拆了`).toContain(`<${box}`)
    }
  })

  it('② TriagePage 在 web 生产代码里**零 import**——它仍在雪藏（红了说明被挂回去了）', () => {
    const importers = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => !f.startsWith(TRIAGE_DIR))
      .filter((f) => /from\s+'[^']*\/TriagePage\.js'/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))

    expect(importers,
      '有活代码 import 了 TriagePage —— 甄别页被挂回导航了。\n' +
      '这不一定是错，但下面几处「雪藏」的陈述前提已变，必须一并更新：\n' +
      '  · web/src/triage/TriagePage.tsx 头注释（本裁决的正本）\n' +
      '  · web/src/shell/{tabs,route,AppShell,Sidebar}.ts(x) 的雪藏段\n' +
      '  · docs/design/2026-08-11-FRONTEND-IMPL-DESIGN.md 的 triage 行\n' +
      '  ⚠️ 挂回导航还要补：route.ts 的 Tab 联合 + TAB_IDS、tabs.ts 的 TABS 项、\n' +
      '     Sidebar 的 TAB_ICONS.triage、i18n 两侧的 nav_triage 键。\n' +
      '     其中 AppShell 分支与 i18n 键**漏了都不报错**（静默空白 / 显示 key 原文）。',
    ).toEqual([])
  })

  it('③ verify 族判据：runVerifySweep 仍**没有**被接进 daemonV2（TimingBox 的保留前提）', () => {
    // `subtitleVerifyRepo.ts` §4 判据 (b) 的机器载体——此前那条判据只是一句散文里的
    // `rg` 命令，没有任何东西会在它失效时变红。
    const daemon = codeOf(join(SRC_ROOT, 'v2', 'daemonV2.ts'))
    const wired = /\brunVerifySweep\s*\(/.test(daemon)

    expect(wired,
      'daemonV2 接上了 runVerifySweep —— verify 族的封闭环有入口了。\n' +
      'subtitle_verify 表从此会有真行，/api/v2/subtitle/shifted 不再恒 []，\n' +
      'TimingBox 从"空转的 UI"变成"有数据却没人看得到的 UI"。\n' +
      '必须重读并更新：\n' +
      '  · src/v2/subtitleVerifyRepo.ts 头注释（§2「封闭空转的环」与 §4 判据 (b) 已失效）\n' +
      '  · web/src/triage/TriagePage.tsx 头注释（恢复条件已满足一半，该回答"挂回哪一页"）\n' +
      '  · src/cli/index.ts 顶部「刻意不 import」那段（恢复接线的第 1 步已完成）',
    ).toBe(false)
  })

  it('④ parked 族判据：parked_paths 有活写入者，而 triage/ 是它在前端**唯一**的读取面', () => {
    // 这一条与②③方向相反：它证明 TriagePage 不只是"verify/jobs 两族的空壳容器"——
    // Pending/Excluded 两区的数据面今天是**活的**。删页 = 让 parked_paths 变成
    // "有活写入者却零读取面"，那正是本仓病 A 的形状（只是换了个方向）。
    const writers = productionSources(SRC_ROOT, ['.ts'])
      .filter((f) => f !== join(SRC_ROOT, 'v2', 'libraryRepo.ts')) // 定义处不算调用点
      .filter((f) => /\.upsertParkedPath\s*\(/.test(codeOf(f)))
      .map((f) => relative(SRC_ROOT, f))
    expect(writers,
      'parked_paths 不再有活写入者 —— 若它整族退役，triage 的 Pending/Excluded 两区\n' +
      '也失去了数据面，TriagePage 的第三条保留理由消失（另两条见②③）。',
    ).toContain('v2/ingest.ts')

    const readers = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => !f.startsWith(TRIAGE_DIR) && !f.includes('/api/')) // api/ 是定义层，不是读取面
      .filter((f) => /\.triage\s*\(|useTriage\s*\(/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))
    expect(readers,
      'parked 事实有了 triage/ 之外的第二个读取面 —— 第三条保留理由消失。\n' +
      '若②③也已满足，TriagePage 可以整页删除了（连同它的 6 源 4 测试）。',
    ).toEqual([])
  })

  it('判据自检：三套扫描器都真的能抓到东西（否则②③④恒绿）', () => {
    // ②的扫描器：用 AppShell 当靶子——它确实 import 了 ActivityPage，同一条正则
    // （改成 ActivityPage）必须抓得到。抓不到 = 扫描器空转 = ②的"零 importer"毫无意义。
    const shellImporters = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => /from\s+'[^']*\/ActivityPage\.js'/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))
    expect(shellImporters).toContain('shell/AppShell.tsx')

    // ③的扫描器：daemonV2 里换一个**确实存在**的调用当靶子。
    expect(/\brunMaintenance\s*\(/.test(codeOf(join(SRC_ROOT, 'v2', 'daemonV2.ts')))).toBe(true)

    // ④读取面扫描器：把 triage/ 放回扫描范围，TriagePage 必须被抓到。
    const withTriage = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => !f.includes('/api/'))
      .filter((f) => /\.triage\s*\(|useTriage\s*\(/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))
    expect(withTriage).toContain('triage/TriagePage.tsx')
  })
})
