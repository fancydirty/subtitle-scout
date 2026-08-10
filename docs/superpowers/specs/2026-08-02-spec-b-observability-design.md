# Spec B — 观测面补强：电影索引/详情 + 母语媒体可见性 + 波形第三轨

日期：2026-08-02 ｜ 状态：已裁决待实现 ｜ 上游：四路研究代理实测结论（已亲核复核）+ Spec C（四屏重建，本 spec 的电影详情页落在其重建后的 Library 上）

## 1. 背景与设计模型

观测台定位不变（只读为主，极少数一键决策）。本 spec 补四个"系统知道、用户看不见"的观测缺口，全部经代码核实：

1. **电影没有自己的视角**：库索引后端早已把 movies 混进统一索引（`buildLibrary`，`src/dashboard/apiV2.ts:174`，`LibraryItemDTO.kind: 'series' | 'movie'`），但前端只有目录分区（剧集/动漫/电影，`web/src/library/filter.ts` KNOWN_SECTION_ORDER）——没有"跨目录只看电影"的视角；
2. **电影没有详情页**：`PosterCard.tsx` 对 movie 渲染**静态 div**（`:62` 起，series 才有 `<a href>`）——点不进去，一部电影的字幕状态、副本覆盖、校验结论、跑过的任务全部不可见；后端也没有电影详情端点（只有 `buildLibrarySeriesDetail`，`apiV2.ts:1250`）；
3. **母语媒体"无声消失"**：ingest 分类 rule 0（`src/v2/ingest.ts:354`，`originSkipLanguages.includes(langOf(originLang))` → `ignored`）与 rule 1b（`:359` 标题中文启发式兜底）把母语条目标成 ignored——而 `ignored` **不入覆盖桶**（`apiV2.ts:79`），海报墙上这类条目覆盖计数全零、无任何标记，用户无从分辨"还没扫"和"母语不扫"；DTO 里没有语言字段（`LibraryItemDTO` 九键无 originLang，`web/src/api/types.ts:18`）；
4. **波形第三轨画好了却没数据**：`CompareTimeline`/`WaveTrack` 已发货（`web/src/subtitleVerify/CompareTimeline.tsx:178-181` 有 peaks 就画），`subtitleCompareApi.ts:338-358` 文件尾注释把 peaks 端点的形状、ffmpeg 命令、两档实测性能（cifs 8s/284KB、rclone >120s 拒）全写死了，但 `InspectPanel.tsx:112` 仍硬编码 `waveformPeaks={null}`——**只缺端点与接线**。

## 2. 范围

**In：** ① Library 海报墙加"类型视角"（全部 / 剧集 / 电影，纯前端过滤，零后端）；② 电影详情端点（新 GET）+ 电影详情页（含 PosterCard movie 分支接链接）；③ 母语媒体可见性：库索引 DTO 加语言字段 + 后端派生 `nativeAudio` 布尔 + 海报卡母语标记 + "显示母语条目"开关（默认开）；④ 波形 peaks 端点（新 GET，cloud 拒、lan/local 整轨抽取）+ InspectPanel 接线。

**Out：** 电影逐条获取按钮（无逐条端点，同 kill-list #1 纪律——详情页只观测）；母语判定规则本身的修改（rule 0/1b 语义不动）；`origin_skip_languages` 独立设置项（它由 `resolveTargetLanguages` 从 target_languages + `SKIP_CHINESE_ORIGIN` env 派生，映射式在 `src/cli/targetLanguages.ts:53`，本 spec 不新增键）；peaks 持久化缓存（首版无缓存，§4.3 论证）；系列详情的结构改动（Spec C 已随迁）；Library 海报墙的栈迁移（归 Spec C 卸载步，行为冻结——见下）；任何写路径。

**施工顺序约束**：本 spec 在 Spec C 之后落地（管线 A→C→B）。电影详情页直接用 C 的新栈（Tailwind/shadcn 自绘件）；**Library 海报墙（SeriesGrid/PosterCard）不由 C 的四屏重建覆盖**，但 C 的 Astryx 卸载步（C §7 第 4-5 步，2026-08-02 补注）会把墙一并栈随迁、行为冻结——本 spec 的墙上增量（类型 chip、母语开关、PosterCard 接链接）落在随迁后的组件上。filter.ts 的 `KindFilter` 纯函数与栈无关，可先行。

## 3. 已裁决决策清单

1. **电影索引 = 纯前端过滤，零后端改动**（用户拍板口径）：统一索引已含全部 movie 行，类型视角只是 `kind` 上的客户端过滤，与既有覆盖过滤 chip（`filter.ts` all/gap/throttled/full）正交组合。
2. **电影详情 = 新只读 GET，形状仿 series 详情**：`buildLibrarySeriesDetail`（`apiV2.ts:1250-1300`）是模板——行直译 + 关联数据组装 + 未找到返回 null（404 语义）+ 纯同步只读 ScoutDb。**已知不对称照单全收**：movies 表无 `backdrop_path`（hero 走模糊海报降级，与活动页电影 hero 同一降级路径，`apiV2.ts:882-886/:951` 注释钉死）、无 `overview`（不画简介段）、无 `genres`（不画流派）。
3. **母语可见性 = 后端派生，前端零判定**：DTO 加 `originLang` + `nativeAudio` 两键，`nativeAudio` 由后端用**同一个** `langOf()`（`src/agent/languages.ts:68`）+ **同一条求值式** `resolveTargetLanguages(process.env, settingsRepo.get('target_languages'))`（与 `cli/index.ts:177` 的 `languagesNow` 逐字同一式，含 `SKIP_CHINESE_ORIGIN` env 腿与 settings>env 优先规则，`targetLanguages.ts:40-55`）派生 originSkipLanguages——与 ingest rule 0 同语义 by construction，前端不移植归一化逻辑（web 不 import src/，零既有先例，不开创）。开关默认**显示**（用户拍板）；持久化在 localStorage——立论独立：这是**长命视图偏好**（藏起来的人明天也想藏着），区别于筛选 chip 的会话级探索语义（覆盖 chip 现状 `useState` 不持久化，`SeriesGrid.tsx:50`，类型 chip 跟随之，§5.1）；key 用 `scout-show-native`，沿用 `scout-lang` 的 `scout-` 前缀（`useT.ts:13`）；不新增 settings 键。
4. **peaks 端点 = compare 的姊妹路由，自门自给**：cloud 直接拒（端点自己判 mountKind，不信前端——`subtitleCompareApi.ts:338-358` 注释原话"前端不可信"）；超时按 cifs 实测 8s 取 30s 余量档，**不按云盘 >120s 取**；ffmpeg 命令钉死注释里那一条；响应独立成端点（峰值大数组不与画图元数据混在一个 JSON——同文件注释的既有论证）。

## 4. 后端设计

纪律：两个新 GET 全只读；`buildLibrary` 加两键是纯增量；零 schema 迁移（movies/series 的 `origin_lang` 列早已存在，`db.ts:29/:54`）。

### 4.1 库索引 DTO 增量（`buildLibrary`，apiV2.ts:174）

`LibraryItemDTO` 增两键：

```ts
originLang: string | null   // series.origin_lang / movies.origin_lang 直译；NULL=未解析
nativeAudio: boolean        // originLang 已解析 ∧ langOf(originLang) ∈ originSkipLanguages
```

- `originSkipLanguages` 在 buildLibrary 内**复用同一条求值式**现求：`resolveTargetLanguages(process.env, settingsRepo.get('target_languages')).originSkipLanguages`（与 `cli/index.ts:177` `languagesNow` 逐字同一式——settings 键优先、空串回落 env、`SKIP_CHINESE_ORIGIN=false` 时 skip 表丢 'zh' 而 target 表不动，全部沿用，不自写简化版；与 ingest 每轮 pass 起点新鲜求值的既定口径一致，`ingest.ts:71` 债务 D5 注释）——target_languages 改了，**下一次 15s 轮询**标记自然翻转，无重启；
- `nativeAudio=false` 的三类情形必须等价于 rule 0 的不命中：origin_lang 为 NULL（未解析）、解析了但不在跳过表、归一化后空串（`langOf` 空输入返 `''`，永不相等，`languages.ts:66-67`）；
- series 行取 `series.origin_lang`（`:177` 的 SELECT 已有 genres，顺手加一列），movie 行取 `movies.origin_lang`（`:230` 同理）。

### 4.2 GET /api/v2/library/movies/:id —— 电影详情

仿 `buildLibrarySeriesDetail`（`apiV2.ts:1254`）写 `buildLibraryMovieDetail(db, id)`，未找到 → null → 404。DTO：

```ts
interface MovieDetailDTO {
  id: string
  name: string
  chineseTitle: string | null
  year: number | null
  posterPath: string | null        // 无 backdropPath——前端恒走模糊海报降级
  path: string
  subStatus: SubStatus             // movies.sub_status 七值域（基表六值 db.ts:51-52；v15 :224-225 扩到七值，新增 hardsub-assumed）
  statusReason: string | null
  recheckAfter: number | null
  originLang: string | null
  nativeAudio: boolean             // 同 §4.1 派生
  files: ItemFileCoverage[]        // lib.itemFileCoverage(id)——重复源副本覆盖，同 series 详情 :1297 的既有调用
  subtitles: { language: string; path: string }[]   // subtitles JOIN 直译（series 详情 coverageRows 同构，apiV2.ts:1271-1277）
  recentJobs: { id: number; state: string; priority: number; updatedAt: number }[]
                                  // jobs WHERE movie_id = id ORDER BY id DESC LIMIT 5——供"最近活动"只读列表
}
```

- **键集合封闭**，显式列键不 spread（铁律②同款纪律；movies 行无密级字段但纪律不破例）；
- `itemId` 语义：movies.id 即校验体系的 itemId（`subtitle_verify.item_id`），前端拿它查 verify 结论与对照图——与 series 集行同一消费路径，不另立通道；
- `recentJobs` 只要五元组（id/state/priority/updatedAt + 隐含 kind），**不带 payload**（内部 JSON 不上屏）；`kind='movie'` 与 movie 目标的 `worker_task`（series_id IS NULL + movie_id 命中——apiV2.ts:211 注释定形态；movie_id 落列出处 `jobsRepo.ts:153` INSERT、movie 派发传参 `orchestratorAgent.tools.ts:285`）都算；
- 路由落在 server.ts library 路由族，形状照 series 详情先例（同步只读函数 + 404 分支）。

### 4.3 GET /api/v2/subtitle/waveform-peaks?itemId= —— 波形第三轨

形状照 `server.ts:679` compare 路由先例（method 门 → 参数门 → 异步判断层 → 写响应；鉴权走统一前置门；单条 itemId 刻意不批量）：

1. **解析 item**：itemId → episodes/movies 行（同 compare 的双表查找）；找不到 → 404；
2. **自门**：`classifyPath(item.path)`（`src/core/mountKind.ts`，server.ts:31 已 import）——`'cloud'` → **403** `{ error: 'waveform is not available for cloud-mounted media' }`；**按片源判，不按字幕文件**（compare :316 同款注释：波形从视频抽，成本由视频落点决定）；
3. **抽取**：spawn `ffmpeg -i <path> -map 0:a:0 -ac 1 -ar 100 -f s16le -`（命令逐字照 `subtitleCompareApi.ts:347` 注释，peaks 设计论证全文 `:338-358`）；stdout 收 Buffer，s16le 小端 → 每样本取绝对值 → 归一化到 0..1（除以 32767，峰值若全零则原样返回全零数组——静音轨是合法结果，不当错误）；**超时 30s**（cifs 实测 8s + 余量；超时强杀——§11-3 钉死既有封装的 kill 语义适配）；
4. **响应**：`{ itemId, peaks: number[], sampleRate: 100, durationMs }`——peaks 归一化到 0..1 并**保留 3 位小数**（`Math.round(v*1000)/1000`；对 WaveTrack 的 stride-max 画法视觉无损，响应体积直接砍近半）；durationMs 复用 compare 的 `resolveDurationMs` 语义（前端对轨要用同一把尺）；
5. **并发护栏**：单飞（同一路径同时在抽只允许一个，后来的等同一份结果；进程内 Map<path, Promise> 即可，不引入队列）；**无持久化缓存**——peaks 是"打开对照面板才要"的冷数据，首次 8s 可接受，缓存引入失效维度（文件被换）是净负收益；真成热点再议；
6. **失败分类**：ffmpeg 缺席/非零退出/超时 → 502 + 人话 error；前端据此回退双轨（§5.5），不弹 toast。

### 4.4 依赖注入

两个新判断层函数照 `subtitleCompareApi` 的 deps 注入模式（classify/spawn/exists 全注入），测试用假 deps 驱动，不真 spawn ffmpeg、不真读 mountinfo（`mountKind.ts` 自身的测试先例：mountinfo 文本解析纯函数）。

## 5. 前端设计

### 5.1 类型视角 chip（Library 海报墙）

- 现有覆盖过滤 SegmentedControl（all/gap/throttled/full）旁加**第二组** chip：`All / Series / Movies`（新拟文案，§5.6 登记），默认 `All`；
- 纯客户端：`kind` 字段过滤，与覆盖过滤**相乘**（先类型后覆盖，顺序无关——两个谓词独立）；`filter.ts` 加 `KindFilter` 类型与谓词，单一事实源（同 LIBRARY_FILTERS 惯例），SeriesGrid 消费；
- 状态持久化：与覆盖 chip 同一存储惯例（若覆盖 chip 现状不持久化则类型 chip 也不持久化——实现期核对，不发明新惯例）。

### 5.2 海报卡母语标记 + 显示开关

- **标记**：`nativeAudio=true` 的海报卡在 meta 区加一行弱色小字 `"Native audio — no subtitles needed"`（新拟，§5.6）；**不画角标、不动覆盖点**（母语条目的覆盖桶全零是正确事实，不粉饰）；
- **开关**：Library 屏工具行一个 shadcn Switch + 标签 `"Show native-language titles"`（新拟），默认 **ON**；OFF 时 `nativeAudio` 条目从海报墙隐藏（纯视图过滤，数据照拉）；localStorage key `scout-show-native`（沿用 `useT.ts:13` `scout-lang` 的 `scout-` 前缀惯例）；
- 空态：全库皆母语且开关 OFF → 显 `"All titles are native-language. Turn on “Show native-language titles” to see them."`（新拟），不画错误页。

### 5.3 电影详情页

- **入口**：PosterCard movie 分支从静态 div 改为 `<a href>`（与 series 分支同形，`libraryItemHref` 加 movie 路由）；
- **路由**：`/library/movies/:id`——注意 `route.ts` 的 `parseShellHash` 现状把 `#/library/<seg>` 的第二段直接当 series libraryId（R1 审计抓获），新 `movies` 段必须改 route.ts 解析先行识别（否则电影 id 被当 series id 路由走）——实现期第一刀落这里（§11-4）；
- **布局**（用 Spec C 栈自绘，组件粒度仿 Library detail）：
  - hero：模糊海报出血背景（电影恒降级，§3-2）→ 132px→**160px** 海报（电影规格，`ActivityHero` 电影 160px 的既有度量）→ 标题 + `name · year` meta → mono 状态行（subStatus 人话化，见下）→ 母语标记行（`nativeAudio` 时，同 §5.2 文案）；
  - **状态段**：subStatus 七值 → 人话句映射（复用活动页/详情页既有措辞族——covered → "subtitles installed" 系；missing → "missing subtitles" 系；unavailable + recheckAfter → formatRetryIn 系；ignored + nativeAudio → 母语句；ignored + 非母语 → statusReason 透传行——**rule 1b 的 status_reason 是中文内部串**（`ingest.ts:336` RULE_1B_REASON），不透传，落 "Marked as not needing subtitles during scan."（新拟）+ 建议人工回看的次行）；
  - **副本质检段**（`files`）：每个文件一行 mono path + 覆盖点（绿/灰），多副本才渲染本段（单文件零信息增量）；
  - **字幕清单段**（`subtitles`）：行 = 语言 chip + mono path；
  - **校验段**：itemId 查 verify 结论——shifted → 红点行 + "Fix the timing"/"Undo"（复用 Spec C §5.4 行型与 correct/revert 接线）；aligned/unverifiable → 绿点行（皆绿是仓库刻意裁决，同 C §5.4 口径）；无记录 → 不渲染本段；
  - **对照图入口**："Inspect" 按钮开 InspectPanel（既有件，本 spec §5.5 顺带接上第三轨）；
  - **最近活动段**（`recentJobs`）：行 = mono 时刻 + state 人话词；零按钮零下钻（runs 全文不在本 spec——SeriesRunDTO 级历史是系列详情既有形状，电影侧首版只给五元组列表，YAGNI）；
- **全部句子级文案能抄则抄**（活动页 text.ts/phrases.ts 同源），无处可抄的进 §5.6 登记。

### 5.4 电影在 Activity/Queue 中的既有呈现

不动。电影行在 Up next/Just finished 的呈现（"missing subtitles" 副行等）是 Spec C 保真范围，本 spec 只补"点进电影"的目的地。

### 5.5 InspectPanel 接线第三轨

- `InspectPanel.tsx:112` 的 `waveformPeaks={null}` 改为：`data.waveformAvailable === true` 时发 `GET /api/v2/subtitle/waveform-peaks?itemId=`，成功 → 传 `data.peaks`；loading → CompareTimeline 下沿渲染骨架轨（shimmer 一条）；失败（403/502/超时）→ **静默回退双轨**（对照图两轨照常可用，波形是增强不是门槛）；
- `cloudBlocked` 分支（`InspectPanel.tsx:70` 现状 = 仅判 `mountKind==='cloud'`；`waveformAvailable` 与 `canRenderWaveform(mountKind)` 定义等价，描述以代码行为准）现状不变（既有云盘说明文案 `verify_cloud_title/body` 已是真表字符串，`en.ts:98-99`）；
- peaks 请求在面板关闭时 abort（AbortController，同 hooks.ts 既有惯例）。

### 5.6 新拟文案登记处（审计可逐条砍）

1. `"All / Series / Movies"` 类型 chip 三词；
2. `"Native audio — no subtitles needed"` 海报卡标记；
3. `"Show native-language titles"` 开关标签 + §5.2 空态句；
4. `"Marked as not needing subtitles during scan."`（rule 1b ignored 行替代文案）；
5. 电影详情页区头（"Files"/"Subtitles"/"Timing"/"Recent activity" 四个区头词——若库内有同源措辞则抄，实现期核对后登记实际采用值）；
6. peaks 失败的行内提示（若选择渲染；默认静默回退则不产文案）。

## 6. 数据流

**母语标记**：target_languages 改 → 下次 buildLibrary（≤15s 轮询）→ `nativeAudio` 翻转 → 标记/开关过滤即时反映。无缓存层，无重启。

**电影详情**：点海报 → 路由 → GET 详情（一次性，非轮询）→ 校验段并行拉 verify 结论（既有 `GET /api/v2/subtitle/verify?itemIds=` 通道）→ correct/revert 走既有 POST，成功后就地刷新详情与 verify。

**波形**：开 InspectPanel → compare DTO 已到（`waveformAvailable`）→ true 才发 peaks 请求 → 第三轨渲染；云盘 → 说明文案（既有）；抽取失败 → 双轨回退。

## 7. 错误处理

- 电影详情 404：路由级 "Not in library" 简页（沿用 series 详情 404 惯例，不新设计）；
- peaks 403（cloud）：前端本就不该发（`waveformAvailable` 已 false），收到则按失败回退双轨；
- peaks 502/超时：双轨回退，不重试（用户重开面板自然重试）；
- ffmpeg 进程泄漏防护：超时 SIGKILL + 面板 abort 时杀进程（deps.spawn 的 kill 语义实现期核对 node child_process 行为）；
- 母语开关状态损坏（localStorage 脏值）：非 `'false'` 一律视为 ON（fail-open，同 engine_enabled 的脏值哲学）。

## 8. 安全与性能

- peaks 的 `itemId` → 路径解析**只走 DB**（episodes/movies 行），用户输入永不拼进 spawn 参数——ffmpeg argv 用数组形式（无 shell），路径来自 DB 行；
- ffmpeg 超时 30s 硬杀；单飞护栏防并发抽同一片；peaks 体积按 **JSON number[]** 如实估（R1 审计修正：284KB 是 ffmpeg 二进制 stdout，不是响应体）——3 位小数后每样本约 4-5 字符（`0.xxx,`），23.7min 片（142,200 样本）≈ 0.6-0.7MB，2h 片（720,000 样本）≈ 3-3.6MB。局域网 dashboard、开面板才拉的冷数据，可接受；**不引入二进制编码**（YAGNI，真疼再议）；
- 电影详情/库索引增量全只读 SQL，无注入面（参数绑定照既有先例）；
- 原生判断不读文件、不探进程，性能零增量。

## 9. 测试

**后端：**
- buildLibrary：`originLang`/`nativeAudio` 矩阵——未解析 null+false / 'ja'+false / 'zh-CN'+true（langOf 归一化命中）/ 脏值大小写 'ZH'+true；target_languages 变更后重建 DTO 翻转（无重启路径）；
- 电影详情：fixture 电影行（含两副本 + 一字幕 + 两 job）→ DTO 全键断言；不存在 → null/404；键集合封闭（无 backdrop/overview/genres 键泄漏——反向断言）；
- peaks：假 deps——cloud → 403 且不 spawn；lan → 假 ffmpeg stdout（构造 s16le Buffer 含已知峰值）→ 归一化数组断言（0..1、长度=时长×100±容差）；全零轨合法返回；超时 → 502 且收到 kill；单飞：两并发请求只 spawn 一次；
- 两端点鉴权 401。

**前端：**
- 类型 chip 与覆盖 chip 相乘过滤（filter.ts 纯函数用例）；
- 母语标记渲染 + 开关 OFF 过滤 + 脏值 fail-open + **全母语空态文案**（§5.2）；
- PosterCard movie 分支渲染 `<a>`（既有静态 div 测试反转）；
- 电影详情页：七 subStatus 人话句映射快照、ignored+rule1b 不透传中文 reason、**ignored+非母语行渲染**（§5.3 状态段）、多副本段条件渲染、校验段三态；
- 路由解析：`#/library/movies/<id>` → movie 详情；`#/library/<seriesId>` 原样（回归）；
- InspectPanel：waveformAvailable=true → 发请求 → 三轨渲染；失败 → 双轨回退无报错 UI；关闭面板 abort。

**实机验收（media-router，部署后）：**
- 库中真实母语剧（国产剧）海报出现标记，开关 OFF 消失、ON 复现；
- 真实电影点进详情：hero 降级美术、状态句、副本质检、校验段齐全；
- LAN 库打开任一对照面板：第三轨在 ~10s 内出现波形；云盘条目（若有）显示既有云盘文案、不发 peaks 请求（DevTools Network 核实）；
- 改 target_languages 去掉 zh → 下轮轮询母语标记消失。

## 10. 兼容与迁移

- 纯增量：DTO 加键（旧前端忽略未知键）、两个新路由、前端新 chip/开关/页面；无 schema 迁移、无既有端点契约变化；
- 母语开关默认 ON = 现状行为（母语条目今天就在墙上，只是没标记）——默认零打扰；
- peaks 端点不上线时，前端 `waveformAvailable` 恒 true 的 LAN 条目也只是回退双轨——前后端可独立发布，无顺序依赖；
- Spec C 依赖：电影详情页用 C 的栈与 token；若 B 先行落地（管线允许时不允许——顺序已定 A→C→B，此条仅记录）需返工，故锁死顺序。

## 11. 实现期验证项（plan 阶段落实）

1. 类型 chip 的存储跟随覆盖 chip 惯例（现状 `useState` 不持久化，`SeriesGrid.tsx:50`——R1 已核实，plan 阶段直接照此落）；**母语开关持久化已裁决**（§3.3/§5.2 localStorage `scout-show-native`），不再绑定 chip 惯例、无需再核；
2. `resolveDurationMs`（subtitleCompareApi）能否原样复用于 peaks 响应的 durationMs（同一把尺的论证以代码为准）；
3. node spawn 的 timeout-kill 既有封装：既有封装是 `src/files/extractEmbeddedSub.ts` 的 `execFileAsync`（execFile + timeout + maxBuffer + 可注入 impl，stdout 取 **string**）——peaks 需二进制 stdout，适配点 = `encoding: 'buffer'`；execFile 超时默认 SIGTERM，强杀要显式 `killSignal: 'SIGKILL'`（§7 的 kill 语义以此为准），复用封装而非新造；
4. `libraryItemHref` 现签名（`route.ts:59`）与 AppShell 路由注册点——**含 `parseShellHash` 的段解析改造**（`#/library/movies/<id>` 的 `movies` 段会被现状解析当 series libraryId，必须先识别保留段）；series 详情路由怎么挂的，movie 照挂；
5. SettingsDTO 是否已含 targetLanguages（若 §4.1 实现选择在前端派生 nativeAudio 的备选方案才需要——主推后端派生，此项仅备查）；
6. s16le→0..1 归一化的峰值定义（max-abs 还是 RMS——CompareTimeline/WaveTrack 的画法吃哪种，以 :273-304 WaveTrack 渲染代码为准）。

## 12. 明确不做

- 电影逐条获取/重派按钮（无逐条端点，观测台纪律）；
- 母语判定规则（rule 0/1b）本身的任何修改、`origin_skip_languages` 独立设置化；
- peaks 持久化缓存、二进制编码、批量端点；
- 电影 runs 全文历史（五元组列表之外的部分，YAGNI）；
- series 详情结构改动（Spec C 地盘）；InspectPanel 除第三轨接线外的任何重设计；
- 任何写路径端点；任何 settings 新键；
- 不碰 `realignExecutor.ts`、`src/agent/skills/`。
