# #12 recognizer 括号密集片名 park 调查报告(2026-07-20 夜)

> systematic-debugging 结论:**D 报告 #2"recognizer 对括号密集片名解析回归"假说被证伪。**
> 两个 parked 文件都不是解析 bug,而是**设计北极星("拿不准就不动手")下正确的安全 park**。
> 无 autonomous 代码修复;留一条需用户拍板的设计建议。

## 复现方法

对两个真文件名跑全链(`parseFilename`→`identifyFromPath`→`recognize`),先用 mock TMDB(返回 [])
隔离解析层,再用真 `TmdbClient`(读 .env v4 key,官方直连)看 TMDB 真实返回。脚本见 scratch
`repro-recognizer.mts` / `repro-tmdb-real.mts` / `repro-tmdb-detail.mts`。

## 案 A:`The Astronaut (2025) [2160p][4K][WEB][5.1][YTS.MX].mkv`

**解析层完全正确**——不是括号污染:

```
parseFilename    : {title:"The Astronaut", year:2025, isTv:false, ...}
identifyFromPath : {title:"The Astronaut", year:2025, isTv:false, embeddedTmdbId:null}
recognize -> TMDB.search(movie, "The Astronaut", 2025)  # mediaType/title/year 全对
```

**park 真因 = `ambiguous`:TMDB 侧两条完全相同的记录。** 真机 `search(movie,"The Astronaut",2025)`:

| id | title | original | year | release | 票数 | 简介长 |
|---|---|---|---|---|---|---|
| **1086260** | The Astronaut | The Astronaut | 2025 | 2025-09-26 | **404** | 306 | ← 真片(Kate Mara) |
| **1435035** | The Astronaut | The Astronaut | 2025 | 2025-11-20 | **0** | 80 | ← 近空壳 |

`pickUniqueHit` 走完整流程:①非单一 hit ②年份过滤(两条都 2025)不收窄 ③clean-title 相等
(两条都 "theastronaut")不收窄 → 返回 null → **park `ambiguous`**。两条精确同 title+year,
**确定性规则正确拒绝在两条里瞎猜一个**(猜错就是永久污染库,北极星红线)。

**为何 baseline 有覆盖**:多半当年 TMDB 只有一条 2025 记录(1435035 是 11-20 后加的),或库里带过
`[tmdbid-N]` 标签走 rule-1 直通。从零清库 + YTS 裸文件名(无 tmdbid 标签)双重暴露了这条歧义。

## 案 B:`[The-Nut] High School DxD Hero - 01.mkv`

**解析层对 `[The-Nut]` 前缀彻底失败**(lib 把整名含 `.mkv` 当 title 吐回)→ `identifyFromPath`
park `no-signal`。**但"修好解析"已被证实危险,不是可做的修复:**

```
search(tv, "High School DxD Hero") -> 1 hit: id=45950 "High School DxD" (主系列)
```

若改进解析提出 "High School DxD Hero" + 绝对集号 1 → resolveToTmdb 得**单一 hit** → pickUniqueHit
规则(a)**无条件采纳** id=45950 → ingest 折算绝对 1 → S1E1。**但文件实为 DxD 第四季(副标题 Hero)**
→ 把 S1E1 的字幕装到 S4E1 文件上 = **误认,撞北极星红线**。这正是 index.ts:88-97 早已白纸黑字
记录的多季歧义(Hero 季内集号 vs 全剧绝对集号,裸数字下三种读法都成立)。**保持 park 正确。**

**DxD 的既定正确出路**:人工认领(救援页给 tmdbId + season)—— baseline 正是靠 identify_overrides
覆盖,从零测把该表一并清空才重新 park。这是设计,不是回归。

## 系统的既定歧义出路完好

`isRescueEligible(parkReason)` 对 `ambiguous`/`no-signal` **均 true**(只排除 excluded-extra /
duplicate-content)→ 两者都:①派 rescue worker(AI 再尝试)②在 dashboard 救援页列出供**人工
一键认领**(写 identify_overrides,下轮巡检经 override 识别)。The Astronaut 认领到 1086260 即解,
DxD 认领 + 季号即解。**对不可约歧义,系统本就靠"救援 + 人工认领",非靠 recognizer 瞎猜。**

## 结论

- **#12 不是可修的 recognizer bug。** 两处 park 都是北极星("拿不准就不动手")下的正确安全失败;
  解析层对 The Astronaut 完全正确,对 DxD 的失败即便修好也会撞红线。D 报告 #2 假说证伪(同 #1 更正)。
- **无 autonomous 代码改动**——按"高置信才自动改 + 圣文件/北极星不擅动"铁律,不写危险的启发式修复。

## 留给用户拍板的一条设计建议(**未自动实施**)

**精确同 title+year 时的票数 tiebreak。** The Astronaut 这类"两条 TMDB 记录 title 与 year 全同,
一条真片(高票)、一条空壳(0 票)"会越来越常见(TMDB 数据重复)。可给 `pickUniqueHit` 加一条
**极窄**的确定性 tiebreak:*当多条 hit 精确同 title 且精确同 year、其中恰好一条 `vote_count>0`(或
热度显著主导)时,采纳该条*。

- **为何或许在北极星精神内**:现有规则的"绝不采纳最接近 hit"警告针对的是 title 相似度;这里所有
  候选都是**精确匹配**,tiebreak 选的是"真记录 vs 空壳",不是"最像的"。
- **风险**:确改动一条设计明文的北极星保证(park-on-uncertainty、不做 popularity 排序);极小概率
  下用户的文件真是那条 0 票记录会被误认。需扩 `TmdbSearchHit` 带 vote_count/popularity(改核心契约)。
- **因此**:这是设计决策,非机械修复 → 留你晨定,不擅动。若你要,我 TDD 落地(仅此极窄分支 + 回归夹具)。
