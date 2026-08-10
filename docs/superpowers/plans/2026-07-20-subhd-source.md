# subhd 字幕源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 subtitle-scout 加 subhd 字幕源——HTML 搜索 + 两步 token 下载，套 `FetchAdapter` 契约，反爬最小化。

**Architecture:** 新 `SubhdClient`（search 解析 subhd 搜索页 HTML → 候选；resolveDownload 走 `POST /api/sub/prepare-download` 拿 5 分钟 cookie + `/down/<id>` url）+ `makeSubhdAdapter` 映射层（照抄 zimukuAdapter）+ `buildAdapters` 的 `SUBHD_ENABLED` 门。无验证码/无云锁/无 session store，比 zimuku 简单一半。

**Tech Stack:** TypeScript · undici fetch · vitest · 现有 `htmlAttrs.ts`（HTML 解析）/`jitter.ts`（限速）· OrbStack（真机冒烟）

依据 spec：`docs/design/2026-07-20-subhd-source-design.md`

**🔴 铁律（zimuku 血泪）**：subhd 的 HTML 解析器**必须对真机抓回的真响应编写**（Task 2 在 OrbStack 抓夹具），
禁止凭 spec 描述臆想 CSS/正则。末尾**强制真机冒烟**（Task 9），不许只夹具绿。

**✅ 主控已亲验真实下载流程（2026-07-20 curl 实测 subhd.me，非侦察转述）——实现按此，勿自行揣测：**
1. 搜索 `GET /search/<q>` → HTML，含 40 条 `/a/<base62>` 详情链接（每条出现两次：海报+标题，去重）。
2. **sid == `/a/<id>` 的 base62 id 本身**（实测 `/a/aCZvOt` 的 sid 就是 `aCZvOt`），无需另找数字 id。
3. `POST /api/sub/prepare-download`，JSON `{"sid":"<id>"}`，**必须带 `Referer: <base>/a/<id>` 头**（+ UA + `X-Requested-With: XMLHttpRequest` + `Origin: <base>`）→ 200 `{"success":true,"url":"/down/<id>"}` + `Set-Cookie: tk_…=…; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax`。**不需要 session cookie**（实测空 cookie jar 也 200，只要 sid 有效 + Referer）。
4. **立即**（5 分钟内，因 tk_ Max-Age=300）`GET /down/<id>` 带 `Cookie: tk_…` → 字幕文件。**无 tk_ 或超时 → 403 HTML 页"下载页面已失效"**（实测：隔 >5min 再打就 403，非流程错）。代码里 resolve→download 即时发生，天然满足。
5. 详情页 GET 偶发 `HTTP 000`（Cloudflare 瞬时/节流）——**带 `--retry`/退避重试即恢复**（实测重试即 200）。真实 fetch 层要有一次重试。

**测试命令：** root `npm test`（vitest run，`npm test -- <path>` 单文件）；类型 `npm run check`（tsc）。

---

## Task 1: PROVIDERS 枚举加 'subhd'

**Files:**
- Modify: `src/core/schemas.ts:85`（`PROVIDERS` 元组）
- Test: `src/core/schemas.test.ts`（无则就近新建，或并入现有 schemas 测试）

- [ ] **Step 1: 写失败测试**

```ts
import { PROVIDERS, SubtitleCandidateSchema } from './schemas.js'
it("PROVIDERS 含 'subhd'，且 provider:'subhd' 的候选能通过校验", () => {
  expect(PROVIDERS).toContain('subhd')
  const parsed = SubtitleCandidateSchema.safeParse({ provider: 'subhd', providerId: 'aZ9' })
  expect(parsed.success).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/core/schemas.test.ts`
Expected: FAIL（'subhd' 不在 PROVIDERS）

- [ ] **Step 3: 实现**

`src/core/schemas.ts` L85：`export const PROVIDERS = ['assrt', 'opensubtitles', 'zimuku', 'subhd', 'local'] as const`
（在 'zimuku' 后插 'subhd'；'local' 保持末位，它是本地候选哨兵）。

- [ ] **Step 4: 跑测试确认通过 + 全 root 类型**

Run: `npm test -- src/core/schemas.test.ts && npm run check`
Expected: PASS + tsc 净（枚举扩值可能触发别处 exhaustive switch——若 tsc 报某 switch 缺 'subhd' 分支，
按该处既有 provider 的处理补上，多为"透传/无特殊"分支）。

- [ ] **Step 5: 提交**

```bash
git add src/core/schemas.ts src/core/schemas.test.ts
git commit -m "feat(schemas): PROVIDERS 加 subhd"
```

---

## Task 2: 🔴 在 OrbStack 抓真机 subhd 夹具（解析器的唯一事实源）

**Files:**
- Create: `scripts/capture-subhd-fixtures.ts`（一次性抓取脚本）
- Create: `src/adapters/providers/__fixtures__/subhd/`（真响应落盘：`search-<title>.html`、`detail-<id>.html`、`prepare-download-<id>.json`、`prepare-download-<id>.headers.txt`（含 Set-Cookie）、下载产物 `down-<id>.<ext>`）

- [ ] **Step 1: 确认 OrbStack 容器能到达 subhd**

在 OrbStack 里起一个带 node/curl 的容器（用户环境已装 OrbStack+docker）。**先验可达性**：
```bash
docker run --rm curlimages/curl -sS -o /dev/null -w "%{http_code} %{url_effective}\n" https://subhd.me/
```
Expected: `200 https://subhd.me/`。若容器 DNS 解不到/超时（容器网络未继承宿主代理），改：①`--network host`（OrbStack 支持，让容器走宿主网络栈/代理），或 ②在宿主直接抓（recon 实证宿主可达）。**记录哪种方式可达**——后续冒烟同法。若两法皆不通 → 报 BLOCKED（可达性是硬前提，改上软路由需与人类确认）。

- [ ] **Step 2: 写抓取脚本**

`scripts/capture-subhd-fixtures.ts`：对一个真实剧名（用库里真有的，如 `进击的巨人` 或 `The Rig`）：
1. `GET https://subhd.me/search/<urlencoded>` → 存 `search-<title>.html`。
2. 从搜索页挑一条 `/a/<id>` → `GET` 存 `detail-<id>.html`。
3. `POST https://subhd.me/api/sub/prepare-download`，body `{"sid":"<id>"}`，`Content-Type: application/json` → 存响应体
   `prepare-download-<id>.json` + 全部响应头（尤其 `Set-Cookie: tk_…`）到 `prepare-download-<id>.headers.txt`。
4. 带 tk_ cookie `GET /down/<id>` → 存 `down-<id>.<ext>`（**据此定 fileList：单文件还是 zip**）。
全程带浏览器 UA 头（`User-Agent: Mozilla/5.0 …`）。

- [ ] **Step 3: 跑脚本抓夹具（在 Step 1 确认可达的方式下）**

Run（示例，宿主可达时）: `npx tsx scripts/capture-subhd-fixtures.ts`
Expected: `__fixtures__/subhd/` 下生成非空文件。**人工核验**：`search-*.html` 含 `/a/` 链接与语言徽章；
`prepare-download-*.json` 形如 `{"success":true,"url":"/down/…"}`；`headers.txt` 含 `tk_`；`down-*` 是真字幕/压缩包。

- [ ] **Step 4: 记录夹具事实**

在 `__fixtures__/subhd/STRUCTURE.md` 写下你从真夹具里**实际看到**的结构：搜索条目的 HTML 形状（承载 id 的
元素/属性、语言徽章 class、发布名位置、格式标）；prepare-download 的确切 JSON 字段；下载产物是单文件还是 zip
（含内含文件名）。**后续 Task 3/5 的解析器对着这份真实结构写，不许另行臆想。**

- [ ] **Step 5: 提交**

```bash
git add scripts/capture-subhd-fixtures.ts src/adapters/providers/__fixtures__/subhd/
git commit -m "chore(subhd): 抓真机 subhd 夹具（解析器事实源）+ 结构记录"
```

---

## Task 3: SubhdClient.parseSearchResults — 对真夹具解析搜索页

**Files:**
- Create: `src/adapters/providers/subhd.ts`（先只加 `SubhdSearchResult` 类型 + 纯函数 `parseSearchResults(html)`）
- Test: `src/adapters/providers/subhd.test.ts`

- [ ] **Step 1: 写失败测试（对真夹具断言）**

读 `__fixtures__/subhd/search-<title>.html` 与 `STRUCTURE.md`，看清里面**真实存在**的条目，把它们写进断言：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseSearchResults } from './subhd.js'

const html = readFileSync(join(__dirname, '__fixtures__/subhd/search-<title>.html'), 'utf8')
it('解析真机搜索页 → 候选（id/videoName/language/subtype/releaseSite）', () => {
  const results = parseSearchResults(html)
  expect(results.length).toBeGreaterThan(0)
  // 下面的期望值来自你在 STRUCTURE.md 记录的真实条目——照抄真值，不要编：
  expect(results[0]).toMatchObject({ id: /* 真实 /a/<id> 的 id */ expect.any(String) })
  expect(results.every(r => r.id.length > 0)).toBe(true)
  // 至少断言：id 非空、language 命中简/繁徽章之一、videoName 非空（按真夹具收紧到具体值）
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/adapters/providers/subhd.test.ts`
Expected: FAIL（`parseSearchResults` 未定义）

- [ ] **Step 3: 实现 parseSearchResults**

`src/adapters/providers/subhd.ts`：
```ts
export interface SubhdSearchResult {
  id: string                    // /a/<base62> 的 id 段
  videoName: string | null      // 发布名
  language: string | null       // 简体/繁体/繁中 徽章文本
  subtype: string | null        // SRT/ASS
  releaseSite: string | null    // 组名 / 官方字幕
}
export function parseSearchResults(html: string): SubhdSearchResult[] { /* 见下 */ }
```
用 `htmlAttrs.ts` 的既有提取工具（grep `src/adapters/providers/htmlAttrs.ts` 看它导出什么——zimuku.ts 已在用）
**对着 `STRUCTURE.md` 记录的真实 DOM 形状**抽取：从 `/a/<id>` 链接取 id，从语言徽章 class/文本取 language，
发布名、格式、组名各按真结构取。畸形/缺字段的条目 fail-soft 跳过（不整体炸，同 assrt/zimuku 的 filterMalformed）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/adapters/providers/subhd.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/adapters/providers/subhd.ts src/adapters/providers/subhd.test.ts
git commit -m "feat(subhd): parseSearchResults 对真机夹具解析搜索页"
```

---

## Task 4: SubhdClient.resolveDownload — 两步 token 解析

**Files:**
- Modify: `src/adapters/providers/subhd.ts`（加 `parsePrepareDownload` 纯函数 + cookie 提取）
- Test: `src/adapters/providers/subhd.test.ts`

- [ ] **Step 1: 写失败测试（对真夹具 + 合成响应）**

```ts
import { parsePrepareDownload, extractTkCookie } from './subhd.js'

it('parsePrepareDownload：{success:true,url:"/down/x"} → "/down/x"；success:false → 抛', () => {
  expect(parsePrepareDownload(JSON.stringify({ success: true, url: '/down/aZ9' }))).toBe('/down/aZ9')
  expect(() => parsePrepareDownload(JSON.stringify({ success: false }))).toThrow()
})
it('extractTkCookie：从 Set-Cookie 头数组提取 tk_ 值', () => {
  expect(extractTkCookie(['tk_abc=xyz123; Max-Age=300; HttpOnly', 'other=1'])).toBe('tk_abc=xyz123')
  expect(extractTkCookie([])).toBeNull()
})
```
（用真夹具 `prepare-download-<id>.json` / `headers.txt` 追加一条 sanity 断言，确保真值也过。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/adapters/providers/subhd.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export function parsePrepareDownload(body: string): string {
  const d = JSON.parse(body) as { success?: boolean; url?: string }
  if (!d.success || typeof d.url !== 'string' || !d.url) {
    throw new Error(`subhd prepare-download failed: ${body.slice(0, 200)}`)
  }
  return d.url
}
export function extractTkCookie(setCookies: string[]): string | null {
  for (const c of setCookies) {
    const m = /^(tk_[^=]+=[^;]+)/.exec(c.trim())
    if (m) return m[1]
  }
  return null
}
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `npm test -- src/adapters/providers/subhd.test.ts`
Expected: PASS

```bash
git add src/adapters/providers/subhd.ts src/adapters/providers/subhd.test.ts
git commit -m "feat(subhd): prepare-download JSON 解析 + tk_ cookie 提取"
```

---

## Task 5: SubhdClient 类 — 真 HTTP + 限速 + 镜像兜底

**Files:**
- Modify: `src/adapters/providers/subhd.ts`（`SubhdClient` 类、`SUBHD_HEADERS`）
- Test: `src/adapters/providers/subhd.test.ts`（注入 `fetchImpl` 假实现，不碰真网络）

- [ ] **Step 1: 写失败测试**

```ts
import { SubhdClient, SUBHD_HEADERS } from './subhd.js'

function fakeFetch(routes: Record<string, { body: string; setCookie?: string[] }>): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`
    const r = routes[key]; if (!r) return new Response('nope', { status: 404 })
    const h = new Headers({ 'content-type': 'application/json' })
    for (const c of r.setCookie ?? []) h.append('set-cookie', c)
    return new Response(r.body, { status: 200, headers: h })
  }) as unknown as typeof fetch
}

it('search 打 /search/<q>，resolveDownload 串 prepare-download→拿 url+cookie', async () => {
  const searchHtml = readFileSync(join(__dirname, '__fixtures__/subhd/search-<title>.html'), 'utf8')
  const client = new SubhdClient({
    baseUrl: 'https://subhd.me', fetchImpl: fakeFetch({
      'GET /search/x': { body: searchHtml },
      'POST /api/sub/prepare-download': { body: JSON.stringify({ success: true, url: '/down/aZ9' }), setCookie: ['tk_a=b; Max-Age=300'] },
    }),
  })
  expect((await client.search('x')).length).toBeGreaterThan(0)
  const dl = await client.resolveDownload('aZ9')
  expect(dl.url).toBe('https://subhd.me/down/aZ9')
  expect(dl.cookie).toBe('tk_a=b')
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm test -- src/adapters/providers/subhd.test.ts` → FAIL（SubhdClient 未定义）

- [ ] **Step 3: 实现 SubhdClient**

```ts
import { RequestLimiter } from './jitter.js'   // grep jitter.ts 确认导出名/构造签名，照 zimuku.ts 的用法

export const SUBHD_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}
interface SubhdClientOpts { baseUrl?: string; mirrors?: string[]; fetchImpl?: typeof fetch; onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string }) => void }

export class SubhdClient {
  private base: string
  private mirrors: string[]
  private fetchImpl: typeof fetch
  private limiter = new RequestLimiter(/* 同 zimuku 的节流参数 */)
  constructor(private opts: SubhdClientOpts = {}) {
    this.base = (opts.baseUrl ?? 'https://subhd.me').replace(/\/+$/, '')
    this.mirrors = opts.mirrors ?? ['https://subhd.one', 'https://subhd.top', 'https://subhd.cc']
    this.fetchImpl = opts.fetchImpl ?? fetch
  }
  async search(query: string): Promise<SubhdSearchResult[]> {
    const html = await this.getWithMirrors(`/search/${encodeURIComponent(query)}`)
    return parseSearchResults(html)
  }
  async resolveDownload(id: string): Promise<{ url: string; cookie: string | null }> {
    const { body, setCookies } = await this.postJson('/api/sub/prepare-download', { sid: id })
    const rel = parsePrepareDownload(body)        // '/down/<id>'
    return { url: `${this.base}${rel}`, cookie: extractTkCookie(setCookies) }
  }
  // getWithMirrors：主 base 失败(网络/5xx)→依次试 mirrors；每发一次走 limiter + onApiCall；全败抛。
  // postJson：POST + JSON body + SUBHD_HEADERS，返回 { body, setCookies:string[] }（从响应头收集 set-cookie）。
  // 具体实现照 zimuku.ts 的 fetchPath/requestHtml 骨架裁剪（去掉云锁挑战分支）。
}
```
实现 `getWithMirrors`/`postJson` 私有方法（HTTP + limiter + onApiCall + 镜像循环）；参照 `zimuku.ts` 的
`fetchPath`（L182）但**删除云锁 challenge 那一整套**（subhd 无挑战）。

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `npm test -- src/adapters/providers/subhd.test.ts && npm run check`
Expected: PASS + tsc 净

```bash
git add src/adapters/providers/subhd.ts src/adapters/providers/subhd.test.ts
git commit -m "feat(subhd): SubhdClient——真 HTTP + 限速 + 镜像兜底"
```

---

## Task 6: subhdAdapter 映射层

**Files:**
- Create: `src/cli/adapters/subhdAdapter.ts`
- Test: `src/cli/adapters/subhdAdapter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { makeSubhdAdapter } from './subhdAdapter.js'
it('search 映射→SubtitleCandidate（provider=subhd）；resolve→{url,headers.Cookie}', async () => {
  const client = {
    search: async () => [{ id: 'aZ9', videoName: 'X.S01E01', language: '简体', subtype: 'ASS', releaseSite: '官方字幕' }],
    resolveDownload: async () => ({ url: 'https://subhd.me/down/aZ9', cookie: 'tk_a=b' }),
  }
  const a = makeSubhdAdapter(client)
  expect(a.name).toBe('subhd')
  const cands = await a.search({ queries: ['X'] }, () => {})
  expect(cands[0]).toMatchObject({ provider: 'subhd', providerId: 'aZ9', videoName: 'X.S01E01', language: '简体' })
  const r = await a.resolve({ provider: 'subhd', providerId: 'aZ9', fileIndex: null }, () => {})
  expect(r).toEqual({ url: 'https://subhd.me/down/aZ9', headers: expect.objectContaining({ Cookie: 'tk_a=b' }) })
})
it('queries 为空 → 空候选', async () => {
  const a = makeSubhdAdapter({ search: async () => [], resolveDownload: async () => ({ url: '', cookie: null }) })
  expect(await a.search({ queries: [] }, () => {})).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm test -- src/cli/adapters/subhdAdapter.test.ts` → FAIL

- [ ] **Step 3: 实现（照抄 zimukuAdapter.ts）**

```ts
import { SUBHD_HEADERS, type SubhdClient, type SubhdSearchResult } from '../../adapters/providers/subhd.js'
import type { SubtitleCandidate } from '../../core/schemas.js'
import type { FetchAdapter } from '../fetchLib.js'

function toCandidate(r: SubhdSearchResult): SubtitleCandidate {
  return {
    provider: 'subhd', providerId: r.id, videoName: r.videoName, nativeName: r.videoName,
    language: r.language, subtype: r.subtype, releaseSite: r.releaseSite ?? 'subhd', uploadDate: null, fileList: [],
  }
}
export function makeSubhdAdapter(client: Pick<SubhdClient, 'search' | 'resolveDownload'>): FetchAdapter {
  return {
    name: 'subhd',
    enabled: () => true,
    search: async (args) => {
      const q = args.queries[0]
      if (!q) return []
      return (await client.search(q)).map(toCandidate)
    },
    resolve: async (ref) => {
      const { url, cookie } = await client.resolveDownload(ref.providerId)
      return { url, headers: { ...SUBHD_HEADERS, ...(cookie ? { Cookie: cookie } : {}) } }
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 提交**

Run: `npm test -- src/cli/adapters/subhdAdapter.test.ts`
Expected: PASS

```bash
git add src/cli/adapters/subhdAdapter.ts src/cli/adapters/subhdAdapter.test.ts
git commit -m "feat(subhd): subhdAdapter 映射层（照 zimukuAdapter）"
```

---

## Task 7: buildAdapters 加 SUBHD_ENABLED 门

**Files:**
- Modify: `src/cli/buildAdapters.ts`
- Test: `src/cli/buildAdapters.test.ts`（无则新建；参照现有对 ZIMUKU_ENABLED 的测法，若无则用 env stub）

- [ ] **Step 1: 写失败测试**

```ts
import { buildAdapters } from './buildAdapters.js'
it('SUBHD_ENABLED=true → adapters 含 subhd；未设 → 不含', async () => {
  const prev = process.env.SUBHD_ENABLED
  try {
    process.env.SUBHD_ENABLED = 'true'
    expect((await buildAdapters()).some(a => a.name === 'subhd')).toBe(true)
    delete process.env.SUBHD_ENABLED
    expect((await buildAdapters()).some(a => a.name === 'subhd')).toBe(false)
  } finally { if (prev === undefined) delete process.env.SUBHD_ENABLED; else process.env.SUBHD_ENABLED = prev }
})
```

- [ ] **Step 2: 跑测试确认失败** — Run: `npm test -- src/cli/buildAdapters.test.ts` → FAIL

- [ ] **Step 3: 实现**

`buildAdapters.ts`：import `SubhdClient` + `makeSubhdAdapter`；在 zimuku 块后加：
```ts
  if (process.env.SUBHD_ENABLED === 'true') {
    const client = new SubhdClient({
      baseUrl: process.env.SUBHD_BASE_URL,   // 缺省内部走 subhd.me
      onApiCall: r => emit({ event: 'api_call', provider: 'subhd', ...r }),
    })
    adapters.push(makeSubhdAdapter(client))
  }
```

- [ ] **Step 4: 跑测试确认通过 + 全 root 套件 + 提交**

Run: `npm test -- src/cli/buildAdapters.test.ts && npm run check`
Expected: PASS + tsc 净

```bash
git add src/cli/buildAdapters.ts src/cli/buildAdapters.test.ts
git commit -m "feat(subhd): buildAdapters 加 SUBHD_ENABLED 门"
```

---

## Task 8: fileList / 下载产物形态（据 Task 2 真机产物定夺）

**Files:** 视 Task 2 `down-<id>` 真实形态而定。

- [ ] **Step 1: 判定** —— 看 Task 2 抓回的 `down-<id>.<ext>`：
  - **单字幕文件**（.srt/.ass 直出）→ 无需额外工作：`toCandidate` 的 `fileList:[]` + 下载层按 contentType 兜底
    文件名（同 zimuku 现状），**本 Task 空过，直接标完成**。
  - **zip 压缩包** → 下载层 `adapters/download/direct.ts` 是否已跟随并解包（zimuku 也可能下 zip）？grep 确认；
    若已处理则同样空过；若 subhd 的 zip 需特殊处理（多字幕选择），补一条 TDD：解包→取首个 .srt/.ass（同
    zimukuAdapter L15-18 注释的"v1 单字幕压缩包默认取第一个"口径）。**只在真需要时写代码，别预造。**

- [ ] **Step 2: 若有改动则提交**；无改动跳过。

---

## Task 9: 🔴 强制真机冒烟（OrbStack，env 门控）

**Files:**
- Create: `scripts/smoke-subhd.ts`（或 `src/adapters/providers/subhd.live.test.ts`，用 `SUBHD_LIVE_SMOKE` 守卫跳过默认 CI，参照仓内既有 live-matrix/live 测试的守卫写法——grep `VITEST` / `LIVE` 找范式）

- [ ] **Step 1: 写冒烟**

用真 `SubhdClient`（真 fetch，非注入）：
```ts
// 守卫：非 SUBHD_LIVE_SMOKE=1 时 it.skip
const live = process.env.SUBHD_LIVE_SMOKE === '1'
;(live ? it : it.skip)('真机端到端：搜真剧→resolve→下真字幕（非空 .srt/.ass）', async () => {
  const client = new SubhdClient({})   // 走 subhd.me
  const results = await client.search('进击的巨人')   // 库里真有的剧名
  expect(results.length).toBeGreaterThan(0)
  const dl = await client.resolveDownload(results[0].id)
  const res = await fetch(dl.url, { headers: { ...SUBHD_HEADERS, ...(dl.cookie ? { Cookie: dl.cookie } : {}) } })
  expect(res.status).toBe(200)
  const buf = Buffer.from(await res.arrayBuffer())
  expect(buf.length).toBeGreaterThan(0)   // 拿到真东西
}, 30_000)
```

- [ ] **Step 2: 在 OrbStack 跑冒烟（Task 2 Step 1 确认可达的方式）**

Run（示例）: `SUBHD_LIVE_SMOKE=1 npm test -- src/adapters/providers/subhd.live.test.ts`（在能到达 subhd 的
OrbStack 容器 / 宿主内）
Expected: PASS——**真的搜到、真的下到非空字幕**。这是"确实能拿到东西"的唯一凭证。若失败：按 systematic-debugging
查（可达性?解析漂移?下载 403 说明 cookie 没带对?），修到真绿，**不许 skip 蒙混**。

- [ ] **Step 3: 提交**

```bash
git add scripts/smoke-subhd.ts   # 或 subhd.live.test.ts
git commit -m "test(subhd): OrbStack 真机端到端冒烟（env 门控）"
```

---

## Task 10: 全栈回归 + 收尾

- [ ] **Step 1: 全套件 + 类型**

Run: `npm test && npm run check`
Expected: root 全绿（含新 subhd 单测；live 冒烟默认 skip）+ tsc 净

- [ ] **Step 2: 更新 roadmap** —— `docs/design/2026-07-20-post-deploy-roadmap.md` 标注 item C（subhd）完成、动漫源
  按侦察结论不建、里番短路押后 D。提交。

- [ ] **Step 3: 部署提示** —— subhd 需生产 `.env` 加 `SUBHD_ENABLED=true`（可选 `SUBHD_BASE_URL`）。记在收尾报告里
  提醒人类，本 Task 不动生产。
