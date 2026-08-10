# 开源发布设计：subtitle-scout 公开仓首发

日期：2026-07-09
状态：已批准（§1–§9 用户逐节确认）

## 背景与目标

subtitle-scout（Jellyfin 中文字幕自动侦察兵）已完成 M1–M5b + dashboard + 遗留清理，
236 测试全绿，生产运行验收（软路由双容器挂真实 NAS 库）。本次 milestone：以公开
GitHub 仓 + 公共镜像形式开源发布。

**成功标准（用户视角）**：一个不认识作者、不知道 Cloudflare 是什么的 Jellyfin 用户，
只看公开仓 README，能在装了 Docker 的机器上从零把服务跑起来，并用 `doctor` 命令
自证接线正确。

**风险认知**：核心逻辑可移植（236 测试焊住），陌生环境真正的翻车点是环境接线——
路径映射（最大）、LLM 能力差异、ASSRT 生态预期。本设计用 doctor 命令 + README
分岔教程直接工程化回应。

## §1 发布形态与身份

- 新建公开仓 `fancydirty/subtitle-scout`，MIT license。
- 从当前 main 取净化快照，**单个 initial commit（squash 首发）**，作者用 GitHub
  noreply 邮箱。脏历史（内网 IP、个人邮箱、内部文档）不带走。
- 当前私有仓保留为只读存档（120 commit 演进史本地留查）。
- 版本从 `v0.1.0` 起，打 tag 触发镜像发布。

## §2 公开仓内容清单

### 进
`src/`、`web/`、`fixtures/`、`Dockerfile`、`docker-compose.yml`（净化）、
`docker-compose.bundle.yml`（新增，见 §9）、`vitest.config.ts`、`tsconfig.json`、
`package.json`（补字段）、`.env.example`（净化）、`.gitignore`、`README.md`（重写）、
`LICENSE`（新增）、`docs/adapting.md`（新增，见 §8）、`.github/workflows/`（新增，见 §4）。

### 不进
- `worker/`（Cloudflare ASSRT 中继，作者私用；主代码本就直连 api.assrt.net，剥离零影响）
- `docs/superpowers/`（约 1 万行内部 spec/plan 过程稿）
- `deploy/`（含个人 ssh 别名 `media-router-tunnel`、`/mnt/nvme0n1-4` 路径）
- `docs/cloudflare-worker.md`、`docs/product-shape.md`（内部文档，含个人路径/域名）
- 各 untracked 工作目录（`scratch/`、`.superpowers/`、`.serena/`、`.wrangler/`）天然不进

### 净化（当前 tracked 内容中的个人痕迹，快照前处理）
- `.env.example`：`LLM_BASE_URL` 从小米 MiMo 私有网关改为通用 OpenAI-compatible 示例；
  `LLM_MODEL` 同步改；整体从"个人配置快照"改写成通用模板。
- `docker-compose.yml`：媒体挂载路径改占位符（如 `/path/to/media`），加注释指引。
- `package.json`：补 `license: "MIT"`、`repository`；**保留 `private: true`**
  （发布物是镜像不是 npm 包，防误发）。
- 快照后全仓 grep 验收：`192.168.`、`dirtyfancy`、`gmail`、`mnt/nvme`、
  `media-router-tunnel`、`workers.dev`、`xiaomimimo` 零命中。注意 `fancydirty`
  作为 GitHub 公开身份（repo 地址、ghcr 镜像名）允许出现，不在清单内；
  fixtures 中公开电影文件名与 ASSRT 公网 IP 属公开信息，亦不在此列。

## §3 README 重写

面向普通 Jellyfin 用户，中文为主，开头即分岔两条上手路：

1. **已有 Jellyfin（默认路）**：`docker-compose.yml` 独立版，填现有 Jellyfin 地址。
2. **从零全家桶**：`docker-compose.bundle.yml`，Jellyfin + scout 一起拉起。

三把钥匙的申请路铺平（各配步骤，不假设用户懂技术）：
- **ASSRT token**：注册 assrt.net → 用户中心复制 token。明说配额 5 次/分钟、
  程序已自动限速 4/min 用户无感、ASSRT 对欧美剧集覆盖有限的预期管理。
- **LLM key**：任意 OpenAI-compatible 端点（OpenAI/DeepSeek/硅基流动等均可），
  给最低能力建议（自适应探针会自动降级策略，但排序质量随模型走）。
- **Jellyfin API key**：控制台 → API 密钥的取法截图级步骤。

快速上手第一个命令就是 `doctor`（见 §7）；另含：dashboard 一节（8099 端口、
可选 DASHBOARD_TOKEN）、排障 FAQ（路径映射对不上/只读挂载/配额烧完的表现与解法）、
"适配 Emby 等其他服务器"一节指向 `docs/adapting.md` 并欢迎 PR。

## §4 CI/CD（GitHub Actions）

- `test.yml`：push/PR 触发，`tsc --noEmit` + `vitest run`（236 测试）。
- `release.yml`：推 `v*` tag 触发，buildx 构建 **linux/amd64 + linux/arm64**
  双架构镜像推 `ghcr.io/fancydirty/subtitle-scout`（tag: 版本号 + latest）。
  软路由类 arm 设备直接可用。

## §5 日常开发流转（发布后）

- **公开仓转正为唯一开发主仓**，不搞双仓同步。
- 本工作目录：remote 指向公开仓；`deploy/`、`worker/`、`docs/superpowers/`、
  内部 docs 转为本地 untracked（加 `.gitignore`，文件留磁盘，部署流程不变）。
- 旧私有仓只读存档。

## §6 验收标准

1. 全新环境（无任何本项目状态的机器/目录）按 README 两条路各走一遍，
   `docker compose up -d` 后 `doctor` 五项全绿。
2. 净化 grep 清单（§2）零命中。
3. CI 两条 workflow 真实跑绿：PR 测试 + tag 出双架构镜像，`docker pull` 可用。
4. 陌生人视角通读 README 无"作者私有环境才懂"的暗设。

## §7 `doctor` 预飞自检命令

`subtitle-scout doctor`：顺序检查五件事，每项 ✓/✗ + 人话诊断 + 修复指引，
任一失败 exit 非零：

1. **Jellyfin 可达**：baseUrl 连通 + API key 有效（打一个轻量端点）。
2. **ASSRT token 有效**：打配额查询端点，顺带显示剩余配额。
3. **LLM 端点可用**：完成一次最小对话调用。
4. **媒体目录可写**：复用现有 `isDirWritable` 真实试写探针。
5. **路径映射一致**：取 Jellyfin 报告的库路径，逐一验证在本容器内存在且可写——
   直接命中"scout 容器挂载与 Jellyfin 路径对不上"这个陌生人最大坑。

现有探针代码（写探针、ASSRT quota、LLM probe）尽量复用，主要工作是串联 + 文案。
README 快速上手把 doctor 作为起服务后第一步。

## §8 多服务器适配（三层姿势）

- **做**：从 JellyfinClient 实际被消费的方法面（getSessions、getRecentItems、
  getItemDetail、refreshItem、getChineseTitle、getSeasonEpisodes 等约六个）抽出
  显式 `PlayerServer` 接口；JellyfinClient 实现之；调用点（cli/watcher/triggers/
  mediaContext）改依赖接口。行为零变化，测试不动。
- **写**：`docs/adapting.md` 适配指南：接口契约逐方法说明（语义、入出参、失败约定）
  + **一段可直接投喂用户自家 coding agent 的适配提示词**（"为 X 服务器实现
  PlayerServer 接口"的完整上下文）。
- **不做**：EmbyClient 本体。无 Emby 活体验收环境，违背项目"活体验证才算数"家规。
  README 明说 Emby 与 Jellyfin API 同源、预计改动很小、欢迎 PR（社区第一个贡献磁铁）。

## §9 compose 双路

- `docker-compose.yml`（独立版，默认）：只起 scout，环境变量指向用户现有 Jellyfin。
- `docker-compose.bundle.yml`（全家桶）：Jellyfin + scout 双容器，媒体目录一次挂好
  ——即作者生产环境已验证拓扑的通用化。
- 两条路的验收都是 doctor 五项全绿。

## 非目标（本次明确不做）

- EmbyClient / PlexClient 实现
- npm 包发布
- git filter-repo 历史清洗（已选 squash 首发）
- worker/ 开源、docs/superpowers/ 公开
- live SSE、通知通道（M6 另立）

## 实现顺序建议（供 writing-plans 参考）

净化与内容整理 → doctor 命令 → PlayerServer 接口抽取 → compose 双路 + README +
adapting.md → CI workflows → 新仓创建与首发 → 真实环境双路验收 → 本仓 §5 流转切换。
