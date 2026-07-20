# subhd 字幕源 · 设计文档（2026-07-20，roadmap item C）

## 目标

给 subtitle-scout 增加 **subhd** 这个强字幕源（通用中文站，索引大、含动漫），套现有 `FetchAdapter`
两方法契约，反爬极轻（实测无验证码/无登录）。让全库覆盖更强。

## Scope（brainstorming 定盘，用户 2026-07-20 拍板）

- **只做 subhd**。侦察实证：诸神=博客、ACG.RIP=BT 种子、漫游/澄空=论坛/死站，**无可爬的动漫专源值得建**；
  subhd 本身已覆盖主流动漫。→ **不建"专门动漫源"**（用户本意是"多加强源"，非特指动漫，subhd 即最强）。
- **zimuku 已在仓内实现**（`providers/zimuku.ts` + `ZIMUKU_ENABLED`）——非本轮任务。
- **里番死缺口短路押后到 item D**（从零验证时拿真数据设计判定口径，此刻臆想 TMDB adult/分区口径不靠谱）。
- **反爬最小化**（用户：只要结果、不 care 过程）：真实浏览器头 + 礼貌限速，**不预建 Cloudflare 挑战 solver**；
  真被挡了再加（YAGNI）。

## 侦察实据（subhd 真实流程，来自真机探测 2026-07-20）

- **域名**：`subhd.me`（canonical）为主，镜像 `subhd.one/.top/.cc` 兜底。Cloudflare **被动、无 JS 挑战**。
- **搜索**：`GET <base>/search/<urlencoded query>` → HTML 结果页（带分页"共 N 条 当前第 X 页"）。每条含：
  详情页链接 `/a/<base62>`（=候选身份）、语言徽章（简体/繁体/繁中）、发布名、格式（SRT/ASS）、`官方字幕` 徽章。
- **下载=两步 token 舞**（可全自动，无验证码/无登录，匿名实测通）：
  1. 详情页 `/a/<id>` 上按钮 `<button class="subtitle-prepare-download" data-sid="<id>">`。
  2. `POST <base>/api/sub/prepare-download`，JSON body `{"sid":"<id>"}`，`Content-Type: application/json`
     → 响应 `{"success":true,"url":"/down/<id>"}` **且** `Set-Cookie: tk_…; Max-Age=300`（5 分钟）。
  3. `GET <base>/down/<id>` **带该 cookie** → 字幕文件。无 cookie → 403（"下载页面已失效"）。
- **可达性前提**：探测经用户本机代理（198.18.x fake-ip）。工具本就跑代理化家庭环境，这是真实工况；冒烟走
  本地 OrbStack 容器（用户钦定），subhd 在该环境够得着。

## 架构

契约（已存在，不改）：`FetchAdapter { name; search(args, emit) → SubtitleCandidate[]; resolve(ref, emit)
→ {url, filename?, headers?} }`（src/cli/fetchLib.ts）。`SubtitleCandidate`（src/core/schemas.ts）字段：
`provider / providerId / videoName? / nativeName? / language? / subtype? / releaseSite? / uploadDate? /
fileList[]`。`CandidateRef = {provider, providerId, fileIndex}`。

| 文件 | 职责 |
|---|---|
| `src/core/schemas.ts` | `PROVIDERS` 元组加 `'subhd'`（enum 扩一个值，全链类型收敛） |
| `src/adapters/providers/subhd.ts`（新） | `SubhdClient`——纯 provider 逻辑，不依赖 CLI 层。见下方接口 |
| `src/cli/adapters/subhdAdapter.ts`（新） | `makeSubhdAdapter(client): FetchAdapter`——映射层，套 `zimukuAdapter.ts` 模板 |
| `src/cli/buildAdapters.ts` | 加 `if (process.env.SUBHD_ENABLED === 'true')` 门；**无需 LLM**（不像 zimuku） |

### SubhdClient（src/adapters/providers/subhd.ts）

```
class SubhdClient {
  constructor(opts: { baseUrl?: string; mirrors?: string[]; fetchImpl?: typeof fetch;
                      onApiCall?: (r) => void })   // baseUrl 缺省 subhd.me；fetchImpl 注入供测试
  search(query: string): Promise<SubhdSearchResult[]>       // GET /search/<q> → 解析 HTML
  resolveDownload(id: string): Promise<{ url: string; cookie: string | null }>
        // POST /api/sub/prepare-download {sid:id} → {url:/down/<id>} + 捕获 tk_ cookie
}
interface SubhdSearchResult { id: string; videoName: string|null; language: string|null;
                              subtype: string|null; releaseSite: string|null }
```

- **限速**：复用 `providers/jitter.ts` 的 `RequestLimiter`（同 zimuku），礼貌抓取。
- **镜像兜底**：主 base 请求失败（网络/5xx/Cloudflare 拦）→ 依次试 mirrors，全败才抛（gain-path，同 tmdb 镜像思路）。
- **观测**：每次请求 `onApiCall`（provider:'subhd'），并入 dashboard 的 provider 配额/痕迹（同其他源）。
- **HTML 解析**：复用 `providers/htmlAttrs.ts`（现有 HTML 属性提取工具）；解析器**对真机夹具编写**，不臆想。
- **无** captcha solve、**无** 云锁挑战层、**无** 持久 session store（tk_ cookie 是 resolve 内短命值）。

### subhdAdapter（src/cli/adapters/subhdAdapter.ts）

- `name: 'subhd'`。
- `search(args, emit)`：`client.search(args.query)` → 映射 `SubhdSearchResult` → `SubtitleCandidate`
  （provider:'subhd', providerId:id, videoName, language, subtype, releaseSite, fileList 见下）。语言/目标
  过滤沿用现有 adapter 口径（`args` 携带目标语言，见 zimukuAdapter）。
- `resolve(ref, emit)`：`client.resolveDownload(ref.providerId)` → `{ url, headers: { Cookie: 'tk_…' } }`
  （cookie 经 headers 传给下载层 `adapters/download/direct.ts`，它用 headers 打 `/down`）。5 分钟窗口内
  resolve→download 立即发生，不缓存 cookie。

### fileList / 压缩包（待真机确认）

subhd `/down/<id>` 返回**单文件**还是**zip 压缩包**——真机冒烟确认。若 zip，走仓内既有解包路径
（`adm-zip`，同 zimuku/assrt），映射包内条目→`fileList[{index,name}]`，`resolve` 的 `fileIndex` 定位包内文件；
若单文件，`fileList` 单元素。**此项由夹具捕获阶段（实现 Task 1）实测定夺，不预设**。

## 错误处理 / 诚实降级

- Cloudflare 挑战页 / 非 200 / 网络失败 → **可重试失败**（抛错，不是"无字幕"），交给上层退避（同现有源）。
- 搜索零结果 → 空候选数组（诚实，不编造）。
- prepare-download `success:false` 或缺 url → resolve 抛可重试错。
- cookie 过期（>5min，罕见）→ /down 得 403 → 上层重发 resolve 拿新 cookie。

## 测试（zimuku 血泪铁律：真站侦察 + 真机冒烟，禁止只夹具绿）

- **夹具单测**（默认 CI 跑）：
  - HTML 搜索页解析 → 候选（含分页、语言徽章、格式、`/a/<id>` 提取）。
  - prepare-download JSON 解析 → `{url, cookie}`（含 Set-Cookie tk_ 提取、success:false 分支）。
  - 候选映射 → `SubtitleCandidate`（字段齐、语言过滤）。
  - fileList/解包（若 zip）。
  - **铁律**：全部夹具**必须捕获自真机 subhd 响应**（实现 Task 1 在 OrbStack 抓存），不许手编臆想结构。
- **强制真机冒烟**（env 门控，不进默认 CI，同现有 live-matrix 手法）：在**本地 OrbStack 容器**内，真打
  subhd：搜真剧名 → 得候选 → resolve → 下真字幕文件，断言拿到非空 .srt/.ass。这是"确实能拿到东西"的
  唯一证明。跑法：容器内置工具 + `SUBHD_ENABLED=true` + `SUBHD_LIVE_SMOKE=1` 之类守卫。

## YAGNI / 范围外

- 专门动漫源（诸神/ACG.RIP/漫游）——侦察实证不可爬，不建。
- 里番短路——押后 item D，拿真数据设计。
- Cloudflare JS 挑战 solver——侦察说当前不需要，不预建；真被挡再加。
- subhd 登录/账号态、收藏、评分等站内功能——只做 search+download，其余不碰。
