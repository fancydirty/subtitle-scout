# 生产部署后 · 路线蓝图(2026-07-20,用户在 dashboard 上验收后口述)

鉴权 + CF Access 域名(subtitle.dirtyfancy.sbs)已上生产,用户登入验收,覆盖率实测约 98.8%
(covered 257+6 外挂 / embedded 150+4 内嵌 / ignored 30 / **unavailable 仅 5 集**)。用户口述下一
阶段蓝图,**context 将满,先落档 → compact → 接续**。执行顺序未定死,主控可调。

## 真实缺口(仅此 5 集,两部)
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

### B. 【详情页重设计·需 brainstorming + visual companion】
**用户不满**:详情页"小家子气"、空白多、**没充分利用 TMDB 元数据能力**。要:
1. 展现**剧集 description**(TMDB series overview)。
2. **点击某一集 → 展现那一集的 description(TMDB episode overview)!!!**(用户重点强调)。
3. 更强的媒体库详情页设计。
**执行**:①调研媒体库详情页最佳实践(Jellyfin/Plex/Overseerr/Trakt 等,同 auth 调研套路,
真源码/真产品)②**用 visual companion 给用户看推荐设计**(brainstorming skill 的 visual
companion)③后端:TMDB 逐集 overview——查 tmdb_seasons 缓存(G2/tmdbCatalog.ts)是否已存 episode
overview;TMDB /tv/{id}/season/{s} 端点带每集 overview,可能要扩缓存 + DTO + 前端渲染。
这是设计任务,先 brainstorming 出 spec 再 writing-plans。

### C. 【新字幕源】subhd + 专门动漫源 —— **未实现**
- **subhd**:通用型中文字幕站(非动漫专站,已纠正)。套 zimuku 模板(provider+adapter+反爬+
  session)。**铁律:真站实地侦察 + 真机冒烟,禁止只靠夹具绿**(zimuku 血泪)。
- **专门动漫源**:补里番/动漫弱项(大考实证动漫 27%)。漫游/诸神/澄空生态 or 聚合站。
  里番(成人动漫)更难,可能仍够不着——预期它是死缺口。

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
