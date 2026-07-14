# 真实测试网络根因:本机 fake-ip 透明代理劫持 assrt + mimo（2026-07-14）

状态：根因已定位（决定性 DNS 证据），解决方向=软路由容器测试单元。

## 症状

- **assrt 下载失败**（2026-07-14 真录制）：录制器搜/详情成功、下载某剧场版字幕时 `TypeError: fetch failed / UND_ERR_SOCKET: other side closed`，远端 IP `198.18.78.160`。
- **mimo 会话销毁**（B 层真模型矩阵）：连跑 12 个 orchestrator 跑到一半，`AI_APICallError: Cannot connect to API: The session has been destroyed`（AI_RetryError 重试 3 次仍败），7/12 作废；但单形状 normal-missing×2 单独跑成功。**load / 连跑序列相关。**

## 根因（决定性证据）

本机 DNS 解析：
```
mimo  token-plan-sgp.xiaomimimo.com → 198.18.79.154
assrt api.assrt.net                → 198.18.71.8
```
`198.18.0.0/15` = RFC2544 基准测试保留段，也正是 **Clash/Surge/软路由 fake-ip 模式**给"命中代理规则的域名"分配的假 IP（再由透明代理拦截转发）。**mimo 的 LLM API 和 assrt 都命中了这个本机透明代理。**

- 短交互能扛（A 层 find 大多成功、assrt search/detail 录到了）；
- **持续负载 / 长连接下代理把会话销毁**（sustained LLM 批跑、大文件下载）→ socket 被关 / session destroyed。

**不是 mimo 服务端问题、不是 undici、不是本项目代码——是本机 fake-ip 透明代理在持续负载下不稳定。** 两个症状同一个病根。

## 解决方向

把**真实测试**（真 provider + 真模型的持续批跑）挪到**不经过本机这个不稳代理**的网络路径——即软路由（或任一网络能干净直达/稳定代理到 assrt/mimo 的主机）。离线单元测试（`npm test`，脚本模型 + 重放/内存）不受影响，继续在任何机器跑。

**额外收益**：在软路由上跑 `record-provider-responses.ts` 能录到真 assrt 下载（本机被劫持下不来的那一步在软路由上能成），把合成夹具换成真数据。

## 部署：容器测试单元（`docker-compose.test.yml`）

架构可移植（`node:22-slim` 多架构），**关键：node_modules 走 named volume、容器内 `npm ci`**——绝不把开发机（Mac arm64）的 node_modules 拷到异架构软路由（better-sqlite3 等原生模块架构相关会崩）。

在软路由上（已装 Docker）：
```bash
# 1. 同步本仓（含 .env）到软路由，cd 进去
# 2. 一次性装依赖（容器内、架构正确）
docker compose -f docker-compose.test.yml run --rm test npm ci
# 3. 跑任意 out-of-band runner（网络走软路由的干净路径）
docker compose -f docker-compose.test.yml run --rm test npx tsx scripts/run-orchestrator-matrix.ts --repeat 2   # B 层智能闸门
docker compose -f docker-compose.test.yml run --rm test npx tsx scripts/run-live-matrix.ts --all               # A 层找字幕
docker compose -f docker-compose.test.yml run --rm test npx tsx scripts/record-provider-responses.ts --type anime --form season-pack --title "進撃の巨人" --original "Attack on Titan"   # 录真 assrt
```

## 待用户提供（裁剪容器集群用）

软路由具体环境决定要不要调整：①是否装了 Docker（没有则退化成"任一 Linux 盒子上 `npm ci && npx tsx`"）②架构（node:22-slim 多架构已覆盖 amd64/arm64，MIPS 软路由需换基础镜像）③软路由到 assrt/mimo 是否确实干净（不经 fake-ip）。给我这三点我把 compose 裁到位。

## 待办 / 风险（记账）

- **生产同病风险**：NAS 上的生产 daemon 若也经同款 fake-ip 代理,持续跑会撞同样的 session-destroyed。缓解=defense-in-depth（AI SDK maxRetries 调大 + provider 连接失败退避重试),但真正的修法仍是稳定网络路径。排优先级后做,非本次。
- OrbStack recipe（scripts/run-live-matrix-in-orbstack.sh）在本机 OrbStack（arm64 同架构）bind-mount 本机 node_modules 能用,但**不可照搬到异架构软路由**——软路由用本 compose。
