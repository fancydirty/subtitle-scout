# Bazarr 深度调研报告（v2 rebuild 参考）

来源：调研子代理 2026-07-09，事实均附源。同域字幕自动化标杆（Python+SQLite，Sonarr/Radarr 生态）。

## 核心要点（供 v2 spec 引用）

### 数据模型（bazarr/app/database.py）
- **TableShows / TableEpisodes / TableMovies**：媒体镜像。TableEpisodes 关键字段
  `missing_subtitles`（JSON 字符串列表，如 `"['en:hi','zh']"`）+ `failedAttempts`。
- **TableEpisodesSubtitles / TableMoviesSubtitles**：字幕分表（language/path/forced/hi/size），
  外键 cascade delete，UNIQUE(path+item+language+forced+hi)。→ v2 已采纳为 `subtitles` 表。
- **TableHistory**：provider/subs_id/score/score_out_of/matched/not_matched +
  `upgradedFromId` 自引用外键形成升级链。→ v2 暂不做 upgrade，schema 留意即可。
- **TableBlacklist**：language/provider/subs_id/timestamp，防重复下载已知坏字幕。→ v2 已采纳。
- **Wanted 无独立表**：动态查询 `missing_subtitles != '[]'`。优点零一致性问题；缺点无法持久化
  优先级/退避。→ v2 折中：wanted 从 episodes.sub_status 推导（level-triggered），
  退避状态持久化在聚合 job 行上。

### 调度（APScheduler）
- wanted 搜索默认 3 小时一轮，**逐集搜索**（无季聚合）；大库建议 6-24h。
- Adaptive searching：失败 4 周后降为每周一搜。
- **Provider 限流反模式**：429 → 全局静态冷却 10 分钟，无指数退避 →社区大量
  "All providers are throttled" 投诉（Issue #2845）。→ v2 明确不学，用指数退避+escalation。
- ASSRT 在 Bazarr 里也是 5/min 特判（Issue #1953）——与我们实测一致。

### 同步模型
- 定期**全量** pull（1-5min）+ SignalR 实时推送（Sonarr v3+）+ webhook 端点。
- 全量同步在 52k+ 集大库上内存失控（Issue #3241）。→ v2 用分页增量 + 6h 全量对账。

### UI 信息架构
- Series/Episodes/Wanted/History 四页；每集显示缺失语言列表与已有字幕列表；
  徽章=len(missing_subtitles)；已知徽章与实况不同步的 bug（Issue #257/#1483）。
- → v2 库视图直接以 DB 为准实时查询，避免派生计数漂移。

### 直接借鉴 / 改造 / 不学 清单
- ✅ 直接：字幕分表、blacklist、（未来）升级链、动态 wanted 推导
- 🔄 改造：全量同步→增量+定期对账；逐集搜索→按季聚合（我们的改进点）；静态退避→指数
- ❌ 不学：依赖 Sonarr 中间层、APScheduler 全量轮询、规则引擎匹配（我们有 LLM 判断链）、
  JSON 存文本字段（用 SQLite 原生 json_extract）

## Sources
- github.com/morpheus65535/bazarr（database.py、sonarr/sync/series.py）
- wiki.bazarr.media（Performance-Tuning、Settings、Setup-Guide）
- trash-guides.info/Bazarr/Bazarr-suggested-scoring/
- Issues: #2845(throttle), #2041(wanted), #1107(APScheduler), #1483/#257(徽章不同步),
  #1458(批量bug), #1985(SignalR), #3241(内存), #1953(ASSRT 5/min)
