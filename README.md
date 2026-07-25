# subtitle-scout

subtitle-scout 盯着你的媒体库，自动找到、验证并放好最合适的中文字幕。它不是又一个字幕下载器——它是一层带判断力的匹配智能：宁可不下，也不下错。直接扫描媒体根目录识别文件，不依赖任何媒体服务器（Jellyfin/Emby/Plex 等）——装不装、用哪个播放器都与它无关，字幕落盘后你的播放器该怎么刷新怎么刷新。

**核心能力**：自动发现缺中文字幕的影片 → 搜索并用大模型挑最合适的 → 验证后放到位；支持剧集整季打包下载；剧集目录/命名跟 TMDB 排布对不上时自动整理（可回滚）；自带监控页，处理记录可查。

---

## 快速上手

三步：

```bash
cp .env.example .env
# 编辑 .env，填入三把钥匙（见下一节）与 MEDIA_HOST_PATH
docker compose up -d
```

想同时跑一个 Jellyfin 当播放器（和 scout 的字幕功能完全无关，纯粹图省事）？见 `docker-compose.bundle.yml`。

---

## 三把钥匙：怎么拿

subtitle-scout 需要三组凭据：ASSRT 字幕库、大模型、TMDB（识别文件用，硬性必填）。

### 1. ASSRT Token

**获取步骤**：
1. 注册 [assrt.net](https://assrt.net)
2. 登录后进入"用户中心"
3. 复制 API token，填入 `.env` 的 `ASSRT_TOKEN`

**预期管理**：
- **配额约 5 次/分钟**，程序已自动限速，无需操心
- **ASSRT 对欧美剧集覆盖有限**："暂时没找到合适的字幕"是正常结果，不是故障

### 2. 大模型 API Key

**任意 OpenAI-compatible 端点均可**（DeepSeek、OpenAI、硅基流动等）。需要配置三件套：

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` | 如 `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 对应端点的 API key |
| `LLM_MODEL` | 模型名，如 `deepseek-chat` |

**关键**：三项必须来自**同一个服务商**。模型能力影响匹配质量。

### 3. TMDB API Key（硬性必填）

subtitle-scout 直接扫描媒体根目录发现文件，靠 TMDB 识别标题/年份/季集排布——**没有这把钥匙，`watch`/`reconcile-all` 会直接报错退出**，不会悄悄跑一个"什么都识别不了"的空转进程。

**它还顺手解决一个召回率问题**：字幕库按标题的**具体变体**分区索引，而同一部片的中文译名往往有好几个变体。以生产实例《爱，死亡和机器人》为例，它在各处的官方/民间译名分裂成：

- 「爱，死亡和机器人」（官方译名，用「和」）
- 「爱死亡与机器人」（用「与」）
- 「爱、死亡 & 机器人」（用顿号 + &）

「和」≠「与」，字幕站把它们分在不同的搜索分区里。只拿到一个变体，就只搜得到那一个分区的字幕；拿到**全部变体**，召回率立刻上一个台阶。TMDB 的 `/alternative_titles` 接口正好躺着一部片在 CN/TW/HK 区的全部译名变体。

**怎么申请**（免费）：

1. 注册 / 登录 [themoviedb.org](https://www.themoviedb.org)
2. 右上角头像 → **设置（Settings）**
3. 左侧 **API** → 申请一个 **Developer** key
4. 复制 key（v3 的 32 位 key 或 v4 的 Read Access Token 都支持，程序自动识别认证方式）

**填哪**：`.env` 的 `TMDB_API_KEY`。填完重启 scout 即生效。

### OpenSubtitles（可选）：第二字幕源

ASSRT 主打国产字幕站，欧美剧集/电影覆盖有限；OpenSubtitles 是 ASSRT 之外的第二数据源，专门补这块——同一部片，中文字幕这边常有 ASSRT 搜不到的补充。

**怎么申请**（免费）：

1. 注册 [opensubtitles.com](https://www.opensubtitles.com) 账号
2. 进入 [API Consumers](https://www.opensubtitles.com/en/consumers) 建一个 API consumer（名字仅限字母数字）
3. 复制生成的 key，填入 `.env` 的 `OPENSUBTITLES_API_KEY`

**可选加成**：额外填 `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD`——登录后免费档 20 次下载/天；不填则走匿名档，5 次/天。创建 consumer 时勾选 "Under development" 可拿到 100 次下载/天，开发期很够用。

> 搜索本身不耗配额，只有实际下载才扣；doctor 的探测请求（搜索《黑客帝国》）不会碰下载额度。没有 key 也能跑：这是纯增益的第二数据源，不配置就自动跳过，不阻塞主流程。

---

## 起完先体检：doctor

启动后**先跑一遍 doctor**，确认接线正确：

```bash
docker compose exec subtitle-scout node dist/cli/index.js doctor
```

**示例输出**：

```
✓ tmdb  TMDB API key 有效
✓ assrt  ASSRT token 有效，当前配额余量 180
⊘ opensubtitles  未配置(可选 provider)——设 OPENSUBTITLES_API_KEY 启用
⊘ zimuku  未配置(可选 provider,灰色站点条款风险自担)——设 ZIMUKU_ENABLED=true 启用
✓ llm  LLM 端点可用，最小对话成功
✓ media-roots  2 个媒体根目录全部可写
✓ mount-capabilities  挂载能力画像 — /media/movies（硬链接: 支持, 大小写敏感: 是, 可写: 是）...
✓ database  数据库可用，schema 版本 16
✓ stuck-jobs  无卡住任务

接线检查通过，可以起 watch 了。
```

如果某项显示 `✗`，按提示修复后重跑。`⊘` 是跳过（可选项未配置），不算失败。

---

## 监控页

访问 `http://<主机IP>:8099`（端口可通过 `DASHBOARD_PORT` 自定义）：

- 每部剧/电影的字幕覆盖状态一览（哪几集缺、哪几集处理中、哪几集暂时没找到）
- 全局运行历史：每次处理的结果 + 一行人话摘要（选了谁、为什么，或为什么没找到），出问题可查

### 账号鉴权（单管理员）

首次访问监控页会进入**创建管理员向导**（用户名 + 密码，密码至少 10 位）。设置后：

**⚠️ 安全提示**：首次启动后请**立即**完成管理员向导！未初始化状态下，`/api/v2/auth/setup` 端点对局域网完全开放——**局域网内任何人都能抢先创建管理员账号**接管你的实例。如果需要在不可信网络环境暴露，请先：
- 配置 `DASHBOARD_TOKEN`（老部署兼容方案）
- 或改 docker-compose.yml 的 ports 为 `127.0.0.1:${DASHBOARD_PORT:-8099}:...` 再用反向代理加鉴权

- 用**账号密码登录**，会话以 httpOnly cookie 保持（30 天滚动过期）。
- 同时生成一个 **API key**（32 位十六进制，向导页一次性完整显示，之后在「设置 → 安全」里以脱敏尾 4 位展示，可复制或重新生成）。脚本/集成用 API key 调接口：

  ```bash
  curl -H 'X-Api-Key: <你的-api-key>' http://<主机IP>:8099/api/v2/library
  # 或（SSE/EventSource 无法带头时用 query）
  curl 'http://<主机IP>:8099/api/v2/library?apikey=<你的-api-key>'
  ```

- **忘记密码**：没有邮件找回（自托管形态），在服务器上运行 `docker compose exec subtitle-scout node dist/cli/index.js auth reset` 清除管理员凭据，下次访问重新进入创建向导。

**旧 `DASHBOARD_TOKEN` 兼容**：已设该变量的老部署继续有效——它等价于一个 API key（`?token=<值>` 或 `X-Dashboard-Token` 头仍被接受）。建议在向导里建好账号后**移除** `DASHBOARD_TOKEN`，改用账号密码。

**无内建 HTTPS**：监控页面向家庭局域网，自身不做 TLS。如需从公网访问，请在前面加一层反向代理终止 TLS，例如 Caddy：

```
scout.example.com {
    reverse_proxy 127.0.0.1:8099
}
```

（Caddy 自动申请证书；nginx/Traefik 同理，把 `:8099` 反代出去即可。）

---

## 它怎么工作

五步白话：

1. **自扫描发现**：程序周期性直接扫描媒体根目录（不依赖任何媒体服务器的播放/入库事件），把新出现或变化的路径解析出剧名/季集号并配上 TMDB，直接写自己的库（SQLite），判定这一集/这部片是否已有目标语言字幕
2. **智能调度**：发现变化后派发一次编排判断——先核对这部剧实际的目录/命名排布是否跟 TMDB 季表对得上，对不上就先派"整理"任务把文件挪回该在的位置（多层安全校验：先出计划、留痕可回滚、失败不改一个字节），排布没问题才派"找字幕"任务
3. **搜索候选**：大模型驱动的搜索 worker 自己规划搜索词（原名 + 中文译名 + 年份等组合），调用 ASSRT / OpenSubtitles 等字幕站 API
4. **挑最靠谱**：候选逐个下载进一次性沙盒目录，结构性体检（cue 数量级、时间轴跨度是否匹配片长、简繁判定、编码可解码性等）之后，大模型看着这些证据终审"是/不是这一集"
5. **验证写盘**：确认后把字幕写到视频同目录——你用的媒体服务器（Jellyfin/Emby/Plex 或者压根没有）该怎么发现这个新文件是它自己的事，scout 不参与也不需要参与

每次决策都在监控页留一行人话摘要（选了谁、为什么，或为什么没找到），可查处理历史。

---

## 命名最佳实践

自扫描能不能一次认出一个文件，八成看命名。推荐结构：

```
Title (Year)/Season NN/Title SNNENN.ext
```

例：`Spy x Family (2022)/Season 01/Spy x Family S01E01.mkv`。剧名+年份的目录一层，季目录 `Season NN` 一层，文件名带 `SxxEyy` 编号——三者任一缺失都会增加识别失败的概率，但不是"必须一字不差"：

- **发布组标记**（如 `[SubsPlease] Show - 01 [1080p].mkv`）不影响识别，识别层认得这类命名；救援官战役（见下）还会用这个标记辅助判断"硬字幕假定"。
- **裸番号/绝对集号**（平铺目录、无季文件夹、文件名只有一个数字）能识别，但多季剧下存在歧义——系统会诚实停车而不是瞎猜，人工在监控页「甄别」tab 认领一次即可（认领会同时告诉系统这是第几季，救活整个目录）。
- **完全认不出的命名**（无年份、无集号、纯代号文件名）进入停车场，救援官会先尝试用目录名+文件结构+TMDB 反查自动确认；确认不了的会留下人话理由，供你在「甄别」tab 手动认领。

### 救援官：清理停车场

停车场里的文件（自扫描认不出来的）不需要你一条条手动认领——「甄别」tab 的编排任务会派发一次"救援识别"：agent 拿着目录名、文件清单、文件时长去反查 TMDB，能确认的自动认领入库，拿不准的留在停车场并写清楚理由（宁可留停车，不猜错）。

三类特典/花絮文件的处理：

- **NCOP/NCED/PV/CM/Trailer/Menu** 这类命名一律不会被误认成正片——机械层直接识别并归入「甄别」tab 的「Excluded extras」箱（默认折叠），不会占用救援官的判断预算。这条规则需要在设置页打开 `exclude_extras` 才生效（默认关闭，保守起见）。
- **SP/OVA/OAD/Special** 字样的文件不在机械黑名单里——这类内容有时是有正式字幕的剧情向特典，救援官会用"TMDB 是否有对应的 Season 0 条目"或"时长是否 ≥15 分钟"来判断，能确认就正常入库，判断为纯映像花絮就归入 Excluded extras 箱。
- 误判随时可以在「Excluded extras」箱里点 Restore 翻案，文件会重新进入正常识别流程。

### 硬字幕（烧录字幕）

有些资源的字幕是直接烧进画面里的，根本不存在可以下载的外挂字幕文件。设置页的 `hardsub_mode` 三档决定怎么处理这种情况：

- **`off`**（默认）：不做任何硬字幕假定，找不到外挂字幕就正常报"没找到"，下次还会重试。
- **`agent`**：找字幕的 agent 在彻底搜索无果后，如果文件名带发布组标记（`[Group]` 这类括号标记），会判定"字幕已烧录，无需外挂"，标注为已覆盖（但不是绿色的"外挂字幕已确认"，是独立的"硬字幕假定"样式）。
- **`aggressive`**：跳过 agent 判断，只要探针确认文件确实没有任何内嵌字幕轨、且文件名带发布组标记，机械层直接判定，连搜索都不派发——省资源，但判断比 `agent` 档更激进。

---

## CLI 命令一览

| 命令 | 说明 |
|------|------|
| `doctor` | 检查接线（ASSRT / OpenSubtitles / zimuku / LLM / 媒体根目录 / 挂载能力 / 数据库） |
| `watch` | 常驻模式（daemon）：自扫描发现 + 编排调度 + 找字幕/整理/翻译 worker |
| `reconcile-all` | 全仓校验：一次性扫描全库，按当前规则重新判定并派发缺口任务（同监控页"全仓校验"按钮） |
| `translate-item <videoPath>` | 对单个视频跑 AI 翻译（agent 工作台：选源 → 术语表 → 逐行译 → 质量闸 → 装盘） |
| `auth reset` | 重置管理员账号（忘记密码时用；需能访问数据库文件） |
| `realign-rollback <archiveDir>` | 整理操作逃生舱：读 `<archiveDir>` 下的 write-ahead manifest，把文件搬动逆序重放回原位 |

**容器内执行示例**：

```bash
docker compose exec subtitle-scout node dist/cli/index.js watch
docker compose exec subtitle-scout node dist/cli/index.js translate-item "/media/tv/Show/ep.mkv"
```

---

## 环境变量参考

完整列表见 `.env.example`，主要配置项：

### 必填

| 变量 | 说明 |
|------|------|
| `LLM_BASE_URL` | OpenAI-compatible 端点，如 `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | 对应端点的 API key |
| `LLM_MODEL` | 模型名 |
| `ASSRT_TOKEN` | [assrt.net](https://assrt.net) 用户中心获取 |
| `TMDB_API_KEY` | 识别文件/判定季集排布/取全部中文译名变体都靠它；缺失 `watch`/`reconcile-all` 直接报错退出；见「第三把钥匙」 |
| `MEDIA_HOST_PATH` | （仅 compose）宿主机媒体库根目录，如 `/mnt/media` |

### 可选

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENSUBTITLES_API_KEY` | OpenSubtitles key（可选）——ASSRT 之外的第二字幕源，欧美剧集补盲；见「OpenSubtitles」 | 空 |
| `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` | OpenSubtitles 登录（可选）——免费档下载配额 5→20 次/天 | 空 |
| `ZIMUKU_ENABLED` | zimuku 字幕站开关（灰色地带，条款风险自担）——需要 LLM 支持多模态识图 | `false` |
| `SUBHD_ENABLED` | subhd 字幕源开关（通用型中文字幕站，强源）——无验证码/无云锁，不需 LLM | `false` |
| `TMDB_BASE_URL` / `TMDB_PROXY_URL` | TMDB 反代/代理（墙内直连常被墙时用） | 空 |
| `MEDIA_ROOTS` | 允许写入的根目录白名单（逗号分隔，容器内路径；**首启种子**，之后以 dashboard 设置页为准） | 空 |
| `TARGET_LANGUAGES` | 目标字幕语言（逗号分隔 BCP-47；设置页 target_languages 优先于此） | `zh` |
| `TZ` | 容器时区（影响日志与"今天"统计） | `Asia/Shanghai` |
| `SKIP_CHINESE_ORIGIN` | 国产内容跳过处理 | `true` |
| `JIMAKU_API_KEY` | jimaku.cc 日文字幕源 API key（F2 日→中直译日源；空则该源休眠） | 空 |
| `TRANSLATE_BASE_URL` / `TRANSLATE_API_KEY` / `TRANSLATE_MODEL` | **AI 翻译部署门三件套**——缺一 daemon 自动翻译整体休眠（绝不回退 `LLM_*`，太弱）；三件套配齐后还需在设置页打开"AI 翻译"开关。手动 `translate-item` 命令不受限：未配 `TRANSLATE_MODEL` 时回退 `LLM_*`。compose 部署还需确认 compose 的 environment 透传了它们 | 空 |
| `TRANSLATE_CRITIC` | 语义判官开关（关闭后仅靠确定性质量闸，仍 fail-closed） | `on` |
| `TRANSLATE_CRITIC_MODEL` | 判官单指定模型 | 同 `TRANSLATE_MODEL` |
| `TRANSLATE_TIMEOUT_MS` | 单批翻译超时（毫秒） | `300000` |
| `SCAN_INTERVAL_MS` | 自扫描间隔（毫秒；设置页 scan_interval_ms 优先） | `900000` |
| `DASHBOARD_PORT` | 监控页端口 | `8099` |
| `DASHBOARD_TOKEN` | **legacy**：老部署的访问 token，等价一个 API key。新部署建议留空，改用首启向导设账号密码 | 空 |
| `SUBTITLE_SCOUT_CACHE_DIR` | 缓存目录 | `~/.subtitle-scout/cache` |
| `LOG_RETAIN_DAYS` | daemon 日志文件保留天数 | `30` |
| `LLM_EXTRA_BODY` | （高级）强制注入请求体的 JSON，通常无需配置 | 空 |
| `FFPROBE_PATH` | 内嵌字幕探针用的 ffprobe 二进制路径；官方镜像已内置（apt 装的 ffmpeg），无需配置——只有源码直装且 PATH 上没有 ffmpeg 时才需要手动指定，探测退化为仅靠 sidecar 字幕文件判定 | 空（回退到 `ffprobe-static`） |

---

## Local development

想跑一遍完整链路又没有 NAS/真实媒体库？`docker-compose.local.yml` 在本机（OrbStack/Docker）拉起本地构建的 scout + 一批几 KB 的假视频，全程不碰任何真实文件，也不需要起任何媒体服务器。

```bash
scripts/gen-mock-library.sh          # 生成 fixtures/media 下的 mock 媒体库
cp .env.example .env                 # 填 LLM/ASSRT/TMDB 三把钥匙
docker compose -f docker-compose.local.yml up -d --build
```

然后监控页在 `http://localhost:8099`。

fixtures 里混了几个负例（内嵌中字的、国产片）方便验证跳过逻辑。`fixtures/media/` 已加入 `.gitignore`，不会被提交。

---

## 关于 Emby / Plex / Jellyfin 等媒体服务器

subtitle-scout 不打任何媒体服务器的 API——它直接扫描磁盘、靠 TMDB 识别文件、把字幕写进视频同目录。用不用媒体服务器、用哪一个，都与它无关；字幕落盘之后，你的播放器该怎么发现新文件走它自己的机制（inotify、下次播放时扫描等）。

早期版本曾经通过一个 `PlayerServer` 适配器接口直连 Jellyfin/Emby 拿播放会话与库元数据，这层依赖已经整体退役（见 [`docs/adapting.md`](docs/adapting.md) 头部的说明，历史存档）。

---

## FAQ / 排障

### Q: 挂载是只读的怎么办

**症状**：doctor 显示"不可写"。

**原因**：compose 挂载默认 `rw`，但某些网盘（WebDAV、只读 NFS）或宿主机目录权限限制导致容器内无法写入。

**解决**：
1. 检查 compose 挂载配置是否误加 `:ro`（只读标志），去掉
2. 检查宿主机目录权限，确保容器进程（以 root 运行）有写权限
3. 只读网盘无解——sidecar 字幕无法写入，考虑改用可写挂载

**注意**：容器以 root 运行，写入的 sidecar 字幕文件属主是 root。如果其他服务（如 Jellyfin 以不同 UID 运行）或宿主机用户需要管理这些文件，可能遇到权限问题。解决方案：
- 在 docker-compose.yml 添加 `user: "${PUID:-1000}:${PGID:-1000}"`（需确保该 UID 对挂载目录有写权限）
- 或接受 root 属主（644 权限，其他用户可读）

### Q: "暂时没找到合适的字幕"是 bug 吗

**不是**。这是保守设计，且没有阈值可调——判断权完全交给大模型的理解力，不是分数：
- ASSRT 对欧美剧集覆盖有限，小众片源缺字幕是常态
- 候选字幕先按可能性排序，每个都会被下载进一次性沙盒目录（不直接落媒体库）、结构性
  体检（cue 数量级、时间轴跨度是否匹配片长、简繁判定、字幕组头信息、编码可解码性等），
  再由大模型看着这些证据终审表态"是/不是这一集"——说不出"是"就按"不是"处理，弃了
  换下一个候选；候选试完仍全部落空，才诚实报告"暂无"
- **宁可不下，也不下错**——错写盘是永久污染，没有置信度数字，也没有"调低阈值多下载"
  这类开关

想看某次运行的处理结果和理由，见下面"怎么查某次运行的详细决策过程"。

### Q: 为什么国产片被跳过

默认 `SKIP_CHINESE_ORIGIN=true`：识别文件时会查 TMDB 的出品语言（origin language），解析为中文的条目会被跳过——它们通常不需要中文字幕。TMDB 一时查不到出品语言时，退回一条标题启发式兜底（标题只含汉字、不含假名/谚文 → 视作中文）。

关掉此功能：设 `SKIP_CHINESE_ORIGIN=false`。

### Q: 配额烧完了会怎样

**ASSRT 配额耗尽**：搜索返回 429，任务记瞬时错误并按退避梯重试（30 秒 → 15 分钟 → 天级），监控页运行历史可见；配额恢复后自然通过。

**LLM 配额耗尽**：取决于你的 LLM 服务商返回的错误，通常会记录在监控页的运行历史里，条目进冷却期。

### Q: 怎么查某次运行的详细决策过程

访问监控页 `http://<主机>:8099`：
- 剧集/电影详情页看整体字幕覆盖状态（哪几集缺、哪几集处理中）
- "运行历史"列表看每次处理的一行人话摘要（选了谁、为什么，或为什么没找到）

**LLM/API 调用明细**：traceBus 收官快照已落盘到 `runs.trace_json`（默认保留 30 天），Workflow 页可回放每次 agent 运行的工具调用序列（搜索→下载→验证→安装的完整决策链）。

程序日志（`docker compose logs subtitle-scout` 或容器内 `/cache/logs/`）能看到 provider 报错/提示一类的关键事件，但不是完整调用记录。

### Q: 监控页访问不了

**检查**：
1. `DASHBOARD_PORT` 是否在 compose 的 `ports` 里正确映射
2. 防火墙是否放行该端口
3. 忘记管理员密码：在服务器上运行 `docker compose exec subtitle-scout node dist/cli/index.js auth reset` 清除凭据，重新走创建向导
4. 老部署设了 `DASHBOARD_TOKEN` 但访问时没带 `?token=<值>` 参数（新部署改用账号密码登录）

---

## License

MIT
