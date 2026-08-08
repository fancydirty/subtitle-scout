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

病根：三条运维泳道无叙事。两路调研定稿（正面样本=ChatGPT agent/Devin/Perplexity/Netlify/
GitHub Actions/Overseerr 的公约数五铁律；反面实锤=Sonarr/Radarr Activity 页正是同受众
"看不懂"抱怨的重灾区，与现三泳道同构；工程向 run 视图——Inngest/Trigger.dev/langfuse——
无一提供人话层先例，只配当内层；组件轮子全是 shadcn 系，Astryx 上自绘）：

**五铁律**：①句子主语=内容（剧名）永不=系统部件（worker/job/pass）②默认态=人话摘要，
工程细节永远在点开之后③"正在进行"=短句+步数+耗时，不是滚动日志糊脸④失败/等待用面向
下一步的中性话，红只给点不给块⑤相对时间右对齐位置恒定。

- **顶部人话总览行**（Midday 式大数字嵌句）：
  `Watching 13 gaps · 37 episodes installed in the last 24h · 1 agent working`。
  installed 24h 计数=workers 端点加一条 COUNT 查询（一句 SQL），其余来自现有聚合。
- **Now working 卡（Activity 流顶部）**：卡头人话句 `Searching subtitles for {seriesName}` +
  已跑时长；直播步骤保留（灵魂卖点）但**工具名静态映射成人话动词短语**（read_doc→
  `Reading the playbook`、search_source→`Searching providers`、list_candidates→
  `Reviewing candidates`、probe_candidate→`Inspecting a candidate`、install_subtitle→
  `Installing a subtitle`、finalize→`Wrapping up`、dispatch_*→`Planning work`；未映射工具名
  原样 mono 兜底）；argsSummary 默认不显示，行右仍是耗时；卡头点开右侧板见原始工具名+参数
  （工程层）。
- **Activity 流（页面主体，宽列）**：recent 行改人话句式
  `{seriesName} — {decision 短语} · {相对时间右对齐}`，decision 短语静态映射
  （installed→"subtitles installed"，no_safe_match→"no safe match found"，
  retry_later→"will retry later"【灰点中性，铁律④】，error→"hit a problem — will retry"
  【红点无红块】，realign:done→"library realigned"，realign:parked→"needs a manual look"，
  realign:error→"realign hit a problem"）。**剧名替换 tmdb id**（后端 recent 的 LEFT JOIN
  顺手取 series.name/movies.name；名字为空的降级显示 id——诚实兜底）；detail 原文/三桶报告/
  原始痕迹仍在点开的右侧板（RunDetail 零改动）。
- **Orchestrator passes 降级折叠**：Collapsible「Orchestrator log」默认收起，回执 chip 只在
  展开后出现——工程师内容零删除，只是不再糊脸。
- **Gaps 列保持**（原 Pending，已可读），布局三泳道→两列：Gaps | Activity（passes 折叠区挂
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
