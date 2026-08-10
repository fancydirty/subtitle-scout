# Season-Pack Design: 整季字幕包机会式升格

Status: approved by user on 2026-07-07
Scope: 剧集/动画的整季字幕包匹配下载。逐集触发不变;当处理某集且 rank 选中的候选是整季包、
且该季有 ≥2 集缺中字时,一次性把整季能覆盖的 sidecar 全写下。核心难点=包内文件→每集的安全映射。
不做季级触发编排、不做持久化季覆盖度追踪(见"不做什么")。

## 动因

现在字幕逐集下载:一部 12 集的季要 12 次 identify+planSearch+rank+download,配额与队列 churn 都大,
且各集可能来自不同字幕组(时间轴/风格不一致)。ASSRT 常有**整季打包**字幕(一个条目的 filelist 含
E01…E12 各集的 srt/ass)。升格到季模式:1 次搜索/rank + 1 次 detail + N 次直连下载,覆盖整季,来源一致。

## 取经:mediary-scout(~/projects/media-track,同作者同域同 ASSRT)的实战经验

逐字移植其血泪教训(每条都是疤):
1. **映射用 LLM 批处理读文件名,不用正则库**(no anitomy/guessit)。极简正则只认无歧义的 `SxxExx` /
   `第N集`(当 S1),其余返回 null,绝不猜绝对集号/`[01]`——猜就整季串号。
2. **一次批量决策,不逐集调用**(其 2026-07-02 疤:逐集调用规模下崩溃,77 集只配对 1 集就退)。
3. **按 `SxxExx` 字符串做集合 join,绝不按位置对齐**——防灾命门:包缺一集只是该 code 未覆盖,
   不会让后面全体下滑一位。
4. **verify-then-commit**:只覆盖包里真有文件的集,包标题"1-24"不算数。
5. **字幕永远软失败 + 确定性边界护栏**:先按扩展名过滤 filelist、连败熔断、prefix-copy 命名、错误返空不抛。

**我们相对 mediary 的优势**:Jellyfin 已给每集**权威 season/episode 号(SxxExx)**,映射方向是
"混乱字幕包名 → 一组已知 SxxExx 的视频",正是 mediary `renameSubtitle` 批量步骤的翻版,最可直接移植。

## 组件(单一职责、可独立测试)

### 1. `PlayerAdapter` 季枚举(注入,可选)
`getSeasonEpisodes(item)` → 该剧该季全部集:`[{itemId, seasonNumber, episodeNumber, episodeCode('SxxExx'),
videoFilename, needsChinese}]`。Jellyfin 实现:用当前集的 `SeriesId` + 季号查
`/Shows/{SeriesId}/Episodes?season=N&fields=Path,MediaStreams`(episode item 的 ParentIndexNumber/IndexNumber
给季/集号,MediaStreams 判 needsChinese)。**注入为 pipeline 可选依赖**(与 adoption 同款);未注入 → 自动退化单集。
需给 `JellyfinItemSchema` 补 `SeriesId`,`ITEM_FIELDS` 补 `SeriesId`。

### 2. `mapSeasonPack` 判断点(第 5 个 LLM 点)
`src/agent/mapSeasonPack.ts`。输入:包 filelist(字幕文件名数组,带 index)+ 季集列表(每集
episodeCode + videoFilename)。输出 zod `SeasonMapSchema`:
`{ pairs: [{ filelist_index: int, episode_code: string, confidence: number, reason: string }],
   unmapped_files: int[], reasons: string[] }`。
prompt(抄 mediary 措辞):读真实文件名判断(`第3集`=E03、`尝鲜版09`=E09、`[04]`=E04、`End/完`=大结局),
**不用正则/后缀技巧**;每个字幕文件配一个 episode_code(该季已知集里的);拿不准的进 unmapped_files;
只输出你确信的配对。判断点无断言单测(惯例)。

### 3. `seasonPackGate` 确定性门(防灾核心)
`src/core/seasonPackGate.ts`。对 `mapSeasonPack` 输出做**集合 join + 逐项校验**,产出"安全提交集":
逐 pair 要求 (a) `episode_code` 在 Jellyfin 季集合内存在(集合 join,非位置)、(b) `filelist_index` 越界/
非字幕扩展名(`.srt/.ass/.ssa`)→ 剔、(c) `episode_code` 重复 → 保留 confidence 最高的一个、
(d) `confidence < auto_download_min_confidence` → 剔。verify-then-commit:提交集里每项都对应包里真实
filelist 条目 + 季里真实视频文件。返回 `{ commit: [{episodeCode, filelistIndex, videoFilename, downloadUrl}],
dropped: [{...reason}] }`。纯函数,充分单测。

### 4. pipeline 季分支
`src/core/pipeline.ts`,在 rank+gate 之后、单集 download 之前插入升格判定:
- **升格条件**(全满足):`ctx.media.type==='episode'` && 注入了 `seasonPack` 依赖 && rank 选中候选的
  filelist 覆盖多集(≥2 个不同集的字幕文件) && `getSeasonEpisodes` 返回该季 `needsChinese` 集 ≥2。
- 升格流程:`getSeasonEpisodes` → `assrt.detail(assrt_id)`(拿 filelist 各条 url) → `mapSeasonPack` →
  `seasonPackGate` → 对 commit 集**逐集** `download(url)`+`writeSubtitle`(prefix-copy 各集视频名)→
  逐集 `refreshItem`+正缓存(按该集 identity/provider key)+从预热队列 `remove` → 返回。
- 不升格 → 现有单集路径完全不变。

### 5. 复用 & 结果
`writeSubtitle` 直接复用(已按 videoFilename 做 prefix-copy 命名 + alreadyExists 幂等)。
`PipelineResult` 增 `coveredEpisodes?: { episodeCode: string; subtitlePath: string }[]`;`decision` 仍 `download`。
ledger/journal 记季模式:journal 加 `seasonMap` step(pairs、commit、dropped 计数),run 事件的 name 标注
"S02 (N eps)"。

## 数据流

```
episode 入队 → identify → planSearch("剧名 第N季 年份"/"剧名 S02") → search(并集) → rank 选中季包
  ├─[升格:episode + seasonPack注入 + 候选覆盖多集 + 该季≥2集缺中字]
  │    getSeasonEpisodes → assrt.detail(filelist+urls) → mapSeasonPack(LLM批量读名)
  │    → seasonPackGate(集合join + 逐项校验 + verify-then-commit)
  │    → 逐集: download(url) → writeSubtitle(prefix-copy) → refresh + 正缓存 + 队列remove
  │    → finish(download, coveredEpisodes:[...])
  └─[否] 现有单集路径(rank.file_index 抽一集)不变
```

## 错误处理(全抄 mediary 的疤)

- **逐项软失败**:某集映射/下载失败 → 只跳该集,其余照写,绝不炸整批、不整批重试(dropped[] 逐项收集)。
- **缺集不串号**:集合 join 下缺集只是未覆盖,不影响其余集(位置对齐才灾难,我们不用)。
- **0 有效提交兜底**:seasonPackGate 的 commit 为空 → 回退到 rank 原本的单集抽取(rank.file_index),不丢本集。
- **连败熔断**:季模式逐集下载**连续 3 次失败** → 停止后续下载(dead 包),已成功的保留。
- **软目标**:任何 provider/download 错误 → 该集跳过不抛;季模式整体失败不影响"至少把本集单独搞定"的兜底。
- **季枚举失败/未注入**:静默退化为单集路径。
- **绝对集号/无季标记**:mapSeasonPack 只在能从 Jellyfin 季上下文确定季时才信(我们有该上下文)。

## 配额

升格单任务:planSearch/identify LLM + rank LLM + mapSeasonPack LLM(3-4 LLM)+ search ≤2 + detail 1
(ASSRT ≤3,在单任务上限内)+ N 次直连下载(非 ASSRT 配额,直接文件 fetch)。相比逐集省 (N-1) 整轮流程。

## 测试

- 单测 `seasonPackGate`:集合 join 命中/未命中;缺集→该集未覆盖且其余不移位;filelist_index 越界剔;
  非字幕扩展名剔;episode_code 重复保最高 confidence;confidence 低于门槛剔;commit/dropped 结构。
- 单测 升格判定(pipeline 辅助纯函数 `shouldGraduate`):季包+episode+≥2缺→true;单缺/电影/未注入→false。
- fixture:真实 ASSRT 季包 detail JSON + 手造 Jellyfin 季集列表 → 断言 mapSeasonPack 后经 gate 的正确配对;
  含"包缺 E12"、"命名混杂(第N集 + SxxExx + [04])"、"多一个特别篇不在季集合"三种边界。
- pipeline 集成测试:注入 fake seasonPack 依赖 + fake mapSeasonPack 返回 → 断言逐集 write + dequeue + 缓存。
- 判断点 prompt 无断言单测(惯例)。
- 真实(controller):软路由挑一部有整季包的番/剧跑,核 journal 的 seasonMap + N 集 sidecar 落地可见 + 兄弟集出队。

## 不做什么

- 不做**季级触发/编排**(逐集触发 + 机会式升格已达同等效果,YAGNI)。
- 不做**持久化季覆盖度追踪**(mediary 的 EpisodeState/reconcile 那套)——本里程碑用"每集 needsChinese"
  实时判定,不落库。触发条件:出现"跨轮追踪缺集"的真实需求。
- 不引入 anitomy/guessit(mediary 实证纯 LLM 读名 + 极简正则更稳)。
- 不做图形字幕 OCR、不碰电影路径、不改现有单集/收编/负缓存逻辑。

## 影响面

新增:`src/agent/mapSeasonPack.ts`、`src/core/seasonPackGate.ts` + 各自测试;
`src/core/schemas.ts`(SeasonMapSchema + PipelineResult.coveredEpisodes);
`src/adapters/players/jellyfin.ts`(getSeasonEpisodes + SeriesId 字段);
`src/core/pipeline.ts`(季分支 + shouldGraduate + PipelineDeps.seasonPack 可选依赖);
`src/cli/index.ts`(装配注入 seasonPack 依赖)。零新第三方依赖。
