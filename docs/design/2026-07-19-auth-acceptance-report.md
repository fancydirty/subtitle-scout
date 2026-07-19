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

## 执行方式备忘

A1/A3 服务端 + A4 由主控主循环亲跑（TDD 逐 task 红-绿-亲核-提交）；A2/A3 前端因 **opencode 派 web/ 写任务两次卡死**（K3 2h、luna 10min 均零产出，诊断为 agentic 循环卡等 LLM/serena MCP，非模型问题）改主循环亲跑。执行器阶梯与卡死判据见记忆 [[subagent-executor-kimi-k3]]。
