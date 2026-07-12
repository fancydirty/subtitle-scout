# subtitle-scout

当你在 Jellyfin 里点开一部没有中文字幕的外语片，subtitle-scout 自动找到、验证并放好最合适的中文字幕。它不是又一个字幕下载器——它是一层带判断力的匹配智能：宁可不下，也不下错。

**核心能力**：自动发现缺中文字幕的影片 → 搜索并用大模型挑最合适的 → 验证后放到位；支持剧集整季打包下载；自带监控页，全程留痕可查。

---

## 快速上手

根据你的情况选择一条路：

### A. 已有 Jellyfin（推荐）

使用 `docker-compose.yml`（独立版），三步：

```bash
cp .env.example .env
# 编辑 .env，填入三把钥匙（见下一节）与 MEDIA_HOST_PATH
docker compose up -d
```

### B. 从零开始

使用 `docker-compose.bundle.yml`（全家桶），三步 + 一注意：

```bash
cp .env.example .env
# 编辑 .env，填入三把钥匙（见下一节）与 MEDIA_HOST_PATH
docker compose -f docker-compose.bundle.yml up -d
```

**注意**：Jellyfin 首次运行需先完成初始向导（访问 `http://<主机IP>:8096`），然后在控制台生成 API 密钥，填入 `.env` 的 `JELLYFIN_API_KEY`，再重启 scout：

```bash
docker compose -f docker-compose.bundle.yml restart subtitle-scout
```

---

## 三把钥匙：怎么拿

subtitle-scout 需要三组凭据：ASSRT 字幕库、大模型、Jellyfin 服务器。另有第四把可选钥匙 TMDB（强烈推荐，见本节末尾）。

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

### 3. Jellyfin API Key

**获取步骤**：
1. 打开 Jellyfin 控制台
2. 进入"高级"设置
3. 找到"API 密钥"
4. 点击"新建"，复制生成的 key，填入 `.env` 的 `JELLYFIN_API_KEY`

填完 `JELLYFIN_URL` 后即可启动：Jellyfin 在同机 Docker 上就用 `http://host.docker.internal:8096`（开箱即通，Linux 也支持）；在别的机器上则用 `http://<Jellyfin主机IP>:8096`。

### 第四把钥匙（可选但强烈推荐）：TMDB API Key

不是必填，但**中文搜索召回率会因此质变**——强烈建议配上。

**为什么值得**：字幕库按标题的**具体变体**分区索引，而同一部片的中文译名往往有好几个变体。以生产实例《爱，死亡和机器人》为例，它在各处的官方/民间译名分裂成：

- 「爱，死亡和机器人」（官方译名，用「和」）
- 「爱死亡与机器人」（用「与」）
- 「爱、死亡 & 机器人」（用顿号 + &）

「和」≠「与」，字幕站把它们分在不同的搜索分区里。只拿到一个变体，就只搜得到那一个分区的字幕；拿到**全部变体**，召回率立刻上一个台阶。TMDB 的 `/alternative_titles` 接口正好躺着一部片在 CN/TW/HK 区的全部译名变体——这是无 key 时的 Jellyfin 单译名 fallback 给不了的。

> 没有 key 也能跑：程序会退回 Jellyfin 的单中文译名。TMDB 纯粹是增益路径，任何失败都静默降级、绝不阻塞主流程。

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
# 独立版
docker compose exec subtitle-scout node dist/cli/index.js doctor

# 全家桶版
docker compose -f docker-compose.bundle.yml exec subtitle-scout node dist/cli/index.js doctor
```

**示例输出**：

```
✓ jellyfin  Jellyfin 可达，当前 2 个会话
✓ assrt  ASSRT token 有效，当前配额余量 180
✓ llm  LLM 端点可用，最小对话成功
✓ media-roots  2 个媒体根目录全部可写
✓ path-mapping  抽查 15 个条目、8 个目录：映射一致且可写

接线检查通过，可以起 watch 了。
```

如果某项显示 `✗`，按提示修复后重跑。

### 路径映射：最常见的接线错误

**规则**：scout 容器必须**以与 Jellyfin 相同的路径**挂载媒体目录。

**示例**（两者路径一致，无需配置）：
- Jellyfin 容器挂载：`/mnt/media/Movies:/media/movies`
- scout 容器挂载：`/mnt/media/Movies:/media/movies`

**不一致时的解决方案**：

如果 Jellyfin 和 scout 的挂载路径不同（例如 Jellyfin 看到的是 `/data/movies`，scout 看到的是 `/media/movies`），需配置 `MEDIA_PATH_MAPPINGS`：

```bash
MEDIA_PATH_MAPPINGS=/data/movies=/media/movies
```

格式为 `jellyfin前缀=本地前缀`，多对映射用逗号分隔。

**doctor 的 `path-mapping` 项就是查这个**——如果它显示 `✗`，八成是路径对不上。

---

## 监控页

访问 `http://<主机IP>:8099`（端口可通过 `DASHBOARD_PORT` 自定义），查看每次运行的完整故事：

- 认出哪部片 → 找到哪些字幕 → 挑最靠谱的 → 下好放到位
- 每次决策全程留痕（选了谁、为什么、拒了谁），出问题可查

**可选只读保护**：设置 `DASHBOARD_TOKEN` 后，访问需带 `?token=<值>` 参数。

---

## 它怎么工作

四步白话：

1. **发现缺字幕**：监听 Jellyfin 播放会话 + 定期扫描新入库条目，找到"正在播放且缺中文字幕"的影片
2. **搜索候选**：调用 ASSRT API 搜索，大模型规划搜索词（原名 + 中文译名 + 年份等组合）
3. **挑最靠谱**：大模型分析每个候选的元数据（上传者、文件名、时长匹配度等），打分并排序
4. **验证写盘**：下载置信度最高的字幕，校验哈希，写到视频同目录，刷新 Jellyfin 让它可见

每次决策全程留痕（选了谁、为什么、拒了谁），审计日志可在监控页或 `cache/journals/` 目录查看。

---

## CLI 命令一览

| 命令 | 说明 |
|------|------|
| `doctor` | 检查接线（Jellyfin / ASSRT / LLM / 媒体根目录 / 路径映射） |
| `watch` | 常驻监听模式（daemon），自动处理播放中 + 新入库条目 |
| `run-item --item-id <id>` | 单发调试：手动处理某个 Jellyfin 条目 |
| `run --context <json> --out <dir>` | 离线调试：从 JSON 文件加载上下文 |
| `report [--since <24h\|7d\|ISO-date-UTC>]` | 统计报告（默认最近 24 小时） |

**容器内执行示例**（独立版）：

```bash
docker compose exec subtitle-scout node dist/cli/index.js watch
docker compose exec subtitle-scout node dist/cli/index.js report --since 7d
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
| `JELLYFIN_URL` | Jellyfin 地址，如 `http://host.docker.internal:8096` |
| `JELLYFIN_API_KEY` | Jellyfin 控制台 → API 密钥 → 新建 |
| `MEDIA_HOST_PATH` | （仅 compose）宿主机媒体库根目录，如 `/mnt/media` |

### 可选

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `MEDIA_PATH_MAPPINGS` | Jellyfin 路径到本地路径映射，格式 `jellyfin前缀=本地前缀` | 空 |
| `TMDB_API_KEY` | TMDB key（可选，强烈推荐）——取全部中文译名变体，中文召回质变；见「第四把钥匙」 | 空 |
| `OPENSUBTITLES_API_KEY` | OpenSubtitles key（可选）——ASSRT 之外的第二字幕源，欧美剧集补盲；见「OpenSubtitles」 | 空 |
| `OPENSUBTITLES_USERNAME` / `OPENSUBTITLES_PASSWORD` | OpenSubtitles 登录（可选）——免费档下载配额 5→20 次/天 | 空 |
| `MEDIA_ROOTS` | 允许写入的根目录白名单（逗号分隔） | 空 |
| `TZ` | 容器时区（影响日志与"今天"统计） | `Asia/Shanghai` |
| `POLL_INTERVAL_SECONDS` | watch 模式轮询间隔（秒） | `15` |
| `ITEM_COOLDOWN_MINUTES` | 同一条目处理冷却期（分钟） | `30` |
| `TREAT_PGS_AS_MISSING` | 图形字幕（PGS）视为缺字幕 | `true` |
| `ADOPT_LOCAL_SUBTITLES` | 收编目录中不规范命名的本地字幕 | `true` |
| `SKIP_CHINESE_ORIGIN` | 国产内容跳过处理 | `true` |
| `SKIP_CACHE_MINUTES` | 已有字幕/不需要项的短期跳过缓存（分钟） | `5` |
| `DASHBOARD_PORT` | 监控页端口 | `8099` |
| `DASHBOARD_TOKEN` | 监控页访问 token（可选） | 空 |
| `SUBTITLE_SCOUT_CACHE_DIR` | 缓存目录 | `~/.subtitle-scout/cache` |
| `JOURNAL_RETAIN_DAYS` | 审计日志目录保留天数 | `90` |
| `LOG_RETAIN_DAYS` | daemon 日志文件保留天数 | `30` |
| `LLM_EXTRA_BODY` | （高级）强制注入请求体的 JSON，通常无需配置 | 空 |

---

## Local development

想跑一遍完整链路又没有 NAS/真实媒体库？`docker-compose.local.yml` 在本机（OrbStack/Docker）拉起 Jellyfin + 本地构建的 scout + 一批几 KB 的假视频，全程不碰任何真实文件。

```bash
scripts/gen-mock-library.sh          # 生成 fixtures/media 下的 mock 媒体库
cp .env.example .env                 # 填 LLM/ASSRT 等钥匙，Jellyfin 那两项先留空
docker compose -f docker-compose.local.yml up -d --build
```

然后：
1. 访问 `http://localhost:8096` 走 Jellyfin 初始向导，把 `/media/TV` 加成"节目"库、`/media/Movies` 加成"电影"库
2. 控制台生成 API key，填入 `.env` 的 `JELLYFIN_API_KEY`，然后 `docker compose -f docker-compose.local.yml up -d subtitle-scout`（注意用 `up -d` 而不是 `restart`——`restart` 不会重载 `.env`）
3. 监控页在 `http://localhost:8099`

fixtures 里混了几个负例（内嵌中字的、国产片）方便验证跳过逻辑。`fixtures/media/` 已加入 `.gitignore`，不会被提交。

---

## 适配 Emby / 其他媒体服务器

**Emby**：与 Jellyfin API 同源，预计改动很小。欢迎贡献 PR。

**其他媒体服务器**：参考 [`docs/adapting.md`](docs/adapting.md)，里面有：
- 架构说明（`PlayerServer` 接口）
- 六个方法的契约（`getSessions`、`getRecentItems`、`getItem`、`refreshItem`、`getChineseTitle`、`getSeasonEpisodes`）
- **给 coding agent 的现成提示词**（整段复制粘贴给 Claude Code / Cursor，让它帮你写适配器）

---

## FAQ / 排障

### Q: 刚 up 完就跑 doctor，jellyfin 项 ✗？

Jellyfin 首次启动需要几秒到几十秒完成初始化（尤其全家桶首跑），等它就绪后重跑 doctor 即可。另外：`MEDIA_HOST_PATH` 下不存在的子目录（如还没建 TV/）会被 Docker 自动创建为空目录，属正常现象。

### Q: doctor 显示 `path-mapping` ✗，或"下载了但 Jellyfin 看不到"

**症状**：doctor 输出类似"本容器内不存在：/data/movies"，或字幕已下载到本地但 Jellyfin 刷新后仍不可见。

**原因**：scout 容器与 Jellyfin 容器的媒体挂载路径不一致。

**解决**：
1. 最佳方案：让两容器挂载**相同路径**（如都挂成 `/media/movies`）
2. 无法一致时：配置 `MEDIA_PATH_MAPPINGS=jellyfin路径前缀=scout路径前缀`
3. 修改后重跑 `doctor` 确认 ✓

### Q: 挂载是只读的怎么办

**症状**：doctor 显示"不可写"。

**原因**：compose 挂载默认 `rw`，但某些网盘（WebDAV、只读 NFS）或宿主机目录权限限制导致容器内无法写入。

**解决**：
1. 检查 compose 挂载配置是否误加 `:ro`（只读标志），去掉
2. 检查宿主机目录权限，确保容器用户（通常 UID 1000）有写权限
3. 只读网盘无解——sidecar 字幕无法写入，考虑改用可写挂载

### Q: "暂时没找到合适的字幕"是 bug 吗

**不是**。这是保守设计，且没有阈值可调——判断权完全交给大模型的理解力，不是分数：
- ASSRT 对欧美剧集覆盖有限，小众片源缺字幕是常态
- 候选字幕先按可能性排序，每个都会被下载进一次性沙盒目录（不直接落媒体库）、结构性
  体检（cue 数量级、时间轴跨度是否匹配片长、简繁判定、字幕组头信息、编码可解码性等），
  再由大模型看着这些证据终审表态"是/不是这一集"——说不出"是"就按"不是"处理，弃了
  换下一个候选；候选试完仍全部落空，才诚实报告"暂无"
- **宁可不下，也不下错**——错写盘是永久污染，没有置信度数字，也没有"调低阈值多下载"
  这类开关

想看某次运行具体拒了哪些候选、为什么，见下面"怎么查某次运行的详细决策过程"。

### Q: 为什么国产片被跳过

默认 `SKIP_CHINESE_ORIGIN=true`，中国大陆出品的影片（`ProductionLocations` 含 `CN`）会被跳过——它们通常不需要中文字幕。

关掉此功能：设 `SKIP_CHINESE_ORIGIN=false`。

### Q: 配额烧完了会怎样

**ASSRT 配额耗尽**：搜索返回 429，程序会记日志并跳过该条目，进入冷却期（默认 30 分钟）。配额恢复后自动重试。

**LLM 配额耗尽**：取决于你的 LLM 服务商返回的错误，通常会记录在审计日志，条目进冷却期。

### Q: 怎么查某次运行的详细决策过程

**方式 1**（推荐）：访问监控页 `http://<主机>:8099`，点击对应运行查看完整 4 步过程。

**方式 2**：查看 `cache/journals/<itemId>-<timestamp>/decision.json`，包含：
- 选了哪个字幕、为什么
- 拒了哪些候选、原因
- 每次 LLM / ASSRT API 调用的请求 / 响应

### Q: 监控页访问不了

**检查**：
1. `DASHBOARD_PORT` 是否在 compose 的 `ports` 里正确映射
2. 防火墙是否放行该端口
3. 设了 `DASHBOARD_TOKEN` 但访问时没带 `?token=<值>` 参数

---

## License

MIT
