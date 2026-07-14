# B 层测试设计:orchestrator(主代理)编排判断

日期：2026-07-14。状态：设计定稿（brainstorming，用户已认可草案并点破核心理由）。
前置：A 层（找字幕 worker）已建成+真模型验透；orchestrator 的 check_series_layout tmdbId bug 已修（merge 0a4d763，realign-vs-find 现在可测）。

## 存在理由（用户点破，北极星级）

**orchestrator = 胶水层 = 道成肉身的理性中介。** 上帝不直接往信徒身上刻圣痕（那会把信徒变成疯子＝不可控的子代理），而是派耶稣走到人间、用理性克制的口吻引导。在本项目：
- **"系统直接派" = 刻圣痕**：机械 `aggregate()` 看到"集数和 TMDB 对不上"就无脑造 job。直接喂给**会移动文件的 realign 子代理**，等于往正常库上刻圣痕——一个仅因 TMDB 数错/有特别篇而集数不符的**正常库**会被无脑 realign、把好文件搬乱。
- **orchestrator = 理性滤网**：看全局，只把**确实该做、且成形的**活派下去。

**"正常库零误触发"不是一条断言，是 orchestrator 存在的根本理由。** 它是那道**智能闸门**：确认"到底有没有必要派活"，尤其**绝不对正常库派下会动文件的 realign**。orchestrator 判断"薄"不是缺陷——**克制本身就是它的职责**：不做很厚的形状数学，而是当那道不发疯的闸门 + 把全局状态翻译成克制、成形的派活。

## B 层测什么（不测粒度——粒度是结构写死的）

派活粒度是季级、由工具 schema + SQL 聚合写死（`dispatch_find_subtitle_task` 只收季级、`list_missing_coverage` 已按季聚合），worker 用季包+绝对集数处理季内。所以 B 层测 orchestrator 的**派活判断**：

| 判断 | 断言 |
|---|---|
| **智能闸门·零误触发(定盘星)** | 正常库/良性差异 → realign 派活数 **= 0**；该忍住的忍住 |
| **realign-vs-find(对照)** | 良性差异(TMDB 数错/特别篇,镜像≠TMDB 但布局正常)→ **不** realign；真乱(镜像>>TMDB/绝对编号摊平)→ 才 realign |
| **该派谁** | 每个真缺的季/电影都派了 find task，不漏派、不给不缺的派 |
| **同剧顺序** | 一个剧既要 realign 又要 find → 先 realign 后 find（数据安全） |
| **规模缩放** | backlog 大不滥 spawn sibling；超 100 才溢出下个 orchestrator |
| **幂等** | 同一轮重跑 → 不重复派（DB dedup 兜底，但要断言） |
| **成形派活** | 派出的 worker_task 身份/kind/reason 正确，不是垃圾 |

## 两层结构（抄 A 层）

1. **确定性 in-suite（进 npm test）**：脚本化 `MockLanguageModelV4` 走各 backlog → 断言 DB 里**实际写了哪些 worker_task 行**（身份/kind/顺序/幂等/cap）。扩展现有 orchestratorAgent.test.ts。证管道。
2. **out-of-band 真模型 runner（新脚本，像 run-live-matrix，绝不进 npm test）**：真 mimo 面对各 backlog → 断言它**判断对**（零误触发/realign-vs-find/该派谁/不滥 spawn）。**这层暴露判断 bug**——mimo 会不会对正常库/良性差异瞎派 realign、该 realign 的不 realign。

## 轴 = backlog 形状（定盘星在最前）

`{ 正常库全覆盖(零派活) / 正常库但良性集数差异(零 realign,可能有 find) / 缺一个季 / 整库全缺 / 有些季全缺有些缺一两集 / 一个真乱季(镜像>>TMDB,该 realign) / 一个剧既要 realign 又要 find(顺序) / 超 100 个缺口(溢出 sibling) }`

每格断言：DB 里实际的 worker_task 行集合 = 预期集合（身份+kind），realign 数在正常/良性格 = 0，顺序对，幂等（重跑无增），cap/溢出对。

## 要新建的一块

现无"喂一个 backlog"的工厂——每测手写 `lib.upsertSeries/upsertEpisode`。B 层需一个 **in-memory `seedBacklog(...)` 工厂**（按形状塞 series/episodes/movies + 镜像集数 vs TMDB 差异），两层共用。其余复用：MockLM 脚本模式、`toolCallTap` 观测派活序列、真 `better-sqlite3` in-mem DB + `JobsRepo` dedup 当地面真相、真模型 runner 复用 makeModel。

## 阶段（功能测试，非产品功能）

1. **seedBacklog 工厂 + 确定性 in-suite 层**（扩展 orchestratorAgent.test.ts；覆盖零误触发/realign-vs-find/顺序/幂等/cap/成形，脚本模型）。
2. **out-of-band 真模型 orchestrator runner**（新脚本 + backlog 形状 catalog + 断言实际 DB 行；toolCallTap 观测；真 mimo）。
3. **真模型实弹 + 监控**（各 backlog 形状跑真 mimo，暴露判断缺口→auto-research 三分类）。

## 不在本 spec

- A 层其余格子（国产/欧美/电影）；真数据 cell（env 下载坑）；旧 pipeline 退役承重墙①②；C 层端到端。i18n 反向 backlog。
