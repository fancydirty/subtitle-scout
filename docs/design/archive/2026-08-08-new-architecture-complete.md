# 新架构完成报告（daemonV2 自主运行验证）

**日期**: 2026-08-08 深夜
**状态**: ✅ 新架构五阶段全部完成，daemonV2 自主运行验证通过

---

## 一句话

**你设计的架构（机械扫描 → 识别 agent → DB 传送带 → 字幕 agent）完全实现并自主运行了。**
没有 orchestrator agent、没有 UNIT_LIMIT、没有 24h 心跳——纯机械调度。

## 运行中的系统（当前状态）

```
daemonV2 每 30s 一拍：
  1. 周期扫描（15min 时间门 + 指纹跳过）→ files 表
  2. 识别队列有活 → 识别 agent（一次一个作品目录）
  3. 字幕队列有活 → 字幕 agent（一次一个作品的一簇）

库状态：
  98 作品 / 1500 文件全部识别
  44 文件已覆盖字幕（American Horror Story 20、Peacemaker 15、电影若干）
  315 剩余需字幕（渐进覆盖中，每轮补几个——字幕源配额决定速度）
```

**验证过的真实案例**（都是之前会出问题的）：
- SPY x FAMILY 乱布局（季目录空、文件同级）→ 正确识别为一整部剧
- High School D×D（× vs x）→ 识别正确
- PLUR1BUS（leetspeak 1→i）→ 识别正确
- 绝命毒师（中文目录 vs 英文 TMDB）→ 中文别名匹配
- 115 只读目录 → 正确排除（不尝试写）

## 五阶段完成情况

| 阶段 | 内容 | 状态 |
|---|---|---|
| 0 | files/works schema（v30 迁移） | ✅ |
| 1 | 机械扫描器（Jellyfin 约定 + confidence + 唯一季推导） | ✅ |
| 2 | 识别 agent（TMDB 身份 + 自动绑定） | ✅ 98 作品全识别 |
| 3 | 需字幕判定（国产/内嵌/sidecar 跳过） | ✅ 1500 判定 |
| 4 | 字幕 agent（一簇一作品 + 装盘 + covered 标记） | ✅ 44 装盘 |
| 5 | daemonV2 机械调度 | ✅ 自主运行中 |

## 实测修掉的问题（10+ 个）

1. agent 不调 write 工具 → 绑定改为系统自动执行
2. TmdbDetails 缺 title 字段（日文 original vs 英文目录名）
3. verifyEvidence 命名变体（×→x、leetspeak、年份清洗、模糊匹配）
4. sidecar BCP-47 探测（.zh-Hans.ass 漏判）
5. itemId 必须从 work_id 派生（否则 worker 当"未识别"跳过）
6. 字幕装盘后必须标记 covered（否则反复处理）
7. 字幕队列必须按守备目录过滤（115 只读残留）

## 环境

- OpenList 115 网盘挂载完成（你的 cookie）
- rclone WebDAV 只读挂载到 /mnt/nvme0n1-4/115-test/
- Mediary Scout 测试目录（83 作品）扫描识别全通

## 剩余工作（下次）

1. **旧代码清理**：orchestrator agent / unidentified / workUnit 分组（阶段 5 未删）
2. **旧表迁移**：episodes/movies/subtitles → files/works（provider_ref 来源保留）
3. **Dockerfile CMD 改 daemonV2**（当前手动起，需设为容器主进程）
4. **字幕队列退避**：retry_later 需等配额恢复再试（当前直接重试）
5. **前端全删重做**（用户已裁决）
6. **AI 翻译链路验证**

## 提交记录

```
feat(v2): 新架构阶段 0-1 files/works schema + 机械扫描器
feat(v2): 新架构阶段 2 识别 Agent
feat(v2): 新架构阶段 3 需字幕判定
fix(v2): 识别 agent 端到端跑通 + 绑定机制修正
fix(v2): 字幕链路 itemId 派生 + sidecar BCP-47 探测
fix(v2): 字幕装盘后标记 covered
feat(v2): 新架构 daemon（daemonV2）——纯机械调度主循环
```
