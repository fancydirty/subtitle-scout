# 生产部署后 · 路线蓝图(2026-07-20,用户在 dashboard 上验收后口述)

鉴权 + CF Access 域名(subtitle.dirtyfancy.sbs)已上生产,用户登入验收,覆盖率实测约 98.8%
(covered 257+6 外挂 / embedded 150+4 内嵌 / ignored 30 / **unavailable 仅 5 集**)。用户口述下一
阶段蓝图,**context 将满,先落档 → compact → 接续**。执行顺序未定死,主控可调。

## ⏱ 进度实况(2026-07-20 深夜,接续第一眼看这里)
- **A 内嵌 UX bug** ✅ 合并 main(`d4be89d`)。
- **B 详情页重设计** ✅ 合并 main(`9d5d88b`)——hero+逐集剧照+季手风琴+行内简介展开+删右侧板+超长季50回落;后端 TMDB 富化管线(含存量库回填);已随 C 一并部署上生产。
- **C subhd 字幕源** ✅ 合并 main(`0c94eac`)+ **已部署生产 + subhd 生产实测可用**。真机侦察出 5 步下载流,curl 绕 Node TLS 指纹;**部署踩两坑均已修**:Dockerfile 缺 ca-certificates(`198c6f0`)、cloudflared build 期掉线(detach build 绕过)。容器直连 subhd.me=200,软路由家宽直通不用代理。动漫专源=侦察实证不建;里番=死缺口。
- **部署机制**:`deploy/deploy.sh`(rsync 工作树→路由 `/mnt/nvme0n1-4/docker/subtitle-scout`→`docker compose build && up`)。cloudflared build 期易掉线→**长 build 用 detach**(`nohup ...>log; echo EXIT-$?>done` 后轮询 done)。SSH 别名 `media-router-tunnel`。VPS 跳板:`jisuan`(23.254.150.206)/`yt-email-vps`(192.129.128.217),D 狂打 subhd 时当出口避灰名单。
- **E AI 翻译** ✅ **已建成+真机验收(2026-07-21 上午)**——全垂直落项目(`src/translate/` 7 模块 + `src/files/extractEmbeddedSub` + CLI `translate-item`),确定性编排+可注入 LM/critic,全 TDD(全量 1804+ 绿)。**真机强弱对比**:mimo(弱)生硬+丢标签→held;company opus(强)术语100%+自然中文→installed。**测试逼出 3 改计划全落地**:①E 用可配强模型 TRANSLATE_*(mimo 留 captcha)②样式标签检查降 soft ③加 LLM-judge critic 语义层。实现+发现:`docs/design/2026-07-21-e-implementation-and-findings.md`。**剩:daemon 自动触发接线(sub_status 可译探测+reconcile 派活,较大集成留评审)。** 原设计 spec: docs/design/2026-07-20-ai-translation-design.md。
- **已定但未实现的产品小决策**(compact 后随手做):①**partial** 放宽——只对短到几秒几分的荒谬时长兜底,合理差异(片尾广告等)一视同仁当正常;②**里番**——TMDB `adult` 标记的媒体 ingest 阶段直接不入库/不进工作流(比短路更干净);③**embedded 海报徽章**——把 embedded 计入覆盖分子(与 A 修一致,显 `10/12` 而非误导的 `0/2`);④**subhd 防灰**——D 狂打时容器起 SSH SOCKS 隧道到 VPS(`jisuan`/`yt-email-vps`)+ `ALL_PROXY`,灰了切另一台 IP。
- **D 从零验证** ✅ **完成(2026-07-20,18:45→21:12,2h27m)。终报:docs/design/2026-07-20-from-zero-fullsource-exam-report.md**。
  - **判词**:整机从零自主重建成立,**216 集一轮拿下 ≈94.7% 超九成**;四源全出力、**subhd 实锤 19 个**。
    但大考揪出**三处真回归**(不容粉饰):🔴#1 **结果集排序把精准低产源埋出分页窗→agent 从没看见正确候选**
    (runSearch 按 adapter 顺序拼接、OS 返 50 条错剧把 zimuku 唯一 exact-match 整季包挤到第 66 名,agent limit50
    分页窗只到 49),丢 The Rig S1×6 合法覆盖(baseline 是 zimuku:181453 真中字,已抽内容验实)——**✅已修 commit 5f40900**
    (interleaveByProvider 轮转合并,纯重排非闸,北极星安全;初版误判"空fileList致弃选"已更正;**✅真机闭环已验**:
    The Rig S1 6/6 covered from zimuku:181453,端到端含 archiveEntries 开包逐集装;全库 covered 238→244、unavailable 12→6);🟠#2 recognizer
    对括号密集片名(The Astronaut YTS.MX、[The-Nut] DxD Hero)**再识别失败被 park**(movies 10→9;DxD Hero 整季),
    park 是安全失败、daemon 会重试**可能自愈**——次高;🟢#3 里番(Adam's×4)+ The Rig **S2E1/E6** = 真缺口/真 AI 翻译案例。
    err×1=已知 finalize 未调类(DxD 最终 36/36 覆盖,完全恢复)、nsm×2=合法。观测小缺口:run 级 API 计数器未落库。
  - **⚠️ E 图景更正**:The Rig **S1 不是 AI 翻译案例**(zimuku 有真中字,#1 没装上);**只有 S2E1/E6** 是真"无中字+内嵌英文轨"试验田。
  - **接续排序**:①✅**#1 结果集排序已修+真机闭环验**(commit 5f40900 interleaveByProvider;The Rig S1 6/6 covered)②✅**#2 已调查证伪(非 bug)**——见 `docs/design/2026-07-20-recognizer-park-investigation.md`:The Astronaut 解析完全正确,park 因 TMDB 两条精确同 title+year 记录(1086260 真片/404 票 vs 1435035 空壳/0 票)不可约歧义;DxD Hero"修好解析"会撞多季红线(单一 hit=主系列 45950,折算绝对1→S1E1 装 S4 文件)。两者皆**北极星正确安全 park**,rescue-eligible 可人工认领(baseline 靠 override,从零清库才重 park)。**无代码修复**,留"票数 tiebreak"设计建议待拍板③E 实现。**⚠️E 松绑(用户 2026-07-20)**:AI 翻译要 feature 本身,不必拿 Rig 当例子——随便找带内嵌/外挂英文轨的媒体验证即可,不是真为 Rig 中字。
  - ~~(下方为执行中记录,留档)~~
  - 🔴 **飞行前揪出并修掉一个会让 D 作废的生产 bug**:subhd 从没被 app 装载过。根因=生产 compose 的
    `environment:` 块漏列 `SUBHD_ENABLED`(docker compose 只注入显式列出的变量、无 env_file),.env 里
    `SUBHD_ENABLED=true` 从未到达容器 → `buildAdapters` 门控 `SUBHD_ENABLED==='true'` 恒 false → subhd
    adapter 从未注册。之前"容器→subhd.me=200"只是 curl 连通性,测错了层(ca-cert 同款陷阱)。**修**:路由侧
    自治 compose 补 `SUBHD_ENABLED` 行 + 重建容器,运行时实跑 `buildAdapters()` 打印 `assrt,opensubtitles,
    zimuku,subhd` 铁证四源全在线。OSS 仓 compose 同缺 ZIMUKU/SUBHD 两门(公开用户同坑),已 commit
    `1c7a8d1`(本地,未 push)。deploy.sh 明确不下发 docker-compose.yml(生产 compose 路由侧自治)。
  - e2e-zero 协议:基线快照(eps covered257/embedded150/ignored30/unavailable5、mov covered6/embedded4、
    subs270)→ 归档 270 sidecar 字幕(tar 验证 270==270)+ cache-before/(12.7M 对照物)→ 删 270 字幕(盘剩0)
    + 清 scout.db/result-sets/session → 起全新空 DB。**auth 管理员账号随 DB 清空**(预期副作用,dashboard 需重走
    创建向导——终报提醒用户重建登录)。
  - 触发后:识别浪潮跑完 **228 missing eps + 5 missing mov**(与 2026-07-18 从零 228 一致=同库),首个 agent
    job 已起。change-driven 监视器 persistent 看到 missing→0。预期 2-3h,目标一次性到九成、只剩 The Rig+里番。
- **下一步排序**:D 跑完出终报(验尸 270 旧字幕账本 + subhd 是否真出力 group by source + 剩余缺口)→ E(实现)
  → 上面 4 个小决策(可并入 D 收尾)。

## 真实缺口(仅此 5 集,两部)——注:subhd 上线后此表待 D 从零重测刷新
- **Adam's Sweet Agony(甘い懲罰,里番/成人动漫)** S1E6/E7/E8 —— 主流站不收,需专门动漫/成人源,基本"确实没有"。
- **The Rig** S2E1/S2E6 —— 新剧,可能中文字幕未出 or 匹配问题;**关键:The Rig 的视频文件里带内嵌
  的外挂英文字幕(soft sub,非硬字幕)** → 是 AI 翻译功能的天然试验田。

## 任务清单(post-compact)

### A. 【UX bug·清晰】内嵌显示为"已覆盖"但详情说"无字幕"
**实证**:AHS(tmdb:1413)S01E04 sub_status=`embedded`、外挂字幕=0 → grid 判"已覆盖",右侧"字幕"
面板只列外挂 → 显示"这一集暂无字幕",自相矛盾。**修**:episode 详情面板 + 覆盖句要明确区分
"已覆盖·内嵌字幕(视频自带)" vs "无外挂字幕"。关联 dashboard 审计 #4(embedded 处理)+
[[glue-layer-campaign-progress]] 的 docs/design/2026-07-20-dashboard-robustness-audit.md。
位置:web/src/library/SeriesPage.tsx(EpisodeDetail 面板)、episodeState.ts、text.ts 的覆盖句。

### B. 【详情页重设计·需 brainstorming + visual companion】 —— ✅ 已完成（2026-07-20，branch feat/detail-page-redesign）
> spec: docs/design/2026-07-20-detail-page-redesign-design.md · plan: docs/superpowers/plans/2026-07-20-detail-page-redesign.md（本地）
> 落地=hero 渐变背景图 + FactsRail + 季手风琴 + 逐集剧照 + 点集行内展开该集 TMDB 简介 + 删右侧面板 + 超长季 50 集回落格阵。
> 后端补 TMDB 富化管线（series overview/backdrop + 逐集 overview/air_date/still_path，含存量库回填修补 de19112）。
> 16 提交，root 1717 + web 291 全绿、双端 tsc 净。待并回 main。原始需求：
**用户不满**:详情页"小家子气"、空白多、**没充分利用 TMDB 元数据能力**。要:
1. 展现**剧集 description**(TMDB series overview)。
2. **点击某一集 → 展现那一集的 description(TMDB episode overview)!!!**(用户重点强调)。
3. 更强的媒体库详情页设计。
**执行**:①调研媒体库详情页最佳实践(Jellyfin/Plex/Overseerr/Trakt 等,同 auth 调研套路,
真源码/真产品)②**用 visual companion 给用户看推荐设计**(brainstorming skill 的 visual
companion)③后端:TMDB 逐集 overview——查 tmdb_seasons 缓存(G2/tmdbCatalog.ts)是否已存 episode
overview;TMDB /tv/{id}/season/{s} 端点带每集 overview,可能要扩缓存 + DTO + 前端渲染。
这是设计任务,先 brainstorming 出 spec 再 writing-plans。

### C. 【新字幕源】subhd —— **已实现（feat/subhd-source）**；专门动漫源 —— **不建**
- **subhd** ✅:通用型中文字幕站。真机实测后的链路（与设计文档假设有出入，以实测为准）：
  搜索 `GET /search/<q>`(HTML cards) → `POST /api/sub/prepare-download`(拿 tk 5min cookie) →
  `GET /down/<id>`(激活临时页) → `POST /api/sub/down`(拿真 CDN 文件 url) → `GET dlus.subhd.me/…`。
  **🔴 关键坑:Node TLS(JA3) 指纹被 Cloudflare 在临时页校验上拒**——undici/node:https 恒"已失效",
  故 SubhdClient 默认 fetchImpl **shell 到 curl**（CDN 文件下载仍走 undici，无指纹门）。无验证码/无
  云锁/无 session store，比 zimuku 简单。产物可为单文件 .ass/.srt 或压缩包 .zip/.rar/.7z（.rar/.7z
  非 zip、v1 诚实 UnsupportedArchiveError，由 agent 换候选）。SUBHD_ENABLED=true 开门（无需 LLM）。
  提交见 feat/subhd-source(T1–T10);真机端到端冒烟 `SUBHD_LIVE_SMOKE=1`（默认 CI 跳过）。
- **专门动漫源**:按侦察结论**不建**——里番/成人动漫主流站基本不收,专门源覆盖也差,预期死缺口,
  短路押后到 D（从零验证）再据实评估,不预造。

### D. 【从零验证】清空容器全部日志/状态,完完全全从零跑
用户令:**把当前容器内所有日志/状态全删,完全从零开始**,确认 subhd + 其他源加入后成功率能否
**一次性到九成**——即最终只剩里番 + The Rig 拿不到。这是全栈破坏性大测(比 zimuku 单源大考更全)。
**必走 e2e-zero 协议**:archive + manifest + DB 备份;媒体数据可牺牲,爆炸半径严格限媒体目录;
生产 compose/.env/DB 先备份。基线参照 zimuku 大考终报手法。

### E. 【AI 翻译功能】—— 新功能,The Rig 解锁它
The Rig 拿不到中文字幕,但**视频内嵌了外挂英文字幕(soft/外挂,非硬字幕)**。→ 建 AI 翻译:
探测内嵌 soft 字幕轨 → 抽取英文 → LLM 翻译成目标语言 → 落盘为外挂中文字幕。这是大功能,需
brainstorming 出设计(探测/抽取用 ffprobe/ffmpeg;翻译走现有 LLM;质量校验;北极星=silent
装错比留缺口更糟,翻译错更要防)。用户明确:因为 The Rig 有内嵌英文轨,是这功能的试验田。

## 用户已答疑
- workflow tab 的 peacemaker 等尝试 = **旧积压**(78 条 run,2026-07-18~19 zimuku 大考+恢复期,
  daemon 现无活可干故无新 run)。从零验证(D)会连带清掉这些历史。
- subhd/动漫源 = 未实现,列入 post-compact(C)。

## 收尾提醒
- **CF token `cfut_tnc…` 仍暴露未轮转**——用户需删/regenerate。主控侧临时文件已删。
- 排期建议(可调):A(小 UX 修,快)→ C(subhd+动漫源)→ D(从零验证)→ E(AI 翻译);B(详情页
  重设计)独立设计track,先 brainstorming+visual companion。
