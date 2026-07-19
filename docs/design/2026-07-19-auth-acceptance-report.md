# 鉴权战役 A1-A4 · 验收终报（2026-07-19 夜，无人值守）

spec：[2026-07-17-auth-design.md](2026-07-17-auth-design.md)；计划：[../superpowers/plans/2026-07-19-auth-a1-a4.md](../superpowers/plans/2026-07-19-auth-a1-a4.md)。
调研：[design-recon-auth-pages.md](../../.. 见 scratchpad)（Sonarr/jellyfin-web/Overseerr 真源码 + issue 血泪敲骨吸髓）。

## 成果

DASHBOARD_TOKEN 裸奔时代结束：Sonarr 式单管理员（用户名+密码，首启向导），session cookie + API key 双通道，旧 DASHBOARD_TOKEN 全程等价 api key 兼容零破坏。

**commit 序（全部 main，每个 commit 门禁全绿）**：
- `d25e2f8` A1 凭据纯逻辑层（scrypt/30 天滚动会话/登录节流/AuthService）
- `c773b21` A1 server 统一前置门 + 四端点 + 撤 8 处散布 token 门
- `4c5e05a` A1 fs/list R2D-2 回归钉死
- `50629af` A2 前端全套（AuthShell 共享 serif/AuthField 密码管理器契约/SetupWizard/LoginPage/App 门）
- `d7f3081` A3 服务端 Security 三端点
- `2881c75` A3 SecuritySection（改密 + api key 脱敏/复制/重生成）
- `de81533` A1 硬化（密码阈值 8→10 + setup 三键原子事务）
- `3eb48c4` A3 侧栏登出入口
- `4d63021` A4 启动播报三态 + auth reset CLI
- `3d14985` A4 README + .env.example

## 验收口径逐条核

| spec 验收项 | 结论 | 佐证 |
|---|---|---|
| 未初始化首访 → 向导 | ✅ | server.test.ts「未初始化：/api/v2/library 401 setup required」+ App.test.tsx「initialized:false → SetupWizard」 |
| 设置后未登录 API 全 401（含 SSE） | ✅ | server.test.ts「SSE trace-stream 走 ?apikey=」含未带凭据 401 分支 |
| 登录后四 tab 正常 + SSE 通 | ✅ | App.test.tsx 外壳冒烟（auth/status authenticated:true → Shell 四 tab）+ SSE same-origin cookie 自动携带 |
| X-Api-Key 走通 curl | ✅ | server.test.ts「X-Api-Key 头与 ?apikey= query 都走通」 |
| 旧 DASHBOARD_TOKEN 部署无破坏 | ✅ | server.test.ts「legacy DASHBOARD_TOKEN：未初始化+带旧 token → API 照常通」+「已初始化后 legacy token 仍等价 api key」 |
| R2D-2 fs/list 未鉴权枚举关闭 | ✅ | server.test.ts「fs/list 收口」两条 |
| auth reset 找回密码 | ✅ | **真机端到端烟测**：setup→auth reset CLI→initialized false（真进程真 db，2026-07-19 夜） |

## 门禁

- 根：`vitest run` **1700 passed** + `tsc --noEmit` exit 0
- web：`vitest run` **266 passed** + `tsc --noEmit` exit 0 + `vite build` 通过（auth 组件正常打包）

## 调研折入的强建议（超出原 spec，敲骨吸髓自高星仓）

单屏建管理员 + **auto-login**（避 *arr/Jellyfin 最烂共性"重打刚建凭据"）；**AuthShell 共享 serif**（全站唯一衬线，暗色极简版 Overseerr backdrop）；**密码管理器契约**（autocomplete username/current-password/new-password，禁 off/data-*ignore）；show-password + 上手期长度提示；登录错误精确文案 + username 保留 + password 清空聚焦；**诚实找回**（auth reset CLI 背书文案，不展示不存在的命令）；api key 一次性全显 + tail-4 脱敏 + **regenerate 陈述爆炸半径** + 即时生效；密码阈值 10 + setup 原子事务（Jellyfin 未授权改密 CVE 延伸）。结构性白赚 *arr #6144 stale-cookie 循环 / #6454 deep-link 丢失（AuthGate 包裹架构天然免疫）。

## 遗留：生产部署待用户在场

**代码/测试/文档/验收全绿，但生产部署故意留给用户在场时做**——理由：部署后首个访问未初始化实例的人即可设管理员密码（setup race，LAN 低风险但真实）。用户应在能立即自己走首启向导时部署，避免他人抢注 admin。部署走既有协议（git archive→build→备 DB→up），legacy token 若已设则全程零破坏，未设则用户首访即进向导。

## 对抗性审计轮（2026-07-20 凌晨，3 只读代理：安全/正确性/前端）

审计确认**前置门无旁路**（编码路径对称、setup race 安全、settings-key 注入已闭、verifyApiKey 常量时间且崩溃安全、session 熵/cookie flags 恰当、serif 唯一性/密码管理器契约/标签关联合规）。查出的真洞已全修：

**后端安全（commit cc8a32a）**：
- MEDIUM：改密撤销全部会话 + 给发起者补发新 cookie（凭据轮换让被盗会话立即失效）
- LOW：legacy token `===` → `safeStrEqual`（常量时间，消时序侧信道）
- LOW：登录节流改只计失败（成功不消耗预算，合法管理员不被别人的失败连累）

**前端 a11y/DESIGN（commit e7540c5）**：aria-describedby 关联密码提示 / show-password aria-pressed + 防文本压钮 / 错误文字与未满足提示补到 AA 对比度 / 焦点 2px 环 / role=alert / **regenerate window.confirm → Astryx AlertDialog**（DESIGN §5）/ apiKey 屏复制后 Continue 升 primary / 找回文案去脆弱 .replace。

**correctness（commit 18bb3d4）**：探测失败改**连接错误屏 + 重试**（不再误显 LoginPage 让 fresh install 用户对着"密码不正确"的假象）+ 探测 8s 超时（防挂起服务器永久白屏）。

终态：根 **1707** + web **271** 全绿，双 tsc 净，web 构建过。

### 遗留（LOW / 产品·配置决策，留用户拍板，未擅动）
1. **setup TOFU**：首访未初始化实例者可抢注 admin。缓解=部署时用户在场立即走向导（已采纳）。可选加固=首启在 daemon 控制台打印一次性 setup 码并要求 setup 时提交（Syncthing/HA 式），代价是牺牲"开 URL 即走"的 LAN 便利——需用户权衡。
2. **登录节流 trustProxy**：`remoteAddress` 在反代后塌成单桶（可被连累锁死）。修法=可配置的 `X-Forwarded-For` 信任（trustProxy 开关）——需用户定是否引入该配置。
3. **cookie Max-Age（30d 固定）vs 服务端会话滚动过期**：每日活跃用户会在登录满 30 天时被动登出（服务端本会续期）。修法=认证响应periodically 重发 cookie（每响应 set-cookie 开销）或改绝对过期——rolling vs absolute 是设计取舍。
4. 静默 logout 失败（服务器在但 logout POST 单独失败）会弹回 Shell（LOW，罕见）；apiKey 仅存 React state（当前安全，结构脆弱）；`?apikey=`/`?token=` query 会进反代日志（SSE 必需，属既有权衡）。

## 执行方式备忘

A1/A3 服务端 + A4 由主控主循环亲跑（TDD 逐 task 红-绿-亲核-提交）；A2/A3 前端因 **opencode 派 web/ 写任务两次卡死**（K3 2h、luna 10min 均零产出，诊断为 agentic 循环卡等 LLM/serena MCP，非模型问题）改主循环亲跑。执行器阶梯与卡死判据见记忆 [[subagent-executor-kimi-k3]]。
