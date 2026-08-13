#!/usr/bin/env node
// scripts/verify.mjs —— 单一验收入口。
//
// ── 为什么需要它（2026-08-13，一次真实的漏网）────────────────────────────────
// 此前每轮验收都手敲这两行：
//     npx vitest run --reporter=json > /tmp/a.json
//     node -e "...console.log('total='+j.numTotalTests,'failed='+j.numFailedTests)"
// 它对**空 describe**（`describe('x', () => {})`，vitest 报 "No test found in suite"）
// **完全免疫**：那次 `numFailedTests` 是 0、`numTotalTests` 是 3272，两个数字全部达标，
// 而 `vitest` 的**退出码是 1**、`testResults[].status` 里有一个 `failed`。
// commit message 因此写下了"0 失败"——字面为真，结论是假的。
//
// 讽刺的是同一个 commit 还专门记了「踩到 vitest 静默丢文件，靠断言文件内用例数抓住」——
// 它防住了 0-test **文件**，没防住 0-test **suite**，而验收口径正好瞎在后者。
//
// 所以这个脚本的判据是**四条同时成立**，缺一即失败：
//   ① 退出码为 0        ② numFailedTests === 0
//   ③ 每个 testResults[].status === 'passed'（抓空 describe / 加载失败）
//   ④ 文件数 >= 基线    （抓 vitest 静默丢整个文件——本仓踩过 141 vs 142）
//
// 用法：node scripts/verify.mjs [--be-files N] [--fe-files N]
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt
}
// 基线：低于它就说明有文件被静默丢掉。随真实文件数增长时手动上调。
const MIN_BE_FILES = flag('--be-files', 146)
const MIN_FE_FILES = flag('--fe-files', 84)

const tmp = mkdtempSync(join(tmpdir(), 'scout-verify-'))
let failed = false
const fail = (msg) => { failed = true; console.error(`  ✗ ${msg}`) }
const ok = (msg) => console.log(`  ✓ ${msg}`)

function runSuite(label, cwd, extraArgs, minFiles) {
  const out = join(tmp, `${label}.json`)
  console.log(`\n[${label}] vitest`)
  const r = spawnSync('npx', ['vitest', 'run', ...extraArgs, '--reporter=json', '--outputFile', out],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  // ① 退出码 —— 这一条是本脚本存在的理由，别删
  if (r.status === 0) ok('退出码 0')
  else fail(`退出码 ${r.status}（即便下面的数字全部达标，也**不算通过**）`)

  let j
  try { j = JSON.parse(readFileSync(out, 'utf8')) }
  catch { fail('report 读不出来（vitest 崩了？）'); return }

  // ② 用例级失败
  if (j.numFailedTests === 0) ok(`用例 ${j.numTotalTests} 条，0 失败`)
  else {
    fail(`${j.numFailedTests} 条用例失败：`)
    for (const t of j.testResults) {
      for (const a of (t.assertionResults ?? [])) {
        if (a.status === 'failed') console.error(`      · ${t.name.split('/').pop()} :: ${a.title}`)
      }
    }
  }

  // ③ 文件级状态 —— 空 describe / 模块加载失败只在这里露头
  const bad = j.testResults.filter((t) => t.status !== 'passed')
  if (bad.length === 0) ok(`${j.testResults.length} 个测试文件全部 passed`)
  else {
    fail(`${bad.length} 个测试文件非 passed（空 describe？模块加载失败？）：`)
    for (const t of bad) console.error(`      · ${t.name.split('/').pop()} → ${t.status}`)
  }

  // ④ 文件数下限 —— 抓静默丢文件
  if (j.testResults.length >= minFiles) ok(`文件数 ${j.testResults.length} >= 基线 ${minFiles}`)
  else fail(`文件数 ${j.testResults.length} < 基线 ${minFiles}——有文件被静默丢掉了`)
}

function runTsc(label, cwd) {
  console.log(`\n[${label}] tsc --noEmit`)
  const r = spawnSync('npx', ['tsc', '--noEmit'], { cwd, encoding: 'utf8' })
  if (r.status === 0) ok('类型检查通过')
  else { fail('类型错误：'); console.error((r.stdout || r.stderr).split('\n').slice(0, 12).join('\n')) }
}

runSuite('后端', process.cwd(), ['--exclude', '**/web/**'], MIN_BE_FILES)
runTsc('后端', process.cwd())
runSuite('前端', join(process.cwd(), 'web'), [], MIN_FE_FILES)
runTsc('前端', join(process.cwd(), 'web'))

console.log(failed ? '\n❌ 验收未通过\n' : '\n✅ 四项判据全部通过（退出码 / 用例 / 文件状态 / 文件数）\n')
process.exit(failed ? 1 : 0)
