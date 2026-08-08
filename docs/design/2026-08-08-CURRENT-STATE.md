# Subtitle Scout 当前状态与待办（权威文档）

**日期**: 2026-08-08
**用途**: compact 后继续讨论的单一权威。后端逻辑与前端都要慢慢耐心讨论。
**状态**: 持续更新——每次实质进展更新本节。

---

## 一、项目是什么

自动中文字幕下载器：扫描媒体库 → 识别资源 → 为缺字幕的资源找字幕 → 落盘。

## 二、当前架构（最终确认版）

```
每天一次巡检（距上次满 24h，对齐 Jellyfin 库扫描频率）：
  阶段 1：机械扫描守备目录 → files 表（新文件入库，指纹 mtime+size 跳过）
  阶段 2：识别工作流（上游）
    → 识别工作台 = 未识别的作品（work_id IS NULL 且 next_retry_at 已过）
    → 有活就一直跑（逐个作品），识别不出的标 next_retry_at=明天
    → 跑空才进下一步
  阶段 2.5：judge（识别绑定后判 needs_subtitle：国产/内嵌/sidecar 跳过）
  阶段 3：字幕工作流（下游）
    → 字幕工作台 = 已识别作品里缺字幕的（needs_subtitle=1 且 recheck_after 已过）
    → 有活就一直跑（逐个作品），找不到的标 recheck_after=明天
    → 跑空才结束
  阶段 4：停，歇着，等明天
```

**关键原则**（全部来自用户裁决）：
- 工作台语义 = "有活就一直跑，跑完歇，明天再巡检"，**没有 30s tick 轮询**
- 识别是字幕的上游，识别没完成字幕不开始（流水线串行）
- 找不到 = 明天再试（24h）——字幕源更新慢，15min/6h 重试无意义
- 不设步数上限（用户裁决"stepCap 取消都无所谓"）
- 识别 agent 只认身份（目录 → TMDB），集号绑定由系统自动执行
- 字幕 agent 一个 session 针对一个作品，把缺的补满（不是逐集）

## 三、核心数据模型

```
files 表（机械扫描产出，每行一个媒体文件）：
  path / dir / filename / size / mtime / duration_sec / embedded_langs / audio_langs
  work_dir / season / episode / parse_confidence（high/low/none）
  work_id（NULL=未识别，'tmdb:<id>'=已识别）
  needs_subtitle（NULL=未判定，0/1）
  sub_status（NULL/covered/unavailable）
  attempt / next_retry_at / last_error / recheck_after

works 表（识别 agent 产出，每行一个作品）：
  id（tmdb:<id>）/ title / original_title / year / media_type / origin_lang
  overview / poster_path / chinese_titles

media_roots 表：守备目录 + content_type（movies/tv/mixed）
```

## 四、已验证的能力（115 测试目录 Mediary Scout）

- **机械扫描**：611 文件扫描，248 新入库，confidence 分类正确
- **识别**：83 作品全部识别（中文目录名/`{tmdb-N}` 标签/leetspeak/×变体全处理）
- **judge**：248 文件判定需字幕（国产/内嵌/sidecar 跳过逻辑正确）
- **字幕**：可写目录端到端装盘验证过（Overflow 8 集、American Horror Story 20 集）
- **巡检模型**：扫描→识别→judge→字幕一条龙跑通（115 实测）
- **死循环修复**：找不到的标 24h 退避，队列推进不卡死

## 五、测试状态

- 后端 2768 条测试，7 红（全为既有债务，与近期工作无关）：
  - deployContract 3（部署契约，CI 环境相关）
  - buildAdapters 2（zimuku 灰色站点网络探测）
  - secrets 1 / settingsRepo 1（历史断言没同步代码演化）
- 前端 863 条测试（但前端要重做，见待办）

## 六、环境

- 软路由：192.168.100.1（SSH root，密码见本机 ~/.ssh 或密码管理器，不入库）
- 容器：subtitle-scout（ghcr.io/fancydirty/subtitle-scout:latest）
- OpenList：115 网盘挂载（cookie 已配），rclone WebDAV 只读挂到 /mnt/nvme0n1-4/115-test/
- 测试目录：115 网盘 Mediary Scout（83 作品，Jellyfin 约定，只读）
- 生产媒体：nas_media（用户真实媒体库，**用户裁决不再当测试目录用**）

## 七、待办（compact 后讨论）

### 后端
1. **字幕写盘验证用可写目录**——115 只读验证不了写盘，需要一个可写测试媒体目录
   （用户问：OpenList 只能写入？需确认 115 是否可写或另建）
2. **dispatcher.ts 死代码清理**——daemonV2 巡检化后不再用它
3. **旧架构代码清理**——orchestrator agent / unidentified / workUnit 分组等 18 个旧 agent 文件
4. **旧表迁移**——episodes/movies/subtitles → files/works（provider_ref 来源保留）
5. **skill 限流措辞**——明确"限流等待 vs no_safe_match"（Peacemaker 误判根因）
6. **Dockerfile CMD 改 daemonV2**——当前手动启动，应设为容器主进程
7. **AI 翻译链路验证**（TRANSLATE_* 配置已就绪，未跑过新架构）

### 前端（已裁决删了重做）
8. **前端全删重做**——围绕新数据模型（files/works）重写，用户说"慢慢耐心讨论"

### 文档
9. 归档已完成（7 份过时 → archive/），`conveyor-architecture.md` 归属待确认

## 八、最近提交（git log）

```
f5fdd63 feat(v2): daemonV2 巡检化——消除 30s 轮询，对齐 Jellyfin 日巡检模型
5b5ec79 fix(v2): 死循环修复步 4-5——步数上限移除 + 识别 catch-all + 只读根防护
1db10f0 fix(v2): 死循环修复步 1-3——recheck_after 退避 + 反编造门 + catch-all
f8012dc fix(v2): 死循环修复步 1-3（重复提交）
bd3246c test(tmdb): getDetails 期望值补 title 字段（v30 schema）
7cab442 feat(v2): 新架构 daemon（daemonV2）——纯机械调度主循环
f8dc10d fix(v2): 字幕装盘后标记 covered（needs_subtitle=0）
8270ef0 fix(v2): 字幕链路 itemId 派生 + sidecar BCP-47 探测 + 判定修复
（更早的在新架构文档 archive 里有记录）
```
