# Spec A — 启动面：Bootstrap Wizard + 密钥库 + 发动机总开关

日期：2026-08-01 ｜ 状态：已裁决待实现 ｜ 上游：三轮需求讨论（用户逐条拍板，见 §3）

## 1. 背景与设计模型

用户对浏览器端的定位：**可操作面只有三处——bootstrap（加油+自检）、启动开关（点火）、极少数一键决策（偏移修复）；其余全是观测台**。飞机起飞后即 autopilot，发射后不管。

现状差距（全部经代码核实）：

- 项目有 auth SetupWizard（建 admin + 揭 API key，`web/src/App.tsx:15-23`），但**没有**面向"跑起来"的 bootstrap 流程；
- provider key / TMDB token / LLM 三件套全部 **env-only**（`src/adapters/buildAdapters.ts:30-96`、`src/cli/index.ts:92-94`、`src/cli/index.ts:100-101`），浏览器无法配置；Settings 的 Deploy 区只读是设计如此（`web/src/i18n/en.ts:224`）；
- **没有任何总开关**：daemon 15s tick 固定（`src/v2/daemon.ts:430`），`dispatch()` 每 tick 无条件执行（`daemon.ts:332`），`scan_interval_ms` 只闸 ingest 心跳（`daemon.ts:182-192`）；
- 全项目没有运行时 key 校验，但 **doctor 命令已有全套自检原语**（`src/cli/doctor.ts:13-126`：checkAssrt / checkOpenSubtitles / checkZimuku / checkTmdb / checkLlm / checkMediaRoots）——wizard 的"测一测"直接复用，不重造。

## 2. 范围

**In：** 首跑 bootstrap wizard（7 步全屏流程）；provider/LLM/TMDB 密钥落库 + env 优先解析；运行时校验端点（复用 doctor 原语）；发动机总开关（settings key + daemon 闸 + UI 两处控制）；Settings 的 Deploy 只读区改造为可编辑 Providers 区；watch 启动门禁改造。

**Out：** 翻译模型设计（既定挂起项）；多用户；密钥加密存储（决策见 §4.1）；Windows 路径展示打磨（列入 §11 实现期验证项）；活动页/Library/Triage 的视觉重建（Spec C）；电影详情/母语媒体开关/波形端点（Spec B）。

## 3. 已裁决决策清单（spec 的硬约束）

门禁矩阵（用户 2026-08-01 拍板）：

| 步骤 | 对象 | 门禁 | 测试方式 |
|---|---|---|---|
| 1 | 目标字幕语言 | 必填；选定即时切换 wizard 界面语言 | 无需测 |
| 2 | TMDB token | **硬门禁，不通不给过** | 复用 checkTmdb |
| 3 | LLM 三件套（base URL + key + model） | **硬门禁，不通不给过** | 复用 checkLlm（最小对话） |
| 4 | ASSRT / OpenSubtitles(3 字段) / Jimaku | **可跳过**，每把一个即时测，红了写明后果放行 | 复用 checkAssrt / checkOpenSubtitles；新增 checkJimaku（仿 checkAssrt） |
| 5 | subhd / zimuku | 无 key，开关制，**wizard 内默认开**（用户指定的兜底源；作用域见 §4.4——env 部署维持 opt-in） | 首页/搜索页可达性；zimuku 增列 captchaReady = LLM 已通 |
| 6 | 守备目录 | 可跳过；复用现有 DirBrowser | 服务端校验已存在（`apiV2.ts:667-691`） |
| 7 | 点火 | 发动机总开关，默认 ON | — |

五条小决策（用户逐条"可以"）：

1. **Wizard 触发用推导式不用标志位**：env 或库任一处已有 LLM+TMDB → 跳过 wizard；现有 env 部署升级后零打扰。Settings 留 "Re-run setup wizard" 入口。
2. **点火开关放两处**：Activity 页 hero（发动机状态+开关，视觉归 Spec C）+ Settings Behavior，操作同一个 settings key。
3. **引擎关闭时不画新状态面**（铁规）：页面顶部常驻细 banner，其余界面照常展示现有数据。
4. **Deploy 只读区改造为 Providers 区**：回读一律打码；env 设了的项标注 "Set by environment — locked" 不可改；watch 缺 TMDB 拒启动改为"env 或库任一有即可"。**（2026-08-02 修订：审计发现 dashboard 寄居 watch 进程且排在门禁之后——"拒启动"在零 key 首启下构成死锁（watch 死→dashboard 不起→wizard 永远够不到）。用户批准演进为 setup 模式：缺 key 不 exit、闸全关不产任何工作、wizard 落库后同进程点火，见 §4.7。）**
5. **字幕翻译 agent 继续挂起**；LLM 硬门禁恰好覆盖其前置条件，本 spec 不碰。

更早的两条 A/B 裁决：wizard = **独立首跑全屏流程**（接在 auth SetupWizard 之后）；密钥 = **落库**（settings 表），env 优先。

## 4. 后端设计

### 4.1 密钥存储

settings 表（`src/v2/db.ts:170`：`key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL`）新增 `secret:*` 键空间：

- `secret:TMDB_API_KEY`
- `secret:LLM_BASE_URL` / `secret:LLM_API_KEY` / `secret:LLM_MODEL`
- `secret:ASSRT_TOKEN`
- `secret:OPENSUBTITLES_API_KEY` / `secret:OPENSUBTITLES_USERNAME` / `secret:OPENSUBTITLES_PASSWORD`
- `secret:JIMAKU_API_KEY`

**决策：sqlite 明文存储，不加密。** 理由：PERSONAL 项目、家用部署、DB 文件本就有文件权限保护；Sonarr/Bazarr 同级产品同此做法；加密会引入 master key 保管问题，对本项目是净负收益。任何 API 永不回读明文（§4.4 打码序列化）。

`settingsRepo.ts` 新增：`getSecret(name)` / `setSecret(name, value)` / `listSecretMeta()`（只返回哪些已设置 + 打码预览 + source，不返回值）。打码格式：长度 ≥8 → 前 3 + `••••` + 后 3；<8 → 全 `••••`。**白名单校验**：只允许上表 10 个名字，拒绝其他 `secret:*` 写入。

### 4.2 解析优先级

新模块 `src/v2/secrets.ts`：

```
resolveSecret(name) → { value, source: 'env' | 'db' | 'none' }
```

env 非空 → env 胜（deploy-locked）；否则读库；都没有 → none。**env 优先保证现有部署零迁移、零行为变化。**

生效时机沿用现有约定："Takes effect on the next daemon tick"（`cli/index.ts:584-586`、`en.ts:205`）。实现按客户端寿命分三路（架构事实，已亲核）：

- **per-claim 现建的 fetch adapters**（`cli/index.ts:455` find_subtitle 分支、`:506` translate 分支——注释明确"每次 claim 现建"）：天然下一任务生效，无需任何机制；
- **进程级长命客户端**——`assemble()` 产的 `reasoningModel` 与 `tmdb`（`cli/index.ts:97-102`）**以及 realign 字幕先行的 adapters**（`:314`；`:308-310` 注释原话"adapters 只在这里建一次（watch 进程生命周期内长驻）"，一次性构建是有意的优化——realign 是几十集紧凑循环，重建只有 Zimuku session 重读盘的开销）：`secrets_version` 计数器（任何 secret 写入自增），daemon 每 tick 比对，变了才重建并替换；
- **替换机制钉死**：boot 时这些客户端被闭包捕获（`:312-318`），重建必须经 **holder 间接层**——`clients = { current: { reasoningModel, tmdb, realignAdapters } }`，闭包统一经 `clients.current` 取用，版本变化时重建并整体换 `current`。禁止"可变 ref 各写各的"。**holder 覆盖必须延伸到 dashboard 注入面**：`server.ts:194` 按值解构 tmdb、`:253` series 详情惰性刷新（缺席即跳过）、`:584` GET /api/v2/tmdb/search（缺席 503）、`cli/index.ts:623-627` reconcileAllClosure（boot 定型，setup 模式下 undefined → reconcile-all POST 503）——这些按值消费点 holder 管不到，注入一律改 getter 形式（`() => clients.current.tmdb`，消费处现取现判空）或 secrets_version 变化时重建 dashboard deps；否则"同进程点火"后这三处保持 503/跳过直到重启，直接违背 §4.7 步 4 的头条承诺。

### 4.3 消费点改造清单

| 消费点 | 现状 | 改造 |
|---|---|---|
| `cli/index.ts:92-94` assemble() | `requireEnv('LLM_BASE_URL'/'LLM_API_KEY'/'LLM_MODEL')`，缺值即 `process.exit(2)`（`:62`）；且 cmdWatch `:210` 调 assemble() **早于** TMDB 门禁 `:215-218`——key 只在库里时 watch 会先死在 assemble，根本到不了新门禁 | assemble 改走 resolveSecret，**缺值不再 exit**：返回 `reasoningModel: null` + 一行 warn；硬性要求上提到门禁层（§4.7 统一检查 LLM+TMDB，指向 wizard/env） |
| `cli/index.ts:97-102` assemble() | 构造进程级长命 `reasoningModel` + `TmdbClient` | 走 resolveSecret；纳入 §4.2 版本驱动重建 |
| `buildAdapters.ts:30-96` | 直读 process.env（ASSRT/OS/SUBHD/JIMAKU）；zimuku 段 `ZIMUKU_ENABLED==='true'` 时 `requireEnvForZimuku('LLM_*')` 缺值即 throw，任务执行点 throw = 任务失败 | 全部改走 resolveSecret；**zimuku 入列守卫下沉到组装层**：`resolved_enabled ∧ LLM 三件套可解析` 才入列，LLM 缺席 → 跳过该 adapter + 一行 warn（wizard UI 的 captchaReady 只是展示，后端必须自己守） |
| `cli/index.ts:776-778` cmdDoctor | 直读 LLM_* | 改走 resolveSecret |
| `translateItemCommand.ts:46` + `:300-303` | LLM 三件套 requireEnv + 直读 TMDB_API_KEY | 改走 resolveSecret（translate-item 缺 LLM 仍报错，语义不变，只是来源无关） |
| `cli/index.ts:86-88` | LLM_EXTRA_BODY | 保持 env-only 高级项，wizard 不收 |
| `apiV2.ts` Deploy 区 | 只读 env 展示 | 改 Providers DTO（§4.4） |

### 4.4 新端点（全部挂在现有 admin 鉴权后）

**GET /api/v2/setup/status** →

```json
{
  "bootstrapComplete": false,
  "tmdb":   { "satisfied": false, "source": "none", "masked": null },
  "llm":    { "satisfied": false, "source": "none", "model": null },
  "providers": {
    "assrt":        { "satisfied": false, "source": "none", "masked": null },
    "opensubtitles":{ "satisfied": false, "source": "none", "hasUsername": false },
    "jimaku":       { "satisfied": false, "source": "none", "masked": null },
    "subhd":        { "enabled": false, "source": "none" },
    "zimuku":       { "enabled": false, "source": "none", "captchaReady": false }
  },
  "roots":  { "count": 0 },
  "engineEnabled": true
}
```
（示例 = 全新零配置首跑的"全缺"态。）

`bootstrapComplete = tmdb.satisfied && llm.satisfied`（推导式，决策 1）。subhd/zimuku 的 `enabled` 三级解析：env 显式设置 → env 值；否则库 `provider:SUBHD_ENABLED` / `provider:ZIMUKU_ENABLED`；都没有 → **视为关**（与今天 env-only 的缺省一致，§10 零打扰成立）。**布尔解析钉死 `=== 'true'` 精确匹配**（沿用今天 `buildAdapters.ts:54、:77` 语义；fail-closed——flag 默认关，与 engine 的 fail-open 相反，闸的性质不同）。两键的写入通道钉死：`provider:SUBHD_ENABLED` / `provider:ZIMUKU_ENABLED` 与 engine_enabled 同款——入 PUT /api/v2/settings 白名单（`SETTINGS_KEYS`，`apiV2.ts:515-518`）+ zod enum（`:617`），**不另起端点**。"默认开"只在 wizard 路径生效：步骤 5 两个开关出厂 ON，**Continue 时写库**（每步独立落库，与 §7 中途刷新语义一致）——全新 DB-only 用户必经 wizard 故必得默认开；env 部署（含现有盒子）保持显式 opt-in，行为零变化。OpenSubtitles `satisfied` = 仅 apiKey 可解析即可；`hasUsername` 仅在 username+password **成对**可解析时为 true，单填视为未填（客户端本就容忍仅 apiKey——`opensubtitles.ts:99` username 可选、`:228` 仅无 token 且成对才登录）。

**validate 薄壳翻译规则**：doctor 的 null-probe 返回 `ok:true skip:true`（未配置不算失败，`doctor.ts` checkOpenSubtitles/checkZimuku 语义）；HTTP 层统一译为 `{ ok:false, error:'<target> is not configured' }`——对 wizard 而言"没配"就该是红而不是绿。

**PUT /api/v2/settings/secrets** `{ name, value }` — 白名单校验；空字符串 = 删除；写审计日志（只记 name，永不记 value）；bump secrets_version。

**POST /api/v2/setup/validate** `{ target, credentials? }` → `{ ok, detail?, error? }`

- target ∈ `tmdb | llm | assrt | opensubtitles | jimaku | subhd | zimuku`；
- `credentials` 提供时测**请求体里的凭据且不落库**（wizard 的"先测后存"）；省略时测已解析（env/db）的凭据；
- 每次测试 10s 超时；结果写入 `secret_test:<target>`（`{ ok, at, error? }`），Providers 区凭此渲染上次测试点，不必每次重测；
- 错误分类：401/403 → "Invalid credentials"；404 → model/baseUrl 错；网络/超时 → 连接问题。detail 给用户可执行的下一步。

### 4.5 校验实现：复用 doctor 原语

`doctor.ts:13-126` 的 check 函数全部接受注入式 probe（天然可测、可组合）：

- tmdb → `checkTmdb`（:80-90，搜索探测）；llm → `checkLlm`（:92-102，最小对话；实现时 `max_tokens=1` 控成本）；
- assrt → `checkAssrt`（:13，quota 调用）；opensubtitles → `checkOpenSubtitles`（:28）；zimuku → `checkZimuku`（:50-）；
- **新增** `checkJimaku`（仿 checkAssrt：一次最便宜的鉴权调用，具体端点实现期按 jimaku API 文档定）与 `checkSubhd`（首页可达性 GET，期望 200）。

validate 端点 = 这些 check 函数的 HTTP 薄壳 + 凭据注入。doctor CLI 行为不变。

### 4.6 发动机总开关

- settings key：`engine_enabled`，值 'true'/'false'。**缺省 = true**（现有部署零行为变化）；wizard 点火步显式写入。
- PUT /api/v2/settings 允许键新增 `engine_enabled`（布尔校验）；settings GET DTO 增 `engineEnabled`（hero/banner 共用此数据源）。
- daemon tick（`daemon.ts:430`）闸口：`engine_enabled=false` 时跳过**所有产工作的循环**——ingest 心跳（:182-192）、dispatch（:332）、orchestrate 心跳、verify sweep。**维护性循环不闸**：lease/孤儿回收继续跑（暂停中也可能有待回收的租约，这是安全网不是产工作）。状态翻转时各记一行日志。
- 脏值读取语义钉死 **fail-open**：库里读出 `'false'` 才视为关；其他任何值（含手改库进去的脏值）一律视为开——与缺省=true 的精神一致。
- 暂停语义是"不产新工作"：已落库的队列不删不动，重开后续跑。

### 4.7 watch 启动门禁 → setup 模式（本 spec 的生死改动）

**死锁事实链（已亲核）**：dashboard 不是独立进程——`startDashboard` 只在 cmdWatch 内被调（`cli/index.ts:637`；`server.ts:264` 注释 "startDashboard runs once per daemon process"），CLI 分派（`cli/index.ts:899-904`）无独立 dashboard 命令；cmdWatch 顺序为 assemble() `:210` → TMDB 门禁 `:215-218`（exit 2）→ openDb `:230` → startDashboard `:637`；`Dockerfile:40` CMD 就是 `cli watch`，`docker-compose.yml:9` restart:unless-stopped + `:25` 健康检查探 dashboard 端口。**全新零 key 安装：watch 死在门禁 → dashboard 从未起 → 容器 crash-loop → 用户永远到不了 wizard → key 永远落不了库。** "去 dashboard 完成 wizard"指向一个没在跑的 UI。

**改造：watch 先起 dashboard，再过门禁；门禁不过不 exit，转 setup 模式存活。**

1. **顺序重排**：openDb → startDashboard（port>0 时）先行，门禁评估在后。dashboard 起 = 容器健康 = 不再 crash-loop；auth SetupWizard（建 admin）同样因此永远可达。assemble() 落点钉在 **openDb 之后**（要读库解析密钥）；在 startDashboard 前/后均可——dashboard 对 tmdb 缺席本就有降级（`server.ts:60-63` 注释：两个消费点各自独立降级）。
2. **门禁评估**：openDb 后 `resolveSecret('TMDB_API_KEY')` 与 LLM 三件套。任一 `none` → **setup 模式**：经 watchStartupWarnings 通道打警告（"dashboard is up — finish the setup wizard; engine stays gated until TMDB and LLM are configured"），进程继续跑。
3. **setup 闸**：产工作的许可 = `engine_enabled ∧ tmdb 可解析 ∧ llm 可解析`。setup 闸是内部 AND 条件，不是第二个用户开关；§4.6 的 engine 语义不变。闸全关时 daemon tick 照常跑（reaper 等维护循环不受影响），只是不产工作。
4. **同进程点火**：secrets_version 变化（wizard 落库）→ 下一 tick 重解析 → 门禁满足 → 按 §4.2 holder 重建长命客户端 → 打一行 "setup complete — engine live" → 正常运行。**容器/进程无需重启**——这正是 §4.2 热重载存在的意义。
5. **null 耐受**：setup 模式下 assemble 返回 `reasoningModel:null / tmdb:null`（§4.3）；`:316` 注释"tmdb 恒非空"的前提不再成立。需逐一放宽的消费点清单：`cli/index.ts:316` realign worker 组装注释前提、`:272` ingestPass（`buildIngestPass:119` 的 `tmdb: TmdbClient` 非空签名需放宽为可空+调用点判空）、`:343-347` tmdb facade（本就是惰性箭头闭包，抽查安全）、`:386-393` orchestrate deps、`:455-459`/`:506-510` per-claim workers（adapters 每次 claim 现建，但仍读 boot 绑定的 reasoningModel/tmdb——§4.2 holder 统一覆盖，点名更稳）。闸全关保证没有任何工作真的流到这些点，null 只是结构性的。
6. **一次性命令维持拒启动**：reconcile-all（`cli/index.ts:155-157`）不寄居 dashboard，缺 TMDB **或 LLM** 仍 exit 2（报错文案改指 wizard 或 env）——assemble 改 null 耐受后，门禁必须同时查两把钥匙，否则拿 null reasoningModel 跑 orchestrator 会运行时炸而非人话拒启动；doctor 检查同步改走 resolveSecret（`:76-79` "假信心"注释所述问题）。

*脚注：setup 闸连带闸住 translate 车道（翻译用 TRANSLATE_* 三件套而非 LLM_*）——今天这类部署本就被 requireEnv 挡死，无回归；属极端边角，不为它开第三个闸。*

## 5. 前端设计

### 5.1 入口与触发

`App.tsx` 现状顺序：auth 检查 → 无 admin → SetupWizard。新顺序：auth 通过 → GET setup/status → `bootstrapComplete=false` → 全屏 `<BootstrapWizard/>` 替代 AppShell。**锁死是有意决策**：bootstrap 完成前观测台无物可观（引擎闸全关），wizard 不提供 dismiss；setup 模式（§4.7）保证 dashboard 永远可达，锁死不会变成死锁。Settings System 区 "Re-run setup wizard" 按钮以 re-run 模式重进（已满足的硬门禁显示绿色打码态，Continue 直接可走，不必重测；可手动 Re-test）。

### 5.2 七步流程

步进器头部 7 点，每步卡片式，全部英文文案（选定 zh 后 wizard 自身即时切中文——联动机制的现场证明）：

1. **Subtitle language** — 多选 chips（zh / en / ja / ko + 自定义 BCP-47 输入，沿用现有正则 `apiV2.ts:618-620`）。首选语言决定 UI 语言：`zh*` → setLang('zh')，其余 → 'en'，立即生效并持久化（localStorage key `scout-lang`——`useT.ts:13` STORAGE_KEY、`:21-29` readStoredLang 读路径、`:45-53` setLang 写路径，这是 setLang 的第一个真实调用方）。同时 PUT target_languages（复用现有端点）。
2. **TMDB** — 单输入 + Test；硬门禁：绿了才能 Continue；env 已配 → 锁定绿态 "Configured via environment" 直接可走。流程：输入 → Test（credentials 走请求体不落库）→ 绿 → Save & continue 才 PUT secrets。
3. **LLM** — 三字段（Base URL / API key / Model）+ Test；硬门禁同 TMDB。Base URL 提示通常以 `/v1` 结尾（沿用 doctor hint 语义 `doctor.ts:99`）。
4. **Subtitle providers**（可跳过整步）— ASSRT 1 字段、OpenSubtitles 3 字段、Jimaku 1 字段，各带 Test + 状态点（灰→转→绿/红）。红不拦路，行内写明后果（"Without ASSRT, one fewer subtitle source"）。**只保存测绿的 key**；横幅说明："subhd and zimuku are built-in free sources and stay on as fallback."
5. **Free sources** — subhd / zimuku 两个开关，默认 ON；进步骤时自动做可达性测试只展示不拦截；zimuku 行尾标注 "Captcha solver: ready (LLM configured)"。
6. **Media roots**（可跳过整步）— 复用 DirBrowser（从 RootsManager 抽成共享组件）；跳过附后果说明 "Library will stay empty until you add roots — you can do this later in Settings."。
7. **Launch** — 汇总清单（配了什么/跳了什么）；Engine 开关默认 ON；"Launch" → PUT engine_enabled → 硬刷新进主界面。

### 5.3 组件与文案

栈按既定裁决：shadcn Input/Button/Switch/Card + 自绘步进点与状态点；不引入 AI Elements 的流式组件（wizard 无流式内容）。i18n 新增 `wizard_*` 键区，**en/zh 双表都要写**（key-parity 测试强制，`web/src/i18n/i18n.test.ts`）；"Workflow 区永不本地化"裁决不覆盖 wizard。Providers 区/开关/banner 等新 Settings 文案同步进双表。

### 5.4 Settings 改造

- **Behavior** 区加 "Engine" 开关（engine_enabled）；
- **Deploy 只读区 → Providers 区**：每家一行——打码值、source 徽标（environment / database）、上次测试点（`secret_test:*`）、编辑（仅 db 源可改，env 源显示 "Set by environment — locked" 禁用输入）、Test 按钮；**无 key 的 subhd/zimuku 两家以 toggle 行呈现**（同一 PUT settings 通道），日常开关不必 Re-run wizard。**与 wizard 的不对称是有意的**：wizard 的"先测后存"是首跑引导纪律；Settings 是日常修改面，保存不强制测试，靠上次测试点展示兜底（测试按钮常备）。
- **System** 区加 "Re-run setup wizard"；
- 纯部署信息（非密 env 展示）保留为只读小块。

### 5.5 Activity hero 发动机控制

视觉形态归 Spec C；本 spec 只保证数据与写路径就绪：engineEnabled 在 settings GET、PUT 可写、下 tick 生效（≤15s）。hero 开关 = Settings 那个开关的另一处绑定，无二义性。

*（2026-08-02 Spec C R1 审计交叉注：Spec C §5.3 裁决 hero 仅在"有在跑任务"时渲染，故 hero 开关随之只在有在跑时出现；引擎关停/无在跑时的控制面 = 本处 Settings 开关 + §5.6 banner 的 "Turn on"。决策 2 的"两处"语义由此闭合：开关能力两处齐备，但同一时刻可能只可见其一。）*

### 5.6 引擎关闭 banner

所有主屏顶部常驻细条（仅 engineEnabled=false 时渲染）："Engine off — polling and dispatch are paused." + "Turn on" 快捷钮（PUT 同键）。不画任何新状态页面（铁规：卡死/断连不设计专属状态面）。

## 6. 数据流（一次完整首跑）

1. 首启 → auth SetupWizard 建 admin（既有）→ 登录；
2. App 拉 setup/status → 全缺 → wizard 全屏接管；
3. 步骤 1 选 zh → PUT target_languages + setLang('zh') → wizard 界面即时变中文；
4. 步骤 2 输入 TMDB token → POST validate(target=tmdb, credentials) → checkTmdb 绿 → PUT secrets(TMDB_API_KEY)；
5. 步骤 3 三件套 → checkLlm 绿 → PUT secrets×3；
6. 步骤 4 只测了 ASSRT 绿 → PUT secrets(ASSRT_TOKEN)，其余跳过；
7. 步骤 5 默认双开 → PUT provider:SUBHD/ZIMUKU_ENABLED；
8. 步骤 6 用 DirBrowser 加一个 /media → 既有 addMediaRoot 校验入库；
9. 步骤 7 Launch → PUT engine_enabled=true → 刷新；
10. daemon 下一 tick：secrets_version 变了 → 按 §4.2 holder 重建长命客户端（realign adapters 一并）；scan_interval 到 → ingest 扫到新 root → 正常派单（per-claim 现建的 fetch adapters 自动吃上库里新 key）。**若本次是零 key 首启（setup 模式，§4.7）：同一步既重建客户端又解除 setup 闸——同进程点火，容器无需重启。**

## 7. 错误处理

- validate 每项 10s 超时；错误三分类（凭据无效 / model·baseUrl 错 / 网络不通）行内红字 + 可执行提示；validate 端点自身 5xx → 行内 "Test unavailable, retry"；
- secrets PUT 白名单外的 name → 400；空值 = 删除语义；并发写 = sqlite 单行 upsert 天然串行、last-write-wins，不引入锁；
- engine_enabled 手改进脏值 → fail-open 视为开（§4.6）；
- wizard 中途刷新：重进推导式 status，已存步骤自然显示满足态，无断点恢复需求（每步独立落库）；
- DirBrowser/addMediaRoot 错误沿用现有（EACCES → 4xx，`apiV2.ts:594-609`）；
- daemon 侧：库里的坏 key（手改 DB）与 env 坏 key 行为一致——adapter 照常构建、调用照常失败、既有退避/限流兜底，不新增特殊态。

## 8. 安全

- 三个新端点全部走现有 admin 鉴权中间件；
- 任何日志（含审计日志、daemon 日志、SSE trace）永不出现密钥明文——实现期 grep 新增代码的全部 log 调用人工核对，**特别盯 check 失败路径的 `String(e)`**：若异常消息 echo 了响应体/请求头，可能带出凭据（现有 trace 通道已核实干净——assrt 的 onApiCall 上报 params 不含 token、TraceEvent.argsSummary 只走 agent 工具参数；风险全在新增代码）；
- validate 的 credentials 只在请求生命周期内存活，不落库不落日志；
- sqlite 文件权限不变；明文存库的决策与理由已记录（§4.1）。

## 9. 测试

**单测（后端）：**
- resolveSecret 优先级矩阵：env 胜 / db 兜底 / 空字符串 env 视为未设 / 删除后回落 none；
- 打码序列化：≥8 与 <8 两档，断言不含明文子串；
- secrets PUT：白名单拒绝、空值删除、secrets_version 自增；
- setup/status 推导矩阵：纯 env / 纯 db / 混合 / 全无 四种部署形态；
- daemon 闸：engine off → ingest/dispatch/orchestrate/verify 全部不被调用，reaper 仍被调用；on→off→on 翻转日志各一行；
- **setup 模式（§4.7）**：零 key boot → dashboard 已起（端口可达）+ 产工作循环全闸 + 警告日志；写入 secrets 后 secrets_version 变化 → 同进程 holder 重建 + 闸门解除 + "engine live" 日志，全程无重启；**点火后 /api/v2/tmdb/search 与 reconcile-all POST 不再 503**（holder 覆盖 dashboard 注入面的直接断言）；reconcile-all 零 key 仍 exit 2；
- PUT settings 接受 engine_enabled 合法值、拒绝非法值；
- validate 分发：未知 target → 400；
- provider flag 布尔解析：`=== 'true'` 精确匹配，'1'/'TRUE'/脏值一律关。

**集成：**
- validate 全 target：mock HTTP（沿用 adapter fixtures 模式），checkJimaku/checkSubhd 新原语配 fixture；
- 密钥 round-trip：写入 → status 反映 source=db + 打码 → env 同名变量出现后 source=env。

**前端：**
- wizard 门禁逻辑：2/3 步未绿 Continue 禁用；re-run 模式满足态直通；
- 步骤 1 选 zh → t() 即时切中文（断言 wizard_* 中文案渲染）；
- Providers 区：env 源禁用输入、db 源可编辑、打码渲染；
- banner 仅 engineEnabled=false 出现；
- i18n parity 既有测试自动覆盖新键。

**实机验收清单（media-router）：**
- 现有 env 部署升级 → wizard 不出现、行为零变化；
- **零 key 全新容器：watch 不再 exit → dashboard 起来 → 健康检查转绿 → wizard 可见；走完全流程 → 同进程点火（日志见 "engine live"），容器从首启到出活零重启**；
- 临时挪走 env key → wizard 出现，全流程走通 → 引擎点火 → 下一轮 ingest 日志出现新 root 扫描；
- Engine off → banner 出现、日志无 dispatch；on → 恢复。

## 10. 兼容与迁移

- 纯增量：settings 表新键空间，无 schema 迁移（key-value 表无需 ALTER）；
- env 优先保证现有部署升级后零迁移零打扰；subhd/zimuku"默认开"**只在 wizard 路径生效**（步骤 5 出厂 ON、Continue 写库），未设过 env flag 的老部署 bootstrapComplete 推导为 true、永不进 wizard、两字幕源维持关闭——真零行为变化；
- MEDIA_ROOTS env 首启播种逻辑（`settingsRepo.ts:79-84`）不动；
- 已存在 roots/keys 的部署 bootstrapComplete 推导为 true。

## 11. 实现期验证项（plan 阶段落实）

1. Windows 主机路径语义：fs/list 与 DirBrowser 在 `C:\` 风格绝对路径下的展示与校验（研究已确认 POSIX 无问题，Windows 需实测）；
2. assrt/opensubtitles/jimaku 各家"最便宜鉴权调用"的具体端点，以各家 API 文档为准并配 fixture；
3. checkLlm 实现加 `max_tokens=1`，确认目标服务商对该参数行为正常；
4. setLang 的 localStorage 持久化细节以 `useT.ts` 实现为准（已核实：STORAGE_KEY='scout-lang' 在 `:13`，读路径 readStoredLang `:21-29`，写路径 setLang `:45-53`；实现期核对写路径是否顺带触发重渲染机制）。

## 12. 明确不做

- 密钥加密 / master key；
- 独立 dashboard 进程/命令——setup 模式在 watch 进程内解决（dashboard 本就寄居 watch，`server.ts:264` once-per-process；Docker/compose/健康检查拓扑不动）；
- wizard 内收 LLM_EXTRA_BODY、TMDB_PROXY_URL/BASE_URL（env-only 高级项）；
- 多语言切换器 UI（语言联动走 target_languages，既定铁律）；
- 任何卡死/断连专属状态面；
- 翻译 agent 的模型/策略设计；
- 为"测试失败"提供强制放行（硬门禁无后门——用户原话"不给，没法通都不给过"）。
