# 从零全源大考 · 运行记录与验尸报告(2026-07-20)

用户令(roadmap item D):**清空容器全部日志/状态,完全从零跑**,确认 subhd + 全部源加入后成功率能否
**一次性到九成**——即最终只剩里番 + The Rig 拿不到。执行于生产软路由(dev/test,用户明确"随意弄"),
取证目录 `e2e-fullsource-20260720/`。18:45 清零 → 21:12 队列跑干,全程 **2h27m**。

## 判词(TL;DR)

- ✅ **整机从零自主重建成立**:228 missing eps + 5 missing mov → 队列跑干 missing=0。**216 集一轮拿下 ≈ 94.7%,超九成目标**。
- ✅ **subhd 上线并大量出力**(19 个字幕)——见"飞行前捕获"。四源全部贡献。
- 🔴 **但大考揪出三处真回归**(这正是从零大考的价值):The Rig S1×6(zimuku adapter bug)、
  The Astronaut + DxD Hero×12(识别 park 回归)。最终"只剩里番 + The Rig"的定性目标达成,但账不是干净的九成五。

## 飞行前捕获:subhd 从没在跑(测错层陷阱)

清零前运行时核查发现 **subhd 在生产里是死的**:生产 compose 的 `environment:` 块漏列 `SUBHD_ENABLED`
(docker compose 只注入显式列出的变量、无 `env_file`)→ `.env` 里 `SUBHD_ENABLED=true` 从未到达容器 →
`buildAdapters` 门控恒 false → subhd adapter 从未注册。此前"容器 curl subhd.me=200"只是连通性、**测错了层**
(与 ca-certificates 那次同款陷阱)。修:路由自治 compose 补行 + 重建容器,运行时实跑 `buildAdapters()`
打印 `assrt,opensubtitles,zimuku,subhd` 四源全在线铁证。OSS 仓 compose 同缺 ZIMUKU/SUBHD 两门,已 commit
`1c7a8d1`(本地未 push)。**若非此核查,本场大考会在无 subhd 下白跑。**

## 协议(全程带保险,可完整回滚)

取证目录 `e2e-fullsource-20260720/`:
- `deleted-subs-manifest.txt`:删除的 **270** sidecar 字幕全路径(6 Movies / 239 TV / 25 anime;148 .ass + 122 .srt,与 DB 270 subtitles 行精确一致)
- `subs-archive.tgz`:删除前 tar 归档(**tar 验证 270==270** 后才删,4.4M)
- `cache-before/`:旧世界全部状态退休(scout.db 1.38MB + result-sets + 决策缓存,12.7M 验尸对照物)
- `from-zero.log`:docker-logs 持久 follower;`baseline-coverage.json` / `finaldump.json`:清零前后全量快照
- `query.js` / `progress.js` / `monstat.js` / `finaldump.js`:战况查询脚本(容器内 better-sqlite3 跑)
- **auth 管理员账号随 DB 清空**(预期副作用,dashboard 需重走首次创建向导)

## 终局账本(baseline → final)

| 维度 | Baseline | Final | 说明 |
|---|---|---|---|
| episodes covered | 257 | **238** | -19,见回归 |
| episodes embedded | 150 | 150 | 持平 |
| episodes ignored | 30 | 30 | 国产跳过门 |
| episodes unavailable | 5 | **12** | +7 回归 |
| movies covered | 6 | **5** | -1(The Astronaut park) |
| movies embedded | 4 | 4 | 持平 |
| subtitles | 270 | 251 | 见回归 |
| parked | — | **13** | The Astronaut + DxD Hero×12 |

**来源归属(subtitles.provider_ref 前缀,权威)**:assrt **116** / opensubtitles **20** / **subhd 19** / zimuku **17**
+ preexisting/去重传播 **79** = 251。**四源全部真实出力,subhd 交付 19 个(修 bug 的回报)。**
run 决策:installed 24 / rescue:parked 6 / rescue:claimed 3 / no_safe_match 2 / error 1。

## 大考交卷的发现(按严重度)

### 🔴 #1 真回归·zimuku adapter 整季包 fileList 为空 → agent 无从验包弃选(The Rig S1×6)

**实证**:baseline 里 The Rig(2023,tmdb:112581)S1E1-E6 全 covered,来源 `zimuku:181453`(Season 1 TRUFFLE
整季包)。从归档抽出 `The.Rig.S01E01...zh-Hans.srt`,内容是**货真价实的 2023 剧中字**("金洛克B区"=剧中钻井
平台 Kinloch Bravo、"于特西拉北海南海…西南风三到四节"=S1E1 开场航运预报)。**baseline 覆盖合法无误。**

本轮从零,agent 对 The Rig 搜了 **17 次**(穷尽 "The Rig"/"钻井平台"/"鑽油平台危機"/"The Rig 2023 S01
AMZN"…),`cache/result-sets/8/` 缓存证实 **zimuku 本轮确实召回了同一个 181453 包**(命中 6 次)。但 agent
眼中该候选长这样:

```json
{ "provider":"zimuku","providerId":"181453",
  "videoName":"钻井.The.Rig.S01.1080p.AMZN.WEBRip.DDP5.1.x264-TRUFFLE",
  "language": null,        // 无法从元数据确认中文
  "fileList": [] }         // 整季包内容清单为空!
```

**根因**:zimuku adapter 对整季包候选返回**空 `fileList` + null `language`** → agent 无从验证包内含哪 6 集、
是否中文 → 谨慎的反-Bazarr 判断只能弃选(叠加 assrt 返"雷玛根大桥"1969电影、OS 返"窗邊女孩"错剧的噪声)→
判 no_safe_match。**判断力没错,喂给它的候选元数据残缺**(与 2026-07-18 从零 #2"喂错单集时长"同族:错在喂料)。

**修法**(入队):zimuku 搜索结果须填充 `fileList`(开包枚举季内逐集文件)+ `language`;或加"resolve 前置窥包"
步骤,让 agent 判前拿到包内清单。zimuku 本轮为别的剧装了 17 个字幕(健康),故是**整季包路径特异性缺陷**,
非源整体故障。

### 🟠 #2 识别回归·括号堆砌片名再识别失败被 park(The Astronaut + DxD Hero×12)

**实证**:parked=13 全部是 `The Astronaut (2025) [2160p] [4K] [WEB] [5.1] [YTS.MX].mkv` 与
`[The-Nut] High School DxD Hero - 01..12.mkv`。这些文件**盘上都在**(只删了字幕),baseline 都有字幕(在删除清单),
即 baseline 曾识别+覆盖。本轮再识别失败 → park。
- **The Astronaut**:整部电影从 movies 表消失(movies 10→9),该片仅此一文件 → **确定覆盖丢失**。
- **DxD Hero(=DxD 第四季)**:tmdb:45950 现只有 S1/S2/S3(各12,全covered),**无 S4**;12 个 [The-Nut] Hero 文件
  全 park、从没建成 S4 集 → **Hero 整季识别回归**(主系列 S1-3 经其他文件仍覆盖)。

**性质**:park 是**安全失败**(宁可不识别也不装错),且 daemon 会按 `last_attempt` 重试 → 部分可能后续自愈。
但 baseline 识别过、本轮没识别出,指向 recognizer 对**方括号密集/非常规发布名**(YTS.MX、[The-Nut]…Hero - NN)
的鲁棒性回归或非确定性。**入队**:核查 recognizer 对这两类命名的解析;观察 parked 是否自愈。

### 🟢 #3 里番真缺口 + The Rig S2 = 真 AI 翻译案例(改写 E 图景)

最终 12 unavailable = The Rig×8 + Adam's Sweet Agony(里番)×4。逐个查根:
- **Adam's Sweet Agony**(里番)S1E1/E6/E7/E8:agent 判词"OpenSubtitles 只有 E02-E05,穷尽多语查询无中字"——
  **全网确实无中字**,真缺口(预期,里番主流站不收)。baseline 已缺 E6-8,本轮 E1 也判无(+1)。
- **The Rig S2E1/E6**(emb=`["eng"]`):从来无中字、只有内嵌英文轨 → **真 AI 翻译案例**。
- ⚠️ **E 图景更正**:The Rig **S1E1-6 不是 AI 翻译案例**(zimuku 有真中字,见 #1,是没装上)。**只有 The Rig
  S2E1/E6 是真正的"无中字+内嵌英文轨"AI 翻译试验田。** E 实现时以 S2E1/E6 为准,别拿 S1 当例子。

### 🟢 #4 已知类·状态机兜住(非新问题)

- **error×1** = job#19(tmdb:45950 High School DxD)"reasoning agent 结束未调 finalize"——2026-07-18 从零同款
  已知模型行为类,状态机兜住;**该剧最终 36/36 全覆盖,err 完全恢复**,非缺口。
- **no_safe_match×2** = The Rig(8集判无)+ Adam's(4集判无),正是两个合法缺口,非可解内容的假阴性。
- **观测小缺口**:`runs.llm_calls`/`assrt_calls` 聚合恒 0(实际打了 116 assrt),run 级 API 计数器未落库——
  onApiCall 观测链没接到 run 行。入队(低优先)。

## 结论

**整机从零可用性成立且更强了**:识别→分类→智能派活→四源(含新上线 subhd)获取→传播→救援全链在真实生产库上
自主重建了字幕世界,**216 集一轮拿下 ≈94.7%,超九成目标**,subhd 实锤大量出力。"只剩 The Rig + 里番"的定性
目标达成。

**但大考诚实暴露三处真回归**,不容粉饰为干净九成五:
1. **zimuku 整季包 fileList 空**(#1,可修)——丢 The Rig S1×6 合法覆盖,最高优先级修。
2. **recognizer 对括号密集片名 park 回归**(#2)——丢 The Astronaut(确定)+ DxD Hero×12(可能自愈),次高。
3. 里番 + The Rig S2 = 真缺口/真 AI 翻译案例(#3,符合预期,E 的靶子)。

**下一步排序**:①修 #1 zimuku fileList(走 TDD,真机复现 The Rig S1 装上闭环)②查 #2 recognizer park 回归
(观察自愈 or 修解析)③E(AI 翻译)以 The Rig S2E1/E6 为唯一试验田推进。#1/#2 均可并入 E 之前的一轮清算。
