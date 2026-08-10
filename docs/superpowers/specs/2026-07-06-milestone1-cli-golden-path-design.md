# Milestone 1 Design: CLI 黄金路径（subtitle-scout）

Status: approved by user on 2026-07-06
Scope: 核心字幕流水线 + ASSRT provider + CLI 入口。不含 Jellyfin adapter（里程碑二）、不含 Docker 打包（里程碑三）。

## 目标

给定一个手写的 `MediaContext` JSON（模拟"播放器告诉我们有人在播某个媒体"），跑通完整链路：

```
识别媒体身份 → 查缓存 → 生成搜索策略 → ASSRT 搜索 → 候选排序与包内选择
→ 硬校验 gate → 下载 → 解压/编码归一化 → 落盘（Jellyfin 命名）→ 验证 → decision.json
```

产出物：字幕文件 + `decision.json`（含选择理由、拒绝理由、全部 LLM 输入输出）。

## 不做什么（YAGNI 边界）

- 不做 Jellyfin API 对接（里程碑二）。
- 不做 judgeCacheReuse 模糊缓存复用判断——CLI 单次运行只信任精确 cache key 命中；模糊复用等有真实 Jellyfin 数据再做。
- 不做 rar/7z 解压——遇到即 `no_safe_match`，journal 说明原因。
- 不做 CF Worker / 代理 / relay——只有 `direct` 下载后端。
- 不做数据库——缓存是本地 JSON 文件。
- 不做 monorepo——单 package，目录分层当软边界。

## 仓库布局

```
subtitle-plugin/          # 目录名不动；package 名改为 subtitle-scout
├── src/
│   ├── core/
│   │   ├── schemas.ts        # 全部 Zod schema：MediaContext、Decision、判断点输出
│   │   ├── pipeline.ts       # 固定流水线状态机
│   │   ├── cache.ts          # 本地 JSON 文件缓存，含负缓存（no_safe_match TTL 7 天）
│   │   └── journal.ts        # decision.json 写出
│   ├── agent/
│   │   ├── llm.ts            # createOpenAICompatible 封装；强制 tool 模式
│   │   ├── identifyMedia.ts  # 判断点①
│   │   ├── planSearch.ts     # 判断点②
│   │   └── rankCandidates.ts # 判断点③（排序 + 包内文件选择合并为一次调用）
│   ├── adapters/
│   │   ├── providers/assrt.ts    # quota/search/detail + 令牌桶限速
│   │   └── download/direct.ts    # 直连下载 + 重试
│   ├── files/
│   │   └── subtitleWriter.ts # zip 解压、编码归一化、命名、落盘
│   └── cli/
│       └── index.ts          # subtitle-scout run --context ctx.json --out ./out
├── worker/                   # 现有 CF Worker 代码整体挪入封存（wrangler.jsonc、src/index.ts、worker-configuration.d.ts）
├── fixtures/                 # MediaContext 样例 + 录制的 ASSRT 响应
└── docs/
```

技术栈：Node 22、TypeScript（strict）、tsx 直跑、Vitest、AI SDK（`ai` + `@ai-sdk/openai-compatible`）、Zod、`adm-zip`（或等价 zip 库）、`chardet` + `iconv-lite`。

## 流水线状态机（纯代码，agent 无权改道）

```
loadContext → identify → cacheLookup ─命中→ writeFromCache → verify → journal
                              └─未命中→ planSearch → assrtSearch(filelist=1)
                                        → rankCandidates → gate → download
                                        → extract/normalize → write → verify → journal
```

关键原则：**LLM 只输出 decision，执行永远在 orchestrator。** 下载、写文件、删文件永远不作为 tool 暴露给 LLM。

### gate（纯代码硬校验）

agent 的 rankCandidates 输出必须逐条通过：

1. `assrt_id` 来自本次 search 返回的候选集合；
2. `file_index` 存在于该候选的 filelist（非包则忽略）；
3. episode 类型媒体：season/episode 与 MediaContext 严格相等；
4. `confidence >= 0.86`（可配 `AUTO_DOWNLOAD_MIN_CONFIDENCE`）；
5. 语言符合用户偏好（zh-Hans / 双语，繁体按配置）。

任何一条不过 → decision 降级为 `ask_user` 或 `no_safe_match`，不落盘。

## 三个 LLM 判断点

统一实现约定（`src/agent/llm.ts`）：

- `createOpenAICompatible({ baseURL: LLM_BASE_URL, apiKey: LLM_API_KEY })`，模型名 `LLM_MODEL`；
- **结构化输出强制走 tool 模式**（强制单 tool 调用），**禁用 `response_format: json_schema`**——实测 MiMo 静默忽略 json_schema（返回 JSON 但不遵守 schema，无报错）；
- `maxOutputTokens: 4000`——mimo-v2.5 是 reasoning 模型，先产 `reasoning_content` 再产正文，token 预算必须留足（实测 max_tokens=10 时正文为空、finish_reason=length）；
- Zod parse 失败 → 把校验错误喂回模型重试一次 → 再失败按 `no_safe_match` 收场；
- 每次调用的输入/输出原文记入 journal。

### 判断点① identifyMedia

输入：MediaContext（标题、原始标题、文件名、路径、年份、季集、provider ids、production_locations、现有字幕流）。
输出：`{ canonical_title, original_title, year, type, season?, episode?, edition?, confidence, evidence[] }`。

### 判断点② planSearch

输出：**有序查询列表，最多 3 条**，从精确（完整 release 名）到宽泛（标题+年份）。代码按序执行，某条返回可用候选即停。配额消耗可控，策略由 LLM 定。

### 判断点③ rankCandidates

输入：search 结果（含 `filelist=1` 返回的包内文件列表）+ canonical identity + 用户偏好。
输出：`{ decision: "download"|"ask_user"|"no_safe_match", assrt_id?, file_index?, confidence, reasons[], rejected[]: {assrt_id, reason} }`。

设计依据：Matrix 冒烟测试中 ASSRT id 606770 是漂亮的三部曲合集，但包内第一个文件是 Animatrix——必须做文件级判断，这是本产品的立身场景。

## ASSRT 客户端

- 令牌桶限速 **4 次/分钟**（实测配额 5/分钟，留余量）；
- 单次任务 API 调用硬上限 4 次；
- 所有响应先检查 JSON `status` 字段（0 为成功），再看 HTTP 状态码；
- search/detail 响应按 `endpoint+参数` 落盘缓存 24h；
- search 一律带 `filelist=1&no_muxer=1`，尽量避免为每个候选花 detail 配额；只对最终选中者调一次 detail 拿时效性下载 URL；
- 下载 URL 有时效，**永不缓存 URL，只缓存下载后的文件与元数据**；
- `ASSRT_TOKEN` 环境变量读入，永不入 git。

## 字幕文件处理

- 支持：直接 `.srt/.ass/.ssa` 文件、zip 包。rar/7z → `no_safe_match` + journal 说明；
- 编码：chardet 检测（GB18030/BIG5/UTF-16 等）→ 统一转 UTF-8（带 BOM 的保留原样即可被 Jellyfin 读取，转码仅在非 UTF-8 时发生，且 journal 记录原编码）；
- 命名：`<视频文件名去扩展名>.zh-Hans.<ext>`（繁体输出为 `zh-Hant`）；
- 写盘前检查同名文件：存在则不覆盖，journal 记 `already_exists`。

## 缓存

本地 JSON 文件（默认 `~/.subtitle-scout/cache/`，可配）：

- 正缓存 key：`imdb/tmdb id + season/episode`，及 `canonical title|year|type|S/E` 两层；value 含 identity、decision、evidence（沿用 product-shape.md 的结构）；
- 负缓存：`no_safe_match` 记录，TTL 7 天；
- ASSRT 响应缓存：24h（见上）。

## CLI 形态

```bash
subtitle-scout run --context fixtures/matrix.json --out ./output
```

- 输出：`output/<name>.zh-Hans.ass` + `output/decision.json`；
- exit code：`0` 成功下载、`1` no_safe_match/ask_user（正常的没找到）、`2` 异常（网络/配置/API 错误）；
- 配置全走环境变量：`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`、`ASSRT_TOKEN`、`AUTO_DOWNLOAD_MIN_CONFIDENCE`（可选）；支持 `.env`。与未来 Docker 形态零差异。

## decision.json（journal）

单次运行的完整审计记录：

- 输入 MediaContext 摘要；
- 每个流水线步骤的开始/结束/结果；
- 三个判断点的完整 LLM 输入输出（prompt、raw response、parsed 结果、重试）；
- ASSRT API 调用记录（endpoint、参数、status、耗时）；
- gate 校验逐条结果；
- 最终 decision 与验证结果（文件路径、字节数、编码）。

失败路径同样产出完整 journal。

## 测试策略

1. **单元测试（无网络）**：Zod schemas、gate 校验逻辑、缓存 key 生成、编码转换、命名规则；
2. **fixture 测试**：ASSRT client 与 pipeline 用录制的真实 API 响应（`fixtures/`）测试，含错误响应（status 非 0、配额耗尽）；
3. **端到端冒烟（手动触发，不进 CI）**：真调 MiMo SGP + ASSRT + 真实下载 The Matrix，验证全链路；
4. LLM 判断点不做断言式单测（测它即测模型），靠 journal 回放人工审。

## 错误处理原则

- 任何一步失败都产出完整 journal；
- exit code 区分"正常没找到"与"异常"；
- **宁可 no_safe_match 也不下载错字幕**——错字幕比没字幕伤害大；
- ASSRT 配额耗尽 → `retry_later` decision，不算异常。

## 开发环境凭据（不入 git，仅记录约定）

- LLM 测试：Xiaomi MiMo Token Plan，SGP 端点 `https://token-plan-sgp.xiaomimimo.com/v1`，模型 `mimo-v2.5`，key 在 `~/projects/token(1).txt` 的 `XIAOMI_API_KEY`（`tp-` 前缀）。DeepSeek key 同文件可作备用。
- ASSRT token：用户已提供（见历史会话），配额实测 5 次/分钟。

### MiMo 已实测的兼容性事实（2026-07-06）

| 能力 | 结果 |
|---|---|
| tool calling + 强制 tool_choice | ✅ 正常，finish_reason=tool_calls |
| `response_format: json_schema` | ❌ 静默忽略 schema，返回不合规 JSON 且无报错 |
| `response_format: json_object` | ✅ 可用，约束靠 prompt |
| reasoning 行为 | 先产 reasoning_content；max_tokens 过小时正文为空 |
| tool schema 的 `anyOf: [integer, null]` union | ❌ 无视类型约束，数字输出成字符串（`"1999"`），空值输出成 `"-"`/`"None"` 等随机变体（live e2e 实测）。对策：schema 边界归一化（`looseNumeric`/`looseNullableString`） |
| reasoning token 消耗 | ⚠️ 10 候选排序任务 reasoning 烧掉 3999/4000 输出 token，tool call 被截断。对策：默认 `maxOutputTokens=16000` + 候选/filelist 载荷截断 |

### Provider 兼容性实测：DeepSeek（2026-07-06）

用真实 CLI（非单测）跑完整判断链路：

| 模型 | 结果 |
|---|---|
| `deepseek-chat` | ✅ 三判断点全部 0 重试；原生返回正确 JSON 类型（无需 coercion）；速度显著快于 mimo-v2.5（rank 7.8s vs 62s）；候选选择合理（CMCT 简英双语 ASS，file_index 指向包内正确文件） |
| `deepseek-reasoner` | ❌ API 层拒绝强制 tool_choice（"Thinking mode does not support this tool_choice"）。我们的封装 fail-closed：重试一次后干净地产出 error decision + 完整 journal |
| 无效 API key | ✅ 干净 error decision，journal 记录 provider 的脱敏认证错误 |

重要：`deepseek-chat`/`deepseek-reasoner` 将于 **2026-07-24 废弃**，现役模型为
`deepseek-v4-flash`/`deepseek-v4-pro`，且 **v4 系列默认开 thinking**——thinking 模式
拒绝一切非 auto 的 tool_choice（`'required'` 也被拒，实测）。解法（已实现并实测通过）：

- `makeModel` 支持 `extraBody`，通过自定义 fetch 逐字段合并进每个请求体；
- CLI 暴露 `LLM_EXTRA_BODY` 环境变量（JSON）；
- DeepSeek v4 配置：`LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}`，
  实测 v4-flash 全链路 0 重试通过（identify 2.6s / plan 3.3s / rank 6.2s）。

该轮实测还首次在真实环境走通了 `ask_user` 路径：v4-flash 以 0.82 置信度主动拒绝
自动下载（担心 720p 校时字幕配 1080p 文件），gate 原样放行降级，exit code 1。
另观察到同模型对边界 case 的置信度存在跨运行方差（0.95 vs 0.82）——保守阈值
设计正确吸收了这种抖动。

结论：OpenAI 兼容边界设计成立——同一套代码在两家 provider 上行为正确；
MiMo 的类型 coercion 层对 DeepSeek 是无害的（它根本用不上）；
"强制 tool_choice" 与部分 thinking 模型互斥是已知类别限制，错误面清晰。

### Live E2E 发现（2026-07-06，五轮迭代）

完整链路已验证：3 个 LLM 判断点 0 重试通过、ASSRT search/detail status 0、gate 放行、
时效下载 URL 解析正确。字幕文件下载在开发机的 fake-ip 代理网络上不可达
（`file*.assrt.net` HTTP/HTTPS 均被黑洞，API 域名正常——代理规则只覆盖部分域名），
同一 URL 从家庭网络（iStoreOS 软路由，经 CF Tunnel 验证）下载成功，169750 字节，
与 07-02 直下产物一致。结论：代码链路完整正确；文件下载可达性取决于部署网络，
与 product-shape.md 的 download egress 设计判断一致。

## 后续里程碑（本 spec 不含）

- 里程碑二：Jellyfin adapter（session 轮询、MediaContext 构造、refresh、字幕流验证）+ judgeCacheReuse；
- 里程碑三：Docker 镜像 + compose 示例 + iStoreOS 真实部署验证。
