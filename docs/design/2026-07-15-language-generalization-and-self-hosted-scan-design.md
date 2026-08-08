# v3 反客为主 · 语言泛化 + 自研巡检/触发 + 自研刮削识别 · 设计（2026-07-15）

状态：brainstorming 完成（用户逐轮追问验证），未写代码。本设计是三个独立子系统，各自可单独实现/单独测试/单独回滚。

## 背景：为什么现在做这个

v3 核心（找字幕 agent + orchestrator 智能闸门 + realign）已在真站验证过（stage-3 PASS、B 层 12/12、Wall①②断且真站验证 PASS）。用户在此基础上把产品愿景升级：不再是"给 Jellyfin 的中文字幕 sidecar"，而是"agent 驱动的 Bazarr 替代品，最终可能把 Jellyfin 降级为纯刮削器"。这次升级逼出三处旧假设需要纠正/补齐：

1. **语言写死了中文**——现在要支持任意目标字幕语言，且要有"跳过同语言"的正确性门（用户当场发现的逻辑错误：曾经给国产剧建了"找中文字幕"的测试格，这是无意义的）。
2. **触发依赖 Jellyfin 的每日巡检**——独立产品不能永远寄生宿主的调度器。
3. **识别（文件名/路径 → tmdbId）目前依赖 `jf.getItem` 读 Jellyfin 已刮削的结果**——独立产品需要自己识别。

三者互相独立，但 B（触发）依赖 C（识别）产出的 tmdbId 才能真正入队工作流，所以实现顺序是 A、C、B（C 在 B 之前）。

---

## 子系统 A：目标字幕语言泛化 + 同语言跳过门

### 现状

`FindSubtitleTask`/找字幕 skill 里，"要找中文字幕"是硬编码假设（prompt 里直接说中文字幕；provider 里 assrt 是纯中文源）。A 层测试矩阵曾经错误地给 `cdrama`（中文原音内容）建了"找中文字幕"的格子——用户指出：**中文观众看国产剧不需要中文字幕**，这个格子本身就是无意义场景。已在 `ed1db75` 修正（删除该格子 + 在 `liveMatrix.ts` 顶部写明不变式）。

### 不变式（已写进代码注释，现在要真正落地成机制）

> **永远不为"内容原音语言 = 目标字幕语言"的组合找字幕。**

判据：TMDB `original_language`（不是"国家"——国家有歧义，语言字段精确；英语横跨美英澳、中文横跨陆台港，用国家会漏判）。

### 设计

1. **目标语言变成配置项**，不再是隐含假设：`targetLanguages: string[]`（ISO 639-1 code，如 `['zh']` 或 `['zh','en']`），读自 daemon 配置（.env 或 dashboard 未来可配，本次先做 .env + 一个可注入的 config 读取点，dashboard 接线是 backlog）。
2. **同语言跳过门**：机械预清洗层（scanLibrary / 活文档生成阶段）对每个目标语言 `L`，若某内容的 `original_language === L`，该内容对语言 `L` 不生成"缺字幕"任务——即使配置了多个目标语言，也是**逐语言独立判断**（一部中文剧：不生成"找 zh 字幕"任务，但如果同时配置了 `en`，正常生成"找 en 字幕"任务）。
3. **Provider 语言门控**：`assrt` 是中文字幕源（今晚 A 层录制实测：对国产剧原音内容本身零命中——它是同人翻译档不是原生字幕镜像；但作为"字幕语言=中文"的源，任何非中文目标语言请求都不该调用它）。加一层 provider-语言适配：每个 provider 声明它能产出哪些字幕语言（`assrt: ['zh']`，`opensubtitles`/`zimuku`: 更广），dispatch 时按 `task.targetLanguage` 过滤 provider 列表，即使配置了 assrt 也不会被非中文请求调用。
4. **FindSubtitleTask 加字段** `targetLanguage: string`（单个，不是数组——一个 worker_task 对应一个语言的查找；多语言场景=为同一集派发多个 task，各自 targetLanguage 不同）。
5. **Skill/prompt 去硬编码**：`findSubtitleSkill.ts` 现在的中文措辞改为按 `task.targetLanguage` 参数化的语言名（"Chinese"→"{languageName(task.targetLanguage)}"）。

### 边界（YAGNI，不做）

- 不做"语言优先级/回退链"（要 zh 找不到就试 en 之类）——用户没提，加了是过度设计。
- 不做每个 provider 完整语言矩阵调研——只需 assrt=纯中文这一条硬门是当务之急，其余 provider 已经是多语言（opensubtitles/zimuku）无需门控。

### 测试

- 单测：同语言跳过门（cdrama+zh 目标→不生成任务；cdrama+en 目标→生成）；provider 语言过滤（assrt 被 en 目标请求排除）。
- A 层矩阵：不新增格子（现有格子已经是"目标 zh + 非中文原音"的正确形状），只加上面两处机制的单测。

---

## 子系统 C：自研媒体识别（路径 → tmdbId）

### 现状

realign 已有部分文件名解析能力（`buildRealignPlan` 从文件名抠集号），但完整的"新文件 → tmdbId"识别目前隐式依赖 Jellyfin 已经刮削过（`jf.getItem(id).ProviderIds.Tmdb`）。要做到 B（自研巡检），巡检发现的新文件在 Jellyfin 刮削之前就需要被识别——所以 C 必须先于 B。

### 关键坑（用户连续两轮追问挖出的，写进设计而不是留作暗坑）

1. **文件名本身可能零信息**，真正的信息在父目录/祖父目录里（例：`间谍过家家/Season 1/ep 1.mp4`——标题在祖父目录，季在父目录，集在文件名）。**任何只解析 basename 的方案都会在这类结构上失败。**
2. **元数据只有一个来源：TMDB**（我们自己的 `TMDB_API_KEY`，不是新增依赖——`TmdbClient` 已在用，orchestrate/realign 的绝对集数调和全建在它上面）。Jellyfin/Sonarr/Radarr 的刮削同样是调 TMDB（Jellyfin 内置自带的 TMDB app key），我们不依赖它们的凭证，只是"自己也调一遍同一个 API"。
3. **"文件名解析"和"元数据"是两个不同的层**：解析只是把字符串拆成结构化候选（title/year/season/episode），不产生元数据；TMDB 才产生元数据（tmdbId、权威标题、季表、original_language……）。

### 调研结论

`.research/video-filename-parser`（`@ctrl/video-filename-parser`，MIT，Sonarr/Radarr 解析正则的 TS 移植版，已 clone 到 gitignored `.research/` 供参考读源码，不作为运行依赖直接引入前需要先加为 npm 依赖评估）：

- 纯字符串解析器，`filenameParse(name: string, isTv)`，**零路径感知**（源码验证：无任何 path/dirname/parent 相关逻辑）。
- 但输出结构完整：title/year/season/episodeNumbers/isMultiSeason/complete(季包判断)/quality/group/language。
- **有动漫绝对集号支持**（`anime-subgroup-title-episode-absolute`、`absolute-plus-season-episode` 等 pattern + `applyAbsoluteEpisodeNumbers`）——直接对上我们的绝对集数调和需求。

结论：**该库解决"把一段字符串拆成结构化字段"这个子问题（本来看起来要复刻 Sonarr 好几年的活），但"决定喂给它哪几段字符串、怎么合并结果"（路径感知）是我们自己要建的一层，且是必须的一层**——Jellyfin/Sonarr/Radarr 也都是这样分层的（约定俗成的目录结构：`剧名/Season XX/文件`）。

### 设计：识别流水线

```
输入：一个视频文件的绝对路径
  │
  ▼
① 路径分段：video.path 按目录分隔符切开，取「文件名」「父目录」「祖父目录」（最多再上一级，够 Show/Season/File 三层约定）
  │
  ▼
② 各段跑 filenameParse()：
    - 文件名段 → 集号候选（若同时有季号更好，如 S01E01 全在一个文件名里的常见情况）
    - 父目录段 → 季号候选（"Season 1"/"S01" 这类）
    - 祖父目录段 → 标题候选（+ 可能的年份）
  │
  ▼
③ 合并规则（确定性，不是模型判断）：
    - 集号：文件名段有则用文件名段的；否则报"无法确定集号"
    - 季号：文件名段若已含季号（常见：single-file already has S01E01）→ 用它；
             否则父目录段的季号 → 用它；
             否则（既非季包目录也非文件名带季）→ 视为"该内容不分季"（如电影，或绝对编号动漫）
    - 标题：祖父目录段的解析标题 优先（约定：目录名通常比文件名干净）；
             若祖父目录解析失败或看起来不像标题（如只是 "Season 1" 误读到这一层——防御性检查），
             回退父目录段的标题候选；再退文件名段。
    - 若路径里已有 `[tmdbid-XXX]`（我们 realign 输出的格式，或用户库本来被 Sonarr/Radarr/Jellyfin 整理过）
      → 直接用它作为高置信度 tmdbId，跳过下面的搜索+消歧。
  │
  ▼
④ 无嵌入 id 时：TMDB search(标题候选[, 年份]) → 取候选列表
  │
  ▼
⑤ 消歧（确定性规则，不靠模型）：
    - 年份匹配（若②解析出年份，年份完全匹配的候选优先）
    - 类型匹配（isTv 标志 → 只在 TMDB tv search 结果里选，不跟 movie 结果混）
    - 唯一结果 → 直接采用
    - 多个候选且无法用上述规则收窄到 1 个 → 该内容标记"待消歧"，PARK（不猜）——同 realign
      "拿不准就不动手"的哲学一致，等后续（agent 兜底或用户在 dashboard 手动指认，两者都是 backlog）
  │
  ▼
输出：{ tmdbId, title(TMDB权威), isTv, season, episode, absoluteEpisode? } 或 PARK{reason}
```

### 边界（YAGNI，写清楚不做什么，防止实现时蔓延）

- **不做模型辅助识别的第一版**——纯确定性规则先跑，够覆盖 Jellyfin/Sonarr 目录约定下的绝大多数库。模型兜底（"规则消歧不了，让 agent 看看"）是明确的**后续增强 backlog**，不在本次范围。
- **不做零信号文件的救援**——如果文件名和所有父目录都解析不出任何候选（如 `movies/aaa/bbb.mkv`），PARK，不特殊处理（这是任何刮削器的根本极限，Jellyfin 也认不出）。
- **不引入 TVDB/AniDB**——TMDB 是唯一元数据源（虽然动漫圈 TVDB/AniDB 有时更细，但那是可选增强，不是本次范围；我们已有的绝对集数调和全建在 TMDB 上，保持单一来源）。
- **不做识别结果缓存/增量索引的存储设计细节**——那是 B（自研巡检）的关注点，C 只是一个纯函数式的"给路径，出结果"的模块，不管调用频率/缓存。

### 测试

- 单测：三层路径分段 + 合并规则的每条分支（文件名带季 vs 父目录带季 vs 都没有；标题回退链；嵌入 tmdbid 直通）。
- 用真实"零信息文件名"场景做回归夹具（如用户举的 `间谍过家家/Season 1/ep 1.mp4`）。
- 集成测试：喂真实录制的库树形状（可复用 realign 真站验证时建的 `_scout_realign_test` 那类结构），断言识别出的 tmdbId 与季/集正确。

---

## 子系统 B：自研周期巡检 + 自动触发

### 现状

daemon 的唯一自动触发是旧 pipeline 的 `aggregate`（v2/aggregator.ts，每 15 分钟造 `series_season`/`movie` job，喂给旧 `executeJob`→`runPipeline`）。v3 orchestrator 目前只能手动/dashboard 触发（`cmdReconcileAll`）——退役旧 pipeline 时曾发现这是一个悬而未决的产品缺口（见 `2026-07-15` 当晚的墙②收尾讨论）。

### 设计

1. **周期扫描**：daemon 里加一个定时任务（复用现有 `cmdWatch` 的定时器基建，不重新发明），按配置的间隔（默认与旧 aggregate 相同的 15 分钟，可配）遍历所有配置的媒体根目录（`MEDIA_ROOTS`）。
2. **差异检测（不是全量重新识别）**：SQLite 状态机已经知道"上次看到的文件集合"（`library` 表 / `scanLibrary` 的既有机制）。扫描 = 走文件系统 → 对比状态机里记录的已知路径集合 → 只对**新增**路径跑子系统 C 的识别流水线（已知路径不重新识别，除非该内容此前是 PARK 状态——PARK 的内容每次巡检重试识别，因为环境可能变了，比如用户后来手动改了目录名）。
3. **识别成功后入队**：C 输出 `{tmdbId, isTv, season, episode}` → 写入活文档（现有机制）→ 下一次 orchestrator pass 的 `list_missing_coverage` 就能看到它，走正常的智能闸门派活（不绕过 B 层的零误触发闸门——新资源和"已存在但缺字幕"的资源走同一条 orchestrator 判断路径，不特殊化）。
4. **orchestrator 触发本身**：巡检发现"有新增/变化"后，触发一次 orchestrator pass（而不是巡检本身直接派 worker_task——保持"巡检只做事实盘点，orchestrator 才做判断派活"的既有分层，不破坏 B 层已验证的智能闸门架构）。若一次巡检没发现任何变化，不触发 orchestrator pass（避免空转）。

### 与旧 pipeline 退役的关系

一旦 B 落地，daemon 就有了 v3 路径的自动触发，旧 `aggregate`/`executeJob` 便真正可以退役（Phase 2/3，此前因为"退了旧 feed 就没有自动触发"而搁置的产品缺口，由 B 填补）。**B 落地是解锁 Phase 2/3 大删除的前提**——但本次设计范围只到 B 本身落地，Phase 2/3 的实际删除仍是后续任务，不在本次一并做（保持每次改动可独立验证/回滚）。

### 边界（YAGNI）

- **不做 inotify/fsnotify 实时监听**——轮询巡检足够（NAS 场景，新文件到达频率低，15 分钟延迟完全可接受，用户从未要求"秒级"响应）。真正想要实时性是后续增强，不是本次。
- **不做多根目录并行扫描优化**——顺序扫描，简单可靠优先。
- **dashboard 上配置巡检间隔/媒体根**——UI 部分是 backlog（用户明确"具体啥样我没头绪，不是现在该考虑的"），本次只做配置项本身可从 .env/config 读取，不做 UI。

### 测试

- 单测：差异检测（已知路径不重扫；新路径触发识别；PARK 路径重试识别）。
- 单测：无变化时不触发 orchestrator pass；有变化时触发且只触发一次（不重复）。
- 集成：喂一个模拟的"巡检发现新文件"场景，断言活文档正确更新，且后续 orchestrator pass 能看到它。

---

## 实现顺序 + 依赖

```
A（语言泛化）——独立，可与 C/B 并行
C（识别层）——B 的前置
B（巡检+触发）——依赖 C
```

Phase 2/3（旧 pipeline 大删除）不在本次范围——B 落地后才重新评估是否推进，且需要另一轮判断（daemon 触发行为的实际验证），本设计到 B 落地为止。

## 自我审查

- **占位符扫描**：无 TBD/TODO。
- **内部一致性**：A/C/B 三节的边界（YAGNI 段）互相不冲突；C 明确"不做模型兜底"与项目"agent 判断"北极星看似张力——但这里的分层是对的：**识别是机械事实问题（这段字符串是不是标题），不是判断问题（这个候选字幕对不对）**，机械预清洗层本来就该用确定性规则，agent 的判断力留给真正需要判断的地方（找字幕、orchestrator 派活）。
- **范围检查**：三个子系统均可独立实现+独立测试+独立提交，符合"聚焦到能单独出一份实现计划"的粒度。
