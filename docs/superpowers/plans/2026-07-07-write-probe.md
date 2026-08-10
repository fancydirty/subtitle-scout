# Write-Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在跑 LLM/ASSRT 之前探测视频目录是否可写,不可写则干净止损(明确日志 + 冷却跳过),避免只读挂载白烧额度、无限重试。

**Architecture:** 新增纯函数 `isDirWritable(dir)`(真实试写临时文件),在 watcher `maybeProcess` 与 cli `cmdRunItem` 两处现有路径预检旁调用,复用现有 "media dir not accessible" 分支的处理形态。零新依赖,核心 pipeline 不变。

**Tech Stack:** TypeScript NodeNext ESM(`.js` imports)、Node 22 `node:fs`、Vitest。

**Spec:** `docs/superpowers/specs/2026-07-07-write-probe-design.md`

---

## File Structure

- `src/core/mediaContext.ts` — 新增导出 `isDirWritable(dir: string): boolean`(真实试写)。
- `src/core/mediaContext.test.ts` — 新增 `isDirWritable` 单测。
- `src/daemon/watcher.ts` — `WatcherDeps` 新增注入 `isWritable: (dir: string) => boolean`;`maybeProcess` 在 `pathExists` 预检后加一道不可写止损。
- `src/daemon/watcher.test.ts` — 所有 fake `WatcherDeps` 补 `isWritable: () => true`;新增只读分支用例。
- `src/cli/index.ts` — `cmdRunItem` 加不可写检查;`cmdWatch` 的 Watcher 装配注入 `isWritable`。

---

## Task 1: isDirWritable 纯函数 + 单测

**Files:**
- Modify: `src/core/mediaContext.ts`(文件末尾新增导出函数;顶部 import 增补)
- Test: `src/core/mediaContext.test.ts`

背景:`src/core/mediaContext.ts` 当前从 `node:path` import `{ basename, dirname, resolve, sep }`,并导出 `parsePathMappings`/`mapPath`/`buildMediaContext`/`mediaDir`/`isUnderRoots`。新函数放这里,与 `isUnderRoots` 等路径工具同处。真实试写:在 `dir` 下写一个隐藏前缀的唯一命名临时文件,成功即删除返回 true,任何异常返回 false(目录不存在也会因写失败返回 false)。用模块级自增计数器 + `process.pid` 保证唯一,避免 `Math.random`/`Date.now`(本仓库测试环境对时钟/随机有约束,且计数器足够)。

- [ ] **Step 1: 写失败测试**

在 `src/core/mediaContext.test.ts` 顶部 import 增补(该文件已 `import { readFileSync } from 'node:fs'`,改为同时引入所需):

```typescript
import { mkdtempSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

并把现有 `import { buildMediaContext, parsePathMappings, mapPath, mediaDir, isUnderRoots } from './mediaContext.js'` 一行加上 `isDirWritable`:

```typescript
import { buildMediaContext, parsePathMappings, mapPath, mediaDir, isUnderRoots, isDirWritable } from './mediaContext.js'
```

追加 describe 块:

```typescript
describe('isDirWritable', () => {
  it('returns true for a writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ok-'))
    expect(isDirWritable(dir)).toBe(true)
  })
  it('leaves no probe file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-clean-'))
    isDirWritable(dir)
    expect(readdirSync(dir).some(f => f.startsWith('.subtitle-scout-writetest'))).toBe(false)
  })
  it('returns false for a non-existent directory', () => {
    expect(isDirWritable(join(tmpdir(), 'wp-does-not-exist-zzz', 'nope'))).toBe(false)
  })
  it('returns false for a read-only directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ro-'))
    chmodSync(dir, 0o555)
    // 注意:以 root 运行时权限位被绕过,该断言不成立 → 条件跳过
    if (process.getuid && process.getuid() === 0) return
    expect(isDirWritable(dir)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/core/mediaContext.test.ts`
Expected: FAIL — `isDirWritable` is not exported.

- [ ] **Step 3: 实现**

在 `src/core/mediaContext.ts` 顶部,把 `node:path` 的 import 保持不变,新增 `node:fs` import(文件当前未引入 fs;加一行):

```typescript
import { writeFileSync, unlinkSync } from 'node:fs'
```

在文件末尾(`isUnderRoots` 之后)新增:

```typescript
let writeProbeCounter = 0

/**
 * 目录是否可写:在 dir 下真实试写一个隐藏临时文件再删除。成功→true,任何异常→false
 * (目录不存在也会因写失败返回 false)。不用 fs.access(W_OK)——网络挂载(WebDAV/rclone/CIFS)
 * 上 W_OK 会撒谎,且容器内 root 会绕过权限位;真实试写走 sidecar 将来同一条写路径,是唯一可信信号。
 */
export function isDirWritable(dir: string): boolean {
  const probe = resolve(dir, `.subtitle-scout-writetest-${process.pid}-${writeProbeCounter++}`)
  try {
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    try { unlinkSync(probe) } catch { /* 写失败时无残留;写成功删失败的边界尽力清理 */ }
    return false
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/core/mediaContext.test.ts`
Expected: PASS(既有 mediaContext 测试仍绿;新 4 例通过,root 环境下只读用例自跳过)。

- [ ] **Step 5: 提交**

```bash
git add src/core/mediaContext.ts src/core/mediaContext.test.ts
git commit -m "feat(context): isDirWritable via real test-write probe"
```

---

## Task 2: 接线 watcher + cli 两处预检

**Files:**
- Modify: `src/daemon/watcher.ts`(`WatcherDeps.isWritable` + `maybeProcess` 预检)
- Modify: `src/daemon/watcher.test.ts`(fake 补齐 + 只读用例)
- Modify: `src/cli/index.ts`(`cmdRunItem` 检查 + `cmdWatch` 注入)

背景:`watcher.ts` 的 `maybeProcess` 现有一段(约 106-110 行):
```typescript
      if (!this.deps.pathExists(mediaDir(ctx))) {
        this.deps.log(`media dir not accessible locally: ${mediaDir(ctx)} — check MEDIA_PATH_MAPPINGS (jellyfin path prefix = local path prefix)`)
        processed = true // 进冷却:配置不修好,重试也没用
        return
      }
      processed = true
      this.deps.log(`processing ${item.Name} (${itemId})`)
```
`WatcherDeps` 现有 `pathExists: (path: string) => boolean` 字段。cli `cmdWatch` 装配处传 `pathExists: p => existsSync(p)`。cli `cmdRunItem` 有 `if (!existsSync(mediaDir(ctx))) { console.error(...); process.exit(2) }`。

- [ ] **Step 1: watcher 加 WatcherDeps 字段 + 预检**

在 `src/daemon/watcher.ts` 的 `WatcherDeps` 接口里,`pathExists` 字段后新增一行:

```typescript
  /** 媒体目录可写性预检(默认真实试写)。只读挂载时避免白烧 LLM/ASSRT 配额 */
  isWritable: (dir: string) => boolean
```

在 `maybeProcess` 里,把上面引用的 `pathExists` 失败分支之后、`processed = true` / `this.deps.log('processing ...')` 之前,插入不可写止损:

```typescript
      if (!this.deps.pathExists(mediaDir(ctx))) {
        this.deps.log(`media dir not accessible locally: ${mediaDir(ctx)} — check MEDIA_PATH_MAPPINGS (jellyfin path prefix = local path prefix)`)
        processed = true // 进冷却:配置不修好,重试也没用
        return
      }
      if (!this.deps.isWritable(mediaDir(ctx))) {
        this.deps.log(`media dir not writable: ${mediaDir(ctx)} — sidecar 无法写入,检查挂载读写权限(只读网盘/WebDAV?)`)
        processed = true // 进冷却:只读是永久条件,重试也没用
        return
      }
      processed = true
      this.deps.log(`processing ${item.Name} (${itemId})`)
```

- [ ] **Step 2: makeDeps 默认补一行 + 加只读用例**

`src/daemon/watcher.test.ts` 的 `makeDeps(over)`(第 14-37 行)返回**单个**默认 deps 对象,用 `...over` 合并覆盖。**只需在该默认对象里加一行**——在 `pathExists: () => true,`(第 26 行)之后:

```typescript
    pathExists: () => true,
    isWritable: () => true,
```

这一处默认即覆盖所有既有用例(它们都经 `makeDeps` 构造),无需改任何内联 override。

然后新增只读用例——**照抄第 40-42 行 "not accessible" 姊妹用例的结构**(默认 `jellyfin` 已返回可触发的 `cleanItem` + 播放中的 `sessions`,`maybeProcess` 会一路走到 isWritable 检查):

```typescript
it('skips (no runJob) when media dir is not writable', async () => {
  const logs: string[] = []
  const runJob = vi.fn(async () => ({ decision: 'download' as const, subtitlePath: '/m/x.zh-Hans.ass', journalPath: '/j/decision.json' }))
  const deps = makeDeps({ isWritable: () => false, runJob, log: m => logs.push(m) })
  const w = new Watcher(deps)
  await w.tick()
  expect(runJob).not.toHaveBeenCalled()
  expect(logs.some(m => m.includes('not writable'))).toBe(true)
})
```

放在第 40 行 `describe('Watcher.tick', ...)` 块内(与 "not accessible" 用例相邻)。

- [ ] **Step 3: 跑 watcher 测试确认通过**

Run: `npx vitest run src/daemon/watcher.test.ts`
Expected: 先因缺 `isWritable` 类型/断言失败 → 补齐所有 fake 后 PASS,含新只读用例。

- [ ] **Step 4: cli 接线**

在 `src/cli/index.ts` 顶部 import 处,把现有 `import { buildMediaContext, mediaDir, parsePathMappings, isUnderRoots, type PathMapping } from '../core/mediaContext.js'` 加上 `isDirWritable`:

```typescript
import { buildMediaContext, mediaDir, parsePathMappings, isUnderRoots, isDirWritable, type PathMapping } from '../core/mediaContext.js'
```

在 `cmdRunItem` 里,现有的:
```typescript
  if (!existsSync(mediaDir(ctx))) {
    console.error(`media dir not accessible locally: ${mediaDir(ctx)} — check MEDIA_PATH_MAPPINGS`)
    process.exit(2)
  }
```
之后紧接着加:
```typescript
  if (!isDirWritable(mediaDir(ctx))) {
    console.error(`media dir not writable: ${mediaDir(ctx)} — sidecar 无法写入,检查挂载读写权限(只读网盘/WebDAV?)`)
    process.exit(2)
  }
```

在 `cmdWatch` 里 `new Watcher({ ... })` 的 deps 对象中,现有 `pathExists: p => existsSync(p),` 后加一行:
```typescript
    isWritable: dir => isDirWritable(dir),
```

- [ ] **Step 5: 跑全量测试 + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无类型错误(cli 的 `isWritable` 注入满足新接口字段;watcher 所有 fake 已补齐)。

- [ ] **Step 6: 提交**

```bash
git add src/daemon/watcher.ts src/daemon/watcher.test.ts src/cli/index.ts
git commit -m "feat(watcher/cli): writability precheck before pipeline, clean stop on read-only"
```

---

## Task 3: Controller 真实验证 + 部署(主循环执行)

**Files:** 无代码改动——真实环境验证、部署。主循环持凭据执行,不派子代理。

背景:验证只读目录被干净止损(不烧 LLM/ASSRT),可写目录不受影响。软路由容器以 root 运行,`chmod` 权限位对 root 无效——要造出对该进程真只读的目录,用**只读 bind mount** 或**属主/ACL**,或退一步用一个进程无写权限的路径。最省事可信的做法:在容器内造一个 root 也写不了的路径——用 `mount -o remount,ro` 不可行(需权限);改用一个不存在可写后端的路径不合适。实用方案:临时把某个测试目录用 `chattr +i`(immutable)或换非 root 运行不便。故此处采用**行为验证**:构造指向一个可写 tmp 目录的 context 确认放行,再指向一个只读目录确认止损——只读目录用 `docker exec` 内 `chown`+非 root `su` 跑,或直接在**本地 OrbStack**(非容器、当前用户非 root)造只读目录跑 `run --context` 验证,更简单可信。

- [ ] **Step 1: 本地只读目录止损验证(非 root,chmod 生效)**

在本机(当前用户非 root)造只读目录 + 一个 context 指向它,跑 `run --context`,确认 pipeline 未启动(无 LLM/ASSRT 调用)、退出码 2、错误含 "not writable"。命令(itemId 用假路径即可,重点是写探针在 pipeline 前拦截):

```bash
cd ~/projects/subtitle-plugin
D=$(mktemp -d); cat > "$D/ctx.json" <<JSON
{"request_id":"wp-ro-test","trigger":"manual_search","media":{"type":"movie","path":"$D/Foreign.Film.2020.mkv","filename":"Foreign.Film.2020.mkv","title":"Foreign Film","year":2020,"provider_ids":{},"production_locations":["United States"],"existing_subtitles":[]},"preferences":{}}
JSON
chmod 0555 "$D"
npx tsx src/cli/index.ts run --context "$D/ctx.json" --out "$D"; echo "exit=$?"
chmod 0755 "$D"; rm -rf "$D"
```

Expected:stderr 含 `media dir not writable`,`exit=2`,且**未**出现 identify/planSearch 的 LLM 调用日志(pipeline 未启动)。注意:`cmdRun`(`run --context`)当前直接调 `runPipeline` 不经 `cmdRunItem` 的检查——若 `run` 路径未接写探针,此步会跑进 pipeline;届时确认写探针是否也该覆盖 `cmdRun`。**先按现状(仅 `cmdRunItem`+watcher 接线)验证:若 `run` 未拦截,改用 `run-item` 路径无法本地造只读的真实 Jellyfin item,则此步改为"可写目录放行"正向验证 + 依赖 watcher 单测覆盖只读分支。** 记录实际观察。

- [ ] **Step 2: 全量测试 + typecheck 最终确认**

```bash
npx vitest run && npx tsc --noEmit
```
Expected:全绿、无类型错误。

- [ ] **Step 3: 部署软路由**

```bash
cd ~/projects/subtitle-plugin && bash deploy/deploy.sh
```
部署后确认容器起来并 watching:
```bash
ssh media-router-tunnel 'docker ps --filter name=subtitle-scout'
```
Expected:`subtitle-scout` 容器 Up;日志 `subtitle-scout watching ...`。

- [ ] **Step 4: 生产回归——正常片仍正常**

生产上对一部可写目录的外语片跑 `run-item`(清负缓存后),确认写探针放行、决策与 M5b 一致(download/no_safe_match 正常),证明探针未误伤可写场景。

- [ ] **Step 5: 收尾**

用 `superpowers:finishing-a-development-branch` 合并 `write-probe` 回 main,更新 `project-subtitle-scout-status` 记忆(补"写探针已合并:只读媒体目录 pipeline 前止损")。

---

## Self-Review

**Spec coverage(逐节核对):**
- 探测方式(真实试写,非 W_OK)→ Task 1 `isDirWritable`。✅
- 探测位置(mediaContext helper;watcher maybeProcess + cmdRunItem)→ Task 1(helper)+ Task 2(两处接线)。✅
- 不可写行为(照搬 not-accessible 分支:log + processed=true 冷却 + return;cli error+exit 2)→ Task 2。✅
- 不记 ledger(v1)→ 计划未加 ledger 事件,符合。✅
- watcher 装配注入 `isWritable` → Task 2 Step 4。✅
- 测试(isDirWritable 单测含 root 跳过;watcher 只读用例 + fake 补齐)→ Task 1/2。✅
- 真实 controller 验证 + 部署 → Task 3。✅
- 不做 Jellyfin 上传兜底 / 不改 writeSubtitle → 计划未触碰,符合。✅

**已知取舍(计划内已注明):**
- Task 3 只读真实验证在容器内因 root 绕权限位而受限,改用本地非-root 只读目录验证;并标注 `cmdRun`(run --context)当前未接写探针的可能观察点。若验证发现 `run` 路径也需覆盖,作为 Task 3 的实测产出反馈(spec 只承诺 watcher + cmdRunItem;`cmdRun` 是本地调试入口,非生产路径,可不接)。

**Placeholder 扫描:** 无 TBD/TODO;每步给了完整代码与命令。✅

**类型一致性:** `isDirWritable(dir: string): boolean`(Task 1)在 Task 2 watcher 注入 `isWritable: dir => isDirWritable(dir)` 与 cli `isDirWritable(mediaDir(ctx))` 一致;`WatcherDeps.isWritable: (dir: string) => boolean` 字段名在接口/装配/测试 fake 全一致。✅
