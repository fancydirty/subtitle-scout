# Agent 判断 + Staging 沙盒 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 字幕候选是否匹配目标资源,全程由 agent 定性判断(是/不是,无置信度数字);拿不准的候选下载进沙盒、开箱体检、agent 终审后才二选一表态;通过终审的字幕原子安装进媒体库,试错垃圾随 job 结束清零。needs_review/ask_user 人工确认环节从判定链、DB、executor、web 全部拔除。

**Architecture:** 三个新增独立模块打底(`src/files/stagingSandbox.ts` 沙盒生命周期+原子安装、`src/files/subtitleInspect.ts` 开箱体检信号、`src/agent/verifySubtitle.ts` 终审 agent 调用),各自零依赖既有代码、可独立测试。判定链收窄为两态:`rankCandidates` 只排序候选+丢弃 mismatch(不再打分/定阈值),`gate.ts` 把排序结果校验成一份结构合法的候选队列,`pipeline.ts` 依队列顺序逐个"下载→体检→终审",第一个终审"是"即装机结束。executor/db/libraryRepo/web 层的 needs_review 状态与 ask_user 分支整条拔除,DB 用一条新迁移把存量 needs_review 行复位为 missing 重新排队。

**Tech Stack:** TypeScript ESM(`.js` import 后缀), vitest, better-sqlite3, zod, 既有 LLM runtime(`src/agent/runtime.ts` 的 `LlmRuntime.call`), chardet+iconv-lite(字幕编码归一化,已是依赖)。

**Spec:** `docs/design/2026-07-12-agent-judgment-staging-design.md` — 两条公理("无计算器"/"无人工环节")与流程图以 spec 为准,本计划的每个任务都在实现 spec 里的某一条。

---

## 阶段编排与红窗口说明(先读,再动手)

七个阶段顺序执行,worktree 隔离,TDD。**阶段 1-3 互相独立、不改动任何既有文件**,每个阶段结束仓库全量 `npm test` + `npm run check` 保持绿色。

阶段 4-5 之间存在一个**刻意接受的红窗口**:`gate.ts`(阶段 4)与 `pipeline.ts`(阶段 5)共享 `RankDecision`/`GateResult` 的类型形状,阶段 4 改掉这两个类型后,`pipeline.ts`、`pipeline.test.ts`、`cli/index.ts` 会编译失败(`rank.decision`/`rank.confidence`/旧版 `runGate` 签名不再存在)。这是不可避免的——`gate.ts`/`schemas.ts` 只有一个消费方(`pipeline.ts`),不可能在不碰 `pipeline.ts` 的前提下改完它们的形状还保持整仓库绿色。处理方式:

- 阶段 4 的每个任务只运行**该任务自己新增/修改的独立测试文件**(如 `gate.test.ts`、`seasonPackGate.test.ts`),不跑 `npm test` 全量、不跑 `npm run check`。
- 阶段 4 结束时明确标注:"此刻 `pipeline.ts`/`pipeline.test.ts`/`cli/index.ts` 处于红——阶段 5 任务 5.1 第一件事就是修复编译。"
- 阶段 5 任务 5.1 是这次红窗口的唯一收口点:改完当场跑 `npm run check` 确认整仓库编译通过,再继续该阶段其余任务。

阶段 6、7 各自开始前仓库应为绿(阶段 5 结束时收口)。阶段 6 内部（db 迁移→libraryRepo→executor）有类似的小红窗口，见阶段 6 说明。

---

## File Structure

| 文件 | 责任 |
|---|---|
| `src/files/stagingSandbox.ts`(新) | 沙盒目录生命周期:`allocate`(建目录+`.ignore`标记)、`install`(NFC 归一化原子 rename,含 EEXIST/EPERM/EBUSY 退避重试与 EXDEV 拷贝兜底)、`cleanup`(job 结束整目录删除)、`gcOrphans`(启动孤儿回收,镜像 `jobsRepo.reapAllActive`) |
| `src/files/stagingSandbox.test.ts`(新) | 上述四个函数的单测 |
| `src/files/subtitleInspect.ts`(新) | 开箱体检:解析已落盘 `.srt`/`.ass`,产出 `cueCount`/时间轴跨度/简繁体系/`isHtml`/`decodable` 等结构信号(不合成分数) |
| `src/files/subtitleInspect.test.ts`(新) | SRT/ASS 解析、HTML 错误页/不可解码检测、简繁判定的单测 |
| `src/agent/verifySubtitle.ts`(新) | 终审 agent:一次 LLM 调用,输入目标身份+候选元数据+体检信号,输出 `{match, reason}` |
| `src/agent/verifySubtitle.test.ts`(新) | prompt 内容与 schema 接线单测 |
| `src/core/schemas.ts`(改) | 新增 `VerifyDecisionSchema`;`RankDecisionSchema` 从"单一决策+置信度"改写为"排序候选队列+理由"(`order[]`/`rejected[]`/`reasons[]`);`MediaContextSchema.preferences` 删 `auto_download_min_confidence`;`FinalDecisionSchema.decision` 枚举删 `ask_user`;`LooseEpisodesMapSchema`/`SeasonMapSchema` 删 `confidence` 字段 |
| `src/core/gate.ts`(改) | 两态化:`ok=true` 时产出结构校验过的候选队列(`GateQueueItem[]`),不再单选一个候选;`ok=false` 时恒为 `no_safe_match`(`ask_user` 出口拔除) |
| `src/core/orphanGate.ts`(改) | 删除置信度阈值比较,只保留结构校验(`file` 在扫描到的孤儿集合里) |
| `src/core/seasonPackGate.ts`(改) | 删除 `minConfidence`/`confidence` 阈值过滤,重复 `episode_code` 去重规则从"保留高置信度"改为"保留 map 输出中先出现的" |
| `src/agent/rankCandidates.ts`(改) | prompt 与实现改为"排序 + 丢弃 mismatch",不再要求模型打分或选择唯一 `decision` |
| `src/agent/mapSeasonPack.ts`(改) | prompt 删除对 `confidence` 字段的要求 |
| `src/agent/mapLooseEpisodes.ts`(改) | prompt 删除对 `confidence` 字段与"< 0.75 不指派"规则的要求 |
| `src/core/mediaContext.ts`(改) | 删除 `applyConfidenceOverride`(读 `AUTO_DOWNLOAD_MIN_CONFIDENCE` 环境变量的函数,字段已不存在) |
| `src/core/cache.ts`(改) | `CacheEntry` positive 分支删除 `confidence` 字段 |
| `src/core/pipeline.ts`(改) | 核心重接线:新增 `staging`/`verify` deps;候选队列循环(下载进沙盒→体检→未过结构体检直接弃→终审→装机);季横扫/季包升格分支删除置信度过滤,去重改"先出现者胜出";`PipelineResult.decision` 删 `ask_user` |
| `src/cli/index.ts`(改) | `makeDeps` 接线 `verify`+`staging`;`cmdRun`/`cmdRunItem` 删 `applyConfidenceOverride` 调用;`cmdWatch` 接线 daemon 启动沙盒 GC |
| `src/v2/daemon.ts`(改) | `DaemonDeps` 新增可选 `gcStaging`,`run()` 启动时调用一次(镜像 `reapAllActive` 调用点) |
| `src/v2/db.ts`(改) | 新增 `MIGRATIONS[5]`(v6):把存量 `needs_review` 行复位为 `missing`+`recheck_after=now`;不重建 CHECK 约束 |
| `src/v2/libraryRepo.ts`(改) | `SubStatus` 删 `needs_review`;删除 `markNeedsReview`;`missingBySeason`/`missingMovies`/`resetRecheck` 的 SQL 删 `needs_review` 分支 |
| `src/v2/executor.ts`(改) | `remainingTargets` 删 `needs_review` 复查分支;`ask_user` 分支/`askUserDetail`/`minConfidence`/`confidence` 字段全删;决策路由收窄为 `no_safe_match` 单一内容失败出口 |
| `src/v2/scanner.ts`(改) | 磁盘 arm 的 `unavailable`/`needs_review` 保留逻辑删掉 `needs_review` 分支 |
| `src/dashboard/labels.ts`(改) | 删除 `ask_user` 人话标签条目 |
| `src/dashboard/apiV2.ts`(改) | `CoverageDTO` 删 `needsReview`;`emptyCoverage`/`addToCoverage` 同步删除 |
| `web/src/api/types.ts`(改) | `SubStatus` 删 `needs_review`;`CoverageDTO` 删 `needsReview` |
| `web/src/lib/badge.ts`(改) | `BadgeKind` 删 `review`;`scoutScope`/`coverageBadge`/`matchesFilter` 删 review 相关分支 |
| `web/src/lib/episode.ts`(改) | `EpisodeCellState` 删 `review`;`episodeCellState` 删 needs_review 分支 |
| `web/src/lib/detail.ts`(改) | `StateTally` 删 `review`;删除 `needsReviewTooltip` |
| `web/src/components/EpisodeGrid.tsx`(改) | 删 review 格子/图例条目 |
| `web/src/styles.css`(改) | 删 `--amber`/`--amber-dim`、`.badge.review`/`.ep.review`/`.sw.review` |
| 各文件对应 `*.test.ts`/`*.test.tsx` | 随每次改动同步更新,见各任务 |

---

## Phase 1: Staging 沙盒模块(独立,可单独测试)

### Task 1.1: `allocate` + `cleanup`

**Files:**
- Create: `src/files/stagingSandbox.ts`
- Create: `src/files/stagingSandbox.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/files/stagingSandbox.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, cleanup } from './stagingSandbox.js'

const mediaRoot = () => mkdtempSync(join(tmpdir(), 'stage-root-'))

describe('allocate', () => {
  it('creates <mediaRoot>/.subtitle-staging/<jobId>/ and returns its path', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    expect(dir).toBe(join(root, '.subtitle-staging', 'job-1'))
    expect(existsSync(dir)).toBe(true)
  })

  it('drops a .ignore marker file next to the per-job dirs (Jellyfin should skip this tree)', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    expect(existsSync(ignorePath)).toBe(true)
    expect(readFileSync(ignorePath, 'utf8')).toContain('subtitle-scout staging')
  })

  it('is idempotent: allocating the same jobId twice does not throw and keeps existing files', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'marker.txt'), 'x')
    const dir2 = allocate('job-1', root)
    expect(dir2).toBe(dir)
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true)
  })

  it('does not overwrite an existing .ignore file on a second allocate', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    writeFileSync(ignorePath, 'custom content')
    allocate('job-2', root)
    expect(readFileSync(ignorePath, 'utf8')).toBe('custom content')
  })
})

describe('cleanup', () => {
  it('removes the whole per-job staging directory', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'leftover.srt'), 'junk')
    cleanup('job-1', root)
    expect(existsSync(dir)).toBe(false)
  })

  it('is a no-op (does not throw) when the directory was never allocated', () => {
    const root = mediaRoot()
    expect(() => cleanup('never-allocated', root)).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/stagingSandbox.test.ts`
Expected: FAIL — `Cannot find module './stagingSandbox.js'`(文件不存在)

- [ ] **Step 3: 最小实现**

```ts
// src/files/stagingSandbox.ts
// 字幕试错沙盒:候选下载到这里"打开看",agent 终审通过才原子安装进媒体目录。
// 试错本身零风险——job 结束(无论成败)整个沙盒目录被删除,写错媒体库的唯一路径是 install()。
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STAGING_DIRNAME = '.subtitle-staging'

/** 每 job 独立的沙盒目录:`<mediaRootForVideo>/.subtitle-staging/<jobId>/`。必须与目标视频
 *  同一文件系统——install() 的原子 rename 单跳不容跨设备。目录带点前缀 + 同级 `.ignore`
 *  标记文件,Jellyfin 双保险扫不到。jobId 由调用方保证同一时刻内唯一。 */
export function allocate(jobId: string, mediaRootForVideo: string): string {
  const root = join(mediaRootForVideo, STAGING_DIRNAME)
  const dir = join(root, jobId)
  mkdirSync(dir, { recursive: true })
  const ignorePath = join(root, '.ignore')
  if (!existsSync(ignorePath)) {
    try {
      writeFileSync(ignorePath, 'subtitle-scout staging area — media servers should not scan this directory\n')
    } catch {
      // best-effort 标记;缺失从不阻塞试错流程,顶多让 Jellyfin 误扫到孤儿 srt
    }
  }
  return dir
}

/** job 结束(无论成败)删除整个沙盒目录——试错垃圾零残留。best-effort:NAS/SMB 上 rm
 *  可能因残留文件句柄失败,不让清理失败拖垮主流程结论(同 subtitleWriter 的孤儿 .tmp 清理先例)。 */
export function cleanup(jobId: string, mediaRootForVideo: string): void {
  const dir = join(mediaRootForVideo, STAGING_DIRNAME, jobId)
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // best-effort:清理失败不影响本次运行已产生的结论
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/stagingSandbox.test.ts`
Expected: PASS(6 tests)

- [ ] **Step 5: 提交**

```bash
git add src/files/stagingSandbox.ts src/files/stagingSandbox.test.ts
git commit -m "feat(staging): add sandbox allocate/cleanup"
```

### Task 1.2: `install` — NFC 归一化原子 rename

**Files:**
- Modify: `src/files/stagingSandbox.ts`
- Modify: `src/files/stagingSandbox.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/files/stagingSandbox.test.ts
import { renameSync } from 'node:fs'
import { install } from './stagingSandbox.js'

describe('install', () => {
  it('atomically renames the staged file to the final path', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.zh-Hans.srt')
    writeFileSync(stagedPath, '1\n00:00:01,000 --> 00:00:02,000\nhi\n')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(existsSync(stagedPath)).toBe(false)
  })

  it('NFC-normalizes the final path before writing (Synology SMB NFD landmine)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    // "é" 的 NFD 分解形式(e + combining acute accent,2 个 code point)
    const nfdName = 'Café.zh-Hans.srt'
    const finalPath = join(root, nfdName)
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath.normalize('NFC'))
    expect(result.path).not.toBe(finalPath) // 输入是 NFD,输出必须是 NFC,两者字节不同
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/stagingSandbox.test.ts -t install`
Expected: FAIL — `install is not a function`

- [ ] **Step 3: 最小实现**

```ts
// 追加到 src/files/stagingSandbox.ts 顶部 import
import { renameSync } from 'node:fs'

// 追加到文件末尾
/** 原子安装:沙盒里胜出的文件 rename 进媒体目录。文件名一律 NFC 归一化(群晖 SMB 的
 *  NFD/NFC 乱码坑)——finalPath 先 normalize('NFC') 再改名。 */
export async function install(stagedPath: string, finalPath: string): Promise<{ path: string }> {
  const normalizedFinal = finalPath.normalize('NFC')
  renameSync(stagedPath, normalizedFinal)
  return { path: normalizedFinal }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/stagingSandbox.test.ts -t install`
Expected: PASS(2 tests)

- [ ] **Step 5: 提交**

```bash
git add src/files/stagingSandbox.ts src/files/stagingSandbox.test.ts
git commit -m "feat(staging): add NFC-normalized atomic install"
```

### Task 1.3: `install` — EEXIST/EPERM/EBUSY 退避重试 + EXDEV 拷贝兜底

**Files:**
- Modify: `src/files/stagingSandbox.ts`
- Modify: `src/files/stagingSandbox.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/files/stagingSandbox.test.ts
import * as fsMod from 'node:fs'
import { vi } from 'vitest'

describe('install — retry and EXDEV fallback', () => {
  it('retries on EBUSY (simulated SMB oplock jitter) and eventually succeeds', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const realRename = fsMod.renameSync
    let calls = 0
    const spy = vi.spyOn(fsMod, 'renameSync').mockImplementation((...args) => {
      calls++
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return realRename(...(args as Parameters<typeof realRename>))
    })
    try {
      const result = await install(stagedPath, finalPath)
      expect(result.path).toBe(finalPath)
      expect(calls).toBe(3)
      expect(existsSync(finalPath)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('gives up after exhausting retries on a persistently retryable error', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const spy = vi.spyOn(fsMod, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('perm'), { code: 'EPERM' })
    })
    try {
      await expect(install(stagedPath, finalPath)).rejects.toThrow(/perm/)
    } finally {
      spy.mockRestore()
    }
  })

  it('falls back to copy+fsync+rename on EXDEV (cross-device, theoretically unreachable given allocate() shares the video root)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    const spy = vi.spyOn(fsMod, 'renameSync').mockImplementation((from, to) => {
      renameCalls++
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      // 第二次调用来自 copyThenRenameSameDir 内部的同盘 rename——放行到真实实现
      return fsMod.renameSync(from as string, to as string)
    })
    try {
      const result = await install(stagedPath, finalPath)
      expect(result.path).toBe(finalPath)
      expect(existsSync(finalPath)).toBe(true)
      expect(readFileSync(finalPath, 'utf8')).toBe('cross-device content')
    } finally {
      spy.mockRestore()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/stagingSandbox.test.ts -t "retry and EXDEV"`
Expected: FAIL — 第一个测试里 `calls` 停在 1(当前实现不重试,EBUSY 直接抛出)

- [ ] **Step 3: 最小实现**

```ts
// src/files/stagingSandbox.ts — 替换顶部 import 为:
import {
  existsSync, mkdirSync, rmSync, writeFileSync, readFileSync,
  renameSync, openSync, writeSync, fsyncSync, closeSync,
} from 'node:fs'
import { join, dirname } from 'node:path'

// 追加常量(放在 STAGING_DIRNAME 下面)
const INSTALL_RETRY_DELAYS_MS = [50, 150, 400, 1000]
const RETRYABLE_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY'])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 与 subtitleWriter.writeAll 同款:裸 writeSync 不保证一次写完全部字节
function writeAll(fd: number, buf: Buffer): void {
  let written = 0
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written)
    if (n === 0) throw new Error('writeSync wrote 0 bytes; aborting to avoid an infinite loop')
    written += n
  }
}

/** 跨设备兜底(理论上不该发生——沙盒与视频同根,见 allocate):拷到目标目录内点前缀
 *  临时名 → fsync → 同盘 rename。 */
function copyThenRenameSameDir(stagedPath: string, finalPath: string): void {
  const data = readFileSync(stagedPath)
  const tmpPath = join(dirname(finalPath), `.subtitle-scout-install-${process.pid}-${Date.now()}`)
  const fd = openSync(tmpPath, 'w')
  try {
    writeAll(fd, data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, finalPath)
}

// 替换 install() 实现为:
/** 原子安装:沙盒里胜出的文件 rename 进媒体目录。文件名一律 NFC 归一化(群晖 SMB 的
 *  NFD/NFC 乱码坑)——finalPath 先 normalize('NFC') 再判存在性/改名。遇 EEXIST/EPERM/
 *  EBUSY(SMB oplock 抖动)退避重试;EXDEV(跨设备)兜底走拷贝+改名。不用 O_TMPFILE
 *  (网络盘不支持)。 */
export async function install(stagedPath: string, finalPath: string): Promise<{ path: string }> {
  const normalizedFinal = finalPath.normalize('NFC')
  let lastError: unknown
  for (let attempt = 0; attempt <= INSTALL_RETRY_DELAYS_MS.length; attempt++) {
    try {
      renameSync(stagedPath, normalizedFinal)
      return { path: normalizedFinal }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        copyThenRenameSameDir(stagedPath, normalizedFinal)
        return { path: normalizedFinal }
      }
      lastError = e
      if (code && RETRYABLE_CODES.has(code) && attempt < INSTALL_RETRY_DELAYS_MS.length) {
        await sleep(INSTALL_RETRY_DELAYS_MS[attempt])
        continue
      }
      throw e
    }
  }
  throw lastError
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/stagingSandbox.test.ts`
Expected: PASS(全部到目前为止的用例,含 Task 1.1/1.2)

- [ ] **Step 5: 提交**

```bash
git add src/files/stagingSandbox.ts src/files/stagingSandbox.test.ts
git commit -m "feat(staging): retry install on EBUSY/EPERM/EEXIST, fall back to copy on EXDEV"
```

### Task 1.4: `gcOrphans` — 启动孤儿回收

**Files:**
- Modify: `src/files/stagingSandbox.ts`
- Modify: `src/files/stagingSandbox.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/files/stagingSandbox.test.ts
import { mkdirSync } from 'node:fs'
import { gcOrphans } from './stagingSandbox.js'

describe('gcOrphans', () => {
  it('removes every staging dir not in activeJobIds, across multiple media roots', () => {
    const root1 = mediaRoot()
    const root2 = mediaRoot()
    allocate('job-orphan-1', root1)
    allocate('job-active', root1)
    allocate('job-orphan-2', root2)

    const cleaned = gcOrphans([root1, root2], new Set(['job-active']))

    expect(cleaned).toBe(2)
    expect(existsSync(join(root1, '.subtitle-staging', 'job-orphan-1'))).toBe(false)
    expect(existsSync(join(root1, '.subtitle-staging', 'job-active'))).toBe(true)
    expect(existsSync(join(root2, '.subtitle-staging', 'job-orphan-2'))).toBe(false)
  })

  it('is a no-op when a media root has no .subtitle-staging dir yet', () => {
    const root = mediaRoot()
    expect(() => gcOrphans([root], new Set())).not.toThrow()
    expect(gcOrphans([root], new Set())).toBe(0)
  })

  it('does not treat the .ignore marker file as an orphan directory', () => {
    const root = mediaRoot()
    allocate('job-1', root) // 顺带创建 .ignore
    gcOrphans([root], new Set())
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
  })

  it('boot semantics: empty activeJobIds nukes everything (mirrors jobsRepo.reapAllActive)', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    allocate('job-2', root)
    mkdirSync(join(root, '.subtitle-staging', 'job-3'), { recursive: true })
    const cleaned = gcOrphans([root], new Set())
    expect(cleaned).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/stagingSandbox.test.ts -t gcOrphans`
Expected: FAIL — `gcOrphans is not a function`

- [ ] **Step 3: 最小实现**

```ts
// 追加到 src/files/stagingSandbox.ts 顶部 import,加入 readdirSync, statSync
import {
  existsSync, mkdirSync, rmSync, writeFileSync, readFileSync,
  renameSync, openSync, writeSync, fsyncSync, closeSync,
  readdirSync, statSync,
} from 'node:fs'

// 追加到文件末尾
/** 启动即回收(镜像 jobsRepo.reapAllActive 的"单实例前提,无条件回收"):删除每个
 *  mediaRoot 下所有不在 activeJobIds 里的 .subtitle-staging/<jobId> 目录。daemon
 *  启动时旧进程必已死,任何残留沙盒目录都是崩溃/被杀留下的试错垃圾——不看年龄,直接清。
 *  返回清理的目录数。 */
export function gcOrphans(mediaRoots: string[], activeJobIds: Set<string>): number {
  let cleaned = 0
  for (const root of mediaRoots) {
    const stagingRoot = join(root, STAGING_DIRNAME)
    if (!existsSync(stagingRoot)) continue
    let entries: string[]
    try {
      entries = readdirSync(stagingRoot)
    } catch {
      continue // best-effort:目录列不出来(权限/挂载抖动)跳过这一根,下次启动再试
    }
    for (const name of entries) {
      if (name === '.ignore' || activeJobIds.has(name)) continue
      const full = join(stagingRoot, name)
      try {
        if (!statSync(full).isDirectory()) continue
        rmSync(full, { recursive: true, force: true })
        cleaned++
      } catch {
        // best-effort:单个目录清理失败不影响其它目录/其它根
      }
    }
  }
  return cleaned
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/stagingSandbox.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: 提交 + 阶段收尾**

```bash
git add src/files/stagingSandbox.ts src/files/stagingSandbox.test.ts
git commit -m "feat(staging): add gcOrphans startup sweep"
```

Run: `npm test && npm run check`
Expected: 全绿(本阶段是新文件,不影响既有代码)

---

## Phase 2: 开箱体检模块(独立,可单独测试)

### Task 2.1: SRT cue 解析

**Files:**
- Create: `src/files/subtitleInspect.ts`
- Create: `src/files/subtitleInspect.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/files/subtitleInspect.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectSubtitle } from './subtitleInspect.js'

const dir = () => mkdtempSync(join(tmpdir(), 'inspect-'))
function stage(name: string, content: string): string {
  const p = join(dir(), name)
  writeFileSync(p, content, 'utf8')
  return p
}

const SRT_SAMPLE = [
  '1', '00:00:01,000 --> 00:00:03,500', '你好世界', '',
  '2', '00:00:04,000 --> 00:00:06,200', '第二条字幕', '',
  '3', '00:20:00,000 --> 00:20:02,000', '最后一条', '',
].join('\n')

describe('inspectSubtitle — SRT cue parsing', () => {
  it('counts cues and reports first/last/span in ms', () => {
    const signals = inspectSubtitle(stage('a.srt', SRT_SAMPLE))
    expect(signals.cueCount).toBe(3)
    expect(signals.firstCueMs).toBe(1000)
    expect(signals.lastCueMs).toBe(20 * 60_000 + 2000)
    expect(signals.spanMs).toBe(signals.lastCueMs! - signals.firstCueMs!)
  })

  it('handles a comma or dot millisecond separator', () => {
    const dotStyle = '1\n00:00:01.000 --> 00:00:02.000\nhi\n'
    const signals = inspectSubtitle(stage('b.srt', dotStyle))
    expect(signals.cueCount).toBe(1)
  })

  it('zero cues on an empty-but-decodable file', () => {
    const signals = inspectSubtitle(stage('empty.srt', '\n\n'))
    expect(signals.cueCount).toBe(0)
    expect(signals.firstCueMs).toBeNull()
    expect(signals.lastCueMs).toBeNull()
    expect(signals.spanMs).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/subtitleInspect.test.ts`
Expected: FAIL — `Cannot find module './subtitleInspect.js'`

- [ ] **Step 3: 最小实现**

```ts
// src/files/subtitleInspect.ts
// 开箱体检:解析已落盘到沙盒的 .srt/.ass,产出结构信号喂给 agent 终审。不合成任何数字——
// 原始值(cue 数/时间轴跨度/检测到的文字体系)原样呈交,agent 像人一样推理,不是打分。
import { readFileSync } from 'node:fs'

export interface InspectSignals {
  decodable: boolean
  isHtml: boolean
  cueCount: number
  firstCueMs: number | null
  lastCueMs: number | null
  spanMs: number | null
  detectedScript: 'zh-Hans' | 'zh-Hant' | 'zh-yue' | 'other' | 'unknown'
  assTitle?: string | null
}

interface Cue { startMs: number; endMs: number; text: string }

const SRT_TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{3})/

function srtTimeToMs(h: string, m: string, s: string, ms: string): number {
  return (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + Number(ms)
}

function parseSrtCues(text: string): Cue[] {
  const cues: Cue[] = []
  const blocks = text.split(/\r?\n\r?\n/)
  for (const block of blocks) {
    const m = SRT_TIME.exec(block)
    if (!m) continue
    const startMs = srtTimeToMs(m[1], m[2], m[3], m[4])
    const endMs = srtTimeToMs(m[5], m[6], m[7], m[8])
    const lines = block.split(/\r?\n/)
    const timeLineIdx = lines.findIndex(l => l.includes('-->'))
    const cueText = lines.slice(timeLineIdx + 1).join(' ').trim()
    cues.push({ startMs, endMs, text: cueText })
  }
  return cues
}

/** 目前只支持 .srt——ASS 解析在 Task 2.2 加入,detectedScript/decodable/isHtml 在
 *  Task 2.3/2.4 加入。这里先给一个占位判定,后续任务会替换。 */
export function inspectSubtitle(stagedPath: string): InspectSignals {
  const text = readFileSync(stagedPath, 'utf8')
  const cues = parseSrtCues(text)
  const firstCueMs = cues.length > 0 ? Math.min(...cues.map(c => c.startMs)) : null
  const lastCueMs = cues.length > 0 ? Math.max(...cues.map(c => c.endMs)) : null
  return {
    decodable: true, isHtml: false, cueCount: cues.length,
    firstCueMs, lastCueMs,
    spanMs: firstCueMs != null && lastCueMs != null ? lastCueMs - firstCueMs : null,
    detectedScript: 'unknown',
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/subtitleInspect.test.ts`
Expected: PASS(3 tests)

- [ ] **Step 5: 提交**

```bash
git add src/files/subtitleInspect.ts src/files/subtitleInspect.test.ts
git commit -m "feat(inspect): add SRT cue count/span parsing"
```

### Task 2.2: ASS cue 解析 + `assTitle`

**Files:**
- Modify: `src/files/subtitleInspect.ts`
- Modify: `src/files/subtitleInspect.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/files/subtitleInspect.test.ts
const ASS_SAMPLE = [
  '[Script Info]',
  'Title: [字幕组] Show S02E05 [1080p]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,20',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好,世界',
  'Dialogue: 0,0:00:04.00,0:00:06.20,Default,,0,0,0,,第二条字幕',
].join('\n')

describe('inspectSubtitle — ASS cue parsing', () => {
  it('counts Dialogue lines as cues and extracts the Script Info Title', () => {
    const signals = inspectSubtitle(stage('a.ass', ASS_SAMPLE))
    expect(signals.cueCount).toBe(2)
    expect(signals.assTitle).toBe('[字幕组] Show S02E05 [1080p]')
  })

  it('parses ASS H:MM:SS.cc timestamps into ms and preserves commas inside Text', () => {
    const signals = inspectSubtitle(stage('b.ass', ASS_SAMPLE))
    expect(signals.firstCueMs).toBe(1000)
    expect(signals.lastCueMs).toBe(6 * 1000 + 6200 - 6000 + 6000) // 6200ms
  })

  it('.ssa extension uses the same ASS parser', () => {
    const signals = inspectSubtitle(stage('c.ssa', ASS_SAMPLE))
    expect(signals.cueCount).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/subtitleInspect.test.ts -t "ASS cue parsing"`
Expected: FAIL — `.ass` 走的仍是 SRT 解析器,`cueCount` 为 0,`assTitle` 为 `undefined`

- [ ] **Step 3: 最小实现**

```ts
// src/files/subtitleInspect.ts — 追加 import
import { extname } from 'node:path'

// 追加解析函数
const ASS_TIME = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{2})$/

function assTimeToMs(raw: string): number | null {
  const m = ASS_TIME.exec(raw.trim())
  if (!m) return null
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10
}

function parseAssCues(text: string): { cues: Cue[]; title: string | null } {
  const lines = text.split(/\r?\n/)
  const cues: Cue[] = []
  let title: string | null = null
  let inScriptInfo = false
  let inEvents = false
  let textFieldIndex = -1
  for (const raw of lines) {
    const line = raw.trim()
    if (/^\[Script Info\]/i.test(line)) { inScriptInfo = true; inEvents = false; continue }
    if (/^\[Events\]/i.test(line)) { inEvents = true; inScriptInfo = false; continue }
    if (/^\[/.test(line)) { inScriptInfo = false; inEvents = false; continue }
    if (inScriptInfo && /^Title\s*:/i.test(line)) {
      title = line.slice(line.indexOf(':') + 1).trim() || null
      continue
    }
    if (inEvents && /^Format\s*:/i.test(line)) {
      const fields = line.slice(line.indexOf(':') + 1).split(',').map(f => f.trim().toLowerCase())
      textFieldIndex = fields.indexOf('text')
      continue
    }
    if (inEvents && /^Dialogue\s*:/i.test(line)) {
      const rest = line.slice(line.indexOf(':') + 1)
      const fields = rest.split(',')
      // Text 字段允许含逗号:Format 声明的位置往后全部并回去(标准 ASS 惯例)
      const idx = textFieldIndex >= 0 ? textFieldIndex : 9
      if (fields.length <= idx) continue
      const startMs = assTimeToMs(fields[1] ?? '')
      const endMs = assTimeToMs(fields[2] ?? '')
      if (startMs == null || endMs == null) continue
      const cueText = fields.slice(idx).join(',').trim()
      cues.push({ startMs, endMs, text: cueText })
    }
  }
  return { cues, title }
}

// 替换 inspectSubtitle() 实现为:
export function inspectSubtitle(stagedPath: string): InspectSignals {
  const text = readFileSync(stagedPath, 'utf8')
  const ext = extname(stagedPath).toLowerCase()
  let cues: Cue[]
  let assTitle: string | null | undefined
  if (ext === '.ass' || ext === '.ssa') {
    const parsed = parseAssCues(text)
    cues = parsed.cues
    assTitle = parsed.title
  } else {
    cues = parseSrtCues(text)
  }
  const firstCueMs = cues.length > 0 ? Math.min(...cues.map(c => c.startMs)) : null
  const lastCueMs = cues.length > 0 ? Math.max(...cues.map(c => c.endMs)) : null
  return {
    decodable: true, isHtml: false, cueCount: cues.length,
    firstCueMs, lastCueMs,
    spanMs: firstCueMs != null && lastCueMs != null ? lastCueMs - firstCueMs : null,
    detectedScript: 'unknown',
    ...(assTitle !== undefined ? { assTitle } : {}),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/subtitleInspect.test.ts`
Expected: PASS(全部到目前为止的用例)

- [ ] **Step 5: 提交**

```bash
git add src/files/subtitleInspect.ts src/files/subtitleInspect.test.ts
git commit -m "feat(inspect): add ASS cue parsing and Script Info Title extraction"
```

### Task 2.3: `decodable` / `isHtml` 检测(结构体检 fail-closed 的依据)

**Files:**
- Modify: `src/files/subtitleInspect.ts`
- Modify: `src/files/subtitleInspect.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/files/subtitleInspect.test.ts
describe('inspectSubtitle — decodable / isHtml', () => {
  it('flags an HTML error page masquerading as .srt', () => {
    const html = '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body>gone</body></html>'
    const signals = inspectSubtitle(stage('fake.srt', html))
    expect(signals.isHtml).toBe(true)
    expect(signals.cueCount).toBe(0)
  })

  it('flags an empty file as undecodable', () => {
    const signals = inspectSubtitle(stage('blank.srt', ''))
    expect(signals.decodable).toBe(false)
  })

  it('flags a file dominated by replacement characters as undecodable', () => {
    const garbage = '�'.repeat(500)
    const signals = inspectSubtitle(stage('garbled.srt', garbage))
    expect(signals.decodable).toBe(false)
  })

  it('a normal SRT file is decodable and not HTML', () => {
    const signals = inspectSubtitle(stage('ok.srt', SRT_SAMPLE))
    expect(signals.decodable).toBe(true)
    expect(signals.isHtml).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/subtitleInspect.test.ts -t "decodable / isHtml"`
Expected: FAIL — `isHtml`/`decodable` 恒为写死的 `false`/`true`

- [ ] **Step 3: 最小实现**

```ts
// src/files/subtitleInspect.ts — 追加两个检测函数(放在 parseSrtCues 上方)
function isLikelyUndecodable(text: string): boolean {
  if (text.trim().length === 0) return true
  const replacementCount = (text.match(/�/g) ?? []).length
  if (replacementCount > 0 && replacementCount / text.length > 0.01) return true
  // eslint-disable-next-line no-control-regex -- 故意扫描控制字节,这正是"解不出来"的信号
  if (/[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 2000))) return true
  return false
}

function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 200).toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /<title>|<body[ >]/.test(head)
}

// 替换 inspectSubtitle() 开头几行为:
export function inspectSubtitle(stagedPath: string): InspectSignals {
  const text = readFileSync(stagedPath, 'utf8')
  const decodable = !isLikelyUndecodable(text)
  const isHtml = looksLikeHtml(text)
  if (!decodable || isHtml) {
    return { decodable, isHtml, cueCount: 0, firstCueMs: null, lastCueMs: null, spanMs: null, detectedScript: 'unknown' }
  }
  const ext = extname(stagedPath).toLowerCase()
  let cues: Cue[]
  let assTitle: string | null | undefined
  if (ext === '.ass' || ext === '.ssa') {
    const parsed = parseAssCues(text)
    cues = parsed.cues
    assTitle = parsed.title
  } else {
    cues = parseSrtCues(text)
  }
  const firstCueMs = cues.length > 0 ? Math.min(...cues.map(c => c.startMs)) : null
  const lastCueMs = cues.length > 0 ? Math.max(...cues.map(c => c.endMs)) : null
  return {
    decodable, isHtml, cueCount: cues.length,
    firstCueMs, lastCueMs,
    spanMs: firstCueMs != null && lastCueMs != null ? lastCueMs - firstCueMs : null,
    detectedScript: 'unknown',
    ...(assTitle !== undefined ? { assTitle } : {}),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/subtitleInspect.test.ts`
Expected: PASS(全部到目前为止的用例)

- [ ] **Step 5: 提交**

```bash
git add src/files/subtitleInspect.ts src/files/subtitleInspect.test.ts
git commit -m "feat(inspect): detect HTML error pages and undecodable bytes"
```

### Task 2.4: `detectScript` 简繁/粤语启发式

**Files:**
- Modify: `src/files/subtitleInspect.ts`
- Modify: `src/files/subtitleInspect.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/files/subtitleInspect.test.ts
function srtWithLines(lines: string[]): string {
  return lines.map((text, i) =>
    `${i + 1}\n00:00:0${i}.000 --> 00:00:0${i + 1}.000\n${text}\n`
  ).join('\n')
}

describe('inspectSubtitle — detectScript', () => {
  it('detects simplified Chinese from sampled cue text', () => {
    const lines = Array.from({ length: 12 }, () => '这是国说来时会为学过对现关开东车门问儿')
    const signals = inspectSubtitle(stage('simp.srt', srtWithLines(lines)))
    expect(signals.detectedScript).toBe('zh-Hans')
  })

  it('detects traditional Chinese from sampled cue text', () => {
    const lines = Array.from({ length: 12 }, () => '這是國說來時會為學過對現關開東車門問兒')
    const signals = inspectSubtitle(stage('trad.srt', srtWithLines(lines)))
    expect(signals.detectedScript).toBe('zh-Hant')
  })

  it('detects Cantonese markers even mixed with traditional characters', () => {
    const lines = Array.from({ length: 12 }, () => '佢哋唔係咁樣嘅嘢喺呢度')
    const signals = inspectSubtitle(stage('yue.srt', srtWithLines(lines)))
    expect(signals.detectedScript).toBe('zh-yue')
  })

  it('reports "other" for non-Han text', () => {
    const lines = Array.from({ length: 12 }, () => 'Hello world, this is English text.')
    const signals = inspectSubtitle(stage('eng.srt', srtWithLines(lines)))
    expect(signals.detectedScript).toBe('other')
  })

  it('reports "unknown" when there are too few Han characters to judge', () => {
    const signals = inspectSubtitle(stage('sparse.srt', srtWithLines(['你', '好'])))
    expect(signals.detectedScript).toBe('unknown')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/files/subtitleInspect.test.ts -t detectScript`
Expected: FAIL — `detectedScript` 恒为写死的 `'unknown'`

- [ ] **Step 3: 最小实现**

```ts
// src/files/subtitleInspect.ts — 追加(放在文件末尾附近,inspectSubtitle 之前)
const SIMPLIFIED_ONLY = new Set('国说来时会为学过对现关开东车门问儿无与从这样后应变电动经济单卫华叶')
const TRADITIONAL_ONLY = new Set('國說來時會為學過對現關開東車門問兒無與從這樣後應變電動經濟單衛華葉')
const CANTONESE_MARKERS = new Set('嘅嘢喺咁佢哋唔冇啦喎')

function stripTags(s: string): string {
  return s.replace(/\{[^}]*\}/g, '').replace(/<[^>]*>/g, '')
}

/** 语言/简繁判定:采样多条 cue 拼接后判——单行简繁不可靠(design 明文要求)。是信号,
 *  不是硬门槛:字数不够或简繁字都没出现时诚实报 unknown,让 agent 自己看正文判断。 */
export function detectScript(cues: Cue[]): InspectSignals['detectedScript'] {
  const sample = cues.slice(0, 50).map(c => stripTags(c.text)).join('')
  const hanChars = [...sample].filter(ch => /\p{Script=Han}/u.test(ch))
  if (hanChars.length < 10) return hanChars.length === 0 ? 'other' : 'unknown'
  let simp = 0, trad = 0, yue = 0
  for (const ch of hanChars) {
    if (SIMPLIFIED_ONLY.has(ch)) simp++
    if (TRADITIONAL_ONLY.has(ch)) trad++
    if (CANTONESE_MARKERS.has(ch)) yue++
  }
  if (yue >= 3) return 'zh-yue'
  if (simp === 0 && trad === 0) return 'unknown'
  return simp >= trad ? 'zh-Hans' : 'zh-Hant'
}

// 在 inspectSubtitle() 里把 detectedScript: 'unknown' 的两处都替换成 detectScript(cues):
// 第一处(decodable/isHtml 提前返回分支)保持 'unknown'(没有可用 cues,不用改);
// 第二处(正常返回)改为:
//   detectedScript: detectScript(cues),
```

Note: the early-return branch (undecodable/HTML) has no parsed cues, so it keeps `detectedScript: 'unknown'` unchanged — only the normal-path return statement's `detectedScript: 'unknown'` becomes `detectedScript: detectScript(cues)`.

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/files/subtitleInspect.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 5: 提交 + 阶段收尾**

```bash
git add src/files/subtitleInspect.ts src/files/subtitleInspect.test.ts
git commit -m "feat(inspect): add simplified/traditional/Cantonese script heuristic"
```

Run: `npm test && npm run check`
Expected: 全绿

---

## Phase 3: 终审 Agent(独立,可单独测试)

### Task 3.1: `VerifyDecisionSchema`

**Files:**
- Modify: `src/core/schemas.ts`
- Modify: `src/core/schemas.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/core/schemas.test.ts 的 import 列表
import {
  MediaContextSchema, MediaIdentitySchema, SearchPlanSchema,
  RankDecisionSchema, AssrtSearchResponseSchema, AssrtDetailResponseSchema,
  FinalDecisionSchema, OrphanDecisionSchema, LooseEpisodesMapSchema,
  VerifyDecisionSchema,
} from './schemas.js'

// 追加新 describe 块
describe('VerifyDecisionSchema', () => {
  it('accepts {match, reason} with no confidence field', () => {
    const d = VerifyDecisionSchema.parse({ match: true, reason: 'cue count and span line up with the episode runtime' })
    expect(d.match).toBe(true)
  })
  it('rejects a missing reason', () => {
    expect(() => VerifyDecisionSchema.parse({ match: false })).toThrow()
  })
  it('rejects a non-boolean match', () => {
    expect(() => VerifyDecisionSchema.parse({ match: 'yes', reason: 'x' })).toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/schemas.test.ts -t VerifyDecisionSchema`
Expected: FAIL — `VerifyDecisionSchema` 不是 `./schemas.js` 的导出

- [ ] **Step 3: 最小实现**

```ts
// src/core/schemas.ts — 追加到 FinalDecisionSchema 定义之后
// ---------- 终审 agent 输出(staging 沙盒体检后的二选一表态) ----------
export const VerifyDecisionSchema = z.object({
  match: z.boolean(),
  reason: z.string(),
})
export type VerifyDecision = z.infer<typeof VerifyDecisionSchema>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/schemas.test.ts`
Expected: PASS(不影响既有用例,新增 3 个通过)

- [ ] **Step 5: 提交**

```bash
git add src/core/schemas.ts src/core/schemas.test.ts
git commit -m "feat(schemas): add VerifyDecisionSchema for the staging verify agent"
```

### Task 3.2: `verifySubtitle` + prompt

**Files:**
- Create: `src/agent/verifySubtitle.ts`
- Create: `src/agent/verifySubtitle.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/agent/verifySubtitle.test.ts
import { describe, it, expect } from 'vitest'
import { verifySubtitle } from './verifySubtitle.js'
import type { LlmRuntime } from './runtime.js'
import type { MediaContext, MediaIdentity, SubtitleCandidate, VerifyDecision } from '../core/schemas.js'
import type { InspectSignals } from '../files/subtitleInspect.js'

function capture(): { llm: LlmRuntime; prompt: () => string } {
  let captured = ''
  const llm: LlmRuntime = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async call(opts: any) {
      captured = opts.prompt
      const parsed: VerifyDecision = { match: true, reason: 'matches' }
      return { parsed, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt } as any
    },
    profileInfo: () => ({ mode: 'test' }),
  }
  return { llm, prompt: () => captured }
}

const ctx = {
  media: { filename: 'Show.S02E05.1080p.mkv', runtime_minutes: 45 },
} as unknown as MediaContext
const identity: MediaIdentity = {
  canonical_title: 'Show', original_title: null, year: 2020, type: 'episode',
  season: 2, episode: 5, edition: null, confidence: 0.9, evidence: [],
}
const candidate: SubtitleCandidate = {
  provider: 'assrt', providerId: '801', videoName: 'Show.S02E05.WEB-DL',
  nativeName: '节目 第5集', language: 'zh', subtype: null, releaseSite: '字幕组X', uploadDate: null,
  fileList: [],
}
const signals: InspectSignals = {
  decodable: true, isHtml: false, cueCount: 320,
  firstCueMs: 1000, lastCueMs: 44 * 60_000, spanMs: 44 * 60_000 - 1000,
  detectedScript: 'zh-Hans',
}

describe('verifySubtitle prompt', () => {
  it('carries target identity, candidate metadata, and inspection signals into the prompt', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    const p = prompt()
    expect(p).toContain('"season":2')
    expect(p).toContain('"episode":5')
    expect(p).toContain('assrt')
    expect(p).toContain('801')
    expect(p).toContain('cueCount')
    expect(p).toContain('zh-Hans')
  })

  it('never asks for or mentions a confidence score', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(prompt().toLowerCase()).not.toMatch(/confidence score|report.*confidence/i)
  })

  it('instructs the model to treat a wrong install as worse than a gap', async () => {
    const { llm, prompt } = capture()
    await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(prompt()).toMatch(/worse than no subtitle/i)
  })

  it('returns the parsed {match, reason} from the LLM call', async () => {
    const { llm } = capture()
    const result = await verifySubtitle(llm, ctx, identity, candidate, signals)
    expect(result.parsed).toEqual({ match: true, reason: 'matches' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/verifySubtitle.test.ts`
Expected: FAIL — `Cannot find module './verifySubtitle.js'`

- [ ] **Step 3: 最小实现**

```ts
// src/agent/verifySubtitle.ts
import type { LlmRuntime } from './runtime.js'
import { VerifyDecisionSchema, type MediaContext, type MediaIdentity, type SubtitleCandidate } from '../core/schemas.js'
import type { InspectSignals } from '../files/subtitleInspect.js'
import type { CallStructuredResult } from './llm.js'

/** staging 沙盒终审:一次 LLM 调用,给定目标身份 + 候选元数据 + 开箱体检信号,
 *  要求 agent 像人一样表态"是/不是"——没有置信度数字。 */
export async function verifySubtitle(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity,
  candidate: SubtitleCandidate, signals: InspectSignals,
) {
  const prompt = [
    'You are about to install this subtitle file into the user\'s media library. Decide, like a human',
    'who just opened the file, whether it IS the subtitle for this exact movie/episode — not "plausible",',
    'actually is it. A wrong subtitle silently installed is worse than no subtitle: it looks fine until',
    'someone plays the video and the dialogue is wrong. If you cannot tell, that is match=false — a gap',
    'can be filled next time, a wrong install cannot be quietly undone.',
    '',
    'Report match=true or match=false and a short reason, the way a person would explain their judgment',
    'after opening the file. Do not invent or report a numeric confidence score anywhere.',
    '',
    `target: ${JSON.stringify({
      title: identity.canonical_title, original_title: identity.original_title, year: identity.year,
      type: identity.type, season: identity.season, episode: identity.episode,
      runtime_minutes: ctx.media.runtime_minutes, filename: ctx.media.filename,
    })}`,
    `candidate metadata: ${JSON.stringify({
      provider: candidate.provider, providerId: candidate.providerId,
      videoName: candidate.videoName, nativeName: candidate.nativeName, releaseSite: candidate.releaseSite,
    })}`,
    `structural inspection of the actual downloaded file: ${JSON.stringify(signals)}`,
    '',
    'Use the inspection signals as evidence, not a formula: cueCount in the low hundreds and spanMs',
    'roughly matching the target runtime are healthy signs for a normal episode/movie; a handful of cues,',
    'or a span wildly shorter than the runtime, suggests a partial or wrong file; an HTML error page',
    '(isHtml=true) or undecodable bytes (decodable=false) is never a real subtitle. detectedScript is a',
    'hint about simplified/traditional/Cantonese, not a hard gate. assTitle, if present, often names the',
    'release — cross-check it against the target. Judge the whole picture like a person would.',
  ].join('\n')
  return llm.call({
    name: 'report_verify_decision',
    description: 'Report whether the downloaded subtitle file is the one for this exact movie/episode',
    prompt, schema: VerifyDecisionSchema,
  }) as Promise<CallStructuredResult<{ match: boolean; reason: string }>>
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/verifySubtitle.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: 提交 + 阶段收尾**

```bash
git add src/agent/verifySubtitle.ts src/agent/verifySubtitle.test.ts
git commit -m "feat(agent): add verifySubtitle staging-verdict agent call"
```

Run: `npm test && npm run check`
Expected: 全绿(Phase 1-3 均为新文件,零touch 既有代码)

---

## Phase 4: Gate 两态化 + Schema 阈值残留清除

**本阶段结束时 `pipeline.ts`/`pipeline.test.ts`/`cli/index.ts` 处于红**(见开头"阶段编排"说明)——它们是 `RankDecisionSchema`/`gate.ts` 唯一的消费方,改完这两个的形状必然连带炸它们。本阶段每个任务只运行自己新增/修改的独立测试文件,不跑 `npm test` 全量。Phase 5 任务 5.1 是收口点。

### Task 4.1: `RankDecisionSchema` 改写为排序队列 + `MediaContextSchema` 删除置信度阈值字段

**Files:**
- Modify: `src/core/schemas.ts:48-55`(`MediaContextSchema.preferences`)
- Modify: `src/core/schemas.ts:103-122`(`RankDecisionSchema`)
- Modify: `src/core/schemas.ts:198-217`(`FinalDecisionSchema`)
- Modify: `src/core/schemas.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 src/core/schemas.test.ts,替换原有的 describe('agent output schemas') 里
// "RankDecision requires assrt_id when decision=download" 那个用例(旧形状已不存在),
// 新增下面这些:
describe('RankDecisionSchema — ordered candidate queue (no scalar decision/confidence)', () => {
  it('accepts an ordered list of candidates with per-item identity_match and no top-level decision/confidence', () => {
    const r = RankDecisionSchema.parse({
      order: [
        { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact title+season+episode' },
        { candidate_id: 'assrt:606770', file_index: null, identity_match: 'uncertain', reason: 'no season signal in name' },
      ],
      rejected: [{ candidate_id: 'assrt:999', reason: 'wrong film' }],
      reasons: ['ordered by identity confidence'],
    })
    expect(r.order).toHaveLength(2)
    expect(r.order[0].identity_match).toBe('confirmed')
    expect('decision' in r).toBe(false)
    expect('confidence' in r).toBe(false)
  })
  it('defaults order/rejected/reasons to empty arrays when omitted', () => {
    const r = RankDecisionSchema.parse({})
    expect(r.order).toEqual([])
    expect(r.rejected).toEqual([])
  })
  it('coerces a numeric candidate_id and string file_index inside order[]', () => {
    const r = RankDecisionSchema.parse({
      order: [{ candidate_id: 673114, file_index: '0', identity_match: 'confirmed', reason: 'x' }],
    })
    expect(r.order[0].candidate_id).toBe('673114')
    expect(r.order[0].file_index).toBe(0)
  })
  it('fail-soft: an invalid identity_match value normalizes to uncertain instead of throwing', () => {
    const r = RankDecisionSchema.parse({
      order: [{ candidate_id: 'assrt:1', file_index: null, identity_match: 'bogus', reason: 'x' }],
    })
    expect(r.order[0].identity_match).toBe('uncertain')
  })
})

describe('MediaContextSchema — no confidence threshold preference', () => {
  it('preferences no longer accepts/needs auto_download_min_confidence', () => {
    const raw = JSON.parse(readFileSync('fixtures/contexts/matrix.json', 'utf8'))
    const ctx = MediaContextSchema.parse(raw)
    expect('auto_download_min_confidence' in ctx.preferences).toBe(false)
  })
})

describe('FinalDecisionSchema — ask_user removed', () => {
  it('rejects decision=ask_user', () => {
    expect(() => FinalDecisionSchema.parse({
      request_id: 'r', decision: 'ask_user', reasons: [],
    })).toThrow()
  })
  it('still accepts confidence:null (kept for backward-compat with historical journal files)', () => {
    const d = FinalDecisionSchema.parse({ request_id: 'r', decision: 'no_safe_match', confidence: null, reasons: [] })
    expect(d.confidence).toBeNull()
  })
})
```

Also delete the now-obsolete tests in `schemas.test.ts` that assert the *old* `RankDecisionSchema` shape (`decision`/`confidence`/single `candidate_id`): the `'RankDecision requires assrt_id when decision=download'` test in `describe('agent output schemas')`, and the three tests under `describe('LLM output coercion ...)'` named `'RankDecision coerces candidate_id numbers and file_index strings'`, `'RankDecision normalizes nullish-string candidate_id to null on non-download'`, and `'RankDecision tolerates numeric candidate_id inside rejected[]'` — they test fields (`decision`, top-level `candidate_id`/`file_index`/`confidence`) that no longer exist on `RankDecision`. Delete these four `it()` blocks; their behavior is superseded by the new tests above and by Task 4.1's `order[]`-level coercion tests.

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/schemas.test.ts`
Expected: FAIL — new tests fail because `order`/`rejected` don't exist yet on the old `RankDecisionSchema`; `ask_user` still validates on `FinalDecisionSchema`

- [ ] **Step 3: 最小实现**

```ts
// src/core/schemas.ts

// 替换 MediaContextSchema.preferences(L48-54)为:
  preferences: z.object({
    language: z.enum(['zh-Hans', 'zh-Hant']).default('zh-Hans'),
    prefer_bilingual: z.boolean().default(true),
    allow_traditional: z.boolean().default(true),
    allow_machine_translated: z.boolean().default(false),
  }),

// 替换 RankDecisionSchema 及其上方的 looseCandidateId 使用方式(L93-122)为:
export const RankedCandidateSchema = z.object({
  /** "<provider>:<providerId>",与 prompt 里 candidates[].id 完全一致 */
  candidate_id: looseCandidateId(),
  file_index: looseNumeric(z.number().int()),
  // 身份判决:confirmed=同作品/季/集,uncertain=信息不足。mismatch 理论上不会出现在
  // order[] 里(prompt 要求丢进 rejected[]),但 schema 层不禁止——gate.ts 会防御性剔除。
  identity_match: IdentityMatchSchema,
  reason: z.string(),
})
export type RankedCandidate = z.infer<typeof RankedCandidateSchema>

export const RankDecisionSchema = z.object({
  /** 按偏好排序的候选队列,最可能匹配的排最前。这是初筛,不是终局——每个留下的候选
   *  之后都会被下载、打开、体检,写盘前还有一轮终审。 */
  order: z.array(RankedCandidateSchema).default([]),
  rejected: z.array(z.object({
    candidate_id: z.preprocess(v => (typeof v === 'number' ? String(v) : v), z.string()),
    reason: z.string(),
  })).default([]),
  reasons: z.array(z.string()).default([]),
})
export type RankDecision = z.infer<typeof RankDecisionSchema>

// FinalDecisionSchema(L198-217)的 decision 枚举删除 'ask_user':
export const FinalDecisionSchema = z.object({
  request_id: z.string(),
  decision: z.enum(['download', 'no_safe_match', 'retry_later', 'already_exists', 'error', 'adopted_local']),
  // confidence 保留(nullish)仅为向后兼容历史 journal 文件的形状;判定链不再产出真实值,
  // pipeline.ts 今后恒写 null。
  confidence: z.number().nullish(),
  selected: z.object({
    provider: z.string(),
    provider_id: z.string(),
    subtitle_name: z.string(),
    language: z.string(),
    format: z.string(),
  }).nullish(),
  reasons: z.array(z.string()).default([]),
  verification: z.object({
    downloaded: z.boolean(),
    path: z.string().nullish(),
    bytes: z.number().nullish(),
    encoding: z.string().nullish(),
  }).nullish(),
})
export type FinalDecision = z.infer<typeof FinalDecisionSchema>
```

Note: `IdentityMatchSchema`/`IDENTITY_MATCHES`(unchanged, still three-state — `mismatch` stays a valid enum value used elsewhere, e.g. `rankCandidates`'s per-item verdict before dropping into `rejected[]`) — do not touch that block.

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/schemas.test.ts`
Expected: PASS(其余引用旧 `RankDecision` 字段的测试文件——`gate.test.ts`/`rankCandidates.test.ts`/`pipeline.test.ts`——此刻仍红,留给 4.2/4.5/5.1 修)

- [ ] **Step 5: 提交**

```bash
git add src/core/schemas.ts src/core/schemas.test.ts
git commit -m "feat(schemas): rank decision becomes an ordered candidate queue, drop confidence threshold preference"
```

### Task 4.2: `gate.ts` 两态化(`proceed` | `no_safe_match`)

**Files:**
- Modify: `src/core/gate.ts`(全文件重写)
- Modify: `src/core/gate.test.ts`(全文件重写)

- [ ] **Step 1: 写失败测试**

```ts
// src/core/gate.test.ts(整份替换)
import { describe, it, expect } from 'vitest'
import { runGate } from './gate.js'
import type { SubtitleCandidate, MediaIdentity, RankDecision } from './schemas.js'

const identity: MediaIdentity = {
  canonical_title: 'The Matrix', original_title: null, year: 1999, type: 'movie',
  season: null, episode: null, edition: null, confidence: 0.95, evidence: [],
}
const candidates: SubtitleCandidate[] = [
  { provider: 'assrt', providerId: '673114', videoName: 'The.Matrix.1999', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'a.zh.ass' }] },
  { provider: 'assrt', providerId: '606770', videoName: 'Matrix Trilogy', nativeName: null, language: 'zh', subtype: null, releaseSite: null, uploadDate: null, fileList: [{ index: 0, name: 'animatrix.ass' }, { index: 1, name: 'matrix1.ass' }] },
]

const rankWith = (order: RankDecision['order']): RankDecision => ({ order, rejected: [], reasons: [] })

describe('runGate', () => {
  it('builds a one-item queue from a valid order', () => {
    const r = runGate(rankWith([{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' }]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.decision).toBe('proceed')
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('673114')
    expect(r.queue[0].fileIndex).toBe(0)
    expect(r.queue[0].identityMatch).toBe('confirmed')
  })

  it('keeps both confirmed and uncertain candidates in the queue, preserving order', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'exact match' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain', reason: 'no season/episode signal' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue.map(q => q.candidate.providerId)).toEqual(['673114', '606770'])
  })

  it('drops a mismatch entry defensively even if rank disobeys the prompt and includes it', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'mismatch', reason: 'wrong film' },
    ]), candidates, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/mismatch/i)
    expect(r.queue).toEqual([])
  })

  it('skips an unresolvable candidate_id but keeps trying the rest of the order (fail-soft per item)', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:999999', file_index: 0, identity_match: 'confirmed', reason: 'x' },
      { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'y' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('673114')
    expect(r.failures[0]).toMatch(/candidate_id/)
  })

  it('skips an out-of-range file_index for one item without failing the whole gate', () => {
    const r = runGate(rankWith([
      { candidate_id: 'assrt:673114', file_index: 5, identity_match: 'confirmed', reason: 'x' },
      { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'confirmed', reason: 'y' },
    ]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue).toHaveLength(1)
    expect(r.queue[0].candidate.providerId).toBe('606770')
  })

  it('empty fileList tolerates file_index null or 0, rejects >0', () => {
    const noFiles: SubtitleCandidate = {
      provider: 'opensubtitles', providerId: '7174766', videoName: 'The.Matrix.1999',
      nativeName: null, language: 'zh-CN', subtype: null, releaseSite: null, uploadDate: null, fileList: [],
    }
    const pool = [...candidates, noFiles]
    const ok = runGate(rankWith([{ candidate_id: 'opensubtitles:7174766', file_index: null, identity_match: 'uncertain', reason: 'x' }]), pool, identity)
    expect(ok.ok).toBe(true)
    const bad = runGate(rankWith([{ candidate_id: 'opensubtitles:7174766', file_index: 2, identity_match: 'uncertain', reason: 'x' }]), pool, identity)
    expect(bad.ok).toBe(false)
    expect(bad.decision).toBe('no_safe_match')
  })

  it('empty order → no_safe_match with an explanatory failure', () => {
    const r = runGate(rankWith([]), candidates, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.length).toBeGreaterThan(0)
  })

  it('self-heals a bare providerId (model dropped the provider prefix)', () => {
    const r = runGate(rankWith([{ candidate_id: '673114', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), candidates, identity)
    expect(r.ok).toBe(true)
    expect(r.queue[0].candidate.providerId).toBe('673114')
  })

  it('a bare providerId colliding across providers is skipped as ambiguous', () => {
    const pool: SubtitleCandidate[] = [
      { provider: 'assrt', providerId: '123', videoName: 'ASSRT Video', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] },
      { provider: 'opensubtitles', providerId: '123', videoName: 'OpenSubtitles Video', nativeName: null, language: null, subtype: null, releaseSite: null, uploadDate: null, fileList: [] },
    ]
    const r = runGate(rankWith([{ candidate_id: '123', file_index: null, identity_match: 'confirmed', reason: 'x' }]), pool, identity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.failures.join(' ')).toMatch(/ambiguous/i)
  })

  it('episode media without resolved season/episode fails closed regardless of order contents', () => {
    const epIdentity: MediaIdentity = { ...identity, type: 'episode', season: null, episode: 3 }
    const r = runGate(rankWith([{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'confirmed', reason: 'x' }]), candidates, epIdentity)
    expect(r.ok).toBe(false)
    expect(r.decision).toBe('no_safe_match')
    expect(r.queue).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/gate.test.ts`
Expected: FAIL — `runGate` 仍是旧的三参数(含 `prefs`)单候选签名,`GateResult` 没有 `queue`

- [ ] **Step 3: 最小实现**

```ts
// src/core/gate.ts(整份替换)
import type { SubtitleCandidate, MediaIdentity, RankDecision, IdentityMatch } from './schemas.js'
import { candidateKey } from './schemas.js'

export interface GateQueueItem {
  candidate: SubtitleCandidate
  fileIndex: number | null
  identityMatch: IdentityMatch
}

export interface GateResult {
  ok: boolean
  /** ok=false 时的降级 decision;ok=true 时恒为 'proceed'——真正的下载/验证结论在
   *  pipeline.ts 的候选队列循环里产生,gate 只负责把 rank.order 校验成安全可试的队列。 */
  decision: 'proceed' | 'no_safe_match'
  failures: string[]
  queue: GateQueueItem[]
}

/** 纯代码硬校验 agent 的排序输出,产出一份结构合法、按偏好排序的候选队列。身份判决
 *  保留"是/不是"两态:mismatch 永不进队列(即便 LLM 违反 prompt 把它塞进 order[],这里
 *  也防御性剔除);confirmed/uncertain 一视同仁排队待验——"拿不准"不是终态,是"还没看
 *  仔细",下游一律走 stage→inspect→verify 终审。单项结构失败(candidate_id 找不到/
 *  file_index 越界)只丢弃那一项,不拖垮整个队列;全部候选都被丢弃才是 no_safe_match。 */
export function runGate(
  rank: RankDecision, candidates: SubtitleCandidate[], identity: MediaIdentity,
): GateResult {
  if (identity.type === 'episode' && (identity.season == null || identity.episode == null)) {
    return {
      ok: false, decision: 'no_safe_match',
      failures: ['episode media without resolved season/episode cannot be auto-downloaded'],
      queue: [],
    }
  }

  const queue: GateQueueItem[] = []
  const failures: string[] = []

  for (const item of rank.order) {
    if (item.identity_match === 'mismatch') {
      failures.push(`candidate_id ${item.candidate_id} identity verdict mismatch — dropped defensively (rank should not have queued it)`)
      continue
    }

    let candidate = candidates.find(c => candidateKey(c) === item.candidate_id)
    // LLM 自愈:模型偶尔丢 "provider:" 前缀只回裸 providerId——不含冒号时按 providerId
    // 兜底匹配。仅恰好一个候选命中才自愈;2+ 命中(跨 provider id 碰撞)视为找不到——
    // fail closed(跳过这一项,不是整个队列)。
    if (!candidate && item.candidate_id != null && !item.candidate_id.includes(':')) {
      const matches = candidates.filter(c => c.providerId === item.candidate_id)
      if (matches.length === 1) {
        candidate = matches[0]
      } else if (matches.length > 1) {
        failures.push(`candidate_id ${item.candidate_id} is ambiguous: matches ${matches.length} candidates across providers (${matches.map(candidateKey).join(', ')})`)
        continue
      }
    }
    if (!candidate) {
      failures.push(`candidate_id ${item.candidate_id} is not in this search's candidate set`)
      continue
    }

    if (candidate.fileList.length > 0) {
      if (item.file_index == null || item.file_index < 0 || item.file_index >= candidate.fileList.length) {
        failures.push(`file_index ${item.file_index} out of range for filelist of ${candidate.fileList.length} (candidate ${item.candidate_id})`)
        continue
      }
    }
    if (candidate.fileList.length === 0 && item.file_index != null && item.file_index !== 0) {
      failures.push(`file_index ${item.file_index} given but candidate ${item.candidate_id} has no filelist`)
      continue
    }

    queue.push({ candidate, fileIndex: item.file_index ?? null, identityMatch: item.identity_match })
  }

  if (queue.length === 0) {
    return {
      ok: false, decision: 'no_safe_match',
      failures: failures.length > 0 ? failures : ['rank produced no usable candidates'],
      queue: [],
    }
  }
  return { ok: true, decision: 'proceed', failures, queue }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/gate.test.ts`
Expected: PASS(11 tests)

- [ ] **Step 5: 提交**

```bash
git add src/core/gate.ts src/core/gate.test.ts
git commit -m "feat(gate): two-state gate producing a validated candidate queue, ask_user removed"
```

### Task 4.3: `orphanGate.ts` 删除置信度阈值比较

**Files:**
- Modify: `src/core/orphanGate.ts:7-16`
- Modify: `src/core/orphanGate.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/core/orphanGate.test.ts — 追加(在已有测试之后)
it('trusts the model\'s adopt=true verdict without a confidence floor', () => {
  const decision = { adopt: true, file: 'x.ass', language: 'zh-Hans' as const, confidence: 0.1, reasons: ['looks right'] }
  const r = runOrphanGate(decision, [{ path: '/m/x.ass', filename: 'x.ass' }])
  expect(r.ok).toBe(true)
})
```

Read `src/core/orphanGate.test.ts` first to see its current imports/fixtures and add the above alongside them; also **delete** any existing test asserting a `confidence below threshold` rejection (it tests behavior this task removes) and any test passing a `minConfidence` argument to `runOrphanGate`.

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/orphanGate.test.ts`
Expected: FAIL — `runOrphanGate` still requires a third `minConfidence` argument (TS error) and the low-confidence case still rejects

- [ ] **Step 3: 最小实现**

```ts
// src/core/orphanGate.ts(整份替换)
import type { OrphanDecision } from './schemas.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'

export interface OrphanGateResult { ok: boolean; failures: string[]; orphan?: OrphanSubtitle }

/** 收编 gate:LLM 只提议,代码验证结构(文件确实在本次扫描到的孤儿集合里)。adopt 本身
 *  已经是模型的二选一判断——不再叠加一层置信度阈值二次质疑它。不过就放弃收编走搜索,
 *  绝不误收。 */
export function runOrphanGate(
  decision: OrphanDecision, orphans: OrphanSubtitle[],
): OrphanGateResult {
  if (!decision.adopt) return { ok: false, failures: [] }
  const orphan = orphans.find(o => o.filename === decision.file)
  if (!orphan) return { ok: false, failures: [`file ${decision.file} is not in the scanned orphan set`] }
  return { ok: true, failures: [], orphan }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/orphanGate.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/orphanGate.ts src/core/orphanGate.test.ts
git commit -m "feat(orphanGate): drop confidence-floor check, trust the model's binary adopt verdict"
```

### Task 4.4: `seasonPackGate.ts` 删除置信度阈值 + 去重规则改为"先出现者胜出"

**Files:**
- Modify: `src/core/seasonPackGate.ts`(全文件重写)
- Modify: `src/core/seasonPackGate.test.ts`(全文件重写)
- Modify: `src/agent/mapSeasonPack.ts:23-25`(prompt)

- [ ] **Step 1: 写失败测试**

```ts
// src/core/seasonPackGate.test.ts(整份替换)
import { describe, it, expect } from 'vitest'
import { runSeasonPackGate } from './seasonPackGate.js'
import type { SeasonEpisode } from './episode.js'

function ep(n: number, needs = true): SeasonEpisode {
  return { itemId: `it${n}`, seasonNumber: 2, episodeNumber: n, episodeCode: `S02E${String(n).padStart(2,'0')}`,
    videoPath: `/media/tv/Show/Season 2/Show.S02E${String(n).padStart(2,'0')}.mkv`,
    videoFilename: `Show.S02E${String(n).padStart(2,'0')}.mkv`, needsChinese: needs }
}
const seasonEps = [ep(1), ep(2), ep(3)]
const filelist = [
  { f: 'Show.S02E01.chs.ass', url: 'http://a/1' },
  { f: 'Show.S02E02.chs.ass', url: 'http://a/2' },
  { f: 'Show.S02E03.chs.ass', url: 'http://a/3' },
  { f: 'readme.txt', url: 'http://a/r' },
]

describe('runSeasonPackGate', () => {
  it('commits valid pairs joined by episode_code (not position)', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E02'])
    expect(r.commit.find(c => c.episodeCode === 'S02E01')!.downloadUrl).toBe('http://a/1')
    expect(r.commit.find(c => c.episodeCode === 'S02E01')!.videoFilename).toBe('Show.S02E01.mkv')
  })
  it('a missing episode leaves it uncovered without shifting others', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 2, episode_code: 'S02E03', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit.map(c => c.episodeCode).sort()).toEqual(['S02E01', 'S02E03'])
  })
  it('drops pairs whose episode_code is not in the Jellyfin season set', () => {
    const map = { pairs: [{ filelist_index: 0, episode_code: 'S02E99', reason: 'special' }], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit).toEqual([])
    expect(r.dropped.some(d => /not in season/i.test(d.reason))).toBe(true)
  })
  it('drops out-of-range filelist_index and non-subtitle extensions', () => {
    const map = { pairs: [
      { filelist_index: 99, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 3, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit).toEqual([])
  })
  it('dedups a duplicate episode_code by keeping the FIRST occurrence in pairs[] order (no confidence to compare)', () => {
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'first' },
      { filelist_index: 1, episode_code: 'S02E01', reason: 'second' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit.length).toBe(1)
    expect(r.commit[0].filelistIndex).toBe(0)
    expect(r.dropped.some(d => /duplicate episode_code/i.test(d.reason))).toBe(true)
  })
  it('drops non-integer filelist_index cleanly (no crash)', () => {
    const map = { pairs: [
      { filelist_index: 1.5, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: NaN, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: seasonEps })
    expect(r.commit).toEqual([])
    expect(r.dropped.length).toBe(2)
  })
  it('only covers episodes that still need Chinese (skips already-subbed)', () => {
    const eps = [ep(1, true), ep(2, false)]
    const map = { pairs: [
      { filelist_index: 0, episode_code: 'S02E01', reason: 'x' },
      { filelist_index: 1, episode_code: 'S02E02', reason: 'x' },
    ], unmapped_files: [], reasons: [] }
    const r = runSeasonPackGate({ map, filelist, seasonEpisodes: eps })
    expect(r.commit.map(c => c.episodeCode)).toEqual(['S02E01'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/seasonPackGate.test.ts`
Expected: FAIL — `SeasonPackGateInput` still requires `minConfidence`(TS error);dedup 测试期望"先出现者胜出"但当前实现是"高置信度胜出"

- [ ] **Step 3: 最小实现**

```ts
// src/core/seasonPackGate.ts(整份替换)
import { basename } from 'node:path'
import type { SeasonEpisode } from './episode.js'

const SUBTITLE_EXT = /\.(srt|ass|ssa)$/i

export interface SeasonMapPair { filelist_index: number; episode_code: string; reason: string }
export interface SeasonMapLike { pairs: SeasonMapPair[]; unmapped_files?: number[]; reasons?: string[] }
export interface SeasonPackFile { f: string; url?: string }

export interface SeasonPackCommitItem {
  episodeCode: string
  filelistIndex: number
  filename: string
  downloadUrl: string
  videoPath: string
  videoFilename: string
}
export interface SeasonPackGateResult {
  commit: SeasonPackCommitItem[]
  dropped: { episodeCode?: string; filelistIndex?: number; reason: string }[]
}
export interface SeasonPackGateInput {
  map: SeasonMapLike
  filelist: SeasonPackFile[]
  seasonEpisodes: SeasonEpisode[]
}

/**
 * 按 episodeCode 集合 join(非位置对齐)+ 逐项校验 + verify-then-commit,产出安全提交集。
 * 防"整季串号":缺集只是该 code 未覆盖,不会让其余集下滑。逐项软失败进 dropped[],绝不
 * 整批作废。重复 episode_code 时保留 pairs[] 里先出现的那个——排序本身就是模型的偏好
 * 表达(它把更有把握的排前面),不需要再叠一层数字去比较。
 */
export function runSeasonPackGate(input: SeasonPackGateInput): SeasonPackGateResult {
  const { map, filelist, seasonEpisodes } = input
  const needSet = new Map<string, SeasonEpisode>()
  for (const e of seasonEpisodes) if (e.needsChinese) needSet.set(e.episodeCode, e)

  const commit: SeasonPackCommitItem[] = []
  const dropped: SeasonPackGateResult['dropped'] = []
  const seenCodes = new Set<string>()

  for (const pair of map.pairs ?? []) {
    const tag = { episodeCode: pair.episode_code, filelistIndex: pair.filelist_index }
    if (!Number.isInteger(pair.filelist_index) || pair.filelist_index < 0 || pair.filelist_index >= filelist.length) {
      dropped.push({ ...tag, reason: `filelist_index out of range` }); continue
    }
    const file = filelist[pair.filelist_index]
    if (!SUBTITLE_EXT.test(file.f)) { dropped.push({ ...tag, reason: `not a subtitle file: ${file.f}` }); continue }
    if (!file.url) { dropped.push({ ...tag, reason: `no download url for ${file.f}` }); continue }
    const episode = needSet.get(pair.episode_code)
    if (!episode) { dropped.push({ ...tag, reason: `episode_code not in season (or already subbed): ${pair.episode_code}` }); continue }
    if (seenCodes.has(pair.episode_code)) {
      dropped.push({ ...tag, reason: 'duplicate episode_code, kept first occurrence' }); continue
    }
    seenCodes.add(pair.episode_code)
    commit.push({
      episodeCode: pair.episode_code, filelistIndex: pair.filelist_index,
      filename: basename(file.f), downloadUrl: file.url,
      videoPath: episode.videoPath, videoFilename: episode.videoFilename,
    })
  }
  return { commit, dropped }
}
```

```ts
// src/agent/mapSeasonPack.ts — 替换 L23-25 三行为:
    'For each subtitle file, emit one pair { filelist_index, episode_code, reason } where episode_code',
    'is EXACTLY one of the known episode_codes listed below. If you are not confident which episode a file is,',
    'put its index in unmapped_files instead of guessing. Only emit pairs you are sure of. Order does not',
    'matter for correctness, but if you happen to notice two files could map to the same episode, only',
    'emit the one you trust more — a duplicate will simply have its second occurrence dropped.',
```

Also update `src/core/schemas.ts`'s `SeasonMapSchema`(pairs array): remove the `confidence` field from each pair object, matching the new `SeasonMapPair` shape above:

```ts
// src/core/schemas.ts — replace SeasonMapSchema (search for "export const SeasonMapSchema"):
export const SeasonMapSchema = z.object({
  pairs: z.array(z.object({
    filelist_index: looseNumeric(z.number().int()),
    episode_code: z.string(),
    reason: z.string(),
  })).default([]),
  unmapped_files: z.array(z.number().int()).default([]),
  reasons: z.array(z.string()).default([]),
})
export type SeasonMap = z.infer<typeof SeasonMapSchema>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/seasonPackGate.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: 提交**

```bash
git add src/core/seasonPackGate.ts src/core/seasonPackGate.test.ts src/agent/mapSeasonPack.ts src/core/schemas.ts
git commit -m "feat(seasonPackGate): drop confidence threshold, dedup by first-occurrence order"
```

### Task 4.5: `rankCandidates.ts` — prompt 改写为"排序 + 丢弃 mismatch"

**Files:**
- Modify: `src/agent/rankCandidates.ts:66-120`(`rankCandidates` function body)
- Modify: `src/agent/rankCandidates.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/agent/rankCandidates.test.ts — 替换文件末尾 describe('rankCandidates prompt') 整块为:
describe('rankCandidates prompt', () => {
  function capture(): { llm: LlmRuntime; prompt: () => string } {
    let captured = ''
    const llm: LlmRuntime = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async call(opts: any) {
        captured = opts.prompt
        const parsed: RankDecision = {
          order: [{ candidate_id: 'assrt:1', file_index: 0, identity_match: 'confirmed', reason: 'x' }],
          rejected: [], reasons: ['ok'],
        }
        return { parsed, rawText: '', retries: 0, durationMs: 1, prompt: opts.prompt } as any
      },
      profileInfo: () => ({ mode: 'test' }),
    }
    return { llm, prompt: () => captured }
  }

  const ctx = {
    media: { filename: 'Show.S01E02.1080p.mkv' },
    preferences: { language: 'zh-Hans', prefer_bilingual: true, allow_traditional: true, allow_machine_translated: false },
  } as unknown as MediaContext
  const identity = {
    canonical_title: 'Show', original_title: null, year: 2020, type: 'episode',
    season: 1, episode: 2, edition: null, confidence: 0.9, evidence: [],
  } as unknown as MediaIdentity

  it('instructs the LLM to order candidates and emit per-item identity_match, not a single scalar decision', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    const p = prompt()
    expect(p).toMatch(/order/i)
    expect(p).toMatch(/identity_match/)
    expect(p).toMatch(/confirmed/)
    expect(p).toMatch(/mismatch/)
    expect(p).toMatch(/uncertain/)
  })

  it('instructs the LLM to keep uncertain candidates in order[] rather than refusing them', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt()).toMatch(/keep uncertain/i)
  })

  it('never asks for or mentions a confidence score', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt().toLowerCase()).not.toMatch(/decision threshold|confidence score/i)
  })

  it('encodes the M5b law: source/version differences must not downgrade identity', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt()).toMatch(/must not.*(lower|downgrade|change).*identity/i)
  })

  it('includes candidate_id instruction in prompt', async () => {
    const { llm, prompt } = capture()
    await rankCandidates(llm, ctx, identity, [subWithFiles(1, ['a.chs.srt'])])
    expect(prompt()).toMatch(/candidate_id.*EXACTLY/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/rankCandidates.test.ts`
Expected: FAIL — 旧 prompt 没有 "order"/"keep uncertain" 措辞,仍含 "DECISION THRESHOLD" 字样

- [ ] **Step 3: 最小实现**

```ts
// src/agent/rankCandidates.ts — 替换 rankCandidates() 函数体(L66-120)为:
export async function rankCandidates(
  llm: LlmRuntime, ctx: MediaContext, identity: MediaIdentity, candidates: SubtitleCandidate[],
): Promise<CallStructuredResult<RankDecision>> {
  const compact = compactCandidates(candidates)
  const prompt = [
    'Order these multi-source Chinese subtitle candidates (fields: id = "<provider>:<providerId>") from',
    'most to least likely to be a correct match for this media, or refuse all of them.',
    'This is a PRELIMINARY ordering, not a final verdict — every candidate you keep will later be',
    'downloaded, opened, and inspected before anything is written. Your job here is triage: keep',
    'everything that is plausibly usable, in the order you would try them.',
    '',
    'FORMAT — which candidates are usable:',
    '- Text subtitles (srt / ass / ssa, including those extensions inside filelist) are ALL usable.',
    '- subtype=None or missing is NOT a reason to drop — it is usually an effect/styled .ass.',
    '- Only truly graphic-only packs (PGS .sup, VobSub .idx+.sub) are unusable, and those have already',
    '  been filtered out before you see them; assume every candidate here has text.',
    '',
    'IDENTITY VERDICT — set identity_match per candidate:',
    '- confirmed = the SAME work + correct season +（for a single-episode subtitle）the correct episode,',
    '  or（for a pack）the pack covers the target episode. An exact or equivalent title match (including',
    '  translated-title variants) together with a matching season/episode number IS confirmed.',
    '- mismatch = it is definitively a DIFFERENT work, a different season, or a different episode.',
    '  DROP mismatch candidates entirely — do not put them in order[], list them in rejected[] instead.',
    '- uncertain = plausible but the candidate itself does not carry enough evidence to be sure (e.g. its',
    '  entry name carries no season/episode and its filelist is empty). Keep uncertain candidates in',
    '  order[] — do not refuse just because you are not sure; a closer look downstream will decide.',
    '  Only mismatch gets dropped here.',
    '- Source, resolution, release-group, codec and version differences MUST NOT lower the identity',
    '  verdict — they never change WHICH work / season / episode a subtitle is for.',
    '',
    'If a candidate is a pack (filelist has multiple files), pick the specific file_index whose filename',
    'matches THIS media. A trilogy pack whose files are other movies is a trap.',
    'file_index is the 0-based index into the candidate\'s filelist array; null for non-pack candidates.',
    'Report candidate_id as the candidate\'s id string EXACTLY as shown (e.g. "assrt:673114" or "opensubtitles:7174766").',
    'If the filelist was truncated (filelist_truncated present), only pick from the shown entries.',
    '',
    'Put your best-guess candidate first in order[]. Give a short reason per candidate. List every',
    'seriously-considered-but-dropped (mismatch, or genuinely unusable) candidate in rejected[] with a',
    'concrete reason. Do not report a confidence score anywhere — you are ordering candidates, not',
    'scoring them.',
    '',
    `identified media: ${JSON.stringify(identity)}`,
    `media filename: ${ctx.media.filename}`,
    `candidates: ${JSON.stringify(compact)}`,
  ].join('\n')
  return llm.call({
    name: 'report_rank_order',
    description: 'Order candidates by how likely each is the correct subtitle, or refuse them all',
    prompt, schema: RankDecisionSchema,
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/rankCandidates.test.ts`
Expected: PASS(其余 `compactCandidates`/`isGraphicOnly`/`filterGraphicOnly` 用例不受影响,仍绿)

- [ ] **Step 5: 提交**

```bash
git add src/agent/rankCandidates.ts src/agent/rankCandidates.test.ts
git commit -m "feat(rankCandidates): prompt triage/ordering, drop scalar decision+confidence"
```

### Task 4.6: `mapLooseEpisodes.ts` — prompt 删除置信度字段

**Files:**
- Modify: `src/agent/mapLooseEpisodes.ts:23-29`(prompt)
- Modify: `src/core/schemas.ts`(`LooseEpisodesMapSchema`)
- Modify: `src/agent/mapLooseEpisodes.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/agent/mapLooseEpisodes.test.ts — 替换 mockLlm 的 Assignment 类型与两个受影响用例:
type Assignment = { episode_code: string; candidate_id: string }
function mockLlm(assignments: Assignment[]) {
  const call = vi.fn(async (_opts: { prompt: string }) => ({
    parsed: { assignments, reasons: [] },
    rawText: '', retries: 0, durationMs: 1, prompt: '',
  }))
  return { call, llm: { call } as unknown as Pick<LlmRuntime, 'call'> }
}

// 'maps 3 loose candidates...' 用例:mockLlm 调用去掉每个 assignment 里的 confidence 字段
// (改为 { episode_code: 'S02E01', candidate_id: 'assrt:801' } 等),断言部分不变。

// 替换 'instructs the model to skip low-confidence guesses...' 整个 it() 为:
it('instructs the model to skip ambiguous guesses (leave a gap, do not misassign)', async () => {
  const candidates = [mk(801, '第1集', 'Show.S02E01.chs.ass'), mk(802, '模糊', 'Show.mystery.ass')]
  const eps = [ep(1), ep(2)]
  const { call, llm } = mockLlm([{ episode_code: 'S02E01', candidate_id: 'assrt:801' }])
  const result = await mapLooseEpisodes(llm, ctx, identity, candidates, eps)
  expect(result.parsed.assignments).toHaveLength(1)
  expect(result.parsed.assignments.map(a => a.episode_code)).not.toContain('S02E02')
  expect(call.mock.calls[0][0].prompt).toMatch(/safer to leave a gap/i)
  expect(call.mock.calls[0][0].prompt.toLowerCase()).not.toMatch(/confidence < 0\.75/)
})

// 'instructs the model to assign at most one candidate per episode...' 用例:
// mockLlm 调用同样去掉 confidence 字段。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/agent/mapLooseEpisodes.test.ts`
Expected: FAIL — prompt 仍含 `confidence < 0.75` 字样

- [ ] **Step 3: 最小实现**

```ts
// src/agent/mapLooseEpisodes.ts — 替换 L23-29 的规则列表为:
    '- Read the native_name, videoname, and first_file to decide the episode number.',
    '- Understand patterns like "第3集"=E03, "[Grp] Show - 04.chs.ass"=E04, "S02E05"=E05, etc.',
    '- Each episode can have AT MOST one candidate assigned. If multiple candidates claim the same episode,',
    '  pick the one with the clearest evidence (or skip both if it is genuinely unclear).',
    '- Only emit assignments you are sure of — it is safer to leave a gap than to map incorrectly.',
    '- Only emit assignments you are sure of. episode_code MUST be copied verbatim from the known list below (format SxxExx).',
    '- Report candidate_id exactly as shown in the candidates list (e.g. "assrt:673114").',
```

```ts
// src/core/schemas.ts — 替换 LooseEpisodesMapSchema(搜索 "export const LooseEpisodesMapSchema"):
export const LooseEpisodesMapSchema = z.object({
  assignments: z.array(z.object({
    episode_code: z.string(),
    // fail-soft:单行 candidate_id 缺失/为数字不炸整季 sweep——nullish 放行,下游 filter 剔除
    candidate_id: z.preprocess(v => (typeof v === 'number' ? String(v) : v), z.string()).nullish(),
  })).default([]),
  reasons: z.array(z.string()).default([]),
})
export type LooseEpisodesMap = z.infer<typeof LooseEpisodesMapSchema>
```

Also delete the `schemas.test.ts` case `'LooseEpisodesMap fail-soft: one bad candidate_id row does not kill the whole parse'` if it still passes `confidence` fields in its fixtures — update it to drop `confidence` from each assignment object (the assertions themselves are unaffected).

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/agent/mapLooseEpisodes.test.ts src/core/schemas.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/agent/mapLooseEpisodes.ts src/core/schemas.ts src/agent/mapLooseEpisodes.test.ts src/core/schemas.test.ts
git commit -m "feat(mapLooseEpisodes): drop confidence field and threshold from prompt+schema"
```

### Task 4.7: 删除 `applyConfidenceOverride`(环境变量阈值覆盖,字段已不存在)

**Files:**
- Modify: `src/core/mediaContext.ts:75-82`(删除整个函数)
- Modify: `src/v2/executor.ts`(删除 import + 调用,约 L8, L440 附近)
- Modify: `src/cli/index.ts`(删除 import + 两处调用,约 L25, L186, L218)
- Modify: `src/core/mediaContext.test.ts`(若存在覆盖该函数的用例,删除)

这是一处窄范围的死代码删除,不是阶段 6 的 executor 大改——`applyConfidenceOverride` 读写的 `ctx.preferences.auto_download_min_confidence` 字段已在 Task 4.1 从 schema 里删除,这个函数此刻已经是编译错误。

- [ ] **Step 1: 确认当前编译错误**

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep -i "auto_download_min_confidence\|applyConfidenceOverride"`
Expected: 若干行报 `ctx.preferences.auto_download_min_confidence` 不存在于类型上(来自 `mediaContext.ts`)

- [ ] **Step 2: 删除函数与调用点**

```ts
// src/core/mediaContext.ts — 删除整个函数(原 L75-82):
// /** 环境变量 AUTO_DOWNLOAD_MIN_CONFIDENCE 覆盖 ctx 的自动下载置信度阈值... */
// export function applyConfidenceOverride(ctx: MediaContext): void { ... }
// 直接删除这 8 行,不留占位。
```

```ts
// src/v2/executor.ts — 顶部 import 里删除 applyConfidenceOverride:
import {
  buildMediaContext, isDirWritable, isUnderRoots, mapPath,
} from '../core/mediaContext.js'
// 并删除 makeRunEpisode() 内那一行调用:
// applyConfidenceOverride(ctx)
```

```ts
// src/cli/index.ts — 顶部 import 里删除 applyConfidenceOverride:
import { buildMediaContext, mediaDir, parsePathMappings, isUnderRoots, isDirWritable, mapPath, type PathMapping } from '../core/mediaContext.js'
// 并删除 cmdRun() 与 cmdRunItem() 里各一行调用:
// applyConfidenceOverride(ctx)
```

- [ ] **Step 3: 跑受影响的独立测试**

Run: `npx vitest run src/core/mediaContext.test.ts`
Expected: PASS(若该文件有专门测试 `applyConfidenceOverride` 的 `describe` 块,一并删除该块——它测试的函数已不存在)

- [ ] **Step 4: 确认这三个文件不再报同类编译错**

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep -i "applyConfidenceOverride"`
Expected: 无输出(注意:`pipeline.ts`/`executor.ts` 里其它引用 `RankDecision`/`gate` 旧形状的错误仍会存在,这是本阶段接受的红窗口,留给 Phase 5 收口——这里只确认 `applyConfidenceOverride` 相关的错误已清零)

- [ ] **Step 5: 提交 + 阶段收尾**

```bash
git add src/core/mediaContext.ts src/v2/executor.ts src/cli/index.ts src/core/mediaContext.test.ts
git commit -m "chore: remove dead AUTO_DOWNLOAD_MIN_CONFIDENCE override plumbing"
```

Run: `npx vitest run src/core/gate.test.ts src/core/orphanGate.test.ts src/core/seasonPackGate.test.ts src/core/schemas.test.ts src/agent/rankCandidates.test.ts src/agent/mapLooseEpisodes.test.ts src/agent/verifySubtitle.test.ts src/files/stagingSandbox.test.ts src/files/subtitleInspect.test.ts src/core/mediaContext.test.ts`
Expected: 全部 PASS。**不要**在这里跑 `npm test` 全量或 `npm run check`——`pipeline.ts`/`pipeline.test.ts`/`cli/index.ts` 仍处于本阶段开头说明的红窗口,Phase 5 任务 5.1 收口。

---

## Phase 5: Pipeline 重接线("大任务",拆解说明见下)

这是全计划最大的一块改动:把 `runPipeline` 的下载段从"单候选下载→写盘"改写为"候选队列依次下载进沙盒→体检→终审→装机"。由于 `pipeline.ts` 是 `gate.ts`/`schemas.ts`(Phase 4 已改)唯一的消费方,它此刻处于红——**任务 5.1 第一件事就是把它改到能编译并跑绿**,不存在"先小改一下再大改一次"的中间态(TS 是整文件编译,没有半红半绿的安全中间点)。任务 5.2 收尾 `cli/index.ts`/`daemon.ts` 的接线,是 Phase 4→5 红窗口的真正收口点(`npm run check` 全仓库编译在 5.2 结束时首次重新变绿)。

### Task 5.1: 候选队列重接线(`pipeline.ts` + `pipeline.test.ts`)

**Files:**
- Modify: `src/core/pipeline.ts:24-49`(`PipelineDeps` 接口)
- Modify: `src/core/pipeline.ts:51-67`(`PipelineResult` 接口)
- Modify: `src/core/pipeline.ts:116-525`(`runPipeline` 函数体)
- Modify: `src/core/pipeline.ts:536-710`(`runSeasonSweep` 函数体)
- Modify: `src/core/pipeline.test.ts`(全文件,含共享 `makeDeps`/`makeProviders` 工厂)

- [ ] **Step 1: 改写 `pipeline.test.ts` 的共享工厂 + 写三个新失败测试**

先改共享工厂(文件顶部,替换原有的 `makeDeps`/`makeProviders` 及其上方 import):

```ts
// src/core/pipeline.test.ts — 顶部 import 追加:
import { allocate, install, cleanup } from '../files/stagingSandbox.js'

// 追加(放在现有 `mkCand` 之后):
// 一份可解析出 2 条 cue 的最小 ASS 样本——新流程里每次成功下载都要过 inspectSubtitle,
// 旧夹具 '[Script Info]\nTitle: t\n'(零 cue)会被结构体检直接拒收,必须换成真实可解析内容。
const SAMPLE_ASS = [
  '[Script Info]', 'Title: t', '', '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,你好',
  'Dialogue: 0,0:00:04.00,0:00:06.20,Default,,0,0,0,,再见',
].join('\n')

function makeVerify(result: { match: boolean; reason: string } = { match: true, reason: 'looks right' }) {
  return vi.fn(async () => ({ parsed: result, rawText: '', retries: 0, durationMs: 1, prompt: 'verify prompt' }))
}

// 替换原 makeDeps() 为:
function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    identify: vi.fn(async () => ({
      parsed: {
        canonical_title: 'The Matrix', original_title: 'The Matrix', year: 1999,
        type: 'movie' as const, season: null, episode: null, edition: null,
        confidence: 0.95, evidence: ['filename'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'identify prompt',
    })),
    plan: vi.fn(async () => ({
      parsed: { queries: [{ q: 'The.Matrix.1999.1080p.BluRay.x264', reason: 'release name' }] },
      rawText: '', retries: 0, durationMs: 1, prompt: 'plan prompt',
    })),
    rank: vi.fn(async () => ({
      parsed: {
        order: [{ candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'exact match' }],
        rejected: [], reasons: ['exact match'],
      }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
    })),
    verify: makeVerify(),
    providers: makeProviders(),
    download: vi.fn(async () => ({ bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' })),
    cache: new DecisionCache(mkdtempSync(join(tmpdir(), 'pc-'))),
    maxApiCallsPerJob: 4,
    staging: { allocate, install, cleanup },
    ...overrides,
  }
}
```

`makeProviders()` 本身不用改(仍返回同样的 `search`/`resolveDownload` mock)。

再替换 `describe('runPipeline')` 里的第一个用例("golden path"),并追加两个新用例:

```ts
it('golden path: downloads, verifies, installs subtitle + writes decision.json, exit download', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'out-'))
  const deps = makeDeps()
  const result = await runPipeline(deps, ctx, outDir)
  expect(result.decision).toBe('download')
  expect(existsSync(result.subtitlePath!)).toBe(true)
  expect(result.subtitlePath).toContain('The.Matrix.1999.1080p.BluRay.x264.zh-Hans')
  const journal = JSON.parse(readFileSync(join(outDir, 'decision.json'), 'utf8'))
  expect(journal.llm_calls.length).toBe(4) // identify, plan, rank, verify(新增一轮终审)
  expect(journal.decision.decision).toBe('download')
  expect(journal.decision.verification.downloaded).toBe(true)
  // 沙盒目录随 job 结束清空,试错垃圾零残留
  expect(existsSync(join(outDir, '.subtitle-staging', ctx.request_id))).toBe(false)
})

it('tries the next candidate in the queue when the first fails structural inspection', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'out-'))
  const rank = vi.fn(async () => ({
    parsed: {
      order: [
        { candidate_id: 'assrt:673114', file_index: 0, identity_match: 'uncertain' as const, reason: 'first guess' },
        { candidate_id: 'assrt:606770', file_index: 0, identity_match: 'uncertain' as const, reason: 'second guess' },
      ], rejected: [], reasons: ['ordered'],
    }, rawText: '', retries: 0, durationMs: 1, prompt: 'rank prompt',
  }))
  let downloadCall = 0
  const download = vi.fn(async () => {
    downloadCall++
    // 第一次下载返回 HTML 错误页(结构体检硬拒,不打 LLM);第二次返回正常字幕
    return downloadCall === 1
      ? { bytes: Buffer.from('<!DOCTYPE html><html><body>404</body></html>'), contentType: 'text/html' }
      : { bytes: Buffer.from(SAMPLE_ASS), contentType: 'text/plain' }
  })
  const verify = makeVerify({ match: true, reason: 'second candidate matches' })
  const deps = makeDeps({ rank, download, verify })
  const result = await runPipeline(deps, ctx, outDir)
  expect(result.decision).toBe('download')
  expect(downloadCall).toBe(2)
  expect(verify).toHaveBeenCalledTimes(1) // 第一个候选结构性拒绝,不触发终审;只有第二个触发
})

it('exhausts the queue and reports no_safe_match when verify rejects every candidate (sandbox still cleaned up)', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'out-'))
  const verify = makeVerify({ match: false, reason: 'wrong episode' })
  const deps = makeDeps({ verify })
  const result = await runPipeline(deps, ctx, outDir)
  expect(result.decision).toBe('no_safe_match')
  expect(existsSync(join(outDir, '.subtitle-staging', ctx.request_id))).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: FAIL — 大量编译错误(`PipelineDeps` 缺 `verify`/`staging`;`rank` 的返回类型不匹配 `RankDecision` 的新形状;`runGate` 调用签名不对)

- [ ] **Step 3: 实现——`PipelineDeps`/`PipelineResult` 接口改动**

```ts
// src/core/pipeline.ts — 顶部 import 追加:
import type { InspectSignals } from '../files/subtitleInspect.js'
import { inspectSubtitle } from '../files/subtitleInspect.js'
import type { GateQueueItem } from './gate.js'
import type { VerifyDecision } from './schemas.js'

// 替换 PipelineDeps 接口(原 L24-49)为:
export interface PipelineDeps {
  identify: (ctx: MediaContext) => Promise<CallStructuredResult<MediaIdentity>>
  plan: (ctx: MediaContext, id: MediaIdentity) => Promise<CallStructuredResult<SearchPlan>>
  rank: (ctx: MediaContext, id: MediaIdentity, cands: SubtitleCandidate[]) => Promise<CallStructuredResult<RankDecision>>
  /** staging 沙盒终审:候选下载+体检后,agent 对"是不是这份资源的字幕"二选一表态。 */
  verify: (ctx: MediaContext, id: MediaIdentity, candidate: SubtitleCandidate, signals: InspectSignals) => Promise<CallStructuredResult<VerifyDecision>>
  providers: ProviderPort
  download: (url: string) => Promise<DownloadResult>
  cache: DecisionCache
  /** 现约束候选队列试错(每候选一次 resolve/download)与季横扫的按集 resolve 预算共用同一份治理。 */
  maxApiCallsPerJob: number
  journalReady?: (journal: Journal) => void
  llm?: LlmRuntime
  adoption?: {
    scan: (dir: string, videoFilename: string) => OrphanSubtitle[]
    judge: (ctx: MediaContext, id: MediaIdentity, orphans: OrphanSubtitle[]) => Promise<CallStructuredResult<OrphanDecision>>
    read: (path: string) => Buffer
  }
  seasonPack?: {
    enumerate: (ctx: MediaContext) => Promise<SeasonEpisode[]>
    map: (ctx: MediaContext, id: MediaIdentity, filelist: { index: number; name: string }[], eps: SeasonEpisode[]) => Promise<CallStructuredResult<SeasonMap>>
    onCovered: (ep: SeasonEpisode, subtitlePath: string, providerRef?: string) => void | Promise<void>
  }
  /** 字幕试错沙盒:候选下载进这里打开验,终审通过才原子安装进媒体目录。 */
  staging: {
    allocate: (jobId: string, mediaRootForVideo: string) => string
    install: (stagedPath: string, finalPath: string) => Promise<{ path: string }>
    cleanup: (jobId: string, mediaRootForVideo: string) => void
  }
}

// 替换 PipelineResult 接口(原 L51-67)的 decision 字段:删除 'ask_user'
export interface PipelineResult {
  decision: 'download' | 'no_safe_match' | 'retry_later' | 'already_exists' | 'error' | 'adopted_local'
  subtitlePath?: string
  journalPath: string
  fromCache?: boolean
  /** 保留字段,向后兼容历史 journal/dashboard 消费方——判定链已不产出真实置信度值,恒为 null。 */
  confidence?: number | null
  reasons?: string[]
  stats: { durationMs: number; llmCalls: number; apiCalls: number }
  coveredEpisodes?: { episodeCode: string; subtitlePath: string; providerRef?: string }[]
  selected?: { provider: string; provider_id: string; subtitle_name: string; language: string; format: string } | null
  quotaExhausted?: { resetAt: string | null }
}
```

- [ ] **Step 4: 实现——新增 `candidateSlug`/`tryCandidateQueue` 辅助函数**

插入到 `seasonSelected` 函数之后、`runPipeline` 定义之前:

```ts
interface CandidateInstallOutcome {
  candidate: SubtitleCandidate
  fileIndex: number | null
  path: string
  bytes: number
  encoding: string | null
  reason: string
}

/** 候选试错子目录名:同一 job 沙盒内,不同候选各自独立目录,避免同扩展名候选互相
 *  覆盖("已存在"短路会把第二个候选误判成第一个候选已经写过)。 */
function candidateSlug(candidate: SubtitleCandidate, fileIndex: number | null): string {
  const key = candidateKey(candidate).replace(/[^a-zA-Z0-9_.-]/g, '_')
  return `${key}_f${fileIndex ?? 'x'}`
}

/** 沙盒候选队列执行体:依次下载→体检→终审,第一个终审"是"即装机结束,返回其安装结果;
 *  用尽全部候选仍无匹配返回 outcome=null。结构体检硬拒(不可解码/HTML 错误页/零 cue)不
 *  触发终审调用,直接试下一个。预算:每次尝试消耗一份 provider API 调用配额,用尽
 *  deps.maxApiCallsPerJob 时停止尝试剩余候选——终审 LLM 调用与候选下载共用同一份预算治理。
 *  撞见 ProviderQuotaExhaustedError 直接向上抛,交调用方按 resetAt 精确退避(同季横扫语义)。 */
async function tryCandidateQueue(
  deps: PipelineDeps, ctx: MediaContext, identity: MediaIdentity,
  queue: GateQueueItem[], outDir: string, stagingDir: string, journal: Journal,
): Promise<{ outcome: CandidateInstallOutcome | null; tried: { candidateId: string; verdict: string }[] }> {
  const tried: { candidateId: string; verdict: string }[] = []
  const budget = deps.maxApiCallsPerJob - journal.counts().apiCalls
  let apiCallsUsed = 0

  for (const item of queue) {
    if (apiCallsUsed >= budget) {
      journal.step('candidateQueueBudgetExhausted', { candidate: candidateKey(item.candidate) })
      break
    }
    const candidateId = candidateKey(item.candidate)
    journal.step('candidateAttemptStart', { candidate: candidateId, identityMatch: item.identityMatch })
    try {
      apiCallsUsed++
      const resolved = await deps.providers.resolveDownload({
        provider: item.candidate.provider, providerId: item.candidate.providerId, fileIndex: item.fileIndex,
      })
      const dl = await deps.download(resolved.url)
      const attemptDir = join(stagingDir, candidateSlug(item.candidate, item.fileIndex))
      const staged = await writeSubtitle({
        artifact: dl.bytes,
        artifactFilename: resolved.filename ?? item.candidate.fileList[item.fileIndex ?? -1]?.name ?? 'subtitle.srt',
        videoFilename: ctx.media.filename, langTag: ctx.preferences.language, outDir: attemptDir,
      })
      const signals = inspectSubtitle(staged.path)
      journal.step('candidateInspected', { candidate: candidateId, signals })

      if (!signals.decodable || signals.isHtml || signals.cueCount === 0) {
        journal.step('candidateRejectedStructural', { candidate: candidateId })
        tried.push({ candidateId, verdict: 'structural-reject' })
        continue
      }

      const verifyResult = await deps.verify(ctx, identity, item.candidate, signals)
      journal.llmCall({ point: 'verifySubtitle', prompt: verifyResult.prompt, rawText: verifyResult.rawText, parsed: verifyResult.parsed, retries: verifyResult.retries, durationMs: verifyResult.durationMs })

      if (!verifyResult.parsed.match) {
        journal.step('candidateVerifyRejected', { candidate: candidateId, reason: verifyResult.parsed.reason })
        tried.push({ candidateId, verdict: 'verify-reject' })
        continue
      }

      const videoBase = basename(ctx.media.filename).replace(/\.[^.]+$/, '')
      const finalPath = resolvePath(join(outDir, `${videoBase}.${ctx.preferences.language}${extname(staged.path).toLowerCase()}`))
      const installed = await deps.staging.install(staged.path, finalPath)
      journal.step('candidateInstalled', { candidate: candidateId, path: installed.path, reason: verifyResult.parsed.reason })
      tried.push({ candidateId, verdict: 'match' })
      return {
        outcome: {
          candidate: item.candidate, fileIndex: item.fileIndex,
          path: installed.path, bytes: staged.bytes, encoding: staged.encoding,
          reason: verifyResult.parsed.reason,
        },
        tried,
      }
    } catch (e) {
      if (e instanceof ProviderQuotaExhaustedError) throw e
      journal.step('candidateAttemptFailed', { candidate: candidateId, error: String(e) })
      tried.push({ candidateId, verdict: 'error' })
    }
  }
  return { outcome: null, tried }
}
```

- [ ] **Step 5: 实现——缓存命中分支改为自包含早退**

替换原 L210-215(缓存命中构造伪 `rank` 那 6 行)为:

```ts
    if (cached?.kind === 'positive') {
      journal.step('cacheHitPositive', cached)
      // 缓存命中:直接 resolve→download→写盘,不进候选队列/沙盒——这是"上次已经验证过
      // 这个候选是对的"的复用路径,不是新的、需要重新试错的候选。
      const resolved = await deps.providers.resolveDownload({
        provider: cached.provider, providerId: cached.providerId, fileIndex: cached.fileIndex,
      })
      const artifactFilename = resolved.filename ?? 'subtitle.srt'
      journal.step('download', { url: resolved.url.slice(0, 80) })
      const dl = await deps.download(resolved.url)
      journal.step('write')
      const written = await writeSubtitle({
        artifact: dl.bytes, artifactFilename, videoFilename: ctx.media.filename,
        langTag: ctx.preferences.language, outDir,
      })
      if (written.alreadyExists) {
        return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten'], subtitlePath: written.path, downloaded: false })
      }
      const selected = {
        provider: cached.provider, provider_id: cached.providerId,
        subtitle_name: artifactFilename, language: ctx.preferences.language,
        format: artifactFilename.match(/\.(srt|ass|ssa)$/i)?.[1]?.toLowerCase() ?? 'srt',
      }
      return finish('download', {
        reasons: ['cache hit'], subtitlePath: written.path, bytes: written.bytes, encoding: written.encoding,
        fromCache: true, selected,
      })
    }
    let rank: RankDecision
    let candidates: SubtitleCandidate[]
    let searchProviderErrors: { provider: string; message: string }[] = []
    {
      journal.step('planSearch')
```

Note: this restructures the old `if (cached?.kind === 'positive') {...} else {...}` into an early-return `if` followed by an unconditional block (formerly the `else` branch). The rest of the original "else" branch body(searching, alias-harvest fallback, etc. — 原 L217-319 除首行 `journal.step('planSearch')` 已在上面移入的开头)保持逐字不变,只是缩进层级从 `else {` 变成裸 `{`(一个 block scope,内容不变)。到 `}` 收尾时(原 L319 对应的右花括号)也保持不变。

- [ ] **Step 6: 实现——季横扫触发条件、gate 消费、季包升格三处改写**

替换原 L321-451(季横扫 pre-gate 触发 + gate 消费 + 季包升格)为:

```ts
    // 5-pre. 季横扫前置:代表集 rank 排序为空(triage 全灭)时,gate 必然拒绝——这正是横扫的
    // 头号目标场景(本集自己没候选,散装候选覆盖的是其他集)。故在 gate 早退之前先尝试横扫;
    // 覆盖 >0 直接 finish,0 覆盖则照旧落回 gate 早退。sweepRan 供 gate 后分支去重防重跑。
    let sweepRan = false
    if (deps.seasonPack && deps.llm && ctx.media.type === 'episode'
      && rank.order.length === 0 && candidates.length > 0 && !pickSeasonPack(candidates)) {
      const seasonEpisodes = await deps.seasonPack.enumerate(ctx)
      if (seasonEpisodes.filter(e => e.needsChinese).length >= 2) {
        sweepRan = true
        const { covered, quotaExhausted } = await runSeasonSweep(deps, ctx, identity, candidates, seasonEpisodes, journal, 'pre-gate')
        if (covered.length > 0) {
          return finish('download', { reasons: [`season sweep: covered ${covered.length} episodes`], coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath, selected: seasonSelected(covered[0].providerRef, covered[0].subtitlePath, ctx.preferences.language), quotaExhausted })
        }
        if (quotaExhausted) {
          return finish('error', { reasons: ['season sweep: quota exhausted before any episode coverage'], quotaExhausted })
        }
      }
    }

    // 4. gate:身份判决保留"是/不是"两态,产出结构校验过的候选队列。gate.ok=false 恒为
    // no_safe_match(ask_user 出口已在 Phase 4 拔除)。
    journal.step('gate')
    const gate = runGate(rank, candidates, identity)
    journal.step('gateResult', gate)
    if (!gate.ok) {
      // 候选集残缺(某源瞬时故障 fail-soft 成 [] 但另一源有候选)时,不代表"确实没有安全
      // 匹配"——降级为 retry_later(瞬时可重试)且绝不写负缓存。providerErrors 为空才走
      // 诚实结论。
      if (searchProviderErrors.length > 0) {
        journal.step('incompleteCandidateSet', { providerErrors: searchProviderErrors })
        return finish('retry_later', {
          reasons: [
            'candidate set incomplete due to provider failure — not cacheable',
            ...searchProviderErrors.map(e => `${e.provider} 搜索失败: ${e.message}`),
          ],
        })
      }
      deps.cache.put(keys, { kind: 'negative', reason: gate.failures.join('; ') || 'agent declined' })
      return finish('no_safe_match', { reasons: gate.failures.length ? gate.failures : rank.reasons })
    }

    // 5.season 季包升格:fresh-rank(缓存命中已在上面早退)+ episode + 注入 seasonPack +
    // 候选覆盖多集 + 该季≥2集缺中字
    if (deps.seasonPack && ctx.media.type === 'episode') {
      const pack = pickSeasonPack(candidates)
      const mayGraduate = candidates.length >= 2
      const seasonEpisodes = (pack || mayGraduate) ? await deps.seasonPack.enumerate(ctx) : []
      const needsCount = seasonEpisodes.filter(e => e.needsChinese).length
      if (pack && shouldGraduate(ctx, pack, seasonEpisodes)) {
        journal.step('seasonGraduate', { packId: pack.providerId, episodes: seasonEpisodes.length, needs: needsCount })
        const mapResult = await deps.seasonPack.map(ctx, identity, pack.fileList, seasonEpisodes)
        journal.llmCall({ point: 'mapSeasonPack', prompt: mapResult.prompt, rawText: mapResult.rawText, parsed: mapResult.parsed, retries: mapResult.retries, durationMs: mapResult.durationMs })
        const pairs = (mapResult.parsed.pairs ?? []).filter(p => p.filelist_index != null) as { filelist_index: number; episode_code: string; reason: string }[]
        const gateFilelist = pack.fileList.map(f => ({ f: f.name, url: 'pending' }))
        const gateRes = runSeasonPackGate({ map: { pairs }, filelist: gateFilelist, seasonEpisodes })
        journal.step('seasonPackGate', { commit: gateRes.commit.length, dropped: gateRes.dropped.length })
        if (gateRes.commit.length > 0) {
          const packRef = candidateKey(pack)
          const coveredEpisodes: { episodeCode: string; subtitlePath: string; providerRef: string }[] = []
          let consecutiveFails = 0
          let packQuotaExhausted: { resetAt: string | null } | undefined
          for (const item of gateRes.commit) {
            if (consecutiveFails >= 3) { journal.step('seasonCircuitBreak', { after: coveredEpisodes.length }); break }
            try {
              const resolved = await deps.providers.resolveDownload({ provider: pack.provider, providerId: pack.providerId, fileIndex: item.filelistIndex })
              const dl = await deps.download(resolved.url)
              const written = await writeSubtitle({
                artifact: dl.bytes, artifactFilename: resolved.filename ?? item.filename,
                videoFilename: item.videoFilename, langTag: ctx.preferences.language,
                outDir: dirname(item.videoPath),
              })
              coveredEpisodes.push({ episodeCode: item.episodeCode, subtitlePath: written.path, providerRef: packRef })
              const epMeta = seasonEpisodes.find(e => e.episodeCode === item.episodeCode)!
              try { await deps.seasonPack.onCovered(epMeta, written.path, packRef) } catch { /* 观测/联动不影响主流程 */ }
              consecutiveFails = 0
            } catch (e) {
              if (e instanceof ProviderQuotaExhaustedError) {
                packQuotaExhausted = { resetAt: e.resetAt }
                journal.step('seasonEpisodeQuotaExhausted', { episode: item.episodeCode, after: coveredEpisodes.length, resetAt: e.resetAt })
                break
              }
              consecutiveFails++
              journal.step('seasonEpisodeFailed', { episode: item.episodeCode, message: String(e) })
            }
          }
          if (coveredEpisodes.length > 0) {
            return finish('download', { reasons: [`season pack: covered ${coveredEpisodes.length} episodes`], coveredEpisodes, subtitlePath: coveredEpisodes[0].subtitlePath, selected: seasonSelected(packRef, coveredEpisodes[0].subtitlePath, ctx.preferences.language), quotaExhausted: packQuotaExhausted })
          }
          if (packQuotaExhausted) {
            return finish('error', { reasons: ['season pack: quota exhausted before any episode coverage'], quotaExhausted: packQuotaExhausted })
          }
        }
      } else if (!pack && needsCount >= 2 && deps.llm && !sweepRan) {
        const { covered, quotaExhausted } = await runSeasonSweep(deps, ctx, identity, candidates, seasonEpisodes, journal, 'post-gate')
        if (covered.length > 0) {
          return finish('download', { reasons: [`season sweep: covered ${covered.length} episodes`], coveredEpisodes: covered, subtitlePath: covered[0].subtitlePath, selected: seasonSelected(covered[0].providerRef, covered[0].subtitlePath, ctx.preferences.language), quotaExhausted })
        }
        if (quotaExhausted) {
          return finish('error', { reasons: ['season sweep: quota exhausted before any episode coverage'], quotaExhausted })
        }
      }
    }
```

- [ ] **Step 7: 实现——候选队列试错替换原 steps 6-8**

替换原 L453-517(resolve download URL → download+write → cache+finish)为:

```ts
    // 6-8. 候选队列试错:依次下载进沙盒→体检→终审,第一个终审"是"即装机结束。
    // 崩溃恢复预检:若队首候选的静态元数据能推出确定的输出文件名且已在磁盘上——说明这是
    // "写盘成功但 DB 提交前崩溃"后的重跑,直接短路,绝不再打一次候选队列。
    const head = gate.queue[0]
    const knownName = head.candidate.fileList[head.fileIndex ?? -1]?.name
    if (knownName && /\.(srt|ass|ssa)$/i.test(knownName)) {
      const videoBase = basename(ctx.media.filename).replace(/\.[^.]+$/, '')
      const predictedPath = resolvePath(join(outDir, `${videoBase}.${ctx.preferences.language}${extname(knownName).toLowerCase()}`))
      if (existsSync(predictedPath)) {
        return finish('already_exists', { reasons: ['subtitle file already exists; not overwritten (pre-flight check, no re-download)'], subtitlePath: predictedPath, downloaded: false })
      }
    }

    journal.step('candidateQueue', { size: gate.queue.length })
    const stagingDir = deps.staging.allocate(ctx.request_id, outDir)
    try {
      const { outcome, tried } = await tryCandidateQueue(deps, ctx, identity, gate.queue, outDir, stagingDir, journal)
      if (!outcome) {
        journal.step('candidateQueueExhausted', { tried })
        const reason = `queue exhausted: ${tried.length} candidate(s) tried, none verified as a match`
        deps.cache.put(keys, { kind: 'negative', reason })
        return finish('no_safe_match', { reasons: [reason, ...rank.reasons] })
      }
      deps.cache.put(keys, { kind: 'positive', provider: outcome.candidate.provider, providerId: outcome.candidate.providerId, fileIndex: outcome.fileIndex })
      const selected = {
        provider: outcome.candidate.provider, provider_id: outcome.candidate.providerId,
        subtitle_name: basename(outcome.path), language: ctx.preferences.language,
        format: outcome.path.match(/\.(srt|ass|ssa)$/i)?.[1]?.toLowerCase() ?? 'srt',
      }
      return finish('download', {
        reasons: [outcome.reason, ...rank.reasons], subtitlePath: outcome.path, bytes: outcome.bytes, encoding: outcome.encoding,
        selected,
      })
    } finally {
      deps.staging.cleanup(ctx.request_id, outDir)
    }
  } catch (e) {
    journal.step('error', { message: String(e) })
    const quotaExhausted = e instanceof ProviderQuotaExhaustedError ? { resetAt: e.resetAt } : undefined
    return finish('error', { reasons: [String(e)], quotaExhausted })
  }
}
```

(最后这个 `catch`/结尾大括号与原文件末尾一致,不是新增——只是把 Step 5-7 的新内容接到既有的 outer try/catch 收尾处。)

- [ ] **Step 8: 实现——`runSeasonSweep` 去阈值化 + 去重改"先出现者胜出"**

```ts
// src/core/pipeline.ts — 在 runSeasonSweep 函数体内:

// 替换原过滤(L548-552)为(删除置信度门槛):
  const validAssignments = (mapResult.parsed.assignments ?? [])
    .filter((a): a is typeof a & { candidate_id: string } =>
      a.candidate_id != null && a.candidate_id !== '' && !!a.episode_code)

// 替换 ValidatedAssignment 接口(原 L561-567),删除 confidence 字段:
  interface ValidatedAssignment {
    episode_code: string
    candidate: SubtitleCandidate
    parsedKey: { provider: ProviderName; providerId: string }
    fileIndex: number | null
  }

// 替换 validatedAssignments.push(...)(原 L614)为(删除 confidence):
    validatedAssignments.push({ episode_code: assignment.episode_code, candidate, parsedKey: parsed, fileIndex })

// 替换去重块(原 L619-623)为"先出现者胜出"(不再比较数字):
  const bestByCode = new Map<string, ValidatedAssignment>()
  for (const a of validatedAssignments) {
    if (!bestByCode.has(a.episode_code)) bestByCode.set(a.episode_code, a)
  }
```

- [ ] **Step 9: 跑测试确认通过**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: 大部分 PASS,但仍有若干旧用例因为引用旧 `rank` 形状(`decision: 'download'`、顶层 `confidence`/`candidate_id`)而红——这些是机械改写,规则见下一步。

- [ ] **Step 10: 机械改写 `pipeline.test.ts` 剩余用例**

先枚举所有仍引用旧形状的位置:

Run: `grep -n "decision: 'download'\|decision: 'no_safe_match'\|decision: 'ask_user'\|candidate_id:.*file_index:.*confidence" src/core/pipeline.test.ts`

对每一处按下面的规则机械替换(字段名和值一一对应,不引入新逻辑):

- `{ decision: 'download', candidate_id: X, file_index: Y, confidence: Z, reasons: R, identity_match: M, rejected: [] }`
  → `{ order: [{ candidate_id: X, file_index: Y, identity_match: M, reason: R[0] ?? '' }], rejected: [], reasons: R }`
- `{ decision: 'no_safe_match', candidate_id: null, file_index: null, confidence: Z, reasons: R, identity_match: M, rejected: [] }`
  → `{ order: [], rejected: [], reasons: R }`
- 任何自定义 `rank: vi.fn(...)` 覆盖同理套用上面两条规则改写其 `parsed` 对象。
- 任何断言 `result.confidence`(读取 `PipelineResult.confidence`)的用例:该字段仍存在(向后兼容,见 Step 3),但恒为 `null`——把断言改为 `expect(result.confidence).toBeNull()` 或按上下文删除该断言(若该用例的核心断言点是别的字段)。
- 任何断言 `journal.decision.confidence` 为非 null 数值的用例,同上改为断言 `null`。

跑一遍确认没有遗漏:

Run: `npx vitest run src/core/pipeline.test.ts 2>&1 | grep -A3 "FAIL\|AssertionError"`
Expected: 空输出(全部改写完毕)

- [ ] **Step 11: 跑全部测试确认通过**

Run: `npx vitest run src/core/pipeline.test.ts`
Expected: PASS(全部用例)

- [ ] **Step 12: 提交**

```bash
git add src/core/pipeline.ts src/core/pipeline.test.ts
git commit -m "feat(pipeline): rewire download flow through staging sandbox — stage, inspect, verify, install"
```

### Task 5.2: `cli/index.ts` + `daemon.ts` 接线(Phase 4→5 红窗口收口)

**Files:**
- Modify: `src/cli/index.ts`(顶部 import、`assemble()` 内 `makeDeps`、`cmdWatch()` 内 `daemonDeps`)
- Modify: `src/v2/daemon.ts`(`DaemonDeps` 接口、`run()`)
- Modify: `src/v2/daemon.test.ts`

- [ ] **Step 1: 写失败测试(daemon.ts 的 gcStaging 接线)**

```ts
// 追加到 src/v2/daemon.test.ts,紧跟在已有的两个 'run启动即回收...'/'run启动时无活跃租约...' 用例之后
it('run启动时调用 gcStaging 并在清理数>0 时打日志', async () => {
  const gcStaging = vi.fn(() => 2)
  const daemon = new ScoutDaemon(makeDeps({ gcStaging }))
  const controller = new AbortController()
  const runPromise = daemon.run(controller.signal)
  await new Promise(r => setTimeout(r, 20))
  controller.abort()
  await runPromise
  expect(gcStaging).toHaveBeenCalledTimes(1)
  expect(logs.some(l => l.includes('boot: cleaned 2 orphaned staging'))).toBe(true)
})

it('gcStaging 未注入或返回 0 时不打日志(不影响既有 reapAllActive 行为)', async () => {
  const daemon = new ScoutDaemon(makeDeps())
  const controller = new AbortController()
  const runPromise = daemon.run(controller.signal)
  await new Promise(r => setTimeout(r, 20))
  controller.abort()
  await runPromise
  expect(logs.some(l => l.includes('boot: cleaned'))).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/daemon.test.ts -t gcStaging`
Expected: FAIL — `DaemonDeps` 没有 `gcStaging` 字段(TS 报 `makeDeps({ gcStaging })` 多余属性),日志不会出现

- [ ] **Step 3: 实现**

```ts
// src/v2/daemon.ts — DaemonDeps 接口追加字段(放在 exit? 之前或之后均可):
  /** 沙盒孤儿 GC:daemon 启动时调用一次,镜像 jobs.reapAllActive 的"单实例前提,无条件
   *  回收"语义——旧进程遗留的 .subtitle-staging/<jobId> 目录全部视为孤儿垃圾。 */
  gcStaging?: () => number

// src/v2/daemon.ts — run() 方法内,紧跟在 reapAllActive 那一段之后:
    const reaped = this.deps.jobs.reapAllActive(this.deps.now())
    if (reaped > 0) {
      this.deps.log(`boot: reaped ${reaped} orphaned active lease(s) from previous process`)
    }
    const stagingCleaned = this.deps.gcStaging?.() ?? 0
    if (stagingCleaned > 0) {
      this.deps.log(`boot: cleaned ${stagingCleaned} orphaned staging dir(s) from previous process`)
    }
```

```ts
// src/cli/index.ts — 顶部 import 追加:
import { verifySubtitle } from '../agent/verifySubtitle.js'
import { allocate, install, cleanup, gcOrphans } from '../files/stagingSandbox.js'

// assemble() 内 makeDeps 闭包,追加 verify + staging 字段(rank 字段紧邻处):
    rank: (c, id, cands) => rankCandidates(llm, c, id, cands),
    verify: (c, id, cand, signals) => verifySubtitle(llm, c, id, cand, signals),
    // ...(providers/download/cache/maxApiCallsPerJob/adoption/seasonPack 保持不变)
    staging: { allocate, install, cleanup },

// cmdWatch() 内 daemonDeps 对象字面量,追加一个字段(roots 变量已在函数顶部算好):
    aggregate: (now) => aggregate(lib, jobs, now),
    gcStaging: () => gcOrphans(roots, new Set()),
    executeJob: async (job) => { ... }, // 保持不变
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/v2/daemon.test.ts`
Expected: PASS(全部用例,含新增 2 个)

- [ ] **Step 5: 全仓库编译 + 全量测试(红窗口收口)**

Run: `npm run check`
Expected: 通过,零编译错误(Phase 4 开头声明的红窗口在此收口)

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add src/cli/index.ts src/v2/daemon.ts src/v2/daemon.test.ts
git commit -m "feat(cli,daemon): wire verify+staging deps into the CLI, gcStaging into daemon boot"
```

---

## Phase 6: Executor + needs_review 全灭 + v6 迁移

进入本阶段前仓库应为绿(Phase 5 Task 5.2 收尾)。本阶段内部有一个小红窗口:Task 6.2 改 `libraryRepo.ts` 的 `SubStatus` 类型/删 `markNeedsReview` 后,`executor.ts`/`scanner.ts`/`daemon.ts`(pollSessions)会编译失败(它们引用 `needs_review` 字符串字面量或调用 `markNeedsReview`)。Task 6.3(executor.ts)与 Task 6.4(scanner.ts + daemon.ts pollSessions)依次收口,Task 6.4 结束时跑 `npm run check` 确认恢复绿色。

### Task 6.1: v6 迁移——`needs_review` 存量行复位为 `missing`

**Files:**
- Modify: `src/v2/db.ts`(`MIGRATIONS[]` 数组末尾追加 `MIGRATIONS[5]`)
- Create: `src/v2/migration.needs-review-removal.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/v2/migration.needs-review-removal.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb, MIGRATIONS } from './db.js'

describe('migration: needs_review removal (v6 — reset to missing, recheck_after=now)', () => {
  it('resets existing needs_review episodes/movies to missing with recheck_after ≈ now', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'scout-mig-needsreview-rm-')), 'scout.db')

    // 手工建到 v5(本次迁移前一版):跑 MIGRATIONS[0..4]
    const raw = new Database(dbPath)
    for (let i = 0; i < 5; i++) raw.exec(MIGRATIONS[i])
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '5')").run()

    const past = Date.now() - 86_400_000
    const future = Date.now() + 30 * 86_400_000
    raw.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    raw.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, status_reason, recheck_after, updated_at)
       VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'needs_review', '找到候选但把握不足', ?, ?)`
    ).run(future, past)
    raw.prepare(
      `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
       VALUES ('e2', 's1', 1, 2, 'E2', '/tv/e2.mkv', 'covered', ?)`
    ).run(past) // 非 needs_review 行不受影响
    raw.prepare(
      `INSERT INTO movies (id, name, path, sub_status, status_reason, recheck_after, updated_at)
       VALUES ('m1', 'M1', '/m/m1.mkv', 'needs_review', '找到候选但把握不足', ?, ?)`
    ).run(future, past)
    raw.close()

    const before = Date.now()
    const db = openDb(dbPath)
    const after = Date.now()

    const ep = db.prepare(`SELECT * FROM episodes WHERE id='e1'`).get() as any
    expect(ep.sub_status).toBe('missing')
    expect(ep.status_reason).toBeNull()
    expect(ep.recheck_after).toBeGreaterThanOrEqual(before)
    expect(ep.recheck_after).toBeLessThanOrEqual(after)

    const untouched = db.prepare(`SELECT * FROM episodes WHERE id='e2'`).get() as any
    expect(untouched.sub_status).toBe('covered')

    const movie = db.prepare(`SELECT * FROM movies WHERE id='m1'`).get() as any
    expect(movie.sub_status).toBe('missing')
    expect(movie.status_reason).toBeNull()
    expect(movie.recheck_after).toBeGreaterThanOrEqual(before)

    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(MIGRATIONS.length),
    })
    db.close()
  })

  it('the needs_review enum value is still tolerated by the CHECK constraint (no table rebuild — YAGNI)', () => {
    const db = openDb(':memory:')
    const now = Date.now()
    db.prepare(`INSERT INTO series (id, name) VALUES ('s1', 'Series A')`).run()
    expect(() =>
      db.prepare(
        `INSERT INTO episodes (id, series_id, season, episode, name, path, sub_status, updated_at)
         VALUES ('e1', 's1', 1, 1, 'E1', '/tv/e1.mkv', 'needs_review', ?)`
      ).run(now)
    ).not.toThrow()
    db.close()
  })

  it('a fresh (never-migrated) database ends up on the latest schema version — v6 is a no-op there', () => {
    const db = openDb(':memory:')
    expect(db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get()).toEqual({ value: String(MIGRATIONS.length) })
    db.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/migration.needs-review-removal.test.ts`
Expected: FAIL — `MIGRATIONS.length` 仍是 5,`e1`/`m1` 的 `sub_status` 停留在 `needs_review`

- [ ] **Step 3: 最小实现**

```ts
// src/v2/db.ts — 在 MIGRATIONS 数组的 v5 条目(闭合的 `.trim(),`)之后追加:
  // v6: needs_review 全灭——ask_user 判定路径不复存在(agent 判断链两态化,拿不准的候选
  // 走 staging 沙盒下载+体检+终审后必须二选一表态)。存量 needs_review 行复位为 missing
  // + recheck_after=now,下一轮调和用新流程重跑它们,预期开箱验证通过直接转绿。CHECK 约束
  // 里的 'needs_review' 枚举值有意保留容忍(YAGNI)——不再有代码写它,但不做又一次整表
  // 重建只为收紧一个再没人写的枚举值。
  `
UPDATE episodes
  SET sub_status = 'missing', status_reason = NULL,
      recheck_after = CAST(strftime('%s','now') AS INTEGER) * 1000,
      updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE sub_status = 'needs_review';
UPDATE movies
  SET sub_status = 'missing', status_reason = NULL,
      recheck_after = CAST(strftime('%s','now') AS INTEGER) * 1000,
      updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
  WHERE sub_status = 'needs_review';
  `.trim(),
]
```

(最后一行 `]` 是既有数组的收尾,不是新增——只是标出插入点在数组闭合之前。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/v2/migration.needs-review-removal.test.ts src/v2/db.test.ts src/v2/migration.needs-review.test.ts`
Expected: PASS(新迁移测试 3 个 + 既有 db/迁移测试不受影响)

- [ ] **Step 5: 提交**

```bash
git add src/v2/db.ts src/v2/migration.needs-review-removal.test.ts
git commit -m "feat(db): v6 migration resets existing needs_review rows to missing"
```

### Task 6.2: `libraryRepo.ts` — 删除 `needs_review`/`markNeedsReview`

**Files:**
- Modify: `src/v2/libraryRepo.ts:3`(`SubStatus` 类型)
- Modify: `src/v2/libraryRepo.ts:209-236`(`missingBySeason`/`missingMovies`)
- Modify: `src/v2/libraryRepo.ts:304-326`(`resetRecheck`)
- Modify: `src/v2/libraryRepo.ts:358-387`(删除整个 `markNeedsReview` 方法)
- Modify: `src/v2/libraryRepo.test.ts`

- [ ] **Step 1: 删除测试中已失效的用例**

在 `src/v2/libraryRepo.test.ts` 里删除以下 5 个 `it()` 块(它们测试即将被删除的 `markNeedsReview` 方法与 `needs_review` 状态,行号见上方 grep 结果):`'markNeedsReview 写 sub_status=needs_review...'`、`'markNeedsReview 对 movie 也工作...'`、`'needs_review 带复查时间,missingBySeason 不计入未到期的...'`、`'needs_review 电影同样计入 missingMovies...'`、`'resetRecheck:播放触发把 needs_review 的 recheck_after 拉回 now...'`。

确认删除范围:

Run: `grep -n "needs_review\|markNeedsReview" src/v2/libraryRepo.test.ts`
Expected: 空输出(全部删除干净)

- [ ] **Step 2: 跑测试确认失败(此刻应为 TS 编译错误,不是断言失败)**

Run: `npx vitest run src/v2/libraryRepo.test.ts`
Expected: PASS(测试文件此刻不再引用 `needs_review`;但整仓库 `npm run check` 此刻仍会因 `executor.ts`/`scanner.ts` 引用 `markNeedsReview`/`needs_review` 而失败——这是本阶段说明的红窗口,不在这一步收口)

- [ ] **Step 3: 最小实现**

```ts
// src/v2/libraryRepo.ts — L3,SubStatus 删除 'needs_review':
export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored'

// 替换 missingBySeason()(原 L209-224)为:
  /** unavailable 复查到期后重新计入 missing,让 aggregator 把它纳入下一轮 job。 */
  missingBySeason(now?: number): MissingBySeason[] {
    const timestamp = now ?? Date.now()
    return this.db
      .prepare(
        `SELECT series_id, season, count(*) as missing
         FROM episodes
         WHERE sub_status = 'missing'
            OR (sub_status = 'unavailable' AND recheck_after <= ?)
         GROUP BY series_id, season`
      )
      .all(timestamp) as MissingBySeason[]
  }

  missingMovies(now?: number): Movie[] {
    const timestamp = now ?? Date.now()
    return this.db
      .prepare(
        `SELECT * FROM movies
         WHERE sub_status = 'missing'
            OR (sub_status = 'unavailable' AND recheck_after <= ?)`
      )
      .all(timestamp) as Movie[]
  }

// 替换 resetRecheck()(原 L304-326)为:
  /**
   * 播放触发用:把 unavailable 条目的 recheck_after 拉回 now,
   * 让 executor 重derive targets 时能纳入它。
   */
  resetRecheck(itemId: string, now: number): void {
    const episodeResult = this.db
      .prepare(
        `UPDATE episodes
         SET recheck_after = ?, updated_at = ?
         WHERE id = ? AND sub_status = 'unavailable'`
      )
      .run(now, now, itemId)

    if (episodeResult.changes === 0) {
      this.db
        .prepare(
          `UPDATE movies
           SET recheck_after = ?, updated_at = ?
           WHERE id = ? AND sub_status = 'unavailable'`
        )
        .run(now, now, itemId)
    }
  }

  markUnavailable(itemId: string, reason: string, recheckAfter: number): void {
    // ...(方法体不变,原样保留)
  }

  // 删除整个 markNeedsReview() 方法(原 L358-387)。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/v2/libraryRepo.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/libraryRepo.ts src/v2/libraryRepo.test.ts
git commit -m "feat(libraryRepo): remove needs_review sub_status and markNeedsReview"
```

### Task 6.3: `executor.ts` — 拔除 `ask_user` 分支

**Files:**
- Modify: `src/v2/executor.ts:66-71`(删除 `askUserDetail` 函数)
- Modify: `src/v2/executor.ts:79-80`(`HUMAN_ASK_USER` 常量删除)
- Modify: `src/v2/executor.ts:16-48`(`ExecutorDeps.runEpisode` 返回类型,删 `confidence`/`minConfidence`)
- Modify: `src/v2/executor.ts:92-111`(`remainingTargets`,删 `needs_review` 复查分支)
- Modify: `src/v2/executor.ts:326-361`(决策路由,删 `ask_user` 分支/`markNeedsReview` 调用)
- Modify: `src/v2/executor.ts:467-479`(`makeRunEpisode` 返回值,删 `confidence`/`minConfidence`)
- Modify: `src/v2/executor.test.ts`

- [ ] **Step 1: 删除测试中已失效的用例,写新用例**

在 `src/v2/executor.test.ts` 里删除 `'task 2: ask_user → needs_review...'`(L202)与 `'task 2: ask_user 复查到期后重新计入该季 remainingTargets...'`(L230)两个 `it()` 块(测试即将删除的行为)。追加一个新用例,断言 `no_safe_match` 是内容失败的唯一出口:

```ts
// 追加到 src/v2/executor.test.ts(找一个 no_safe_match 相关 describe 块附近插入)
it('no_safe_match is the only content-failure outcome — no ask_user/needs_review branch left', async () => {
  const now = Date.now()
  lib.upsertSeries({ id: 's1', name: 'Show' })
  lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/tv/e1.mkv', subStatus: 'missing' })
  const job = jobs.forceClaim('s1', 1, now) ?? (jobs.upsertWanted({ kind: 'series_season', seriesId: 's1', season: 1 }, now), jobs.forceClaim('s1', 1, now)!)
  const runEpisode = vi.fn(async () => ({ decision: 'no_safe_match', reasons: ['没有安全匹配'] }))
  await executeJob(job, { lib, jobs, runEpisode, now: () => now, log: () => {} })
  const ep1 = lib.getEpisode('e1')!
  expect(ep1.sub_status).toBe('unavailable') // no_safe_match 统一走 unavailable,没有第二条内容失败轨
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/executor.test.ts`
Expected: FAIL — 旧用例仍引用 `markNeedsReview`(此刻已被 Task 6.2 删除,TS 编译错误);`askUserDetail`/`HUMAN_ASK_USER` 仍在,决策路由仍含 `ask_user` 分支

- [ ] **Step 3: 最小实现**

```ts
// src/v2/executor.ts

// 删除 askUserDetail() 函数(原 L65-71)与 HUMAN_ASK_USER 常量(原 L80),只保留:
const HUMAN_NO_MATCH = '没找到合适的中文字幕'

// 替换 ExecutorDeps.runEpisode 的返回类型(原 L23-45),删除 confidence/minConfidence 两行:
  runEpisode: (
    episodeId: string,
    onCovered: (coveredEpisodeId: string, subtitlePath: string, providerRef?: string) => void,
    journalRef?: string
  ) => Promise<{
    decision: string
    journalPath?: string
    subtitlePath?: string
    reasons?: string[]
    selected?: { provider: string; provider_id: string } | null
    stats?: { llmCalls: number; apiCalls: number }
    quotaExhausted?: { resetAt: string | null } | null
  }>

// 替换 remainingTargets()(原 L92-111),删除 needs_review 复查分支:
function remainingTargets(job: Job, lib: LibraryRepo, now: number): (Episode | Movie)[] {
  if (job.kind === 'series_season') {
    return lib.db
      .prepare(
        `SELECT * FROM episodes
         WHERE series_id = ? AND season = ?
         AND (sub_status = 'missing'
              OR (sub_status = 'unavailable' AND recheck_after <= ?))
         ORDER BY episode ASC`
      )
      .all(job.series_id, job.season, now) as Episode[]
  }
  const movie = lib.getMovie(job.movie_id!)
  if (!movie) return []
  const stillMissing =
    movie.sub_status === 'missing' ||
    (movie.sub_status === 'unavailable' && (movie.recheck_after ?? 0) <= now)
  return stillMissing ? [movie] : []
}

// 替换决策路由块(原 L326-361):
    // 0 coverage, content failure: no_safe_match → content backoff track(唯一出口,
    // ask_user/needs_review 已拔除——判断链只剩"是/不是"两态,拿不准的候选在 pipeline
    // 内部已经走过 staging 沙盒体检+终审才能到这里)。
    if (decision === 'no_safe_match') {
      const transitioned = jobs.completeNoMatch(job.id, now())
      if (transitioned) {
        const finalJob = jobs.get(job.id)!
        const recheckAfter =
          finalJob.state === 'dormant'
            ? now() + 30 * 86_400_000
            : finalJob.next_retry_at ?? now() + 86_400_000
        for (const target of targets) {
          lib.markUnavailable(target.id, HUMAN_NO_MATCH, recheckAfter)
        }
      }
      record(transitioned, decision, HUMAN_NO_MATCH, journalPath, stats)
      return
    }
```

```ts
// src/v2/executor.ts — makeRunEpisode() 返回值(原 L467-479),删除 confidence/minConfidence 两行:
    return {
      decision: result.decision,
      journalPath: result.journalPath,
      subtitlePath: result.subtitlePath ?? undefined,
      reasons: result.reasons ?? [],
      selected: result.selected ?? null,
      stats: { llmCalls: result.stats.llmCalls, apiCalls: result.stats.apiCalls },
      quotaExhausted: result.quotaExhausted,
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/v2/executor.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/v2/executor.ts src/v2/executor.test.ts
git commit -m "feat(executor): remove ask_user branch, no_safe_match is the sole content-failure outcome"
```

### Task 6.4: `scanner.ts` + `daemon.ts`(pollSessions)清理 `needs_review` 残留引用 + 全仓库收绿

**Files:**
- Modify: `src/v2/scanner.ts`(两处 `needs_review` preserve 分支,约 L262-271、L328-337)
- Modify: `src/v2/daemon.ts`(`pollSessions()` 内约 L288-293)
- Modify: `src/v2/scanner.test.ts`

- [ ] **Step 1: 删除测试中已失效的用例**

在 `src/v2/scanner.test.ts` 里删除以下三个 `it()` 块(行号见 grep 结果):`'needs_review status is preserved when reality still says missing...'`(L321)、`'needs_review is overwritten when reality says covered...'`(L351)、`'MINOR: needs_review episode preserved when reality still says missing...'`(L1153)。

Run: `grep -n "needs_review" src/v2/scanner.test.ts`
Expected: 空输出

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/v2/scanner.test.ts`
Expected: PASS(测试层面无失败——本步是编译层面的红:`scanner.ts` 里 `existing?.sub_status === 'needs_review'` 与 `SubStatus` 类型比较此刻无重叠,`tsc` 会报错)

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep -i "needs_review"`
Expected: 若干行报 `scanner.ts`/`daemon.ts` 里 `'needs_review'` 与 `SubStatus` 无重叠

- [ ] **Step 3: 最小实现**

```ts
// src/v2/scanner.ts — episode 分支(原 L262-271)替换为:
        // Preserve unavailable only if reality still says missing;
        // covered/embedded/ignored/missing are reality checks that overwrite it.
        const existing = lib.getEpisode(item.Id)
        let statusToWrite = newStatus

        if (newStatus === 'missing' && existing?.sub_status === 'unavailable') {
          statusToWrite = existing.sub_status
        }

// movie 分支(原 L328-337)替换为:
        // Preserve unavailable only if reality still says missing (mirrors episode branch above)
        const existing = lib.getMovie(item.Id)
        let statusToWrite = newStatus

        if (newStatus === 'missing' && existing?.sub_status === 'unavailable') {
          statusToWrite = existing.sub_status
        }
```

```ts
// src/v2/daemon.ts — pollSessions() 内(原 L288-293)替换为:
        // unavailable 的条目:recheck_after 拉回 now,否则 wake 了 job 但 executor
        // 重derive targets 时 recheck 门会把这集挡在外面,白跑一轮。
        if (row.sub_status === 'unavailable') {
          lib.resetRecheck(row.id, now())
        }
```

- [ ] **Step 4: 跑测试确认通过 + 全仓库收绿**

Run: `npx vitest run src/v2/scanner.test.ts src/v2/daemon.test.ts`
Expected: PASS

Run: `npm run check`
Expected: 零编译错误(本阶段开头声明的小红窗口在此收口)

Run: `npm test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/v2/scanner.ts src/v2/daemon.ts src/v2/scanner.test.ts
git commit -m "chore: remove remaining needs_review references from scanner and daemon pollSessions"
```

### Task 6.5: `dashboard/labels.ts` + `cli/report.ts` — 清理 `ask_user` 人话标签残留

**Files:**
- Modify: `src/dashboard/labels.ts:9`(删除 `ask_user` 条目)
- Modify: `src/cli/report.ts:34`(过滤数组删除 `'ask_user'`)
- Modify: `src/dashboard/labels.test.ts`(若存在覆盖 `ask_user` 的用例,删除或改为断言未知枚举兜底)

- [ ] **Step 1: 确认现状**

Run: `grep -n "ask_user" src/dashboard/labels.test.ts src/cli/report.test.ts`
Expected: 列出需要清理/确认的用例(若有断言 `decisionLabel('ask_user')` 的用例,后续步骤改为断言它落回未知枚举兜底 `{ label: '已处理', tone: 'muted' }`)

- [ ] **Step 2: 若 Step 1 有用例引用 `ask_user`,先改断言(TDD 顺序:这里改测试预期,属于本任务的"写测试"步骤)**

```ts
// src/dashboard/labels.test.ts — 若存在类似用例,改为:
it('unknown/removed decision values fall back to neutral wording (e.g. the retired ask_user)', () => {
  expect(decisionLabel('ask_user')).toEqual({ label: '已处理', tone: 'muted' })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/dashboard/labels.test.ts`
Expected: FAIL(若 Step 2 有改动)——`decisionLabel('ask_user')` 目前仍命中 `DECISION_MAP` 里的专属条目,不会走兜底

- [ ] **Step 4: 最小实现**

```ts
// src/dashboard/labels.ts — DECISION_MAP 删除 ask_user 那一行:
const DECISION_MAP: Record<string, { label: string; tone: Tone }> = {
  download:       { label: '已下好中文字幕', tone: 'ok' },
  adopted_local:  { label: '整理好了本地已有的字幕', tone: 'ok' },
  already_exists: { label: '本来就有字幕，跳过', tone: 'skip' },
  no_safe_match:  { label: '暂时没找到合适的中文字幕', tone: 'muted' },
  retry_later:    { label: '过阵子再试', tone: 'muted' },
  error:          { label: '出错，稍后重试', tone: 'fail' },
}
```

```ts
// src/cli/report.ts — L34,过滤数组删除 'ask_user':
  const failures = runs.filter(r => ['no_safe_match', 'error'].includes(r.decision))
```

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `npx vitest run src/dashboard/labels.test.ts src/cli/report.test.ts`
Expected: PASS

```bash
git add src/dashboard/labels.ts src/cli/report.ts src/dashboard/labels.test.ts
git commit -m "chore: drop retired ask_user label and report filter entry"
```

---

## Phase 7: Web/Dashboard 拔除 `review` 态

进入本阶段前仓库应为绿(Phase 6 Task 6.4 收尾)。本阶段任务之间也有顺序依赖:7.1(后端 DTO)必须先于 7.2-7.6(前端消费方)——`web/src/api/types.ts` 与 `src/dashboard/apiV2.ts` 是前端 `CoverageDTO`/`SubStatus` 类型的唯一来源。7.1 结束后 `web/` 侧会短暂编译失败(`badge.ts`/`episode.ts`/`detail.ts` 仍引用已删除的 `needsReview`/`needs_review`),由 7.2-7.4 依次收口,7.6 结束时跑全量前端测试确认收绿。

### Task 7.1: 后端 DTO — `apiV2.ts` + `web/src/api/types.ts`

**Files:**
- Modify: `src/dashboard/apiV2.ts:7-14`(`CoverageDTO`)
- Modify: `src/dashboard/apiV2.ts:56`(`emptyCoverage`)
- Modify: `src/dashboard/apiV2.ts:59-65`(`addToCoverage`)
- Modify: `src/dashboard/apiV2.test.ts:49,72,77,97`
- Modify: `web/src/api/types.ts:2,4-11`(`SubStatus`/`CoverageDTO`)

- [ ] **Step 1: 改测试**

```ts
// src/dashboard/apiV2.test.ts — L49,删除整行(e5 needs_review episode 不再有意义,
// needs_review 已不是合法 sub_status):
// 删除:lib.upsertEpisode({ id: 'e5', seriesId: 's1', season: 2, episode: 2, name: 'E5', path: '/media/tv/Series A/S02/e5.mkv', subStatus: 'needs_review' })

// L72,series.coverage 断言删除 needsReview 键、covered/missing/embedded/unavailable 不变
// (e5 删除后 series A 从 5 集变 4 集,原本 unavailable 计数不受影响,因为 e5 是独立的一集):
    expect(series.coverage).toEqual({ covered: 1, missing: 1, embedded: 1, unavailable: 1 })

// L77,movie.coverage 断言删除 needsReview 键:
    expect(movie.coverage).toEqual({ covered: 0, missing: 1, embedded: 0, unavailable: 0 })

// L97,同上删除 needsReview 键:
    expect(item.coverage).toEqual({ covered: 0, missing: 0, embedded: 0, unavailable: 0 })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dashboard/apiV2.test.ts`
Expected: FAIL — `lib.upsertEpisode({..., subStatus: 'needs_review'})` 此刻是 TS 编译错误(`SubStatus` 已不含该值,Phase 6 已删);断言里少了 `needsReview` 键与当前 `CoverageDTO` 实现不匹配

- [ ] **Step 3: 最小实现**

```ts
// src/dashboard/apiV2.ts — 替换 CoverageDTO(原 L7-14)为:
export interface CoverageDTO {
  covered: number
  missing: number
  embedded: number
  unavailable: number
}

// 替换 emptyCoverage()(原 L56)为:
const emptyCoverage = (): CoverageDTO => ({ covered: 0, missing: 0, embedded: 0, unavailable: 0 })

// 替换 addToCoverage()(原 L59-65)为:
/** 把一条 sub_status 累加进覆盖桶(ignored 不入桶,它不参与 scout)。 */
function addToCoverage(cov: CoverageDTO, status: string, n: number): void {
  if (status === 'covered') cov.covered += n
  else if (status === 'missing') cov.missing += n
  else if (status === 'embedded') cov.embedded += n
  else if (status === 'unavailable') cov.unavailable += n
}
```

```ts
// web/src/api/types.ts — 替换 SubStatus(L2)与 CoverageDTO(L4-11)为:
export type SubStatus = 'missing' | 'covered' | 'embedded' | 'unavailable' | 'ignored'

export interface CoverageDTO {
  covered: number
  missing: number
  embedded: number
  unavailable: number
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/dashboard/apiV2.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/apiV2.ts src/dashboard/apiV2.test.ts web/src/api/types.ts
git commit -m "feat(dashboard): drop needsReview from CoverageDTO/SubStatus"
```

### Task 7.2: `web/src/lib/badge.ts` — 删除 `review` 徽章态

**Files:**
- Modify: `web/src/lib/badge.ts`(全文件重写)
- Modify: `web/src/lib/badge.test.ts`

- [ ] **Step 1: 删除已失效用例**

在 `web/src/lib/badge.test.ts` 里:
- 删除整个 `describe('task 2: needs_review 徽章态...')` 块(4 个用例)。
- 每个 `cov(...)` 夹具调用里删除 `needsReview: 0`(改用 `web/src/api/types.ts` 新的 `CoverageDTO` 形状后,`cov` 辅助函数本身也要同步改,见下)。
- `matchesFilter` 相关用例里的 `'review'` kind 断言(如 `全部 tab 收所有` 用例里的 `as const` 数组、`缺字幕 = part | none | review` 用例)删除 review 相关行。

```ts
// web/src/lib/badge.test.ts — 顶部 cov 辅助函数替换为:
const cov = (p: Partial<CoverageDTO>): CoverageDTO =>
  ({ covered: 0, missing: 0, embedded: 0, unavailable: 0, ...p })

// '全部 tab 收所有' 用例:
it('全部 tab 收所有', () => {
  for (const k of ['full', 'part', 'work', 'none'] as const) {
    expect(matchesFilter({ kind: k, text: '', pulse: false }, 'all')).toBe(true)
  }
})

// '缺字幕 = part | none（内嵌 full 不入）' 用例(改名去掉 review):
it('缺字幕 = part | none（内嵌 full 不入）', () => {
  expect(matchesFilter({ kind: 'part', text: '', pulse: false }, 'missing')).toBe(true)
  expect(matchesFilter({ kind: 'none', text: '', pulse: false }, 'missing')).toBe(true)
  expect(matchesFilter({ kind: 'full', text: '', pulse: false }, 'missing')).toBe(false)
  expect(matchesFilter({ kind: 'work', text: '', pulse: false }, 'missing')).toBe(false)
})

// scoutScope 用例删除 needsReview 参数:
it('scoutScope 不计内嵌', () => {
  expect(scoutScope(cov({ covered: 2, missing: 3, unavailable: 1, embedded: 9 }))).toBe(6)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run web/src/lib/badge.test.ts`
Expected: FAIL — `CoverageDTO`(来自 Task 7.1)已不含 `needsReview`,`cov()` 夹具此刻是 TS 编译错误;`coverageBadge` 仍会对 `needsReview>0` 返回 `review` 态

- [ ] **Step 3: 最小实现**

```ts
// web/src/lib/badge.ts(全文件重写)
// web/src/lib/badge.ts
// 海报覆盖徽章的纯逻辑:覆盖计数 + 当前 job → 徽章形态。
// 单一事实源,四态互斥,供海报墙徽章、过滤 tab、顶栏事实数字共用。
import type { CoverageDTO, LibraryJobDTO } from '../api/types.js'

export type BadgeKind = 'full' | 'part' | 'work' | 'none'

export interface Badge {
  kind: BadgeKind
  text: string
  /** 仅 work 态为 true:脉冲点只在真实 in-flight。 */
  pulse: boolean
}

const ACTIVE_JOB = new Set(['searching', 'downloading', 'verifying'])

/** job 是否真实在跑(脉冲的唯一依据)。 */
export function jobActive(job: LibraryJobDTO | null): boolean {
  return job != null && ACTIVE_JOB.has(job.state)
}

/** scout 关心的集数(内嵌与策略跳过不计)。 */
export function scoutScope(cov: CoverageDTO): number {
  return cov.covered + cov.missing + cov.unavailable
}

/**
 * 徽章判定(优先级自上而下,互斥):
 * 1. job 在跑 → work:脉冲 + covered/scope 分数
 * 2. 无缺且有中字(外挂或内嵌)→ full:teal 勾
 * 3. 已补到一部分 → part:分数
 * 4. 一集未补:
 *    - 还有 missing(未搜过,含新入库排队中的)→ none:待搜索
 *    - 全是 unavailable(搜穷尽,会定期复查)→ none:暂无
 *    二者 kind/filter 行为一致(都算"缺字幕"),仅文案区分。
 */
export function coverageBadge(cov: CoverageDTO, job: LibraryJobDTO | null): Badge {
  const scope = scoutScope(cov)
  if (jobActive(job)) {
    return { kind: 'work', text: scope > 0 ? `${cov.covered}/${scope}` : '', pulse: true }
  }
  const fullyHandled = cov.missing === 0 && cov.unavailable === 0 && (cov.covered > 0 || cov.embedded > 0)
  if (fullyHandled) return { kind: 'full', text: cov.covered > 0 ? `${cov.covered}/${scope}` : '✓', pulse: false }
  if (cov.covered > 0) return { kind: 'part', text: `${cov.covered}/${scope}`, pulse: false }
  if (cov.missing > 0) return { kind: 'none', text: '待搜索', pulse: false }
  return { kind: 'none', text: '暂无', pulse: false }
}

export type LibraryFilter = 'all' | 'missing' | 'working' | 'done'

/** 过滤谓词:复用徽章 kind,保证 tab 与徽章一致。 */
export function matchesFilter(badge: Badge, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'missing':
      return badge.kind === 'part' || badge.kind === 'none'
    case 'working':
      return badge.kind === 'work'
    case 'done':
      return badge.kind === 'full'
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/badge.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/badge.ts web/src/lib/badge.test.ts
git commit -m "feat(web): remove review badge state"
```

### Task 7.3: `web/src/lib/episode.ts` — 删除 `review` 格子态

**Files:**
- Modify: `web/src/lib/episode.ts`(全文件重写)
- Modify: `web/src/lib/episode.test.ts`

- [ ] **Step 1: 删除已失效用例**

在 `web/src/lib/episode.test.ts` 里删除两个 `it('task 2: needs_review ...')` 用例(`无 job → review` 与 `job 活跃时 needs_review → work`),以及 `cellLabel('review')` 相关断言行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run web/src/lib/episode.test.ts`
Expected: FAIL — `ep('needs_review')` 此刻是 TS 编译错误(`SeriesEpisodeDTO['subStatus']` 已不含该值)

- [ ] **Step 3: 最小实现**

```ts
// web/src/lib/episode.ts(全文件重写)
// web/src/lib/episode.ts
// 集覆盖格子的态映射(纯函数,供详情页格子与图例、状态摘要共用)。
import type { SeriesEpisodeDTO, LibraryJobDTO } from '../api/types.js'

export type EpisodeCellState = 'cov' | 'emb' | 'miss' | 'work' | 'unav'

const CELL_LABEL: Record<EpisodeCellState, string> = {
  cov: '已补齐',
  emb: '自带中字',
  miss: '缺字幕',
  work: '处理中',
  unav: '暂时没找到（会定期复查）',
}

export function cellLabel(state: EpisodeCellState): string {
  return CELL_LABEL[state]
}

/**
 * 集态映射:sub_status 直译;当该季 job 真实在跑且该集仍未补齐(missing/unavailable),
 * 覆盖为 work(脉冲):脉冲只在真实 in-flight。covered/embedded 已到位,不受 job 影响。
 */
export function episodeCellState(ep: SeriesEpisodeDTO, seasonJobActive: boolean): EpisodeCellState {
  if (ep.subStatus === 'covered') return 'cov'
  if (ep.subStatus === 'embedded') return 'emb'
  if (ep.subStatus === 'ignored') return 'emb' // 策略跳过:视觉等同不需处理
  if (seasonJobActive && (ep.subStatus === 'missing' || ep.subStatus === 'unavailable')) return 'work'
  if (ep.subStatus === 'unavailable') return 'unav'
  return 'miss'
}

const ACTIVE = new Set(['searching', 'downloading', 'verifying'])
export function isJobActive(job: LibraryJobDTO | { state: string } | null): boolean {
  return job != null && ACTIVE.has(job.state)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/episode.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/episode.ts web/src/lib/episode.test.ts
git commit -m "feat(web): remove review episode cell state"
```

### Task 7.4: `web/src/lib/detail.ts` — 删除 `review` 计数与提示

**Files:**
- Modify: `web/src/lib/detail.ts`(全文件重写)
- Modify: `web/src/lib/detail.test.ts`

- [ ] **Step 1: 删除已失效用例**

在 `web/src/lib/detail.test.ts` 里删除整个 `describe('tallySeasons / statusSummary:needs_review 计入独立桶')` 块与整个 `describe('needsReviewTooltip:结构对称于 unavailableTooltip')` 块,只保留 `unavailableTooltip` 行为不变的那条断言(把它挪进一个精简后的 describe,或直接留作独立 `it()`)。

```ts
// web/src/lib/detail.test.ts(整份精简为)
import { describe, it, expect } from 'vitest'
import { tallySeasons, statusSummary, unavailableTooltip } from './detail.js'
import type { SeriesSeasonDTO, SeriesEpisodeDTO } from '../api/types.js'

const ep = (id: string, episode: number, subStatus: SeriesEpisodeDTO['subStatus'], overrides: Partial<SeriesEpisodeDTO> = {}): SeriesEpisodeDTO =>
  ({ id, episode, name: null, subStatus, statusReason: null, recheckAfter: null, ...overrides })

const season = (episodes: SeriesEpisodeDTO[]): SeriesSeasonDTO => ({ season: 1, episodes })

describe('tallySeasons / statusSummary', () => {
  it('按态分桶计数', () => {
    const seasons = [season([ep('e1', 1, 'covered'), ep('e2', 2, 'missing'), ep('e3', 3, 'unavailable')])]
    const t = tallySeasons(seasons, false)
    expect(t.cov).toBe(1)
    expect(t.miss).toBe(1)
    expect(t.unav).toBe(1)
  })
  it('statusSummary 报告缺字幕集数', () => {
    const seasons = [season([ep('e1', 1, 'missing'), ep('e2', 2, 'missing')])]
    const summary = statusSummary(tallySeasons(seasons, false))
    expect(summary).toContain('2 集缺字幕')
  })
})

describe('unavailableTooltip', () => {
  it('原因 + 复查时间人话化', () => {
    const now = Date.now()
    const e = ep('e1', 1, 'unavailable', { statusReason: '搜索穷尽', recheckAfter: now + 1000 })
    expect(unavailableTooltip(e, now)).toContain('搜索穷尽')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run web/src/lib/detail.test.ts`
Expected: FAIL — 当前 `detail.ts` 仍导出 `needsReviewTooltip` 但测试已不导入它是无害的;真正的失败源是 `StateTally` 仍含 `review` 字段,`tallySeasons` 用不到的 `ep('e1',1,'needs_review')` 场景已被移除测试不触发,此步骤主要用于确认精简后的用例先跑通既有实现的部分(是"确认现状",非真正 TDD 红——下一步聚焦真正要删的字段)

Run: `grep -n "needsReviewTooltip\|review" web/src/lib/detail.ts`
Expected: 列出 `StateTally.review`、`needsReviewTooltip` 定义——这些是本任务要删除的目标

- [ ] **Step 3: 最小实现**

```ts
// web/src/lib/detail.ts(全文件重写)
// web/src/lib/detail.ts:详情页纯逻辑:状态摘要句 + unavailable 复查时间人话化。
import type { SeriesSeasonDTO, SeriesEpisodeDTO } from '../api/types.js'
import { episodeCellState } from './episode.js'

export interface StateTally {
  cov: number
  emb: number
  miss: number
  work: number
  unav: number
}

export function tallySeasons(seasons: SeriesSeasonDTO[], jobActive: boolean): StateTally {
  const t: StateTally = { cov: 0, emb: 0, miss: 0, work: 0, unav: 0 }
  for (const s of seasons) for (const ep of s.episodes) t[episodeCellState(ep, jobActive)]++
  return t
}

/** 冷峻状态摘要:只报存在的态。全空返回空串。 */
export function statusSummary(t: StateTally): string {
  const parts: string[] = []
  if (t.cov) parts.push(`${t.cov} 集已补齐`)
  if (t.work) parts.push(`${t.work} 集处理中`)
  if (t.miss) parts.push(`${t.miss} 集缺字幕`)
  if (t.unav) parts.push(`${t.unav} 集暂时没找到`)
  if (t.emb) parts.push(`${t.emb} 集自带中字`)
  return parts.join(' · ')
}

function ymd(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/** unavailable 集的原生 title 提示:原因 + 复查时间人话化。 */
export function unavailableTooltip(ep: SeriesEpisodeDTO, now: number): string {
  const bits: string[] = []
  bits.push(ep.statusReason ?? '搜索穷尽,暂时没找到')
  if (ep.recheckAfter != null) {
    bits.push(ep.recheckAfter <= now ? '即将复查' : `${ymd(ep.recheckAfter)} 复查`)
  }
  return bits.join(' · ')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run web/src/lib/detail.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add web/src/lib/detail.ts web/src/lib/detail.test.ts
git commit -m "feat(web): remove review tally bucket and needsReviewTooltip"
```

### Task 7.5: `EpisodeGrid.tsx` + `styles.css` — 删除 review 格子/图例/样式

**Files:**
- Modify: `web/src/components/EpisodeGrid.tsx`(全文件重写)
- Modify: `web/src/styles.css:7-9,49,74,82`

- [ ] **Step 1: 写/改失败测试**

`EpisodeGrid.tsx` 本身没有独立单测(由 `SeriesDetail.test.tsx` 间接覆盖,见 Task 7.6)。本任务先跑一次 `tsc` 确认当前编译状态,作为"失败"基线:

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep -i "EpisodeGrid\|needsReviewTooltip"`
Expected: 报 `EpisodeGrid.tsx` 里 `needsReviewTooltip` 已不是 `detail.js` 的导出(Task 7.4 已删除)

- [ ] **Step 2: 最小实现**

```tsx
// web/src/components/EpisodeGrid.tsx(全文件重写)
// web/src/components/EpisodeGrid.tsx:按季分节的集覆盖格子,照设计稿 CSS 类名
// (cov/emb/miss/work/unav)。
import type { SeriesSeasonDTO } from '../api/types.js'
import { episodeCellState } from '../lib/episode.js'
import { unavailableTooltip } from '../lib/detail.js'

export function EpisodeGrid({
  season,
  jobActive,
  now,
}: {
  season: SeriesSeasonDTO
  jobActive: boolean
  now: number
}) {
  return (
    <div className="season">
      <h3>第 {season.season} 季</h3>
      <div className="eps">
        {season.episodes.map((ep) => {
          const state = episodeCellState(ep, jobActive)
          const title = state === 'unav' ? unavailableTooltip(ep, now) : undefined
          return (
            <div className={`ep ${state}`} key={ep.id} title={title}>
              {ep.episode}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Legend() {
  return (
    <div className="legend">
      <span><i className="sw cov" />已补齐</span>
      <span><i className="sw emb" />自带中字</span>
      <span><i className="sw miss" />缺字幕</span>
      <span><i className="sw unav" />暂时没找到（会定期复查）</span>
    </div>
  )
}
```

```css
/* web/src/styles.css — 删除 L7-9(--amber/--amber-dim 及其注释),
   保留其余 :root 变量: */
:root {
  --bg: #0C0D0F; --surface: #131518; --surface-2: #191c20;
  --text: #E7E9EA; --text-dim: #8B9096; --text-faint: #565B61;
  --teal: #2DD4BF; --teal-dim: rgba(45,212,191,.14);
  --line: rgba(255,255,255,.07);
  --sans: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}

/* 删除 L49(.badge.review 规则)——.badge.work 与 .dot 之间不再有 review 条目 */
/* 删除 L74(.ep.review 规则)——.ep.unav 与 .legend 之间不再有 review 条目 */
/* 删除 L82(.sw.review 规则)——.sw.unav 之后不再有 review 条目 */
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx tsc --noEmit -p tsconfig.build.json 2>&1 | grep -i "EpisodeGrid"`
Expected: 空输出

- [ ] **Step 4: 提交**

```bash
git add web/src/components/EpisodeGrid.tsx web/src/styles.css
git commit -m "feat(web): remove review episode cell, legend entry, and amber accent"
```

### Task 7.6: `SeriesDetail.test.tsx` / `App.test.tsx` / `summary.test.ts` — 夹具清理

**Files:**
- Modify: `web/src/components/SeriesDetail.test.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/lib/summary.ts:12,24`
- Modify: `web/src/lib/summary.test.ts`

- [ ] **Step 1: 改测试**

```tsx
// web/src/components/SeriesDetail.test.tsx — 顶部 DETAIL 夹具删除 e5(needs_review 已不存在):
const DETAIL: SeriesDetailDTO = {
  id: 's1', name: 'Love, Death & Robots', chineseTitle: '爱，死亡和机器人', year: 2019, posterTag: null,
  seasons: [
    { season: 1, episodes: [
      { id: 'e1', episode: 1, name: null, subStatus: 'covered', statusReason: null, recheckAfter: null },
      { id: 'e2', episode: 2, name: null, subStatus: 'embedded', statusReason: null, recheckAfter: null },
      { id: 'e3', episode: 3, name: null, subStatus: 'missing', statusReason: null, recheckAfter: null },
      { id: 'e4', episode: 4, name: null, subStatus: 'unavailable', statusReason: '搜索穷尽', recheckAfter: 4102444800000 },
    ] },
  ],
  runs: [
    { startedAt: Date.now(), finishedAt: Date.now(), decision: 'download', detail: '下好一集放到位', journalPath: '/j/x' },
  ],
}

// fetchFor() 里的 coverage 夹具删除 needsReview 键:
function fetchFor(job: LibraryItemDTO['job']) {
  const lib: LibraryItemDTO[] = [
    { id: 's1', kind: 'series', section: '剧集', name: DETAIL.name, chineseTitle: DETAIL.chineseTitle, year: 2019,
      posterTag: null, coverage: { covered: 1, missing: 1, embedded: 1, unavailable: 1 }, job },
  ]
  return vi.fn(async (url: string) => {
    const body = url.includes('/api/v2/series/') ? DETAIL : lib
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
}

// 第一个 it() 用例删除 e5/review 相关断言(cellClass('5')、'review' 那一行);
// 第二个 it() 用例('job 活跃')同样删除 cellClass('5') 断言;
// 第三个 it() 保持不变(unavailable 提示,仍用 e4);
// 第四个 it()('task 2: needs_review 集带原生 title 提示...') 整个用例删除——
//   needs_review 已不存在,没有对应场景可测。
```

```tsx
// web/src/App.test.tsx — 三处 coverage 夹具删除 needsReview: 0:
    coverage: { covered: 12, missing: 0, embedded: 0, unavailable: 0 } }),                         // full
    coverage: { covered: 3, missing: 5, embedded: 0, unavailable: 0 } }),                           // part → missing
    coverage: { covered: 1, missing: 8, embedded: 0, unavailable: 0 }, job: { state: 'searching', priority: 100 } }), // work
```

```ts
// web/src/lib/summary.test.ts — 四处 coverage 夹具删除 needsReview 键,'task 2: needsReview...'
// 整个 it() 用例删除(review 徽章已不存在,该场景无法复现):
      item({ id: 'a', kind: 'series', coverage: { covered: 12, missing: 0, embedded: 0, unavailable: 0 } }), // full
      item({ id: 'b', kind: 'series', coverage: { covered: 3, missing: 5, embedded: 0, unavailable: 0 } }), // part → missing
      item({ id: 'c', kind: 'series', coverage: { covered: 0, missing: 4, embedded: 0, unavailable: 0 }, job: { state: 'searching', priority: 0 } }), // work
      item({ id: 'd', kind: 'movie', coverage: { covered: 0, missing: 1, embedded: 0, unavailable: 0 } }), // none → missing
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/components/SeriesDetail.test.tsx src/App.test.tsx src/lib/summary.test.ts`
Expected: FAIL — 夹具仍传 `needsReview` 键(此刻 `CoverageDTO` 已不含该字段,TS 编译错误);`summary.ts` 的 `libraryFacts` 仍判 `b.kind === 'review'`(未失效,只是死分支)

- [ ] **Step 3: 最小实现**

```ts
// web/src/lib/summary.ts — 替换 libraryFacts() 里的 badge kind 判断(L24)为:
    if (b.kind === 'work') working++
    else if (b.kind === 'part' || b.kind === 'none') missing++
// 顶部注释(L12)同步去掉 "review 是 task 2 的待确认态" 措辞。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run`
Expected: 全绿(整个 web/ 子项目)

- [ ] **Step 5: 提交 + 全仓库最终收尾**

```bash
git add web/src/components/SeriesDetail.test.tsx web/src/App.test.tsx web/src/lib/summary.ts web/src/lib/summary.test.ts
git commit -m "test(web): drop needsReview fixtures, review badge/cell scenarios are retired"
```

---

## 最终验证

- [ ] **全仓库编译 + 全量测试**

Run: `npm run check`
Expected: 零编译错误

Run: `npm test`
Expected: 全绿(后端 `src/**/*.test.ts`)

Run: `cd web && npm test`
Expected: 全绿(前端 `web/src/**/*.test.ts(x)`)

- [ ] **人工抽查(不是自动化步骤,但强烈建议在合并前跑一次)**

用一个真实(或录制)候选池手动跑一次 `npx tsx src/cli/index.ts run-item --item-id <一个已知有中文字幕候选的条目>`,确认:
1. `~/.subtitle-scout/cache/<mediaRoot>/.subtitle-staging/` 目录在运行期间出现、运行结束后消失。
2. 最终字幕文件名与语言标记(`zh-Hans`/`zh-Hant`)符合预期。
3. journal(`decision.json`)里能看到 `candidateAttemptStart`/`candidateInspected`/`verifySubtitle` 一类新 step,证明真的走了 staging→inspect→verify 链路而非旧的直连下载。

Run: `npm run cli -- doctor`
Expected: 现有诊断项(jellyfin/assrt/llm/media-roots/database/stuck-jobs)全部照旧可用,未受本次改动影响。
