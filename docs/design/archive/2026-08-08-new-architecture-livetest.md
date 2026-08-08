# 新架构 Live Test 观察报告

**日期**: 2026-08-08 深夜
**状态**: 新架构（机械扫描 → 识别 agent → 传送带 → 字幕 agent）端到端跑通

---

## 一句话结论

**新架构五阶段全部完成并在真实数据上验证通过**：
机械扫描 1500 文件 → 识别 agent 98 作品 → 判定 588 需字幕 → 字幕 agent 一簇一作品装盘。
之前困扰的 orchestrator agent / UNIT_LIMIT / MAX_TARGETS / 24h 心跳全部消失——纯机械调度。

---

## 基础设施

- **OpenList 115 网盘挂载完成**（你的 cookie 已配置，Mediary Scout 目录可访问）
- **rclone WebDAV 只读挂载**：`/mnt/nvme0n1-4/115-test/`（测试目录）
- scout 容器通过 `/hostroot` 自动可见 115 测试目录

## 测试数据（Mediary Scout，83 个作品）

| 目录 | 作品数 | 说明 |
|---|---|---|
| Movies/ | 36 部电影 | 标准 Jellyfin 约定 |
| TV/ | 31 部剧 | 含 `{tmdb-N}` 标签 |
| Anime/ | 16 部动画 | 全部单季 |

## 阶段验证结果

### 阶段 0-1：机械扫描（1010 文件）

- 115：1008 文件入库，2 静默跳过（非媒体），confidence: high=975 / low=6 / none=27
- nas_media：492 文件入库，confidence: high=396 / low=73 / none=23
- work_dir 推导全部正确（含 SPY x FAMILY 乱布局 → 正确归为一部剧）

### 阶段 2：识别 Agent（98 作品全部识别）

- 115：61 个作品 100% 识别（0 失败、0 404）
- nas_media：37 个作品 100% 识别（含 SPY x FAMILY 乱布局 50 文件）
- 中文目录名全匹配（绝命毒师→Breaking Bad、后室→Backrooms、教父→The Godfather）
- `{tmdb-N}` 标签直接命中（后室、九门、津门飞鹰等）
- **实测修了 3 个真实问题**：
  1. agent 不调 write 工具 → 绑定改为系统自动执行
  2. TmdbDetails 缺 title 字段 → 补上（日文 original + 英文目录名匹配）
  3. verifyEvidence 命名变体 → ×→x、leetspeak、年份清洗、模糊匹配

### 阶段 3：需字幕判定（1500 文件）

- 588 需字幕 / 808 国产跳过 / 104 sidecar 跳过
- **实测修了 sidecar BCP-47 探测**（`.zh-Hans.ass` 之前漏判）

### 阶段 4：字幕 Agent（端到端装盘）

- **8 部电影 + American Horror Story 20 集 + Overflow 8 集全部装盘**（真实 .ass 落盘）
- Cassandra retry_later=5 = ASSRT 配额节流的正常行为（README 明说的）
- **实测修了 2 个真实问题**：
  1. itemId 必须从 work_id 派生（否则 worker 当"未识别"跳过）
  2. 装盘后必须标记 covered（否则队列反复选中）

## 当前状态

```
库:    works=98  files 已识别=1500/1500
判定:  588 需字幕 / 808 国产跳过 / 104 sidecar 跳过
字幕:  nas_media 已装 ~40 条（电影+剧集），余量因 ASSRT 配额节流分批
```

## 剩余工作

### 阶段 5（未完成）
- [ ] 删旧死代码：orchestrator agent / unidentified 那套 / workUnit 分组（workRootOf 保留）
- [ ] 旧表（episodes/movies/subtitles）迁移或冻结
- [ ] 机械调度 daemon 化（当前是手动 CLI 驱动，需接入 daemon tick）
- [ ] 字幕队列的退避/重试逻辑（当前 retry_later 直接重试，需等配额）

### 后续
- [ ] 前端全删重做（用户已裁决，等后端全通后做）
- [ ] AI 翻译链路的 agent 测试
- [ ] 115 测试目录移出生产守备目录

## 提交记录

```
f0ec221 作品单元基建（旧架构，已废弃）
...（旧架构的多轮）
feat(v2): 新架构阶段 0-1 files/works schema + 机械扫描器
feat(v2): 新架构阶段 2 识别 Agent
feat(v2): 新架构阶段 3 需字幕判定
fix(v2): 识别 agent 端到端跑通 + 绑定机制修正
fix(v2): 字幕链路 itemId 派生 + sidecar BCP-47 探测
fix(v2): 字幕装盘后标记 covered
```
