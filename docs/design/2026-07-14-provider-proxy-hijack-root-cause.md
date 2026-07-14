# 真实测试网络根因:本机 fake-ip 透明代理劫持 assrt + mimo（2026-07-14）

状态：根因已定位（决定性 DNS 证据），解决方向=软路由容器测试单元。**已在软路由验证**——"session destroyed" 消失（见文末「软路由复核」）；软路由上残留的是**另一种、更轻的瞬时 connect timeout**，非本机问题。

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

## 软路由复核（2026-07-14，用户点名"必须查明 mimo 根因"）

在软路由容器里（干净网络，绕开本机 fake-ip 代理）复跑 B 层真模型矩阵，结论分两层——

**① "session destroyed" 已根治。** 挪到软路由后，Mac 上那个"持续负载下代理杀已建连接 → The session has been destroyed"**再没出现过**。证实了病根就是本机 fake-ip 透明代理，挪离即解。

**② 软路由上残留的是另一种、更轻的瞬时故障：`Cannot connect to API: Connect Timeout Error`。** 与①不同——①是**已建连接被中途销毁**，②是**初始 TCP/TLS 连接建不起来**。特征：
- **成簇**：矩阵 12 跑里有 3 跑 THREW（normal-missing run1、realign-and-find run1+2），连续、然后自行恢复；其余 9 跑正常。
- **判断层零污染**：这 3 个 FAIL 全是网络 THREW，模型压根没跑起来（`tools=` 空）；凡 mimo 真回的响应，orchestrator 判断 **13/13 全对**（含 realign-and-find 重跑 4/4、零误触发、零 realign-gate 泄漏）。所以 9/12 是网络分，不是 B 层分。

**探针定性（容器内 node，与失败调用同一 undici/fetch 栈，最忠实复现）：**
```
target token-plan-sgp.xiaomimimo.com/v1
dns → 47.245.105.117, 47.236.158.11, 47.84.2.69, 47.237.8.234,
      47.236.158.71, 47.84.235.191, 8.222.147.102, 8.222.143.90   （8 个阿里云海外 IP 池）
seq   12/12 CONNECT_OK  ~385ms 稳定
burst 12/12 CONNECT_OK  0.4–1.8s（并发下变慢但全成）
SUMMARY seq=12/12 burst=12/12   ← 探针当下 100% 连通，复现不出失败
```

**②的根因判读**：端点是 **8-IP 阿里云池**，undici 每条连接挑一个 IP。China→SGP 上游中转对**池里某子集 IP 间歇性黑洞**时，那一跑正好连到坏 IP 就 connect timeout；而 AI SDK 的 3 次重试在短窗内**复用同一坏连接/坏 IP**，于是整跑作废、且失败成簇。探针此刻 24/24 全过 = 坏窗口是**瞬时**的、来去自走。**这不是我方配置 bug，是上游中转的间歇丢包**——`是mimo 的问题还是什么` 的答案：是 mimo 端点海外中转的瞬时可达性，不是本项目、不是 undici、也不是（软路由上的）本机代理。

**持久解 = defense-in-depth（下一步实施）**：应用层重试要做到 (a) 次数够（默认 maxRetries=2 不足以熬过一个坏窗口）(b) 退避 (c) **重试时重建连接、强制重新解析** → 让下一次落到池里另一个好 IP，而非死磕同一坏连接。纯网络侧无解（中转丢包在我方控制外）。

## 待用户提供（裁剪容器集群用）

软路由具体环境决定要不要调整：①是否装了 Docker（没有则退化成"任一 Linux 盒子上 `npm ci && npx tsx`"）②架构（node:22-slim 多架构已覆盖 amd64/arm64，MIPS 软路由需换基础镜像）③软路由到 assrt/mimo 是否确实干净（不经 fake-ip）。给我这三点我把 compose 裁到位。

## 待办 / 风险（记账）

- **生产同病风险 + 瞬时 connect-timeout 加固**（合并为一件 defense-in-depth 事）：①NAS 生产 daemon 若也经同款 fake-ip 代理，持续跑会撞 session-destroyed（真正修法仍是稳定网络路径）；②软路由复核暴露的瞬时 connect-timeout（上游中转对 8-IP 池子集的间歇黑洞）也靠同一层兜——重试次数够 + 退避 + **重连/重解析**（换池里另一个 IP），而非 AI SDK 默认 maxRetries=2 且复用坏连接。下一步实施，附确定性单测（mock fetch 首次 connect 失败、重试换连接后成功）。
- OrbStack recipe（scripts/run-live-matrix-in-orbstack.sh）在本机 OrbStack（arm64 同架构）bind-mount 本机 node_modules 能用,但**不可照搬到异架构软路由**——软路由用本 compose。
