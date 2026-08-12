// src/cli/handleWorkerTask.orphan.test.ts
// ═══════════════════════════════════════════════════════════════════════════
// 2026-08-13「jobs 队列泄漏」裁决的承载物：把 handleWorkerTask 的**孤儿状态**从
// 一段会过期的注释，升级成一条会红的断言。
// ═══════════════════════════════════════════════════════════════════════════
//
// 背景：handleWorkerTask 是旧 jobs 队列唯一的认领者，随 ScoutDaemon 于第 7 步删除后
// 变成生产零调用者。它被刻意保留（背后四条 runner 是真资产，缺的只是一根 claim 接线），
// 保留的条件是**事实必须可查**。
//
// 这个文件锁住两件事，方向相反，缺一不可：
//
//   ① 它今天仍是孤儿 —— 没有任何活代码 import 它。
//      这条红了 = 有人把它接回去了 = 队列复活了 = handleWorkerTask.ts 头注释里
//      「零调用者」那一大段、以及 ingestTrigger.ts 里「orchestrate 不可执行」的裁决
//      前提，都需要重新审视。**红不等于错，等于"该重读裁决了"**。
//
//   ② 它仍然可用 —— 模块能被 import、导出的是个函数、deps 契约还在。
//      没有这条，①会以最糟的方式恒绿：文件被误删或改坏，"没人 import 它"照样成立。
//
// ⚠️ 判据为什么不是 `rg` 而是真的解析 import：
//    grep 会被字符串、注释、以及本文件自己的 import 语句喂饱（本文件就 import 了它）。
//    所以下面显式排除测试文件——测试 import 不是"接线"，生产 import 才是。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHandleWorkerTask } from './handleWorkerTask.js'

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** src 下所有**非测试**的 .ts 文件（测试 import 不算接线）。 */
function productionSources(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
    }
  }
  walk(SRC_ROOT)
  return out
}

/** 剥掉注释，只留可执行代码——否则 handleWorkerTask.ts 头注释里那句
 *  `rg "from './handleWorkerTask.js'"` 会把判据自己喂饱（真踩过：ingestTrigger 的
 *  同型判据第一版就是被自己的解释性散文匹配到而假红）。 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('handleWorkerTask 的孤儿状态（2026-08-13 裁决的机器可查载体）', () => {
  it('② 阳性对照：模块本身是活的、可 import、导出一个工厂函数', () => {
    // 先立这条。没有它，①会在"文件被删/改坏"时以假绿的方式通过。
    expect(typeof makeHandleWorkerTask).toBe('function')
  })

  it('① 生产代码里**零个** import——它仍是孤儿（红了说明队列被接回去了，去重读两处裁决）', () => {
    const importers = productionSources()
      .filter((f) => codeOf(f).includes("from './handleWorkerTask.js'"))
      .map((f) => relative(SRC_ROOT, f))

    expect(importers,
      '有活代码 import 了 handleWorkerTask —— jobs 队列的认领者回来了。\n' +
      '这不一定是错，但下面两处裁决的前提已变，必须重读并更新：\n' +
      '  · src/cli/handleWorkerTask.ts 头注释（「生产零调用者」+ 删除判据 (b)）\n' +
      '  · src/daemon/ingestTrigger.ts 头注释（orchestrate 入队删除的理由）\n' +
      '    ⚠️ 尤其注意：本文件的路由表没有 orchestrate 分支。若队列复活而 ingest 的\n' +
      '    orchestrate 入队也要一并恢复，必须先实现 orchestrate 的处理分支，\n' +
      '    否则那些行会直接走 completeError。',
    ).toEqual([])
  })

  it('判据自检：扫描器真的能抓到 import（否则①恒绿）', () => {
    // 阴性对照的对照。用本测试文件自己当靶子——它确实 import 了那个模块，
    // 同一套 codeOf+includes 必须能抓到，否则①的"零 importer"毫无意义。
    const selfPath = fileURLToPath(import.meta.url)
    expect(codeOf(selfPath)).toContain("from './handleWorkerTask.js'")
  })
})
