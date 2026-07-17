# 救援官战役 · Spec（2026-07-17）

出处：登记册 §9 立项定稿 + dashboard spec §10 + 验收轮实证（DxD 案证明"停车谦逊+人工裁决可被 agent 替代"；
用户裁决"给 agent 配搜索工具做识别"）。执行器=opencode company/kimi-k3（用户令），主控逐 diff 亲核。

## 目标

停车场（parked_paths，真机现存 ~110 条）从"纯人工甄别"升级为"agent 先清一轮，人只裁 agent 也拿不准的"；
特典媒体明确排除；hardsub_mode / exclude_extras 两个设置从"已保存未消费"点亮为真消费。

## 1. 停车事实入活文档

orchestrator 的 list_missing_coverage 结果附 `parked: { count, sample: [{path, reason}] }`（机械事实，
不是指令——北极星④）；orchestratorSkill 教它：parked>0 时可派 `rescue_identify` worker_task（新 taskType，
jobs 身份=合成 seriesId `rescue-<hash>`，season/movie 恒 null）。派发预算与 find/realign 共享同一 cap。
**skill 文件改动=主控亲笔**（铁律：子代理禁触 src/agent/skills/）。

## 2. 识别救援 worker（新 LLM agent，复用 reasoningAgent 工厂）

- 输入（机械层备好）：停车路径按 dirname 分组（同甄别页 groupPending 口径）、每组文件名清单、
  ffprobe 时长（复用 streamProbe 接口，秒级）、park reason。
- 工具：`search_tmdb`（薄封装 TmdbClient.search tv+movie，回 id/title/year/genres）、
  `get_tmdb_details`（getDetails+getSeasonTable——验证季集数与磁盘文件数是否吻合）、
  `claim_directory`（写 identify_overrides + 踢扫描——与甄别页 claimParked 同一实现路径，
  参数 {dirPrefix, tmdbId, isTv, season?}）、`exclude_extras`（见 §3）、`keep_parked`（回写人话理由
  到 parked_paths.reason——拿不准=显式决定，不是没决定）、finalize（逐组结局汇总）。
- 判断纪律（skill 正文，主控亲笔）：证据链=文件名解析+目录名+时长+TMDB 校验（季集数吻合/年份/类型）；
  单一强证据不够时找第二证据；**宁可 keep_parked 不可猜**（DxD 案的谦逊是对的，救援官只是把
  "查一下就能确认"的那批清掉）；一次认领=一个目录（override 目录级传播）。
- 收官：runs 行（decision=rescue:claimed/rescue:parked/rescue:excluded 计数入 detail）+ trace 快照
  （痕迹通道 C 全套自动生效——runKey=job-<id>）。

## 3. 特典三级排除

- **机械铁案**（ingest 识别前置过滤，不进 LLM）：文件名含 NCOP/NCED/Menu/PV/CM/Trailer/Preview
  （词边界匹配，大小写不敏感）→ parked_paths 落 reason=`excluded-extra`（专用 reason，可稽核可翻案），
  不进 episodes/movies。受 `exclude_extras` 设置门控：'false' 时跳过过滤（默认 false——保守，
  用户显式打开才排除；设置页注记同步改为"已生效"）。
- **灰区归 agent**：SP/OVA/OAD/Special 字样不进铁案——由救援官 worker 判：TMDB S0 有对应条目
  或时长≥15min（剧情级 OAD 实证有字幕专包）→ 正常认领入库（S0）；纯映像特典（时长<15min 且
  无 TMDB 条目）→ exclude_extras 工具落 excluded-extra。
- 甄别页兑现 F5 留位第三箱「Excluded extras」：默认折叠，行=文件+一键翻案（撤 excluded 标记
  重新入识别流）。

## 4. hardsub_mode 消费（find-subtitle worker 侧）

三档语义（spec §7 原定）：`off`=现状（不做硬字幕假定）；`agent`（默认）=find-subtitle worker 的
skill 增补一段判断指引（主控亲笔）：目标视频文件名含【组名】式括号组标记、且探针无内嵌字幕、
且全网确无外挂候选时，**可以**判定 hardsub-assumed（新结局词，harvest 落 item sub_status=
`hardsub-assumed`，格阵/覆盖句按"已覆盖（硬字幕假定）"呈现——诚实标注不是绿点，用独立样式）；
`aggressive`=机械层直判：ingest 探针阶段【组名】+无内嵌 → 直接 hardsub-assumed，不派搜索。
设置值经 FindSubtitleTask 透传（mapper 读 settings）。

## 5. README 命名最佳实践

README 新节：`Title (Year)/Season NN/Title SNNENN.ext` 推荐结构、组名标记的影响、
救援官会怎么处理不规范命名。甄别页改名指引文案与之对齐。

## 非目标

重复源处理（duplicate-content 停车行救援官**跳过不碰**——归重复源战役）；多语言；
自动改名/移动文件（realign 已有，救援官只认领不搬文件）。

## 验收口径

真机 110 条停车中非 duplicate 的部分经一轮救援 pass 后：可确认的（如 Frieren 短名）自动入库，
灰区留停车带人话理由；特典开关打开后 NC 类文件入 excluded 箱；hardsub 三档各真实生效一例。
