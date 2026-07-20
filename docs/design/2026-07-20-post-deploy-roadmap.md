# 生产部署后 · 路线蓝图(2026-07-20,用户在 dashboard 上验收后口述)

鉴权 + CF Access 域名(subtitle.dirtyfancy.sbs)已上生产,用户登入验收,覆盖率实测约 98.8%
(covered 257+6 外挂 / embedded 150+4 内嵌 / ignored 30 / **unavailable 仅 5 集**)。用户口述下一
阶段蓝图,**context 将满,先落档 → compact → 接续**。执行顺序未定死,主控可调。

## ⏱ 进度实况(2026-07-20 深夜,接续第一眼看这里)
- **A 内嵌 UX bug** ✅ 合并 main(`d4be89d`)。
- **B 详情页重设计** ✅ 合并 main(`9d5d88b`)——hero+逐集剧照+季手风琴+行内简介展开+删右侧板+超长季50回落;后端 TMDB 富化管线(含存量库回填);已随 C 一并部署上生产。
- **C subhd 字幕源** ✅ 合并 main(`0c94eac`)+ **已部署生产 + subhd 生产实测可用**。真机侦察出 5 步下载流,curl 绕 Node TLS 指纹;**部署踩两坑均已修**:Dockerfile 缺 ca-certificates(`198c6f0`)、cloudflared build 期掉线(detach build 绕过)。容器直连 subhd.me=200,软路由家宽直通不用代理。动漫专源=侦察实证不建;里番=死缺口。
- **部署机制**:`deploy/deploy.sh`(rsync 工作树→路由 `/mnt/nvme0n1-4/docker/subtitle-scout`→`docker compose build && up`)。cloudflared build 期易掉线→**长 build 用 detach**(`nohup ...>log; echo EXIT-$?>done` 后轮询 done)。SSH 别名 `media-router-tunnel`。VPS 跳板:`jisuan`(23.254.150.206)/`yt-email-vps`(192.129.128.217),D 狂打 subhd 时当出口避灰名单。
- **下一步 = D 从零验证**(破坏性,环境用户明确"随意弄"可劲造)+ 里番短路。**建议 compact 后在干净窗口做 D**(破坏性操作忌中途 compact)。

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
