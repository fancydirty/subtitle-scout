# Spec 1：阿里云盘挂载方式切换（WebDAV + 并发探针）

**日期**：2026-07-27
**状态**：待用户批准
**范围**：纯基础设施 —— 挂载层 + compose 卷 + 探针并发度。不碰任何识别/产品语义。
**索引**：见 `docs/superpowers/specs/2026-07-27-INDEX.md`

## 1. 问题

要把阿里云盘（OpenList 的 `AliyundriveOpen` 后端）接进守备目录，让 agent 像对待物理 NAS 文件一样识别云端资源。核心疑问是**探针性能**：`ffprobe` 读时长需要读文件头 + seek 到尾部，在网络挂载上可能极慢。

历史上有一个口口相传的说法：「NFS 挂载阿里云盘很快」。这个说法**在文档里没有任何记录**，只存在于某次会话的对话中。

## 2. 调研结论（实测，2026-07-27）

全部数字为实测值，同一测试文件（7.5GB REMUX mkv），`ffprobe -show_entries format=duration`，经 `subtitle-scout` 镜像的容器执行。每次冷测用一个从未读过的分集，怀疑缓存效应时明确标注并复测。

| 挂载方式 | 单文件 ffprobe | 4 文件并发（墙钟） | ls | dd 1MB |
|---|---|---|---|---|
| CIFS/SMB NAS（参照基线） | **1.09s** | — | — | — |
| **rclone WebDAV → OpenList** | **~12.8s** | **16.1s** | 0.04s | 2.99s |
| rclone FTP（当前生产用） | ~13.1s | **86.1s** | 0.00s | 3.75s |
| rclone SFTP | 34.1s | — | 0.01s | 8.61s |
| `rclone serve nfs` + mount.nfs v3 | 49.0s | — | 0.01s | 18.87s |
| ffprobe 直连签名 HTTP URL（无 FUSE） | 12.10s | — | — | — |

### 2.1 「NFS 很快」是假的

- **OpenList 根本不能提供 NFS**。读运行中容器的 `config.json`：egress 只有 `s3`/`ftp`/`sftp`/`mcp`，**schema 里没有 `nfs` 键**。
- 唯一的 NFS 路径是 `rclone serve nfs`（NFSv3）。实测 **49.0s 且失败**：返回 `Input/output error`，拿不到时长。rclone 官方文档也说明该功能是为绕开 macOS 的 FUSE 限制，不是为性能。
- 结论：该说法**不可复现**。本 spec 正式废止它，并把实测数据写进文档，杜绝再次口口相传。

### 2.2 我此前「WebDAV 挂死 >600s」的判断也是错的

原因不是 WebDAV 慢，而是 `/mnt/aliyun-dav`（davfs2）的凭据文件 `/tmp/dav-secret` 在 tmpfs 上，**重启后丢失**，该挂载在以 nobody 身份认证。**WebDAV 经 rclone 反而是最快的一档。**

### 2.3 串行没有提升空间，并发才是胜负手

12s 是**阿里云 CDN 的延迟地板**：绕过 FUSE 直接让 ffprobe 读签名 URL，仍是 12.10s。所以：

- **串行**：WebDAV ~12.8s vs FTP ~13.1s，统计上打平，**换挂载方式几乎没有收益**。
- **并发**：FTP 在 4 并发下每个探针从 13s 膨胀到 ~78s（OpenList 的 FTP 服务端按 seek 串行化/重连），WebDAV 因每个 range 请求 302 重定向到 CDN 而真并行。**86.1s → 16.1s，5.6 倍。**
- 子代理特意在**已预热**的文件上复测 FTP 以排除缓存质疑，结果更差（89.97s）。

**这决定了本 spec 的形状**：光换挂载没用，**必须同时让探针并发**，否则收益为零。

### 2.4 元数据正确性已验证

快而说谎的挂载对我们没用，所以逐项核对了：

| 项 | WebDAV 挂载 | 真值来源 | 一致 |
|---|---|---|---|
| 时长 | 1442.048s | 与 FTP 挂载、生产挂载逐字节相同 | ✅ |
| 大小 | 7567057430 | OpenList API | ✅ |
| mtime | 2026-07-26 02:09:53 +0800 | API `2026-07-25T18:09:53.797Z` | ✅（`--no-modtime` 未破坏） |
| `.archive` 隐藏目录 | 可见 | 三种挂载均可见 | ✅ |
| 流数量 | 9（含 4 条字幕轨） | `nb_streams=9` | ✅ |

**时长诚实这一条尤其关键**：它是"侦探式推理"（用时长交叉印证纯数字标题，如 `2012`）在云端文件上依然可用的地基。

### 2.5 已知失败模式（记录在案）

- **SFTP 危险**：抛 `Read error at pos 7569454128`（约文件尾部）**却仍打印出一个时长**。中途出错但返回貌似合理的数字，比直接失败更危险。禁用。
- **NFS 至少是响亮地失败**（`Input/output error`），不静默返回错值。
- **davfs2 那个挂载已实质损坏**（凭据文件丢失），与速度无关。

## 3. 设计

### 3.1 挂载层（宿主机，零代码）

新增一个 rclone WebDAV 挂载，指向 OpenList。**不动**现有 `/mnt/aliyun-ftp` 与 `/mnt/aliyun-dav`（回滚余地）。

rclone remote 配置：

```ini
[aliyun-dav-fast]
type = webdav
url = http://192.168.100.1:5244/dav/aliyun
vendor = other
user = admin
pass = <obscured OpenList admin password>
```

挂载命令：

```sh
rclone mount aliyun-dav-fast:subtitle-scout-test /mnt/aliyun-webdav --daemon \
  --vfs-cache-mode off \
  --vfs-read-chunk-size 1M --vfs-read-chunk-size-limit 128M \
  --dir-cache-time 72h --attr-timeout 1h \
  --no-modtime --vfs-fast-fingerprint \
  --buffer-size 0 --poll-interval 0 --no-checksum \
  --allow-other
```

每个 flag 的依据（全部经实测，非猜测）：

| Flag | 为什么（针对"读头 + seek 尾"访问模式） |
|---|---|
| `--vfs-cache-mode off` | **关键**。ffprobe 只读 7.5GB 文件的几 MB；`full`/`writes` 会把整个文件落盘。`off` 让 range 请求直通。 |
| `--vfs-read-chunk-size 1M` | 每次 seek 花一个 HTTP range 请求（~2s）。实测最优：128k→14.11s（往返太多），**1M→12.07s**，128M→16.42s（过度取用）。 |
| `--vfs-read-chunk-size-limit 128M` | 限制 chunk 倍增，避免尾部 seek 触发巨量取用。 |
| `--buffer-size 0` | 预读在此场景是纯浪费：ffprobe 从头跳到尾，预取的字节必被丢弃。 |
| `--dir-cache-time 72h` `--attr-timeout 1h` | 让 `ls` 从重复 PROPFIND 降到 0.04s（实测）。 |
| `--no-modtime` `--vfs-fast-fingerprint` `--no-checksum` | 省掉每次 open 的额外元数据往返。已验证不破坏 mtime（见 §2.4）。 |
| `--poll-interval 0` | 关闭变更轮询；测试数据静态。 |

**持久化**：挂载必须在重启后存活。davfs2 那个挂载正是因为凭据放在 tmpfs 而在重启后失效——同一个坑不能踩两次。凭据写入 rclone 配置文件（持久路径，非 `/tmp`），挂载由 init 脚本或 systemd/procd 服务拉起。**实施时必须实测一次重启存活。**

### 3.2 compose 卷（关键约束）

`docker-compose.yml` 由软路由持有，且 `deploy/deploy.sh` 用 `--filter='protect /docker-compose.yml'` **明确保护它不被部署覆盖**。因此：

- **compose 改动不能走 `deploy.sh`**，必须在软路由上手工编辑（或另立一个受版本控制的 compose 片段机制，超出本 spec 范围）。
- 新增卷：`- /mnt/aliyun-webdav:/media/aliyun:ro`
- **只读挂载**（`:ro`）：本 spec 阶段只做识别测试，不往云盘写字幕。写入是另一件事（云盘写延迟、原子改名语义都未验证），不在本 spec 范围。
- `MEDIA_ROOTS` 环境变量已是 `/media`（compose 第 53 行），新目录 `/media/aliyun` 自动落在守备范围内，**无需改环境变量**。
- 注意：`jellyfin` 服务也挂了同样三个媒体目录。本 spec **不**给 jellyfin 加 aliyun 卷——Jellyfin 是否该看到云盘是独立决策。

### 3.3 探针并发（唯一的代码改动）

这是本 spec 真正的收益来源。现状：ingest 的 FULL PATH 逐文件串行 `probeDuration` + `probe`。云端 27 个文件 × 13s ≈ **6 分钟**；若并发 4，降到 ~1.5 分钟。

设计约束：

- **并发度按挂载类型区分**。CIFS 上探针 1.09s，并发收益小且可能压垮 SMB；云盘上收益 5.6 倍。但 ingest 层不应该硬编码"哪个路径是云盘"——**用一个可配置的并发上限**，默认值保守。
- **并发只加在探针阶段**，不改识别与写库（那些有事务与顺序语义）。探针是纯读、无副作用、失败不影响他人（现有代码每个探针已各自 `try/catch`）。
- **失败隔离不能退化**：现有语义是"一个文件的探针失败不拖垮整轮"（`ingest.ts` 的 per-file try/catch）。并发化后必须保持——用 `Promise.allSettled` 类语义，不用 `Promise.all`（一个 reject 会丢弃其余结果）。
- **顺序不能成为正确性依赖**：探针结果按 path 归属回填，不依赖完成顺序。

具体并发度与配置项名称留给实施计划（`writing-plans`）确定；本 spec 只钉死"必须并发、必须可配、必须失败隔离、默认保守"。

## 4. 不做什么（YAGNI）

- **不换 NAS 的 CIFS 挂载**。1.09s 已经够快，动它是纯风险。
- **不做云盘写入**（安装字幕到云盘）。延迟与原子改名语义未验证，另立 spec。
- **不引入 rclone 的 aliyundrive 社区后端**。上游 rclone 无此后端；社区分支（AUR `rclone-aliyundrive-git`）最后更新 2023-09-11、锁定 rclone 1.63，用它意味着把工作正常的 1.70.3 换成废弃分支。且 OpenList 已持有可用的 `AliyundriveOpen` OAuth token，原生后端还得另配凭据。
- **不用 OpenList 的 `/d/` 签名 URL 走 rclone `http` 后端**。range 读可行（HTTP 206，2.2s），但 OpenList 返回 SPA、无 autoindex，`http` 后端无法列目录。死路，已验证。
- **不给 Jellyfin 加云盘卷**（见 §3.2）。

## 5. 验收标准

1. `/mnt/aliyun-webdav` 挂载存在，且**重启后仍存在**（实测一次重启）。
2. 容器内 `/media/aliyun` 可见，`ls` 能列出 Anime/Movie/TV 三个目录。
3. 容器内对 `第3集` 的 mkv 跑 ffprobe，**返回 1442.048s 附近的正确时长**（不是 null、不是错值）。
4. 27 个云端视频的探针阶段总耗时**显著低于串行基线**（串行 ≈ 6 分钟；并发后应 ≤ 2 分钟）。
5. 探针并发化后，**全量测试套件仍全绿**（当前 1999 passed / 0 tsc errors），且失败隔离语义有测试覆盖（构造一个探针失败的目标，验证其余目标不受影响）。
6. 元数据正确性抽查：大小、mtime 与 OpenList API 真值一致。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| OpenList 挂了 → 云盘目录变空 → ingest 误判"文件消失"退役库行 | 现有三层防线（errno 区分 / 消失去抖 / 骤降哨兵）本就是为 CIFS 抖动写的，云盘同样受保护。**但需实测一次 OpenList 停机场景**，确认哨兵生效。 |
| 探针并发压垮 OpenList 或触发阿里云限流 | 并发度可配且默认保守；实施时观察 OpenList 日志。子代理调研期间曾触发 OpenList 的暴力破解锁定（HTTP 429，几分钟后自动解除）——说明它有防护，不会被无声打爆。 |
| 云盘挂载的 12s 探针延迟在**全量库**（若以后接入整个云盘）成为瓶颈 | 记录在案：每 240 个文件约 1 小时。本 spec 只接 27 个测试文件；全量接入前需重新评估。 |
| 凭据落在 rclone 配置文件里（明文/obscured） | 与现有 rclone remote 同等待遇（`aliyun-ftp:` 已如此）。不新增暴露面。**不要**放 tmpfs。 |

## 7. 参考

- 调研执行者：子代理（general），2026-07-27，全部数字为实测。
- 宿主环境实况：iStoreOS/OpenWrt 24.10.4，kernel 6.6.110，busybox（**无 `apk`、无 `timeout`、无 `date +%N`**）；rclone v1.70.3；OpenList v4.1.7 驱动 `AliyundriveOpen`。调研期间**未安装任何软件包**。
- 相关代码：`src/v2/ingest.ts`（FULL PATH 探针段）、`deploy/deploy.sh`（compose 保护规则）、软路由 `docker-compose.yml`。
