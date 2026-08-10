# Milestone 5b Design: 匹配准确率修复

Status: approved by user on 2026-07-07
Scope: 三味药——rank prompt 校准 + 格式硬过滤、planSearch 查询策略重构 + 并集召回、
Jellyfin 中文名上下文增强。全部为 prompt/策略/纯代码级，零新特性、零配额风险。
核心流水线结构不变。

## 动因：生产准确率 bug 的实证根因（2026-07-07）

M4 预热队列首夜消费 5 部，2 成功 3 失败。用户带 ASSRT 网页证据报告后，逐一 API 复现：

- **招魂 Last Rites 判 no_safe_match 是错的**。用其 journal 里的实际查询打 ASSRT，
  返回的 15 条含 712919(简英 srt)、711609/711270(SSA)、711397(简繁特效 ass) 等
  **完全可用**的中文字幕，且都在 rank 视野（前 12）内——rank 却以"分辨率/来源不匹配、
  sup 格式"为由全拒（其中"sup"判断本身是错的：712919 是 srt）。**根因 A：rank 病态保守**。
- **裸标题查询埋老片**。ASSRT `sub/search` 按上传时间排序，搜"招魂"→ 招魂4(2025) 挤爆
  前排，招魂1(2013) 沉底。实测「招魂 2013」直接把 2013 正片可用字幕顶到第 1 页。
  **根因 B：查询质量差**（裸标题时间偏置 + 超具体 release 文件名让噪声排前 +
  pipeline "第一条非空查询就停" 停在垃圾上）。
- **Shelby Oaks 判 ask_user 是对的**：ASSRT 上该片仅存 SUP 图形字幕 + 英文 srt，
  无中文文本字幕；模型保守拒绝正确，衰减重试会持续盯梢。用户洞察"缺中文片名上下文"
  成立但非本片死因——中文名「寻踪迷镇」经 Jellyfin RemoteSearch(zh-CN) 实测可取，
  作为**根因 C：上下文增强**纳入。
- **分页方案已排除**：ASSRT 支持 `pos` 翻页（实测 pos=15 返回不同的更老结果），但
  「标题+年份」查询让正确片直接进第 1 页，翻页非必要——YAGNI 砍掉，省一整个配额敏感特性。

## A. rank prompt 校准 + 格式硬过滤

### 格式硬过滤（`src/agent/rankCandidates.ts` 或新纯函数，rank 调用前）

按 filelist 文件扩展名判定可用性：候选的 filelist 中存在 `.srt/.ass/.ssa` 即"含文本字幕"；
包内全是图形字幕（`.sup/.idx/.sub` 或 subtype 明确为 PGS/VobSub）→ 剔除。
subtype 为 `None`/缺失**不作为剔除依据**（常是特效 ass）。全部剔光 → 干净 no_safe_match，
理由"仅存图形字幕，本产品处理文本字幕"。

### rank prompt 三条硬规则

1. 可用格式：srt/ass/ssa（含 filelist 内对应扩展名）皆可用；subtype=None 多为特效 ass，
   不得因此拒绝。
2. 分辨率/来源/编码差异**不是拒绝理由**——同一部片同剪辑版字幕时间轴默认通用。真正的
   风险仅：导演剪辑版 vs 院线版的时长差、明显的季集错配。
3. 决策门槛：存在"格式可用 + 含中文 + 片名年份匹配"的候选时倾向 download；no_safe_match
   只留给确无可用中文文本字幕。宁选来源不完美，勿空手而归。

## B. planSearch 查询策略重构 + 并集召回

### planSearch prompt

生成 **2-3 条"标题+年份"查询**，优先级：`中文名 + 年份`（有中文名时）→ `英文名 + 年份`
→ `英文名`。**禁止**生成超具体 release 文件名查询（噪声让垃圾排前）。系列片可带常见
中文编号（如"招魂4"）。

### pipeline 并集召回（`src/core/pipeline.ts`）

执行 SearchPlan 的**前 2 条查询**，候选并集去重（按 assrt id），再交 rank——不再
"第一条非空就停"。配额：search ≤ 2 + detail 1 = 3 次/任务，在单任务 4 次上限内。
rankCandidates 候选上限 `MAX_CANDIDATES` 12 → 15（吃满 ASSRT 单页）。

## C. Jellyfin 中文名上下文增强

### `JellyfinClient.getChineseTitle(item)`

调 `POST /Items/RemoteSearch/Movie`（或 /Series）with `MetadataLanguage: zh-CN` +
provider_ids（实测 tmdb=937941 → 「寻踪迷镇」）。取首个结果的 Name 作为中文译名。
**失败/无 provider id/超时一律静默返回空**（Jellyfin 刮削不可达即等价于此，绝不阻塞
主流程）。结果按 itemId 进内存缓存避免重复调用。

### MediaContext 增字段

`alternative_titles: string[]`（含 getChineseTitle 结果）、`overview: string | null`
（RemoteSearch 或 item.Overview，供 identify 防歧义）。identifyMedia/planSearch prompt
纳入这两个信号；planSearch 有中文名时以"中文名+年份"为首选查询。

## 不做什么

- 不做 ASSRT 分页（年份查询已覆盖，YAGNI）。
- 不做 TMDB 直连（Jellyfin RemoteSearch 已覆盖中文名；用户不该被要求配 TMDB key + 翻墙）。
- 不做 PGS/图形字幕 OCR 转文本（fast-follow 候选，见下）。

## Fast-follow 候选（记录，本里程碑不做）

- **图形字幕 OCR**：PGS/SUP → OCR → srt 理论可行，但需引入 OCR 二进制依赖、识别错误率、
  繁简与时间轴重建、镜像膨胀——与轻量 sidecar 定位有张力。触发条件：出现真实用户场景
  "某片仅有 PGS 中字且 ASSRT 无文本版"。在此之前不为假想需求扛整个 OCR 子系统。

## 测试

- 单测：格式硬过滤（filelist 扩展名判定、None subtype 不误杀、全图形→剔光）、并集去重、
  getChineseTitle 的 RemoteSearch fixture（成功/失败/无 provider id）、MediaContext 新字段映射；
- 判断点 prompt 无断言单测（惯例），靠真实验证；
- 真实（controller）：软路由部署后，招魂三部片 +14h 衰减重试自动用新逻辑复战——预期招魂
  系列翻案 download、Shelby 干净休眠；用 `report` 台账对比修复前后决策分布。
