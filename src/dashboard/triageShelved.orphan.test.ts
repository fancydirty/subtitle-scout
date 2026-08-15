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
//   · parked 族（Pending/Excluded）—— ☠️ **2026-08-13 整族退役**（见下）。
// 缺载体的两条正是下一个人最容易考古错的两条。
//
// ── 2026-08-13 更新：parked 族出局，本文件从"三族守卫"降为"两族守卫" ────────────
// 原 ④「parked 族判据」断言的是 `parked_paths 有活写入者`（唯一写入者 = v2/ingest.ts 的
// upsertParkedPath）。本轮 ingest 整条链退役，那条断言的**前提**消失——它不是"变红了要修"，
// 而是它守护的那一族已经按它自己写的剧本走完了：
//     『parked_paths 不再有活写入者 —— 若它整族退役，triage 的 Pending/Excluded 两区
//       也失去了数据面，TriagePage 的第三条保留理由消失（另两条见②③）。』
// 正是如此，于是 Pending/Excluded 两区连同端点/hook/client 方法一并删除。
// ④ 因此**改写成反向的墓碑锁**：断言 parked 族确实零写入者、且没人把读出面加回来。
// 正本论证见 `web/src/triage/TriagePage.tsx` 头注释的「2.5 parked 族的结局」段。
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

/** TriagePage 的**两个**区 + 共用纯函数库。缺一个 = 有人在删一半。
 *  （PendingBox/ExcludedBox 于 2026-08-13 随 parked 族整族删除，见文件头更新段。） */
const TRIAGE_FILES = [
  'TriagePage.tsx', 'TimingBox.tsx', 'DormantBox.tsx', 'text.ts',
] as const

/** parked 族退役后**必须保持不存在**的文件。① 同时钉住这一侧：谁把它们加回来，
 *  就得先来读一遍裁决（而不是悄悄复活一个零数据的 UI）。 */
const RETIRED_TRIAGE_FILES = ['PendingBox.tsx', 'ExcludedBox.tsx'] as const

describe('TriagePage 的雪藏保留（2026-08-13 裁决的机器可查载体）', () => {
  it('① 阳性对照：两区仍然完整——四个源文件在场且 TriagePage 挂着两个区；parked 两区确实不在', () => {
    // 先立这条。没有它，②③④会在"文件被删/改坏"时以假绿的方式通过：
    // 页面整个没了，"没人 import 它"照样成立。
    // 🔴 这条也是「不许只删一半」的文件级靶子——删掉 TimingBox 留 DormantBox（或反过来）
    //    会在这里当场变红。渲染层面的两区顺序锁在 web 侧
    //    （`web/src/triage/TriagePage.test.tsx`「两区收件箱集成」），两边分工不重叠。
    for (const f of TRIAGE_FILES) {
      expect(existsSync(join(TRIAGE_DIR, f)), `web/src/triage/${f} 不见了——有人在删一半`).toBe(true)
    }
    const page = codeOf(join(TRIAGE_DIR, 'TriagePage.tsx'))
    for (const box of ['TimingBox', 'DormantBox']) {
      expect(page, `TriagePage 不再挂 ${box}——两区被拆了`).toContain(`<${box}`)
    }
    // parked 族的反向锁：文件不许回来，页面也不许再挂它们。
    for (const f of RETIRED_TRIAGE_FILES) {
      expect(existsSync(join(TRIAGE_DIR, f)),
        `web/src/triage/${f} 又出现了 —— parked 族已于 2026-08-13 整族退役，\n` +
        '复活它之前请先读 web/src/triage/TriagePage.tsx 头注释的「2.5 parked 族的结局」段：\n' +
        'parked_paths 今天零写入者，给它建 UI 就是给一张永远为空的表建界面。',
      ).toBe(false)
    }
    for (const box of ['PendingBox', 'ExcludedBox']) {
      expect(page, `TriagePage 又挂上了 ${box}——见上一条的说明`).not.toContain(`<${box}`)
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

  it('④ parked 族墓碑锁：parked_paths 零写入者，且前端零读取面（2026-08-13 整族退役）', () => {
    // ── 这一条的方向在 2026-08-13 翻转了 ──
    // 原本它断言 parked_paths **有**活写入者（v2/ingest.ts），以此证明 Pending/Excluded
    // 两区的数据面是活的、页不该删。ingest 退役后前提消失，两区已按那条断言自己写的剧本
    // 删除。现在它守相反的一件事：**没人把这一族悄悄接回来**。
    //
    // 为什么要继续守而不是一删了之：接回来是**静默**的——加一个 upsertParkedPath 调用点
    // 不会有任何东西报错，只会让一张没有读出面的表重新长行；反过来加一个读取面则会让 UI
    // 显示一张永远为空的表。两个方向都得有人当场知道。
    const writers = productionSources(SRC_ROOT, ['.ts'])
      .filter((f) => f !== join(SRC_ROOT, 'v2', 'libraryRepo.ts')) // 定义处不算调用点
      .filter((f) => /\.upsertParkedPath\s*\(/.test(codeOf(f)))
      .map((f) => relative(SRC_ROOT, f))
    expect(writers,
      'parked_paths 又有了写入者 —— 这一族已于 2026-08-13 整族退役（唯一写入者 v2/ingest.ts\n' +
      '连同整条链删除）。加写入者之前请先回答：谁读它？在哪一页露出？\n' +
      '若答案是"没有"，那就是本仓病 A 的第 N 次复发。\n' +
      '正本：web/src/triage/TriagePage.tsx 头注释「2.5 parked 族的结局」段。',
    ).toEqual([])

    // 读取面：整个 web/src（**含** triage/，不再豁免——那两个区已经没了）零调用。
    const readers = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => /\.triage\s*\(|useTriage\s*\(|\.parked\s*\(|useParked\s*\(/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))
    expect(readers,
      'parked/triage 的前端读取面又回来了 —— 端点 GET /api/parked 与 GET /api/v2/triage\n' +
      '已于 2026-08-13 删除，调用它们只会拿到 404。见上一条的正本指针。',
    ).toEqual([])
  })

  it('判据自检：三套扫描器都真的能抓到东西（否则②③④恒绿）', () => {
    // ⚠️ ④ 在 2026-08-13 从"正向断言"翻成"墓碑锁"（期望空集合），于是它**天然**会被
    //    "扫描器空转"喂成假绿——这正是本组自检存在的理由，下面第 3、4 段各给它一个靶子。
    // ②的扫描器：用 AppShell 当靶子——它确实 import 了 ActivityPage，同一条正则
    // （改成 ActivityPage）必须抓得到。抓不到 = 扫描器空转 = ②的"零 importer"毫无意义。
    const shellImporters = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => /from\s+'[^']*\/ActivityPage\.js'/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))
    expect(shellImporters).toContain('shell/AppShell.tsx')

    // ③的扫描器：daemonV2 里换一个**确实存在**的调用当靶子。
    expect(/\brunMaintenance\s*\(/.test(codeOf(join(SRC_ROOT, 'v2', 'daemonV2.ts')))).toBe(true)

    // ④写入面扫描器（正则/遍历确实能抓到东西）：靶子要挑一个**确实还有生产调用点**的
    // LibraryRepo 方法。`listParkedPaths` 合适——apiV2.buildWorkflowPending（活的，顶栏
    // 计数）与 cli/unidentifiedFindSubtitle.ts（保留待裁）都在调。
    //
    // ⚠️ 靶子选择踩过一次：先挑的是 `clearParkedPath`，而它在同一轮里随
    //    `triageOps.unexclude` 一起失去了最后一个调用点 → 自检当场红。那不是坏事，
    //    正是自检该做的事（它证明扫描器没在空转）——但也说明**靶子必须挑一个不会跟着
    //    这一族一起消失的方法**，否则下次清理又要来改这里。
    const parkedCallers = productionSources(SRC_ROOT, ['.ts'])
      .filter((f) => f !== join(SRC_ROOT, 'v2', 'libraryRepo.ts'))
      .filter((f) => /\.listParkedPaths\s*\(/.test(codeOf(f)))
      .map((f) => relative(SRC_ROOT, f))
    expect(parkedCallers.length,
      '④ 的写入面扫描器抓不到任何东西——遍历或 codeOf 坏了，那条墓碑锁正在假绿',
    ).toBeGreaterThan(0)

    // ④读取面扫描器：用一个**确实还在**的 hook 当靶子（useMediaLibraryDetail → AppShell）。
    const pendingReaders = productionSources(WEB_SRC, ['.ts', '.tsx'])
      .filter((f) => !f.includes('/api/'))
      .filter((f) => /useMediaLibraryDetail\s*\(/.test(codeOf(f)))
      .map((f) => relative(WEB_SRC, f))
    expect(pendingReaders,
      '④ 的读取面扫描器抓不到任何东西——那条墓碑锁正在假绿',
    ).toContain('shell/AppShell.tsx')
  })
})
