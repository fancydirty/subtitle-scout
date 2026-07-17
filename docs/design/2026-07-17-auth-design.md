# 鉴权战役 · Spec（2026-07-17）

出处：dashboard 战役 R2 双签归档项（R2D-5 无 token 写面质变仅靠告警过渡、R2D-2 fs/list 裸机
全盘枚举），登记册 §八"发布前必做"。用户裁决：照抄 Sonarr 式单管理员。

## 目标

DASHBOARD_TOKEN 裸奔时代结束：单管理员用户名+密码，首启向导设置，session cookie + API key
双通道。公开发布的硬前置。

## 1. 凭据与存储

settings 表三键：`auth_username`、`auth_password_hash`（node:crypto scrypt，`盐:哈希` 格式，
零新依赖）、`auth_api_key`（随机 32 hex，供脚本/未来集成）。未设置=未初始化态。

## 2. 服务端门（server.ts 统一前置）

- 未初始化：仅放行 `POST /api/v2/auth/setup`（写三键，一次性——已初始化后 403）与静态资源；
  其余 API 一律 401 `{error:'setup required'}`。
- 已初始化：`POST /api/v2/auth/login`（scrypt 校验→签发 httpOnly session cookie，随机 token
  存内存 Map+滚动过期 30 天）/`POST /api/v2/auth/logout`；请求鉴权=cookie 或 `X-Api-Key` 头
  或 `?apikey=`（SSE/EventSource 无法带头，query 放行）。
- DASHBOARD_TOKEN 兼容：设置了旧 token 的部署继续接受它（等价 api key），启动告警改为
  "建议迁移到账号密码"；无任何鉴权+已初始化=不可能态。R2D-5 高声告警退役。
- 安全边界如实：无 HTTPS（家庭局域网部署形态，README 注明反代加 TLS 的建议）；登录失败
  节流（内存计数，5 次/分钟）。

## 3. 前端

- `/setup` 向导页（未初始化时全路由重定向）：用户名+密码+确认，成功即登录。
- `/login` 页：极简（DESIGN.md 语汇，serif 只此一处的仪式感可用在标题）。
- api client 统一 401 处理→跳 login；Settings 加「Security」区：改密码（需旧密码）、
  重生成 API key（脱敏显示尾 4 位+复制按钮）。
- 双语（Settings/登录页正常本地化；Workflow 区不涉及）。

## 4. 非目标

多用户/角色；OIDC/反代 SSO 透传（README 提反代方案即可）；HTTPS 内建。

## 验收口径

未初始化首访→向导；设置后未登录 API 全 401（含 SSE）；登录后四 tab 正常+SSE 通；
X-Api-Key 走通 curl；旧 DASHBOARD_TOKEN 部署无破坏。
