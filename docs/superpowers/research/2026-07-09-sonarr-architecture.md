# Sonarr/Radarr 架构深度调研报告

## 摘要

本报告深度调研了 Sonarr（及其兄弟项目 Radarr）的内部机制，特别关注与 subtitle-scout v2（SQLite 状态机 + 按剧聚合调度）直接相关的五个核心领域。Sonarr 是 C# 实现的媒体自动化调度系统，采用 Specification 模式的决策引擎、SQLite/PostgreSQL 双后端、基于时间戳的轮询调度器，以及事件驱动的状态跟踪机制。

---

## 一、季包 vs 单集的搜索决策（最重要）

### 1.1 当前实现机制

**核心发现**：Sonarr **并不存在明确的"缺集数≥阈值则搜季包"的决策引擎**，而是采用**混合搜索策略**，同时提交季包和单集查询。

#### 搜索命令层级
Sonarr 的搜索架构分为三层命令：
- **SeriesSearchCommand** - 全剧搜索
- **SeasonSearchCommand** - 季度搜索（入口点）
- **EpisodeSearchCommand** - 单集搜索

来源文件：`src/NzbDrone.Core/IndexerSearch/`
- `SeasonSearchCommand.cs`
- `EpisodeSearchCommand.cs`  
- `SeasonSearchService.cs`

#### ReleaseSearchService 的混合策略

**关键代码逻辑**（`ReleaseSearchService.SeasonSearch` 方法，第 156-209 行）：

1. **Scene Mapping 分组**：先通过 SceneMapping 将剧集按发布编号分组
2. **动态查询生成**：
   - 当一个 mapping 包含**多集**时 → 生成 `SeasonSearchCriteria`（季包查询）
   - 当一个 mapping 只有**单集**时 → 生成 `SingleEpisodeSearchCriteria`（单集查询）
3. **结果聚合**：所有查询的 `DownloadDecision` 合并后通过 `DeDupeDecisions()` 去重
   - 按 release GUID 分组
   - 优先保留拒绝理由最少的结果
   - 使用 indexer 优先级作为平局决胜器

**去重机制**（第 560-566 行）：
```csharp
decisions.GroupBy(d => d.RemoteEpisode.Release.Guid)
    .Select(g => g.OrderBy(d => d.Rejections.Count())
                  .ThenBy(d => d.RemoteEpisode.Release.IndexerPriority)
                  .First())
```

**来源**：[ReleaseSearchService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/IndexerSearch/ReleaseSearchService.cs)

### 1.2 社区争议与设计权衡

**长期存在的架构争议**：

#### Issue #1812: Completed Season Search
- **用户痛点**：为已完结季搜索时，Sonarr 先对每集发起单独 API 调用，然后才考虑季包
- **性能问题**：大季数剧集"花费巨量时间"且"产生大量 API 调用"
- **提议方案**：优先搜季包，失败后再降级到单集搜索

**来源**：[Issue #1812](https://github.com/Sonarr/Sonarr/issues/1812)

#### Issue #3891: 分级 fallback 机制
当前限制：季度搜索限制为每个 indexer 前 100 个结果
- **提议的决策树**：
  1. 搜索匹配质量和偏好词的季包
  2. 若未找到合适季包 → 单集搜索
  3. 优先级排序：质量 → 偏好词得分 → 种子数
  4. 最终降级：接受低质量季包

**来源**：[Issue #3891](https://github.com/Sonarr/Sonarr/issues/3891)

#### Issue #7744: 不必要的并行搜索
用户报告即使找到完整季包，Sonarr 仍继续搜索单集，浪费 indexer 配额。

**来源**：[Issue #7744](https://github.com/Sonarr/Sonarr/issues/7744)

### 1.3 Specification 决策模式

**决策引擎核心**：`DownloadDecisionMaker` 使用职责链模式聚合多个 Specification。

**关键逻辑**（`GetDecisionForReport` 方法）：
```csharp
foreach (var specifications in _specifications.GroupBy(v => v.Priority).OrderBy(v => v.Key))
{
    reasons = specifications.Select(c => EvaluateSpec(c, remoteEpisode, searchCriteria))
        .Where(c => c != null)
        .ToArray();
    if (reasons.Any())  // 短路：任何优先级组有拒绝即停止
    {
        break;
    }
}
```

**设计要点**：
- 按 `Priority` 分组，**低优先级先执行**
- 同优先级内的 Specification 并行评估
- 一旦某优先级组有拒绝，停止后续检查（短路求值）
- `Accept` 返回 `null`，`Reject` 返回 `DownloadRejection` 对象

**来源**：[DownloadDecisionMaker.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/DecisionEngine/DownloadDecisionMaker.cs)

#### 关键 Specification 清单（按重要性）

**阻断型（Critical）**：
- `AlreadyImportedSpecification` - 防止重复导入
- `BlocklistSpecification` - 黑名单过滤
- `ReleaseRestrictionsSpecification` - 发布限制规则

**质量判断**：
- `QualityAllowedByProfileSpecification` - 质量档位匹配
- `UpgradableSpecification` - 升级可行性
- `AcceptableSizeSpecification` - 文件大小验证（基于运行时长）

**季包特定**：
- `FullSeasonSpecification` - 季包完整性验证
- `SeasonPackOnlySpecification` - 仅季包模式
- `MultiSeasonSpecification` - 多季打包支持

**来源**：[DecisionEngine/Specifications/](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/DecisionEngine/Specifications)

---

## 二、SQLite 用法

### 2.1 Schema 组织

#### 核心表结构（来自 `001_initial_setup.cs`）

**Series 表**：
```sql
- TvdbId (unique), TvRageId, ImdbId
- Title, CleanTitle, TitleSlug, Overview, Status
- QualityProfileId, SeasonFolder, SeriesType
- Runtime, Network, AirTime, FirstAired, NextAiring
- LastInfoSync, LastDiskSync, Monitored
```

**Episodes 表**：
```sql
- TvDbEpisodeId (unique)
- SeasonNumber, EpisodeNumber, AbsoluteEpisodeNumber
- SceneSeasonNumber, SceneEpisodeNumber (映射)
- Title, Overview, AirDate
- SeriesId, EpisodeFileId (外键)
```

**EpisodeFiles 表**：
```sql
- Path (unique), Quality, Size, DateAdded
- SeriesId, SeasonNumber, SceneName, ReleaseGroup
```

**History 表**：
跟踪下载历史（grabs/imports/failures），包含：
- EpisodeId, SeriesId, Quality, Date
- IndexerId, SourceTitle, EventType
```

**来源**：[001_initial_setup.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/Migration/001_initial_setup.cs)

#### Commands 表（Migration 078）

**任务队列表结构**：
```sql
CREATE TABLE Commands (
    Name TEXT NOT NULL,           -- 命令类型标识
    Body TEXT NOT NULL,           -- JSON 序列化的参数
    Priority INT NOT NULL,        -- 执行优先级
    Status INT NOT NULL,          -- 状态码（排队/执行中/完成/失败）
    QueuedAt DATETIME NOT NULL,   -- 入队时间
    StartedAt DATETIME NULL,      -- 开始执行时间
    EndedAt DATETIME NULL,        -- 结束时间
    Duration TEXT NULL,           -- 执行时长
    Exception TEXT NULL,          -- 失败时的异常信息
    Trigger INT NOT NULL          -- 触发源（手动/自动/RSS等）
)
```

**作为任务队列的用法**：
- 生命周期：`QueuedAt` → `StartedAt` → `EndedAt`
- 可空的 `StartedAt`/`EndedAt` 表示待执行的命令
- `Exception` 字段捕获失败信息供重试逻辑使用
- `Body` 存储 JSON 化的命令参数（如 SeriesId、SeasonNumber）

**来源**：[078_add_commands_table.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/Migration/078_add_commands_table.cs)

#### Blocklist 表（Migration 083）

**字段扩展**（`additonal_blacklist_columns`）：
- 添加 `Protocol`, `IndexerFlags`, `TorrentInfoHash` 字段
- 支持按协议类型（Torrent/Usenet）分别去重
- Torrent 通过 InfoHash 匹配，Usenet 通过时间戳±2分钟 + 大小±2MB 匹配

**来源**：GitHub 搜索结果提及 Migration 083

### 2.2 Migrations 机制

**版本化迁移**：采用编号迁移文件（`001` ~ `099+`），按序执行。

**代表性迁移**：
- `090_update_kickass_url.cs` - 配置更新
- `091_added_indexerstatus.cs` - Indexer 状态跟踪表
- `092_add_unverifiedscenenumbering.cs` - Scene 编号验证
- `095_add_additional_episodes_index.cs` - Episodes 表索引优化
- `099_extra_and_subtitle_files.cs` - 媒体文件扩展支持

**来源**：[Datastore/Migration/](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/Datastore/Migration)

### 2.3 WAL 与备份策略

#### WAL 处理（在恢复场景）

**DatabaseRestorationService** 的恢复流程：
1. 检测恢复文件存在
2. **删除 WAL 辅助文件**：`-wal`, `-shm`, `-journal`
3. 删除主数据库文件
4. 移动备份文件到数据库位置

**关键代码逻辑**：
```csharp
// 显式清理 SQLite 辅助文件
Delete(databaseFile + "-shm");
Delete(databaseFile + "-wal");
Delete(databaseFile + "-journal");
Delete(databaseFile);
MoveFile(tempDatabaseFile, databaseFile);
```

**来源**：[DatabaseRestorationService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/DatabaseRestorationService.cs)

#### 备份策略

**局限性**：`DatabaseRestorationService` **仅实现恢复逻辑**，不包含备份触发机制。

**推测的备份架构**（未在源码中直接确认）：
- 通过 `BackupCommand` 定时任务触发（见 TaskManager）
- 备份间隔：配置化，范围 1-7 天，转换为分钟
- 保留策略：未在此文件中显示，可能在备份服务本身实现

**来源**：DatabaseRestorationService.cs 分析

#### Vacuum 维护

**MainDatabase** 提供 `Vacuum()` 方法：
```csharp
Vacuum()  // 执行 "VACUUM;" 命令压缩数据库
```

**来源**：[MainDatabase.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/MainDatabase.cs)

### 2.4 双后端支持

**同时支持 SQLite 和 PostgreSQL**：
- `WhereBuilderSqlite.cs` - SQLite 查询构建器
- `WhereBuilderPostgres.cs` - PostgreSQL 查询构建器
- `PostgresOptions.cs` - PostgreSQL 配置选项
- `DatabaseType` 属性识别连接类型

**迁移路径**：用户可从 SQLite 迁移到 PostgreSQL 以获得更好的并发性能。

**来源**：[Datastore/ 目录结构](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/Datastore)

---

## 三、调度器

### 3.1 Scheduled Tasks 组织

**TaskManager** 在应用启动时注册的默认任务（`Handle(ApplicationStartedEvent)` 方法）：

| 任务命令 | 间隔 | 优先级 | 说明 |
|---------|------|--------|------|
| `RefreshMonitoredDownloadsCommand` | 1 分钟 | High | 高频监控下载状态 |
| `RssSyncCommand` | 可配置（≥10 分钟） | Normal | RSS 订阅同步 |
| `BackupCommand` | 可配置（1-7 天） | Normal | 数据库备份 |
| `CheckHealthCommand` | 6 小时 | Normal | 系统健康检查 |
| `RefreshSeriesCommand` | 12 小时 | Normal | 剧集元数据刷新 |

**配置化间隔**：
- **RssSyncInterval**：若配置 < 10 分钟则钳位到 10；若为负数则禁用（设为 0）
- **BackupInterval**：1-7 天范围，转换为分钟（`days × 24 × 60`）

**来源**：[TaskManager.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Jobs/TaskManager.cs)

### 3.2 调度策略

#### Upsert 模式
```csharp
// 任务定义不存在则创建（使用当前时间戳）
// 存在则更新间隔，保留执行历史
_scheduledTaskRepository.Upsert(defaultTask);
```

#### 到期判断（`GetPending()` 方法）
```csharp
// 任务被认为待执行的条件：
// Interval > 0 && (LastExecution + Interval) < DateTime.UtcNow
```

**轮询模式**：无显式调度器线程，依赖周期性轮询 `GetPending()` 方法。

**来源**：TaskManager.cs 分析

### 3.3 错峰执行策略

**观察**：代码中**未见显式错峰机制**，任务通过到期时间自然分散：
- `RefreshMonitoredDownloadsCommand`（1分钟）与 `CheckHealthCommand`（6小时）频率差异天然错峰
- 高优先级任务（High）可能抢占 Normal 优先级任务

**推测**：错峰可能在命令处理器层面通过优先级队列实现，但未在 TaskManager 本身体现。

### 3.4 失败重试逻辑

**TaskManager 局限**：提供的代码**不包含重试逻辑**。
- `Exception` 字段记录失败信息
- 推测重试由 Commands 表的消费者（Command Executor）实现

**Indexer 的退避策略**（`ProviderStatusServiceBase`）：

#### Escalation Level 机制
```csharp
status.EscalationLevel = Math.Min(MaximumEscalationLevel, status.EscalationLevel + 1);
```

每次失败递增 escalation level（上限 `MaximumEscalationLevel`）。

#### 指数退避计算
```csharp
var level = Math.Min(MaximumEscalationLevel, status.EscalationLevel);
return TimeSpan.FromSeconds(EscalationBackOff.Periods[level]);
```

等待时间从预定义数组 `EscalationBackOff.Periods` 按 level 索引查找。

#### Grace Period 保护
- **启动保护期**：应用启动后 `MinimumTimeSinceStartup`（默认 15 分钟）内不触发 escalation
- **首次失败保护期**：首次失败后 `MinimumTimeSinceInitialFailure`（默认 0）内不升级

#### 恢复机制
```csharp
status.EscalationLevel--;  // 成功后逐级降低
status.DisabledTill = null;
```

每次成功调用降低一级，而非立即重置为 0（渐进式恢复）。

**来源**：[ProviderStatusServiceBase.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/ThingiProvider/Status/ProviderStatusServiceBase.cs)

### 3.5 健康检查（Health Check）清单

**HealthCheck 模块结构**：
- `HealthCheckService.cs` - 管理服务
- `EventDrivenHealthCheck.cs` - 事件触发的检查
- `CheckHealthCommand.cs` - 定时检查命令

**具体检查项**（按类别）：

#### Indexer 类（6 项）
- `IndexerStatusCheck` - 运行状态
- `IndexerRssCheck` - RSS 订阅可用性
- `IndexerSearchCheck` - 搜索功能
- `IndexerLongTermStatusCheck` - 长期故障跟踪
- `IndexerDownloadClientCheck` - 与下载客户端兼容性
- `IndexerJackettAllCheck` - Jackett 聚合器配置

#### Download Client 类（5 项）
- `DownloadClientStatusCheck` - 连接性
- `DownloadClientCheck` - 通用验证
- `DownloadClientRootFolderCheck` - 根目录配置
- `DownloadClientSortingCheck` - 下载排序设置
- `DownloadClientRemovesCompletedDownloadsCheck` - 清理配置

#### 系统状态类（4 项）
- `SystemTimeCheck` - 系统时钟准确性（偏差 > 1 天则警告）
- `RootFolderCheck` - 媒体库路径验证
- `MountCheck` - 挂载存储可用性
- `AppDataLocationCheck` - 应用数据目录

#### 集成与导入类（4 项）
- `ImportListStatusCheck` - 导入列表健康度
- `ImportListRootFolderCheck` - 导入路径
- `ImportMechanismCheck` - 导入机制配置
- `RemotePathMappingCheck` - 远程路径映射

#### 其他（7 项）
- `ApiKeyValidationCheck` - API 认证
- `ProxyCheck` - 代理配置
- `NotificationStatusCheck` - 通知系统
- `MetadataCheck` - 元数据提供商
- `RecyclingBinCheck` - 回收站功能
- `UpdateCheck` - 更新可用性
- `PackageGlobalMessageCheck` - 全局消息

**触发方式**：
- 定时触发：`CheckHealthCommand` 每 6 小时
- 事件触发：特定系统事件（如索引器状态变化）

**来源**：[HealthCheck/Checks/](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/HealthCheck/Checks)

---

## 四、状态机

### 4.1 Release 生命周期

**核心状态流**：`Grabbed` → `Downloading` → `Imported`

#### 状态定义（`TrackedDownloadState` 枚举）
- `Downloading` - 默认状态，正在下载
- `Imported` - 已成功导入
- `Failed` - 下载失败
- `Ignored` - 被忽略（手动标记或规则排除）

**来源**：[TrackedDownloadService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Download/TrackedDownloads/TrackedDownloadService.cs)

### 4.2 状态判断逻辑（`GetStateFromHistory` 方法）

```csharp
// 从 History 表获取最新事件类型
var latestHistoryItem = _downloadHistoryService.GetLatestDownloadHistoryItem(downloadId);

switch (latestHistoryItem.EventType)
{
    case HistoryEventType.DownloadImported:
        return TrackedDownloadState.Imported;
    case HistoryEventType.DownloadFailed:
        return TrackedDownloadState.Failed;
    case HistoryEventType.DownloadIgnored:
        return TrackedDownloadState.Ignored;
    default:
        return TrackedDownloadState.Downloading;  // 默认兜底
}
```

**关键点**：
- 状态由 `History` 表中的最新事件决定
- **无复杂状态转换图**，依赖历史事件类型直接映射

### 4.3 失败态处理

#### Blocklist 自动添加
**DownloadFailedEvent** 触发 `BlocklistService.Handle()`：
```csharp
// 从事件提取失败信息
var blocklist = new Blocklist
{
    SeriesId = message.SeriesId,
    EpisodeIds = message.EpisodeIds,
    Protocol = ParseProtocol(message.Data),
    Indexer = message.Data.GetValueOrDefault("indexer"),
    TorrentInfoHash = message.Data.GetValueOrDefault("torrentInfoHash")
};
_blocklistRepository.Insert(blocklist);
```

**去重逻辑**（`Blocklisted()` 方法）：
- **Torrent**：优先比较 InfoHash，fallback 到 indexer + title
- **Usenet**：匹配 publishedDate（±2 分钟） + size（±2 MB） + indexer

**来源**：[BlocklistService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Blocklisting/BlocklistService.cs)

#### 手动重试
用户可从 UI 清除 blocklist 条目后手动重新搜索。

### 4.4 孤儿清理（Orphan Detection）

**TrackedDownloadService** 的 `UpdateTrackable()` 方法：
```csharp
// 比较缓存与下载客户端当前项
var orphans = cached.ExceptBy(downloadClientItems.Select(i => i.DownloadId), t => t.DownloadId);

// 标记为不可跟踪
foreach (var orphan in orphans)
{
    orphan.IsTrackable = false;
}
```

**孤儿定义**：下载客户端不再返回，但仍存在于 Sonarr 缓存中的下载项。

**触发条件**：
- 下载客户端手动删除
- 下载完成后客户端自动清理（配置决定）
- 下载客户端崩溃或连接中断

**来源**：TrackedDownloadService.cs 分析

### 4.5 状态转换触发点

**事件驱动机制**：

1. **`EpisodeInfoRefreshedEvent`** → 刷新缓存中的剧集元数据
2. **`SeriesAddedEvent`/`SeriesDeletedEvent`** → 更新关联的下载项
3. **`TrackedDownloadRefreshedEvent`** → 通知 UI 更新下载队列显示

**轮询触发**：
- `RefreshMonitoredDownloadsCommand`（每分钟）调用 `DownloadMonitoringService`
- 查询下载客户端当前状态，更新 `TrackedDownload` 缓存
- 检测状态变化（`LogItemChange()` 方法）：
  ```csharp
  if (status != cachedItem.Status || canMoveFiles != cachedItem.CanMoveFiles)
  {
      LogItemChange(item, cachedItem);
  }
  ```

**来源**：[TrackedDownloadService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Download/TrackedDownloads/TrackedDownloadService.cs)

### 4.6 完整生命周期示例

```
1. 用户触发搜索 → SeasonSearchCommand 入队
2. ReleaseSearchService 查询 indexers → 返回候选
3. DownloadDecisionMaker 应用 Specifications → Accept 的加入下载
4. 下载客户端抓取 → History 记录 DownloadGrabbed 事件
5. TrackedDownloadService 缓存该项 → 状态 = Downloading
6. RefreshMonitoredDownloadsCommand 轮询客户端 → 检测完成
7. CompletedDownloadService 导入文件 → History 记录 DownloadImported
8. TrackedDownloadService.GetStateFromHistory() → 状态 = Imported
9. 发布 TrackedDownloadRefreshedEvent → UI 更新
10. （若失败）→ BlocklistService 添加条目，状态 = Failed
```

---

## 五、给 subtitle-scout v2 的移植建议清单

### 5.1 直接借鉴（高优先级）

#### ✅ Specification 决策模式
**建议**：采用 Sonarr 的 Specification Pattern 替代当前可能存在的 if-else 决策链。

**subtitle-scout v2 应用场景**：
- `MinimumScoreSpecification` - ASSRT 搜索结果最低评分阈值
- `LanguageMatchSpecification` - 语言匹配（简中/繁中/双语）
- `BlacklistSpecification` - 已失败字幕的黑名单过滤
- `RateLimitSpecification` - ASSRT 4/分钟硬限速检查
- `LLMConfidenceSpecification` - LLM 判断结果的置信度阈值

**实现要点**：
- 每个 Specification 返回 `Accept()`/`Reject(reason)` 的统一接口
- 按优先级分组（如速率限制应在最早检查，LLM 调用应在最后）
- 使用短路求值避免不必要的 API 调用

**移植优势**：
- 易于单元测试（每个规则独立）
- 新增/修改规则不影响已有逻辑
- 清晰的拒绝理由便于调试和日志分析

---

#### ✅ Commands 表作为任务队列
**建议**：借鉴 Commands 表结构管理剧集搜索任务。

**字段映射**：
```sql
CREATE TABLE Commands (
    Name TEXT NOT NULL,           -- "SeasonSubtitleSearchCommand"
    Body TEXT NOT NULL,           -- JSON: {"season_id": 123, "missing_episodes": [1,2,3]}
    Priority INT NOT NULL,        -- 优先级（新剧 > 补全 > 升级）
    Status INT NOT NULL,          -- 0=排队, 1=执行中, 2=完成, 3=失败
    QueuedAt DATETIME NOT NULL,   
    StartedAt DATETIME NULL,      
    EndedAt DATETIME NULL,        
    Duration TEXT NULL,           -- 执行时长（用于性能分析）
    Exception TEXT NULL,          -- 失败时的异常栈（含 ASSRT/LLM 错误）
    Trigger INT NOT NULL          -- 0=RSS, 1=手动, 2=定时补全
)
```

**优势**：
- 天然支持优先级队列
- 失败任务的 `Exception` 字段便于分析 ASSRT/LLM 错误模式
- `Duration` 可监控 LLM 判断链的性能瓶颈

**与现有状态机集成**：
- Commands 表负责任务调度层
- 字幕文件表负责状态跟踪层（downloading/imported/failed）
- 两表通过 CommandId 外键关联

---

#### ✅ 分级 Health Check
**建议**：实现类似 Sonarr 的 26 项健康检查清单。

**subtitle-scout v2 检查项**：

**数据源类**（对应 Indexer 类）：
- `AssrtStatusCheck` - ASSRT API 可用性
- `AssrtRateLimitCheck` - 当前速率限速余量
- `AssrtAuthCheck` - API token 有效性

**LLM 服务类**：
- `LLMProviderCheck` - LLM API 连接性（OpenAI/Anthropic/本地）
- `LLMQuotaCheck` - API 配额余量监控
- `LLMResponseTimeCheck` - 判断链平均延迟

**系统状态类**：
- `SystemTimeCheck` - 时钟准确性（影响 cron 调度）
- `DiskSpaceCheck` - 字幕库存储空间
- `DatabaseIntegrityCheck` - SQLite PRAGMA integrity_check

**任务调度类**：
- `StuckCommandsCheck` - 检测卡在 "执行中" 超过 1 小时的命令
- `BacklogSizeCheck` - 积压任务数预警（> 1000 条）

**触发策略**：
- 定时：每 6 小时（借鉴 Sonarr）
- 事件驱动：ASSRT 429 错误后立即触发 `AssrtRateLimitCheck`

---

#### ✅ 指数退避的 Provider Status
**建议**：移植 `ProviderStatusServiceBase` 的 Escalation Level 机制。

**应用于 ASSRT API**：
```python
# Escalation Periods (秒)
BACKOFF_PERIODS = [0, 60, 300, 900, 3600, 10800]  # 0s, 1m, 5m, 15m, 1h, 3h

# 失败处理
def record_failure():
    status.escalation_level = min(5, status.escalation_level + 1)
    status.disabled_until = now() + timedelta(seconds=BACKOFF_PERIODS[status.escalation_level])

# 成功恢复（渐进式降级）
def record_success():
    if status.escalation_level > 0:
        status.escalation_level -= 1
    status.disabled_until = None
```

**Grace Period 保护**：
- 应用启动后 5 分钟内 ASSRT 失败不触发 escalation（避免网络初始化问题）
- 首次失败后 2 分钟内不升级（给 ASSRT 恢复窗口期）

**优势**：
- 自动应对 ASSRT 临时故障而不停止整个系统
- 避免在 ASSRT 不稳定时快速耗尽速率限速

---

### 5.2 改造适配（中优先级）

#### 🔄 季包优先搜索策略 → 按剧聚合搜索
**差异**：Sonarr 的季包是"单文件包含多集"，字幕是"每集独立文件"。

**移植逻辑**：
- **触发条件**：某剧缺失字幕集数 ≥ 3（可配置）
- **搜索策略**：
  1. 先发起"剧名 + 季数"的泛搜索（类似 Sonarr 的 SeasonSearchCriteria）
  2. LLM 批量判断结果中哪些 subtitles 适配哪些剧集
  3. 若覆盖率 < 80% → fallback 到单集搜索
- **去重逻辑**：借鉴 `DeDupeDecisions()` 按字幕文件 hash 去重

**优势**：
- 减少 ASSRT API 调用次数（4/分钟硬限速下至关重要）
- 批量 LLM 判断比逐集判断更高效（一次 prompt 处理多集）

---

#### 🔄 TrackedDownload → SubtitleDownloadTask
**差异**：字幕下载无 BitTorrent/Usenet 客户端中间层，直接 HTTP 下载。

**状态简化**：
```
Queued → Downloading → Validating (LLM判断) → Imported / Rejected
```

**孤儿检测不适用**：无需 `IsTrackable` 字段，因为没有外部客户端。

**保留机制**：
- `GetStateFromHistory()` 方法从 History 表推断状态
- 事件驱动更新：`SubtitleValidatedEvent` → 更新状态为 Imported/Rejected

---

#### 🔄 History 表扩展
**新增字段**：
```sql
ALTER TABLE History ADD COLUMN LLMProvider TEXT;      -- "openai-gpt4" / "anthropic-claude"
ALTER TABLE History ADD COLUMN LLMTokensUsed INT;     -- token 消耗统计
ALTER TABLE History ADD COLUMN LLMConfidence REAL;    -- 判断置信度 0.0-1.0
ALTER TABLE History ADD COLUMN AssrtResultRank INT;   -- 该字幕在 ASSRT 结果中的排名
```

**用途**：
- 分析哪些 LLM 提供商的判断准确率更高
- 监控 token 消耗，避免超预算
- 评估 ASSRT 排名与实际适配度的相关性

---

### 5.3 不适用/需规避（低优先级）

#### ❌ 季包完整性 Specification
**原因**：`FullSeasonSpecification`/`SeasonPackOnlySpecification` 检查一个文件是否包含完整季，字幕场景不适用（每集独立文件）。

**替代方案**：实现 `CompletedSeasonCheck` health check，定期扫描是否有季度全部字幕已齐全。

---

#### ❌ Torrent Seeding 检查
**原因**：`TorrentSeedingSpecification` 检查种子健康度，字幕直接 HTTP 下载无此需求。

**替代方案**：实现 `SubtitleSourceAvailabilityCheck`，验证 ASSRT 返回的下载链接是否有效（HTTP 200 检查）。

---

#### ❌ Download Client 系列检查
**原因**：字幕无 SABnzbd/NZBGet/qBittorrent 等中间客户端。

**替代方案**：实现 `HttpDownloaderCheck`，验证用于下载字幕的 HTTP 客户端配置（代理、超时、User-Agent）。

---

#### ❌ Scene Mapping
**原因**：Sonarr 的 Scene Mapping 处理发布组编号与 TVDB 编号差异，字幕场景不涉及。

**保留必要性**：若未来支持多字幕源（如射手网、字幕库），可能需要剧名别名映射。

---

### 5.4 架构级建议

#### 🎯 推荐技术栈对齐
| Sonarr | subtitle-scout v2 推荐 |
|--------|------------------------|
| C# + .NET | Python 3.11+ (保持现状) |
| SQLite + PostgreSQL 双后端 | SQLite（单实例足够），保留 PostgreSQL 迁移路径 |
| Specification Pattern | **必须引入** |
| Event Aggregator | 使用 Python 的 `dataclasses` + `@dataclass` 定义事件 |
| Dependency Injection | 使用 `dependency-injector` 库或手动注入 |

#### 🎯 关键性能参数

**调度间隔**（参考 Sonarr）：
- **RSS 同步**：15 分钟（Sonarr 最低 10 分钟，字幕更新频率低可放宽）
- **下载监控**：2 分钟（Sonarr 1 分钟，字幕下载快可降频）
- **健康检查**：6 小时（直接借鉴）
- **补全搜索**：每日 03:00（错峰 ASSRT 高峰期）

**ASSRT 特殊处理**：
- 全局速率限制器：4 次/分钟（硬限速）
- 单剧连续失败 3 次 → Escalation Level 1（等待 5 分钟）
- Escalation Level 5 → 禁用 3 小时

---

#### 🎯 数据库 Schema 建议

**核心表重构**：
```sql
-- Series 表（对应 Sonarr 的 Series）
CREATE TABLE Series (
    Id INTEGER PRIMARY KEY,
    TmdbId INTEGER UNIQUE,          -- 外部标识
    Title TEXT NOT NULL,
    CleanTitle TEXT,                -- 去特殊字符版本（用于模糊匹配）
    Year INTEGER,
    Status TEXT,                    -- "continuing" / "ended"
    Monitored BOOLEAN DEFAULT 1,
    LastSearchTime DATETIME,
    LastUpdateTime DATETIME
);

-- Episodes 表
CREATE TABLE Episodes (
    Id INTEGER PRIMARY KEY,
    SeriesId INTEGER NOT NULL,
    SeasonNumber INTEGER NOT NULL,
    EpisodeNumber INTEGER NOT NULL,
    Title TEXT,
    AirDate DATE,
    Monitored BOOLEAN DEFAULT 1,
    FOREIGN KEY (SeriesId) REFERENCES Series(Id),
    UNIQUE(SeriesId, SeasonNumber, EpisodeNumber)
);

-- SubtitleFiles 表（对应 Sonarr 的 EpisodeFiles）
CREATE TABLE SubtitleFiles (
    Id INTEGER PRIMARY KEY,
    EpisodeId INTEGER NOT NULL,
    Path TEXT UNIQUE NOT NULL,      -- 文件系统路径
    Language TEXT NOT NULL,         -- "zh-CN" / "zh-TW" / "en"
    Source TEXT,                    -- "ASSRT" / "手动上传"
    SourceId TEXT,                  -- ASSRT 的字幕 ID
    Quality REAL,                   -- LLM 评分 0.0-1.0
    AddedDate DATETIME NOT NULL,
    FOREIGN KEY (EpisodeId) REFERENCES Episodes(Id)
);

-- Commands 表（任务队列）
CREATE TABLE Commands (
    Id INTEGER PRIMARY KEY,
    Name TEXT NOT NULL,
    Body TEXT NOT NULL,             -- JSON
    Priority INTEGER DEFAULT 1,
    Status INTEGER DEFAULT 0,       -- 0=排队, 1=执行中, 2=完成, 3=失败
    QueuedAt DATETIME NOT NULL,
    StartedAt DATETIME,
    EndedAt DATETIME,
    Duration INTEGER,               -- 毫秒
    Exception TEXT,
    Trigger INTEGER NOT NULL,       -- 0=自动, 1=手动, 2=RSS
    RetryCount INTEGER DEFAULT 0    -- 重试次数
);

-- Blocklist 表
CREATE TABLE Blocklist (
    Id INTEGER PRIMARY KEY,
    SeriesId INTEGER NOT NULL,
    EpisodeId INTEGER NOT NULL,
    Source TEXT NOT NULL,           -- "ASSRT"
    SourceId TEXT NOT NULL,         -- 字幕 ID
    Reason TEXT,                    -- "LLM rejected: wrong episode"
    BlockedDate DATETIME NOT NULL,
    FOREIGN KEY (SeriesId) REFERENCES Series(Id),
    FOREIGN KEY (EpisodeId) REFERENCES Episodes(Id),
    UNIQUE(Source, SourceId, EpisodeId)  -- 同字幕+同集不重复拉黑
);

-- History 表（审计日志）
CREATE TABLE History (
    Id INTEGER PRIMARY KEY,
    EventType TEXT NOT NULL,        -- "Search" / "Download" / "Import" / "Reject"
    SeriesId INTEGER,
    EpisodeId INTEGER,
    SubtitleFileId INTEGER,
    Date DATETIME NOT NULL,
    Data TEXT,                      -- JSON: {"assrt_rank": 3, "llm_confidence": 0.85}
    FOREIGN KEY (SeriesId) REFERENCES Series(Id),
    FOREIGN KEY (EpisodeId) REFERENCES Episodes(Id),
    FOREIGN KEY (SubtitleFileId) REFERENCES SubtitleFiles(Id)
);

-- ProviderStatus 表（ASSRT 退避状态）
CREATE TABLE ProviderStatus (
    Id INTEGER PRIMARY KEY,
    Provider TEXT UNIQUE NOT NULL,  -- "ASSRT"
    EscalationLevel INTEGER DEFAULT 0,
    InitialFailure DATETIME,
    MostRecentFailure DATETIME,
    DisabledUntil DATETIME,
    LastSuccessTime DATETIME
);

-- ScheduledTasks 表（定时任务配置）
CREATE TABLE ScheduledTasks (
    Id INTEGER PRIMARY KEY,
    Name TEXT UNIQUE NOT NULL,      -- "RssSync" / "BacklogSearch"
    Interval INTEGER NOT NULL,      -- 分钟
    LastExecution DATETIME,
    NextExecution DATETIME,
    Priority INTEGER DEFAULT 1
);
```

**索引优化**：
```sql
CREATE INDEX idx_episodes_series ON Episodes(SeriesId, SeasonNumber, EpisodeNumber);
CREATE INDEX idx_subtitlefiles_episode ON SubtitleFiles(EpisodeId);
CREATE INDEX idx_commands_status ON Commands(Status, Priority, QueuedAt);
CREATE INDEX idx_history_episode ON History(EpisodeId, Date DESC);
CREATE INDEX idx_blocklist_lookup ON Blocklist(Source, SourceId, EpisodeId);
```

---

### 5.5 风险与限制

#### ⚠️ LLM 判断链的特殊性
**与 Sonarr 差异**：Sonarr 的 Specification 多为确定性规则（文件大小、种子数），subtitle-scout v2 的 LLM 判断是**概率性**的。

**应对策略**：
- 引入 `LLMConfidence` 字段记录置信度
- 低置信度结果（< 0.7）触发人工审核队列
- 定期采样验证 LLM 判断准确率（通过用户反馈或 History 表分析）

---

#### ⚠️ ASSRT 速率限制的硬约束
**Sonarr 优势**：多 indexer 并行搜索可突破单源限制。
**subtitle-scout 劣势**：ASSRT 是唯一主要源，4/分钟硬限速无法绕过。

**缓解措施**：
- **负缓存**：已搜索但无结果的剧集记录 `LastSearchTime`，24 小时内不重复搜索
- **智能聚合**：优先按季聚合搜索，减少 API 调用
- **错峰调度**：补全任务放在凌晨 3-5 点（推测 ASSRT 低峰期）
- **用户反馈机制**：允许用户手动上传字幕，减少对 ASSRT 的依赖

---

#### ⚠️ SQLite 并发写入限制
**Sonarr 方案**：支持迁移到 PostgreSQL。
**subtitle-scout 建议**：
- 初期单实例 + WAL 模式足够（SQLite 的 WAL 支持多读一写）
- 若未来多实例部署，优先考虑：
  1. Redis 作为任务队列（替代 Commands 表的轮询）
  2. PostgreSQL 作为状态存储
  3. SQLite 降级为只读缓存

**WAL 配置**（借鉴 Sonarr）：
```python
import sqlite3
conn = sqlite3.connect("subtitle_scout.db")
conn.execute("PRAGMA journal_mode=WAL")
conn.execute("PRAGMA synchronous=NORMAL")  # 性能与安全性平衡
conn.execute("PRAGMA cache_size=-64000")   # 64MB 缓存
```

---

## 六、总结

### 核心发现

1. **Sonarr 并无"智能季包优先"逻辑**，而是混合搜索 + 去重，这与社区长期诉求存在差距。subtitle-scout v2 可设计更优的聚合策略。

2. **Specification Pattern 是决策引擎的最佳实践**，subtitle-scout v2 应立即引入，特别适合 LLM 判断链的模块化。

3. **Commands 表作为任务队列**简洁有效，优于复杂的消息队列中间件（对单实例应用）。

4. **Health Check 系统**是生产就绪的关键，subtitle-scout v2 当前缺失，需补齐。

5. **指数退避的 Provider Status** 可直接移植到 ASSRT API 的故障处理。

6. **状态机依赖 History 表**而非内存状态，保证了持久化和可追溯性，subtitle-scout v2 应采用。

### 优先级行动清单

**P0（立即实施）**：
- [ ] 引入 Specification Pattern 重构决策逻辑
- [ ] 创建 Commands 表和任务队列消费者
- [ ] 实现 ASSRT 的 ProviderStatus + 指数退避

**P1（近期规划）**：
- [ ] 设计并实现 Health Check 系统（至少 10 项检查）
- [ ] 重构 SQLite schema 对齐 Sonarr 的表结构设计
- [ ] 实现按剧聚合搜索策略（替代逐集搜索）

**P2（中长期优化）**：
- [ ] 开发 dashboard 监控 Commands 执行情况和 Health Check 结果
- [ ] 引入 WAL 模式和定期 vacuum 策略
- [ ] 设计 PostgreSQL 迁移路径（预留接口）

---

## 附录：来源清单

### GitHub 源码文件
1. [SeasonSearchService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/IndexerSearch/SeasonSearchService.cs)
2. [ReleaseSearchService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/IndexerSearch/ReleaseSearchService.cs)
3. [DownloadDecisionMaker.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/DecisionEngine/DownloadDecisionMaker.cs)
4. [AcceptableSizeSpecification.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/DecisionEngine/Specifications/AcceptableSizeSpecification.cs)
5. [TaskManager.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Jobs/TaskManager.cs)
6. [TrackedDownloadService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Download/TrackedDownloads/TrackedDownloadService.cs)
7. [BlocklistService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Blocklisting/BlocklistService.cs)
8. [ProviderStatusServiceBase.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/ThingiProvider/Status/ProviderStatusServiceBase.cs)
9. [DatabaseRestorationService.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/DatabaseRestorationService.cs)
10. [001_initial_setup.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/Migration/001_initial_setup.cs)
11. [078_add_commands_table.cs](https://github.com/Sonarr/Sonarr/blob/develop/src/NzbDrone.Core/Datastore/Migration/078_add_commands_table.cs)

### GitHub Issues
12. [Issue #1812: Completed Season Search](https://github.com/Sonarr/Sonarr/issues/1812)
13. [Issue #3891: Show/Season Searches fallback to Episode Searches](https://github.com/Sonarr/Sonarr/issues/3891)
14. [Issue #7744: Unnecessary parallel episode searches](https://github.com/Sonarr/Sonarr/issues/7744)
15. [Issue #4229: Search season packs only button](https://github.com/Sonarr/Sonarr/issues/4229)
16. [Issue #2037: Season packs optimization](https://github.com/Sonarr/Sonarr/issues/2037)

### 官方文档
17. [Sonarr System Wiki](https://wiki.servarr.com/sonarr/system)
18. [Sonarr Activity Wiki](https://wiki.servarr.com/sonarr/activity)
19. [Sonarr FAQ](https://wiki.servarr.com/sonarr/faq)
20. [Radarr Activity Wiki](https://wiki.servarr.com/radarr/activity)
21. [Sonarr PostgreSQL Setup](https://wiki.servarr.com/sonarr/postgres-setup)

### 目录结构
22. [IndexerSearch/ 目录](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/IndexerSearch)
23. [DecisionEngine/Specifications/ 目录](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/DecisionEngine/Specifications)
24. [HealthCheck/Checks/ 目录](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/HealthCheck/Checks)
25. [Datastore/Migration/ 目录](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/Datastore/Migration)
26. [TrackedDownloads/ 目录](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/Download/TrackedDownloads)

---

**报告生成时间**：2026-07-09  
**调研范围**：Sonarr develop 分支（截至访问时最新代码）  
**字数统计**：约 12,000 字  
**建议阅读顺序**：第一章（季包决策）→ 第五章（移植建议）→ 其余章节深入细节
