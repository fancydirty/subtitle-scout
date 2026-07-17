# 验收修复轮一 · 设计（2026-07-17）

dashboard 战役 F7 收官后用户首轮真机验收的反馈修复。两项设计变更（用户已裁决）+ 五件无争议修复。
上游 spec=2026-07-16-dashboard-rebuild-design.md；宪法=web/DESIGN.md 继续适用。

## A. 媒体库分区 = TMDB 元数据派生（用户裁决：与守备目录解耦）

**判据（用户确认）**：TMDB genres 含 Animation(id=16) → **动漫**，不看产地（美番《爱死机》、
国漫《百炼成神》一律动漫）；其余剧 → **剧集**；电影条目一律 → **电影**（不再看路径）。

**数据链**：
- v13 迁移：`ALTER TABLE series ADD COLUMN genres TEXT`（TMDB genre id 的 JSON 数组，如 `[16,35]`；
  NULL=尚未富化）。
- `TmdbClient.getDetails` 返回值加 `genreIds: number[]`（解析 `/tv|movie/{id}` 响应的 `genres[].id`）；
  `enrichNewSeriesOrMovie` 透传；ingest 的 `upsertSeries` 落列。
- **富化重试（新机制，一石二鸟）**：每轮 ingest pass 末尾，捞 `name='' OR genres IS NULL` 的
  series（每轮上限 10 部，防 TMDB 抖动期连环空转），重跑 enrich 并回写 name/chinese_title/
  poster_path/year/genres 中缺失的字段。存量 36 部剧的 genres 与"空名 ? 卡"（tmdb:24240，
  P6 认领后富化失败且永不重试的缺口）由它自动治愈。
- `sectionOf` 新规则：电影→'电影'；剧有 genres→16∈genres?'动漫':'剧集'；剧无 genres→
  沿现有路径派生兜底；路径也认不出→**'其他'**（处决 `_scout_realign_test` 式原样漏出）。
  分区 token 收敛为闭集 {剧集,动漫,电影,其他}，前端 sectionLabel 全量可 i18n。

## B. Workflow 页叙事化（用户裁决：结构重造，语言全英文——原"永不本地化"裁决完整保留）

病根：三条运维泳道无叙事。重造为"活动故事"页：

- **顶部人话总览行**（英文，Midday 式大数字嵌句）：
  `Watching 13 gaps · 37 episodes installed in last 24h · 1 worker running`。
  数据全部来自现有三端点聚合，不新增后端账目（installed 24h 计数=recent runs 里
  decision='installed' 且 finished_at>now-24h 的行数——近似值，limit 20 截断如实；
  或 workers 端点顺手加一条 COUNT 查询，实施时取后者，一句 SQL 的事）。
- **Activity 流（页面主体，右/宽列）**：running 卡在最上（保留 TraceRows 直播——灵魂卖点不动），
  卡头改人话句 `Searching subtitles — The Rig`; 其下 recent 行改人话句式：
  `{seriesName} — {decision 短语} · {相对时间}`，decision 短语静态映射
  （installed→"subtitles installed"，no_safe_match→"no safe match found"，
  retry_later→"transient failure, will retry"，error→"failed"，realign:*→"library realigned" 族）。
  **剧名替换 tmdb id**（后端 recent 查询 LEFT JOIN series 取 name，movie 同理）；detail 原文
  与三桶报告仍在点开的右侧板（RunDetail 不动）。
- **Orchestrator passes 降级折叠**：Collapsible「Orchestrator log」默认收起，回执 chip 只在
  展开后出现——工程师内容零删除，只是不再糊脸。
- **Pending 泳道保持**（已可读），布局从三泳道改两列：Pending | Activity（passes 折叠区挂
  Activity 底部）；移动端单列不变。

## C. 甄别页修复三件（用户点名）

1. **待选框按目录分组**：停车行按 dirname 分组渲染，认领按钮挂在**目录组**上（一组一认领
   对话框，组内文件列表只读展示）——与 override 的目录级传播粒度一比一，天然"一次一部"，
   多选歧义消灭（原逐行 checkbox 多选撤掉）。
2. **认领后的即时反馈**：认领成功→该目录组立即置灰标记 `claimed · awaiting rescan` 并沉底；
   同时后端 claim 分支踢一脚扫描（startDashboard 加可选 `requestIngest` 闭包，cmdWatch 接
   现有 ingestTrigger）——下一轮 pass（测试台 2min）行真正退户口消失。
3. **duplicate-content 单独分组**：这类停车行（重复副本）与"待人工认领"分开成组，组头说明
   `Duplicates — subtitle propagation is planned; no action needed`（i18n 双语），默认折叠。
   根治归重复源战役（用户本轮反馈将其优先级顶升——立项队列排位提前，本轮只做呈现分组）。

## 非目标（本轮不做）

- 重复副本的字幕自动复制（重复源战役本体，schema v14 级）。
- Workflow 叙事句的集数计数深加工（detail 解析脆弱，v1 句式不含计数，点开看原文）。
- 分区手动覆盖（先看元数据判据的真实准确率，不预建配置面）。

## 验收口径

测试台（scout-test）重部署后用户刷新真机复验：①海报墙动漫/剧集按元数据归位（爱死机/间谍过家家
/Nukitashi 入动漫；? 卡有名字有海报）②Workflow 页一眼读懂在干啥③甄别页按目录认领 Frieren 一组
后 2 分钟内整组消失④duplicate 组不再吓人。
