# 开源发布实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 subtitle-scout 以净化快照 + squash 首发到公开仓 `fancydirty/subtitle-scout`，配 doctor 自检、PlayerServer 接口、compose 双路、GHCR 双架构镜像。

**Architecture:** 先在当前私有仓完成全部净化与新增代码（Task 1–9，每个 task 提交），再从 main 导出净化快照建公开仓（Task 10），真实验收（Task 11），最后本地开发流转到公开仓（Task 12）。spec：`docs/superpowers/specs/2026-07-09-open-source-release-design.md`。

**Tech Stack:** TypeScript + tsx、vitest、zod、Docker buildx、GitHub Actions、gh CLI。

**家规提醒：** 子代理用 sonnet-5。每 task 结束 `npx tsc --noEmit && npx vitest run` 必须全绿再提交。

---

### Task 1: 净化 .env.example / docker-compose.yml / package.json

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `package.json`

- [ ] **Step 1: 重写 `.env.example` 为通用模板**（去掉小米 MiMo 网关，改 OpenAI-compatible 通用示例）：

```bash
# --- LLM（任意 OpenAI-compatible 端点：OpenAI / DeepSeek / 硅基流动 等）---
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=
LLM_MODEL=deepseek-chat
# --- ASSRT（注册 https://assrt.net → 用户中心复制 token；配额 5 次/分钟，程序已自动限速）---
ASSRT_TOKEN=
AUTO_DOWNLOAD_MIN_CONFIDENCE=0.86
SUBTITLE_SCOUT_CACHE_DIR=
# （可选，高级）跳过自动探测、强制注入请求体的 JSON。正常情况下无需配置——会自动探测。
LLM_EXTRA_BODY=
# --- watch 模式（Jellyfin sidecar）---
JELLYFIN_URL=
JELLYFIN_API_KEY=
MEDIA_PATH_MAPPINGS=
MEDIA_ROOTS=
POLL_INTERVAL_SECONDS=15
ITEM_COOLDOWN_MINUTES=30
TREAT_PGS_AS_MISSING=true
ADOPT_LOCAL_SUBTITLES=true
SKIP_CHINESE_ORIGIN=true
SKIP_CACHE_MINUTES=5
ARRIVALS_POLL_MINUTES=15
PREFETCH_INTERVAL_MINUTES=10
JOURNAL_RETAIN_DAYS=90
LOG_RETAIN_DAYS=30
# --- compose 用：宿主机媒体库根目录（含 Movies/ TV/ 等子目录）---
MEDIA_HOST_PATH=/path/to/your/media
# --- dashboard（可选）---
DASHBOARD_PORT=8099
DASHBOARD_TOKEN=
```

- [ ] **Step 2: `docker-compose.yml` 改独立版**（§9：默认路=已有 Jellyfin，只起 scout）。整文件替换为：

```yaml
# 独立版：你已经有一台在跑的 Jellyfin。
# 从零开始的全家桶（Jellyfin + scout 一起拉起）见 docker-compose.bundle.yml。
services:
  subtitle-scout:
    image: ghcr.io/fancydirty/subtitle-scout:latest
    container_name: subtitle-scout
    restart: unless-stopped
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    ports:
      - "${DASHBOARD_PORT:-8099}:${DASHBOARD_PORT:-8099}"
    environment:
      # 指向你现有的 Jellyfin（scout 容器视角可达的地址）
      JELLYFIN_URL: ${JELLYFIN_URL}
      JELLYFIN_API_KEY: ${JELLYFIN_API_KEY}
      LLM_BASE_URL: ${LLM_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_MODEL: ${LLM_MODEL}
      LLM_EXTRA_BODY: ${LLM_EXTRA_BODY:-}
      ASSRT_TOKEN: ${ASSRT_TOKEN}
      # 关键：本容器挂载的媒体路径必须与 Jellyfin 看到的路径一致，
      # 不一致时用 MEDIA_PATH_MAPPINGS 映射（见 README「路径映射」）。
      MEDIA_PATH_MAPPINGS: ${MEDIA_PATH_MAPPINGS:-}
      MEDIA_ROOTS: /media
      SUBTITLE_SCOUT_CACHE_DIR: /cache
      POLL_INTERVAL_SECONDS: ${POLL_INTERVAL_SECONDS:-15}
      TZ: ${TZ:-Asia/Shanghai}
      DASHBOARD_PORT: ${DASHBOARD_PORT:-8099}
      DASHBOARD_TOKEN: ${DASHBOARD_TOKEN:-}
    volumes:
      # 挂成与 Jellyfin 容器内相同的路径（例：Jellyfin 里是 /media/movies）
      - ${MEDIA_HOST_PATH}/Movies:/media/movies
      - ${MEDIA_HOST_PATH}/TV:/media/tv
      - ./cache:/cache
```

- [ ] **Step 3: `package.json` 补开源字段**（`private: true` 保留——发布物是镜像不是 npm 包）。在 `"version"` 之后插入：

```json
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/fancydirty/subtitle-scout.git"
  },
```

并删掉 `worker:deploy` / `worker:dev` 两条 scripts（worker 不随公开仓）。

- [ ] **Step 4: 验证**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -3 && docker compose config -q; echo exit=$?`
Expected: 测试全绿；`docker compose config -q` 因缺 env 可能告警但语法通过（exit=0，需先 `cp .env.example .env` 或容忍 warn）。

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.yml package.json
git commit -m "chore(release): genericize env example, standalone compose, package metadata"
```

---

### Task 2: doctor 检查引擎——远端三项（Jellyfin / ASSRT / LLM）

**Files:**
- Create: `src/cli/doctor.ts`
- Test: `src/cli/doctor.test.ts`

设计：每项检查是注入依赖的纯异步函数，返回统一 `DoctorResult`；不碰真实网络，测试全部用 stub。

- [ ] **Step 1: 写失败测试** `src/cli/doctor.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { checkJellyfin, checkAssrt, checkLlm } from './doctor.js'

describe('doctor 远端三项', () => {
  it('jellyfin 可达 → ok，带会话数', async () => {
    const r = await checkJellyfin({ getSessions: async () => [{}, {}] as never })
    expect(r.ok).toBe(true)
    expect(r.name).toBe('jellyfin')
    expect(r.detail).toContain('2')
  })
  it('jellyfin 401 → 失败并给人话提示', async () => {
    const r = await checkJellyfin({ getSessions: async () => { throw new Error('jellyfin GET /Sessions: HTTP 401') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('API')
  })
  it('assrt quota 正常 → ok 并显示剩余配额', async () => {
    const r = await checkAssrt({ quota: async () => ({ status: 0, user: { quota: 4 } }) })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('4')
  })
  it('assrt token 无效（status 非 0 / 抛错）→ 失败', async () => {
    const r = await checkAssrt({ quota: async () => { throw new Error('ASSRT user/quota returned status 30900') } })
    expect(r.ok).toBe(false)
    expect(r.hint).toContain('assrt.net')
  })
  it('llm 能对话 → ok', async () => {
    const r = await checkLlm(async () => 'ok')
    expect(r.ok).toBe(true)
  })
  it('llm 端点拒绝 → 失败并提示检查 base_url/key/model', async () => {
    const r = await checkLlm(async () => { throw new Error('401 Unauthorized') })
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/LLM_BASE_URL|LLM_API_KEY/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: FAIL（doctor.ts 不存在）

- [ ] **Step 3: 实现** `src/cli/doctor.ts`：

```ts
export interface DoctorResult {
  name: string
  ok: boolean
  /** 环境不满足前提、检查被跳过（不算失败） */
  skip?: boolean
  detail: string
  hint?: string
}

export async function checkJellyfin(jf: { getSessions(): Promise<unknown[]> }): Promise<DoctorResult> {
  try {
    const sessions = await jf.getSessions()
    return { name: 'jellyfin', ok: true, detail: `Jellyfin 可达，当前 ${sessions.length} 个会话` }
  } catch (e) {
    return {
      name: 'jellyfin', ok: false, detail: `连接失败：${String(e)}`,
      hint: '检查 JELLYFIN_URL 是否是 scout 容器视角可达的地址（compose 同网络用服务名），以及 API key 是否有效（Jellyfin 控制台 → API 密钥）。',
    }
  }
}

export async function checkAssrt(assrt: { quota(): Promise<{ status: number; user?: { quota: number } }> }): Promise<DoctorResult> {
  try {
    const q = await assrt.quota()
    if (q.status !== 0) throw new Error(`ASSRT status ${q.status}`)
    return { name: 'assrt', ok: true, detail: `ASSRT token 有效，当前配额余量 ${q.user?.quota ?? '未知'}` }
  } catch (e) {
    return {
      name: 'assrt', ok: false, detail: `配额查询失败：${String(e)}`,
      hint: '检查 ASSRT_TOKEN。注册/获取：https://assrt.net → 登录 → 用户中心复制 API token。',
    }
  }
}

export async function checkLlm(minimalChat: () => Promise<string>): Promise<DoctorResult> {
  try {
    await minimalChat()
    return { name: 'llm', ok: true, detail: 'LLM 端点可用，最小对话成功' }
  } catch (e) {
    return {
      name: 'llm', ok: false, detail: `调用失败：${String(e)}`,
      hint: '检查 LLM_BASE_URL（须为 OpenAI-compatible 的 /v1 端点）、LLM_API_KEY、LLM_MODEL 三者是否匹配同一服务商。',
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat(doctor): remote checks for jellyfin/assrt/llm with plain-language hints"
```

---

### Task 3: doctor 本地两项（媒体目录写探针 + 路径映射一致性）

**Files:**
- Modify: `src/cli/doctor.ts`
- Test: `src/cli/doctor.test.ts`

- [ ] **Step 1: 追加失败测试**（`doctor.test.ts` 末尾新 describe）：

```ts
import { checkMediaRoots, checkPathMappings } from './doctor.js'
// （合并进文件顶部的 import）

describe('doctor 本地两项', () => {
  it('MEDIA_ROOTS 未配置 → skip 而非失败', async () => {
    const r = checkMediaRoots([], () => true)
    expect(r.skip).toBe(true)
    expect(r.ok).toBe(true)
  })
  it('全部根目录可写 → ok', () => {
    const r = checkMediaRoots(['/media/movies', '/media/tv'], () => true)
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('2')
  })
  it('存在只读根目录 → 失败并点名', () => {
    const r = checkMediaRoots(['/media/movies', '/ro'], d => d !== '/ro')
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('/ro')
  })
  it('近期条目映射后的目录都存在且可写 → ok', () => {
    const r = checkPathMappings(
      [{ Path: '/data/movies/A/A.mkv' }, { Path: '/data/tv/B/S01/B.mkv' }],
      [{ from: '/data', to: '/media' }],
      { dirExists: () => true, isWritable: () => true },
    )
    expect(r.ok).toBe(true)
  })
  it('映射后的目录不存在 → 失败，报告 jellyfin 路径与映射结果', () => {
    const r = checkPathMappings(
      [{ Path: '/data/movies/A/A.mkv' }],
      [],
      { dirExists: () => false, isWritable: () => true },
    )
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('/data/movies/A')
    expect(r.hint).toMatch(/MEDIA_PATH_MAPPINGS|挂载/)
  })
  it('jellyfin 库为空 → skip', () => {
    const r = checkPathMappings([], [], { dirExists: () => true, isWritable: () => true })
    expect(r.skip).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: FAIL（两个函数未导出）

- [ ] **Step 3: 实现**（`doctor.ts` 追加；`mapPath`/`PathMapping` 从 `../core/mediaContext.js` 导入，目录取 `node:path` 的 `dirname`）：

```ts
import { dirname } from 'node:path'
import { mapPath, type PathMapping } from '../core/mediaContext.js'

export function checkMediaRoots(roots: string[], isWritable: (dir: string) => boolean): DoctorResult {
  if (roots.length === 0) {
    return {
      name: 'media-roots', ok: true, skip: true,
      detail: 'MEDIA_ROOTS 未配置，跳过（建议配置写入白名单）',
    }
  }
  const bad = roots.filter(r => !isWritable(r))
  if (bad.length > 0) {
    return {
      name: 'media-roots', ok: false, detail: `以下根目录不可写：${bad.join(', ')}`,
      hint: '确认挂载不是只读（ro）、容器用户有写权限。只读网盘/WebDAV 挂载无法写入 sidecar 字幕。',
    }
  }
  return { name: 'media-roots', ok: true, detail: `${roots.length} 个媒体根目录全部可写` }
}

export function checkPathMappings(
  items: Array<{ Path?: string | null }>,
  mappings: PathMapping[],
  deps: { dirExists: (dir: string) => boolean; isWritable: (dir: string) => boolean },
): DoctorResult {
  const paths = items.map(i => i.Path).filter((p): p is string => !!p)
  if (paths.length === 0) {
    return { name: 'path-mapping', ok: true, skip: true, detail: 'Jellyfin 库为空，无法校验路径映射（入库后重跑 doctor）' }
  }
  const dirs = [...new Set(paths.map(p => dirname(mapPath(p, mappings))))]
  const missing = dirs.filter(d => !deps.dirExists(d))
  const readonly = dirs.filter(d => deps.dirExists(d) && !deps.isWritable(d))
  if (missing.length > 0 || readonly.length > 0) {
    const parts: string[] = []
    if (missing.length > 0) parts.push(`本容器内不存在：${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ` 等 ${missing.length} 处` : ''}`)
    if (readonly.length > 0) parts.push(`不可写：${readonly.slice(0, 3).join(', ')}`)
    return {
      name: 'path-mapping', ok: false,
      detail: `Jellyfin 报告的媒体路径映射后有问题——${parts.join('；')}`,
      hint: '这是最常见的接线错误：scout 容器必须以与 Jellyfin 相同的路径挂载媒体目录；无法一致时配置 MEDIA_PATH_MAPPINGS=jellyfin前缀=本地前缀。',
    }
  }
  return { name: 'path-mapping', ok: true, detail: `抽查 ${paths.length} 个条目、${dirs.length} 个目录：映射一致且可写` }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/cli/doctor.test.ts`
Expected: PASS（12 个用例）

- [ ] **Step 5: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts
git commit -m "feat(doctor): media-roots write probe + path-mapping consistency checks"
```

---

### Task 4: doctor CLI 接线 + 报告输出

**Files:**
- Modify: `src/cli/doctor.ts`（追加 runDoctor/formatDoctorReport）
- Modify: `src/cli/index.ts`（dispatch + cmdDoctor）
- Test: `src/cli/doctor.test.ts`

- [ ] **Step 1: 追加失败测试**（格式化与汇总逻辑）：

```ts
import { formatDoctorReport, overallOk } from './doctor.js'

describe('doctor 报告', () => {
  const results = [
    { name: 'jellyfin', ok: true, detail: '可达' },
    { name: 'assrt', ok: false, detail: '失败', hint: '检查 token' },
    { name: 'path-mapping', ok: true, skip: true, detail: '库为空' },
  ]
  it('输出含 ✓ / ✗ / ⊘ 三种标记与 hint', () => {
    const text = formatDoctorReport(results)
    expect(text).toContain('✓ jellyfin')
    expect(text).toContain('✗ assrt')
    expect(text).toContain('⊘ path-mapping')
    expect(text).toContain('检查 token')
  })
  it('有失败 → overallOk false；skip 不算失败', () => {
    expect(overallOk(results)).toBe(false)
    expect(overallOk(results.filter(r => r.name !== 'assrt'))).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli/doctor.test.ts` → FAIL

- [ ] **Step 3: 实现**（`doctor.ts` 追加）：

```ts
export function formatDoctorReport(results: DoctorResult[]): string {
  const lines = results.map(r => {
    const mark = r.skip ? '⊘' : r.ok ? '✓' : '✗'
    const base = `${mark} ${r.name}  ${r.detail}`
    return r.hint && !r.ok ? `${base}\n    ↳ ${r.hint}` : base
  })
  const failed = results.filter(r => !r.ok && !r.skip).length
  lines.push(failed === 0 ? '\n接线检查通过，可以起 watch 了。' : `\n${failed} 项未通过——按上面的提示逐项修复后重跑 doctor。`)
  return lines.join('\n')
}

export function overallOk(results: DoctorResult[]): boolean {
  return results.every(r => r.ok || r.skip)
}
```

- [ ] **Step 4: `src/cli/index.ts` 接线**。在 `cmdReport` 后新增（LLM 最小对话直接用 `makeModel` + `generateText`，绕开完整 runtime 探针以保持轻量；`generateText` 与 `makeModel` 已分别来自 `ai` 与 `../agent/llm.js`，`AssrtClient` 来自 `../adapters/providers/assrt.js`，均按现有 import 风格补）：

```ts
async function cmdDoctor() {
  const { checkJellyfin, checkAssrt, checkLlm, checkMediaRoots, checkPathMappings, formatDoctorReport, overallOk } =
    await import('./doctor.js')
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const jf = new JellyfinClient({ baseUrl: requireEnv('JELLYFIN_URL'), apiKey: requireEnv('JELLYFIN_API_KEY') })
  const assrt = new AssrtClient({ token: requireEnv('ASSRT_TOKEN'), cacheDir: join(cacheRoot, 'assrt') })
  const model = makeModel({
    baseUrl: requireEnv('LLM_BASE_URL'), apiKey: requireEnv('LLM_API_KEY'), model: requireEnv('LLM_MODEL'),
  })
  const mappings = parsePathMappings(process.env.MEDIA_PATH_MAPPINGS)
  const roots = (process.env.MEDIA_ROOTS ?? '').split(',').map(s => s.trim()).filter(Boolean)

  const results = [
    await checkJellyfin(jf),
    await checkAssrt(assrt),
    await checkLlm(async () => (await generateText({ model, prompt: '回复"ok"两个字母即可' })).text),
  ]
  results.push(checkMediaRoots(roots, isDirWritable))
  try {
    const items = await jf.getRecentItems(20)
    results.push(checkPathMappings(items, mappings, { dirExists: d => existsSync(d), isWritable: isDirWritable }))
  } catch {
    results.push({ name: 'path-mapping', ok: true, skip: true, detail: 'Jellyfin 不可达，跳过（先修复上面的 jellyfin 项）' })
  }
  console.log(formatDoctorReport(results))
  if (!overallOk(results)) process.exit(1)
}
```

dispatch 与 usage 各加一行：

```ts
  if (cmd === 'doctor') return cmdDoctor()
```

```ts
  console.error('usage: subtitle-scout run --context <json> [--out <dir>] | run-item --item-id <id> | watch | doctor | report [--since <24h|7d|ISO-date-UTC>]')
```

注意：`makeModel` 的 `LlmConfig` 字段名以 `src/agent/llm.ts:5` 的实际定义为准（若为 `baseURL` 等拼写差异，以现文件为准调整）；`existsSync` 从 `node:fs` 导入（index.ts 若已引入则复用）。

- [ ] **Step 5: 全量验证**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -3`
Expected: 全绿（236 + doctor 新增 14 个）

- [ ] **Step 6: 活体冒烟**（本机有 .env 凭据）：

Run: `set -a; source .env; set +a; JELLYFIN_URL=http://127.0.0.1:1 npx tsx src/cli/index.ts doctor; echo "exit=$?"`
Expected: jellyfin 项 ✗ 且 exit=1；assrt / llm 两项 ✓（真实凭据）。

- [ ] **Step 7: Commit**

```bash
git add src/cli/doctor.ts src/cli/doctor.test.ts src/cli/index.ts
git commit -m "feat(cli): doctor preflight command — 5 checks, plain-language report, exit 1 on failure"
```

---

### Task 5: PlayerServer 接口抽取

**Files:**
- Create: `src/adapters/players/types.ts`
- Modify: `src/adapters/players/jellyfin.ts`（`implements PlayerServer`）
- Modify: `src/cli/index.ts`、`src/daemon/watcher.ts`、`src/daemon/triggers.ts`、`src/core/mediaContext.ts`（类型引用改接口）

行为零变化，不加新测试；现有 236+ 测试就是回归网。

- [ ] **Step 1: 新建 `src/adapters/players/types.ts`**：

```ts
import type { SeasonEpisode } from '../../core/episode.js'
import type { JellyfinItem, JellyfinSession } from './jellyfin.js'

/** 媒体条目/会话的线格式与 Jellyfin API 同形（Emby 天然兼容；其他服务器的适配器负责映射成此形状）。 */
export type MediaItem = JellyfinItem
export type PlaybackSession = JellyfinSession

/**
 * 媒体服务器端口。实现一个新适配器 = 实现这六个方法（语义契约见 docs/adapting.md）。
 * 失败约定：getChineseTitle / getSeasonEpisodes 静默降级（null / []），其余方法抛错。
 */
export interface PlayerServer {
  getSessions(): Promise<PlaybackSession[]>
  getItem(itemId: string): Promise<MediaItem>
  refreshItem(itemId: string): Promise<void>
  getRecentItems(limit: number): Promise<MediaItem[]>
  getChineseTitle(item: MediaItem): Promise<string | null>
  getSeasonEpisodes(item: MediaItem): Promise<SeasonEpisode[]>
}
```

- [ ] **Step 2: `jellyfin.ts` 声明实现**：`export class JellyfinClient implements PlayerServer`（import type PlayerServer from './types.js'）。

- [ ] **Step 3: 调用点类型替换**。四个文件里凡是**类型位置**的 `JellyfinClient` 改为 `PlayerServer`（构造 `new JellyfinClient(...)` 的**值位置**不动）：
  - `src/cli/index.ts:46`（`Assembled.jf`）、`:126`（`verifyChineseSubtitle` 参数）
  - `src/daemon/watcher.ts`、`src/daemon/triggers.ts`、`src/core/mediaContext.ts` 内同理（grep `JellyfinClient` 逐个判断值/类型位置）

- [ ] **Step 4: 验证零回归**

Run: `npx tsc --noEmit && npx vitest run 2>&1 | tail -3`
Expected: 全绿，测试数不变

- [ ] **Step 5: Commit**

```bash
git add src/adapters/players/types.ts src/adapters/players/jellyfin.ts src/cli/index.ts src/daemon/watcher.ts src/daemon/triggers.ts src/core/mediaContext.ts
git commit -m "refactor(players): extract PlayerServer port; JellyfinClient implements it"
```

---

### Task 6: docs/adapting.md（适配指南 + coding agent 提示词）

**Files:**
- Create: `docs/adapting.md`

- [ ] **Step 1: 写指南**，结构固定为四节（用真实接口签名，勿抄此处示意）：

1. **架构一分钟**：管线核心不认识任何媒体服务器；全部耦合走 `src/adapters/players/types.ts` 的 `PlayerServer` 六方法。
2. **逐方法契约表**：方法 × 语义 × 触发时机 × 失败约定（`getSessions` 驱动播放触发节拍；`getRecentItems` 驱动新入库节拍；`refreshItem` 必须触发全量刷新使外挂字幕可见——Jellyfin 的教训是裸 refresh 不重扫外部字幕；`getChineseTitle`/`getSeasonEpisodes` 失败静默降级）。
3. **数据形状**：`MediaItem`/`PlaybackSession` 是 zod passthrough 校验的 Jellyfin 形状，列出必填字段（Id/Name/Type/Path/MediaStreams…）及其消费方。
4. **给你的 coding agent 的现成提示词**：一段完整可粘贴的 prompt，形如：

```text
请为 <你的媒体服务器，例如 Emby> 实现本仓库的 PlayerServer 接口：
- 契约定义：src/adapters/players/types.ts（六个方法，语义与失败约定见 docs/adapting.md 第 2 节）
- 参考实现：src/adapters/players/jellyfin.ts（Emby 与 Jellyfin API 同源，认证头同为 X-Emby-Token，大概率只需小改）
- 数据形状必须通过 src/adapters/players/jellyfin.ts 中的 zod schema 校验（passthrough，多余字段无害）
- 为你的实现写与 jellyfin.test.ts 同风格的 vitest 测试（fixtures 录制真实响应）
- 完成判据：npx tsc --noEmit && npx vitest run 全绿，然后在真实服务器上用 doctor 命令 + run-item 单发验证
```

- [ ] **Step 2: Commit**

```bash
git add docs/adapting.md
git commit -m "docs: adapter guide with PlayerServer contract and ready-to-paste agent prompt"
```

---

### Task 7: compose 全家桶

**Files:**
- Create: `docker-compose.bundle.yml`

- [ ] **Step 1: 写 bundle**（= 作者生产双容器拓扑的通用化；scout 侧与 Task 1 独立版一致，仅 JELLYFIN_URL 指向同 compose 的 jellyfin 服务）：

```yaml
# 全家桶：从零开始，Jellyfin + subtitle-scout 一起拉起。
# 已有 Jellyfin 的用户请用 docker-compose.yml（独立版）。
# 用法：cp .env.example .env 填好三把钥匙与 MEDIA_HOST_PATH，然后
#   docker compose -f docker-compose.bundle.yml up -d
services:
  jellyfin:
    image: ghcr.io/jellyfin/jellyfin:latest
    container_name: scout-jellyfin
    restart: unless-stopped
    ports:
      - "8096:8096"
    volumes:
      - ./jellyfin-config:/config
      - ${MEDIA_HOST_PATH}/Movies:/media/movies
      - ${MEDIA_HOST_PATH}/TV:/media/tv
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }

  subtitle-scout:
    image: ghcr.io/fancydirty/subtitle-scout:latest
    container_name: subtitle-scout
    restart: unless-stopped
    depends_on: [jellyfin]
    ports:
      - "${DASHBOARD_PORT:-8099}:${DASHBOARD_PORT:-8099}"
    environment:
      JELLYFIN_URL: http://jellyfin:8096
      JELLYFIN_API_KEY: ${JELLYFIN_API_KEY}
      LLM_BASE_URL: ${LLM_BASE_URL}
      LLM_API_KEY: ${LLM_API_KEY}
      LLM_MODEL: ${LLM_MODEL}
      LLM_EXTRA_BODY: ${LLM_EXTRA_BODY:-}
      ASSRT_TOKEN: ${ASSRT_TOKEN}
      MEDIA_ROOTS: /media
      SUBTITLE_SCOUT_CACHE_DIR: /cache
      POLL_INTERVAL_SECONDS: ${POLL_INTERVAL_SECONDS:-15}
      TZ: ${TZ:-Asia/Shanghai}
      DASHBOARD_PORT: ${DASHBOARD_PORT:-8099}
      DASHBOARD_TOKEN: ${DASHBOARD_TOKEN:-}
    volumes:
      # 与 jellyfin 服务完全相同的挂载 → 路径天然一致，无需 MEDIA_PATH_MAPPINGS
      - ${MEDIA_HOST_PATH}/Movies:/media/movies
      - ${MEDIA_HOST_PATH}/TV:/media/tv
      - ./cache:/cache
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }
```

- [ ] **Step 2: 语法验证**

Run: `docker compose -f docker-compose.bundle.yml config -q; echo exit=$?`
Expected: exit=0（env 未填的 warn 可忽略）

- [ ] **Step 3: Commit**

```bash
git add docker-compose.bundle.yml
git commit -m "feat(compose): full-bundle topology (jellyfin + scout), generalized from production"
```

---

### Task 8: README 重写

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 整体重写**。面向"不知道 Cloudflare 是什么"的 Jellyfin 用户，删除全部 milestone 内部叙事（"Milestone 3 已完成…软路由…NAS"等私有语境）。骨架（各节写满，不留 TODO）：

```markdown
# subtitle-scout

当你在 Jellyfin 里点开一部没有中文字幕的片子，subtitle-scout 自动找到、验证并放好
最合适的中文字幕。它不是又一个字幕下载器——它是一层带判断力的匹配智能：宁可不下，也不下错。

（三行卖点：LLM 排序判断 + 整季包升格 + 宁缺毋滥的 gate；dashboard 截图占位）

## 两条上手路
### A. 我已经有 Jellyfin（推荐）→ docker-compose.yml
### B. 我从零开始 → docker-compose.bundle.yml
（各给三步：cp .env.example .env → 填三把钥匙 → up -d）

## 三把钥匙怎么拿
### ASSRT token（注册 assrt.net → 用户中心 → 复制 token；配额 5 次/分钟，程序已自动限速到 4/min；
###   预期管理：ASSRT 对欧美剧集覆盖有限，找不到≠故障，dashboard 会用人话告诉你）
### LLM key（任意 OpenAI-compatible：OpenAI/DeepSeek/硅基流动…；模型能力影响匹配质量，推荐主流 chat 模型）
### Jellyfin API key（控制台 → 高级 → API 密钥 → 新建）

## 起完先体检：doctor
docker compose exec subtitle-scout npx tsx src/cli/index.ts doctor
（五项检查逐条解释；路径映射是最常见坑，专门一小节讲 scout 挂载必须与 Jellyfin 同路径，
 不一致用 MEDIA_PATH_MAPPINGS）

## 监控页
http://<主机>:8099 ；可选 DASHBOARD_TOKEN 只读保护

## 它是怎么工作的（4 步白话 + 决策审计/台账一句话）

## 环境变量参考（保留现 README 的表格，补 MEDIA_HOST_PATH/DASHBOARD_*）

## 适配 Emby / 其他服务器
（Emby 与 Jellyfin API 同源、预计改动很小、欢迎 PR；指路 docs/adapting.md，
 里面有可直接投喂你自己 coding agent 的提示词）

## FAQ / 排障
（路径映射对不上的症状与解法；只读挂载；配额烧完；国产片为什么被跳过）

## License
MIT
```

- [ ] **Step 2: 自查**：README 中不出现 milestone 编号、软路由、NAS 型号、内网 IP、worker、`fancydirty.workers.dev`。

Run: `grep -inE 'milestone|软路由|192\.168|workers\.dev|nvme' README.md; echo "exit=$?"`
Expected: exit=1（零命中）

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for public onboarding — two paths, three keys, doctor first"
```

---

### Task 9: LICENSE + GitHub Actions

**Files:**
- Create: `LICENSE`
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: LICENSE**：标准 MIT 全文，版权行 `Copyright (c) 2026 fancydirty`。

- [ ] **Step 2: `.github/workflows/test.yml`**：

```yaml
name: test
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npx vitest run
```

- [ ] **Step 3: `.github/workflows/release.yml`**：

```yaml
name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  packages: write
jobs:
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=semver,pattern={{version}}
            type=raw,value=latest
      - uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 4: 本地先验证 Dockerfile 还能建**（web 多阶段未动，应直过）：

Run: `docker build -t scout-smoke . 2>&1 | tail -3`
Expected: 成功出 image

- [ ] **Step 5: Commit**

```bash
git add LICENSE .github/
git commit -m "chore(release): MIT license, CI test workflow, ghcr multi-arch release workflow"
```

---

### Task 10: 公开仓创建与首发

**Files:**（本 task 在仓外目录操作，当前仓只改 `.gitignore`）
- Modify: `.gitignore`

- [ ] **Step 1: `.gitignore` 追加个人文件段**（进入快照，为 §5 流转后个人文件保持 untracked 做准备）：

```
# 作者私有（不随公开仓；本地保留）
deploy/
worker/
docs/superpowers/
docs/cloudflare-worker.md
docs/product-shape.md
jellyfin-config/
cache/
```

提交：`git add .gitignore && git commit -m "chore(release): ignore private-operational files in public repo"`

- [ ] **Step 2: 导出净化快照**：

```bash
EXPORT=~/projects/subtitle-scout
mkdir -p "$EXPORT"
git archive main | tar -x -C "$EXPORT"
cd "$EXPORT"
rm -rf worker deploy docs/superpowers docs/cloudflare-worker.md docs/product-shape.md
```

- [ ] **Step 3: 净化 grep 验收**（spec §2 清单；`fancydirty` 为公开身份允许出现）：

```bash
grep -rinE '192\.168\.|dirtyfancy|gmail|mnt/nvme|media-router-tunnel|workers\.dev|xiaomimimo' . && echo "LEAK FOUND" || echo "CLEAN"
```

Expected: `CLEAN`。有命中则回当前仓修源头（补 Task 1/8 遗漏），重新走 Step 2。

- [ ] **Step 4: init + 首发提交（noreply 身份）+ 建仓 + tag**：

```bash
cd "$EXPORT"
git init -b main
git config user.name "fancydirty"
git config user.email "fancydirty@users.noreply.github.com"
git add -A
git commit -m "subtitle-scout v0.1.0 — LLM-judged Chinese subtitle scout for Jellyfin"
gh repo create fancydirty/subtitle-scout --public --source=. --push
git tag v0.1.0 && git push origin v0.1.0
```

- [ ] **Step 5: 验证 CI 与镜像**：

```bash
gh run watch --repo fancydirty/subtitle-scout --exit-status   # test + release 两条都绿
docker pull ghcr.io/fancydirty/subtitle-scout:0.1.0
```

Expected: workflows 绿；镜像可拉取（若 package 默认 private，`gh api` 或网页把 package 可见性设 public 后重拉）。

---

### Task 11: 双路真实验收（orbstack）

无代码改动；产出验收记录（贴到发布 PR/会话即可）。

- [ ] **Step 1: 全家桶路**。全新目录模拟陌生人：

```bash
mkdir -p ~/scout-accept/media/Movies && cd ~/scout-accept
curl -LO https://raw.githubusercontent.com/fancydirty/subtitle-scout/main/docker-compose.bundle.yml
curl -L https://raw.githubusercontent.com/fancydirty/subtitle-scout/main/.env.example -o .env
# 编辑 .env：填真实 LLM/ASSRT key，MEDIA_HOST_PATH=~/scout-accept/media
docker compose -f docker-compose.bundle.yml up -d
# Jellyfin 首次向导（http://localhost:8096）建库指向 /media/movies，生成 API key 填回 .env，重启 scout
docker compose -f docker-compose.bundle.yml exec subtitle-scout npx tsx src/cli/index.ts doctor
```

Expected: doctor 五项 ✓/⊘（媒体目录空 → path-mapping 允许 skip）；dashboard http://localhost:8099 出首屏。

- [ ] **Step 2: 独立版路**。同目录改用 `docker-compose.yml`，`JELLYFIN_URL` 指 Step 1 已起的 Jellyfin（`http://host.docker.internal:8096`），doctor 同验收。
- [ ] **Step 3: 陌生人通读**：只按 README 操作是否有断点；发现的每个断点回 README 修复并 push。

---

### Task 12: 本地开发流转（§5）

- [ ] **Step 1: 确认新开发主仓**。Task 10 的 `~/projects/subtitle-scout` 在 `gh repo create --source=. --push` 后已带 origin，直接转正为开发主仓：

```bash
git -C ~/projects/subtitle-scout remote -v   # 应显示 github.com/fancydirty/subtitle-scout
```

- [ ] **Step 2: 迁个人文件（untracked，.gitignore 已覆盖）**：

```bash
cp -R ~/projects/subtitle-plugin/deploy ~/projects/subtitle-scout/
cp -R ~/projects/subtitle-plugin/worker ~/projects/subtitle-scout/
cp -R ~/projects/subtitle-plugin/docs/superpowers ~/projects/subtitle-scout/docs/
cp ~/projects/subtitle-plugin/.env ~/projects/subtitle-scout/
git -C ~/projects/subtitle-scout status --short   # 应为空（全部被 ignore）
```

- [ ] **Step 3: 部署链路验证**：在新主仓跑 `bash deploy/deploy.sh`，软路由容器重建、dashboard 正常 → 流转完成。
- [ ] **Step 4: 旧仓 `~/projects/subtitle-plugin` 标记存档**（目录留置，README 顶部或不动，仅记忆文件更新指向新主仓）。

---

## Self-Review 记录

- spec 覆盖：§1→T10、§2→T1/T10、§3→T8、§4→T9、§5→T12、§6→T10.3/T11、§7→T2-4、§8→T5/T6、§9→T1/T7 ✓
- 占位符：无 TBD/TODO；T8 README 骨架为内容大纲而非占位（各节要求写满）✓
- 类型一致：DoctorResult 贯穿 T2-4；PlayerServer 六方法与 jellyfin.ts 实际签名一致（getItem 而非 getItemDetail）✓
