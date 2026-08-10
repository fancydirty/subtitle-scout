# 运维：云盘挂载（阿里云盘 → OpenList → rclone → 容器）

**归属**：subtitle-scout 个人项目。与任何公司/工作内容无关，不进任何共享 skill 或仓库。
本文件在 `docs/` 下，已被 `.gitignore`（`.gitignore:27`），只存在于本机。

---

## 这条链长什么样

```
阿里云盘（openapi.alipan.com）
   ↓ AliyundriveOpen driver + refresh_token
OpenList 容器（host 网络，:5244，数据卷 /mnt/nvme0n1-4/docker/openlist-data）
   ↓ WebDAV  http://127.0.0.1:5244/dav/aliyun
rclone remote `aliyun-dav`（配置在宿主 ~/.config/rclone）
   ↓ rclone mount --daemon
宿主 /mnt/aliyun-webdav（fuse.rclone）
   ↓ docker bind mount
容器 /media/aliyun
```

链条长，任一环断了表现都是"容器里 /media/aliyun 空目录"。下面按**从下游往上游**的顺序排查，
因为下游更好查、且上游故障必然连带下游。

---

## 2026-07-31 的真实故障：DNS，不是密码

### 症状
- 容器内 `/media/aliyun` 是空的
- `/proc/self/mountinfo` 里它的 fstype 是 **`tmpfs`** 而不是 `fuse.rclone`
  （= 宿主挂载已掉，容器看到的是挂载点下面那个空目录）
- `rclone lsd aliyun-dav:` → `ERROR: directory not found`
- WebDAV `curl /dav/` → **401**

### 我最初的错误结论
看到 401 就判定"OpenList 密码变了"。**这是错的**，而且浪费了不少时间。

真相：401 是因为我拿一个空密码去试（`/tmp/openlist-pass.txt` 随 `/tmp` 清理丢了，
`rclone reveal` 在这版也解不出来）。重置密码后 curl 变成 405/207，
**但 rclone 仍然报 directory not found** —— 说明密码从来不是根因。

### 真正的根因
查 OpenList 的存储列表 API 才看到挂载点的 `status` 字段：

```
"status": "Post \"https://openapi.alipan.com/adrive/v1.0/user/getDriveInfo\":
           dial tcp: lookup openapi.alipan.com on [::1]:53: read: connection refused"
```

**是 DNS 解析失败。** 原因：
- 宿主 `/etc/resolv.conf` 写的是 `nameserver 127.0.0.1`
- 宿主的 dnsmasq **只监听具体网卡 IP**（192.168.0.1 / 172.27.0.1 / …），**不监听 127.0.0.1**
- OpenList 用 host 网络，继承了这份 resolv.conf → 它的 127.0.0.1:53 无人应答
- 于是 OpenList 连不上阿里云 API → 挂载点 status 异常 → WebDAV 那条路径 404 →
  rclone 挂载失败 → 容器看到空目录

宿主自己 `nslookup` 是好的（走 dnsmasq 的网卡 IP），所以"宿主能解析"这个观察会误导人。

### 修法
给 OpenList 容器显式指定 DNS（它是手动 `docker run`，非 compose）：

```sh
docker stop openlist && docker rename openlist openlist-old
docker run -d --name openlist --network host --restart unless-stopped \
  -e UMASK=022 -e RUN_ARIA2=false \
  --dns 192.168.0.1 --dns 223.5.5.5 \
  -v /mnt/nvme0n1-4/docker/openlist-data:/opt/openlist/data \
  openlistteam/openlist:v4.1.7
```

`192.168.0.1` 是宿主 dnsmasq 实际监听的地址之一；`223.5.5.5` 兜底。

验证顺序（每步都要过才往下走）：
1. `docker exec openlist cat /etc/resolv.conf | grep nameserver` → 应是上面两个
2. `docker exec openlist nslookup openapi.alipan.com` → 应解析出地址
3. 存储列表 API 的 `status` → 应为 **`work`**
4. `rclone lsd aliyun-dav:` → 应列出目录
5. 重挂 FUSE（见下）
6. **重启 subtitle-scout 容器**（见下，这一步容易漏）

---

## 容器看不到宿主新挂载：bind mount 传播

宿主重挂 rclone 之后，**容器里仍然是 tmpfs**。这不是 bug，是 Docker 默认
`rprivate` 传播：容器启动时 bind mount 绑定的是当时那个（空的）挂载点，
宿主后来在同一路径挂上 FUSE，容器看不到。

`src/core/mountKind.ts` 的注释里预判了这个失败模式。

**解法**：`docker restart subtitle-scout`（重新绑定）。
更彻底的做法是给 bind mount 加 `bind-propagation=rslave`，但那要改容器创建参数，
而"云盘掉了就重启一次容器"的代价很低，暂不动。

---

## 重挂 rclone 的命令

参数与 `/etc/rc.local:13` 保持一致（开机自挂用的是那一份，别让两处漂移）：

```sh
fusermount -uz /mnt/aliyun-webdav 2>/dev/null
rclone mount aliyun-dav:subtitle-scout-test /mnt/aliyun-webdav --daemon \
  --vfs-cache-mode off --vfs-read-chunk-size 1M --vfs-read-chunk-size-limit 128M \
  --dir-cache-time 72h --attr-timeout 1h --no-modtime --vfs-fast-fingerprint \
  --buffer-size 0 --poll-interval 0 --no-checksum --allow-other
```

两个坑：
- 这台机器（BusyBox/ash）**没有 `pkill`、没有 `timeout`**。用 `fusermount -uz` 卸载，
  别指望 pkill 停 rclone。
- SSH 隧道会话容易在长命令中途断，导致命令根本没执行到。用
  `nohup sh -c "..." >/tmp/x.log 2>&1 &` 派发后另起一次连接查结果。

---

## OpenList 密码

**存放位置**：`/mnt/nvme0n1-4/docker/openlist-data/.creds/openlist-admin.txt`（chmod 600）

放持久盘而不是 `/tmp` —— 上次存 `/tmp` 被系统清理，密码丢了，直接导致这次多绕了一大圈。

重置方法：
```sh
docker exec openlist /opt/openlist/openlist admin set '<新密码>' --data /opt/openlist/data
```
改完必须同步 rclone：
```sh
rclone config update aliyun-dav pass '<新密码>' --non-interactive
```

---

## 排查用的 curl 速查

WebDAV 对 GET 返回 **405 是正常的**（它要 PROPFIND）。别把 405 当故障：

| 命令 | 正常响应 | 含义 |
|---|---|---|
| `curl -u admin:PASS .../dav/` | **405** | 鉴权通过（GET 不被支持而已） |
| 同上 | 401 | 密码错 |
| `curl -X PROPFIND -H 'Depth: 1' -u admin:PASS .../dav/aliyun/` | **207** | 路径正常，能列目录 |
| 同上 | 404 | 挂载点不存在或 status 异常 → 查存储列表 API |

查挂载点真实状态（**最有用的一条**，故障原因就在 `status` 字段里）：
```sh
T=$(curl -s -X POST http://127.0.0.1:5244/api/auth/login \
     -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"PASS"}' \
   | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s -H "Authorization: $T" http://127.0.0.1:5244/api/admin/storage/list
```

---

## 对字幕校验功能的影响面

云盘掉了对本功能影响很小，实测数据：
- 云盘上：**2 行字幕、0 个视频条目**
- 全部 282 个 `covered` 条目都在 CIFS（局域网 NAS）上

而且代码在这个状态下行为是安全的：tmpfs 判 `local`，但空目录里没有文件可处理。
真正的风险是反过来——**云盘被误判成 local** 会让 ffmpeg 去公网拉几 GB、挂死 worker，
所以 `mountKind.ts` 的兜底方向是"判不出来一律 cloud"。
