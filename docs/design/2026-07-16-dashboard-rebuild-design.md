# Dashboard 重建 · 设计（2026-07-16）

状态：与用户逐项讨论定稿（视觉伴侣 + 两轮外部调研佐证）。实施排期在胶水层战役真站闸门
报告落册之后。前置依赖：本 spec 的"后端补件"一节先行。

## 0. 定位与公理

- **第一公理（用户定）**：能交给 agent 的就交给 agent——HITL 只在必要。这是产品卖点本身。
- **干预权边界 = B 档**：观察为主 + 定点扳手（甄别认领、对某剧手动重派含 includeThrottled、
  设置页行为项）。明确拒绝 C 档（Bazarr 式逐集手选字幕源）——那是滑坡回 Bazarr。
- dashboard 的第二使命是**表达系统哲学**：页面结构本身讲"机械层产事实 → 主代理判断 →
  worker 执行"的反 Bazarr 叙事。
- 真源恒为 SQLite（DB=索引，磁盘=真相）；dashboard 是读者与定点写入者，不是第二状态机。

## 1. 技术栈（调研裁定，用户批准）

- **架构不动**：Vite + React 19 SPA，daemon 进程内嵌 serve 静态产物 + JSON API（apiV2 扩展）。
  Next.js 判排除（SSR 服务器层与 daemon 内嵌 serve 硬冲突，单机自托管场景收益为零）。
- **UI 层**：Astryx（Meta 2026-06 开源的 agent-ready 设计系统：150+ 组件、MCP server、
  `template dashboard`）**试点**——先分支验证 React 19 兼容；**shadcn/ui 保底**（new-york、
  zinc、dark）。二选一后不混用。
- **设计纪律栈**（本地 skills）：dashboards-and-real-time-visualization（信息摆放/状态语义/
  动效克制）→ shadcn（token+组件选型）→ geist（字体分工）→ react-best-practices（工程）。
- **DESIGN.md**：仿 voltagent/awesome-design-md 的 9 节结构给本项目写一份，agent 每次写 UI
  必读——治风格漂移。ui-ux-pro-max 不装（边际收益低+star 曲线反常）。

## 2. 设计语言（v2 mockup 方向已过目，落 DESIGN.md 时细化）

两轮调研（Linear/Vercel/Warp/Raycast/Resend/Supabase 六份 DESIGN.md + Trigger.dev 源码
token + Inngest trace 视图 + Midday）的公约数，v2 mockup 已验证方向：

- **存活感=数据新鲜度**：顶栏一行 mono 灰字 `watching /media · scanned 2m ago · 568 files`。
  禁止"● 守护运行中"式声明标语（v1 定罪现场）。
- **色**：canvas 近黑微色温（≈#0b0c0f），3-4 级 surface 阶梯，hairline 半透明白，**深色下
  零 drop-shadow**；4 级 ink 灰阶；单 accent 稀缺使用（每屏≤1 处亮色）；语义色只给状态，
  **排队/中性/取消=灰**（Trigger.dev 源码实证）。
- **状态呈现**：6px 圆点 + 一个同色词；错误行至多 6% 透明度微染；覆盖率写 Midday 式人话
  句子（"Season 1 has **24 of 28** episodes covered"）。
- **排版**：正文 13px/500/-0.01em；字重天花板 600；display 负字距；eyebrow/分区标=uppercase
  小灰 mono；**mono 是技术层专属声音**（路径/ID/时长/时间戳/语言码），正文绝不 mono；
  衬线全站只出现一次（空状态或欢迎语）。
- **交互**：键帽入 UI（⌘K 搜索、按钮内嵌快捷键、esc 角标）；过滤器=下拉 chip 排 + 结果
  计数；详情=固定右侧板不跳页；Loading/Empty/Error 三态全覆盖；动效只给
  active/alert/focus/recency。

## 3. Tab 结构与 i18n

四 tab：**Library / Workflow / Triage / Settings**（中文：媒体库 / Workflow / 甄别 / 设置）。
- i18n：en/zh 两语（项目目标国际化发布）。
- **Workflow 区永不本地化**（用户裁决）：工具名/痕迹/回执是代码世界的英语，中文界面下该区
  仍全英文。

## 4. Library（媒体库）

**三层模型**：应有集（TMDB 权威表）× 实有集（磁盘真相）× 字幕态（covered/missing/
throttled/embedded/hardsub-assumed）。

- 布局（用户点选）：**A 融合格阵**为主视图（每季一格阵，一格一集：灰格+5px 语义点，
  TMDB-有-磁盘-无 = 虚线空格）+ 点格进 **C 逐集详情**（文件名/规格/字幕来源/停牌原因/
  recheck 时刻）。
- 剧集页头：海报 + 人话覆盖句 + tmdb id（mono）。
- 列表页：海报卡网格（Jellyfin 式）+ 覆盖率角标，筛选 chip（有缺口/停牌中/全覆盖）。

## 5. Workflow（工作流活动页）

- **桌面主视图 = 三泳道**（用户点选 A）：左=待处理事实（活文档行：缺口/停牌计数/
  nextRecheckAt；甄别计数入口）；中=主代理 pass 卡（时间线：读了什么→layout 核查→派发
  回执分布 created/revived/coalesced/blocked_dormant + summary——数据即 runs 表 orchestrate
  行）；右=worker 卡（在跑：目标范围、Inngest 式痕迹行[等宽工具名+右对齐耗时+在跑行蓝点]、
  installed n/m；已完成流）。**B 统一时间流**为移动端/次级形态。
- **痕迹通道 = C 方案**（用户拍板）：worker 运行中痕迹走内存环形缓冲 + SSE 直播；run 收官
  时完整痕迹压 JSON 快照挂 runs 行——直播实时、历史可回放、写入仅一次。中途崩溃丢直播段
  可接受（last_error 仍在）。
- run 详情右侧板：目标清单逐集结局、三桶报告原文、痕迹回放、Rerun 按钮
  （= dispatch + includeThrottled 的定点扳手，走确认）。

## 6. Triage（甄别）

现有 parked_paths/identify_overrides 的正式产品面 + 未来救援官战役的呈现层：
- 三箱：**待甄别**（含 agent 放弃理由）/ **已排除**（excluded-extra，可捞回）/ **已认领**。
- 人类动作：认领（现有 override 机制）、捞回、改名指引（README 最佳实践同文：
  `Title (Year)/Season NN/` 命名）。
- 本 tab 前端不等救援官后端：先展示现状（机械重试+人类认领），救援官落地后自然长出
  agent 判决列。

## 7. Settings（设置）

**两层存储（用户批准，含守备目录修订）**：
- **部署级（env，只读脱敏展示）**：provider keys、LLM 端点、dashboard 端口/token。
- **行为级（DB settings 表，可写即时生效）**：目标语言、硬字幕假定三档（off/agent/
  aggressive，默认 agent——设计依据：【组名】≠字幕组，Moozzi2/VCB 是压制组 RAW，机械假定
  会静默漏配；判断归 agent，姿态归用户）、特典排除开关、痕迹保留期、扫描间隔。
- **守备目录（media roots）= DB 表 + UI 目录浏览器**（用户裁决："照抄 Jellyfin 等巨人轮子，
  不自己发明"）：挂载=部署层（compose volume，UI 变不出）；守备目录=产品层（在已挂载文件
  系统内选，Jellyfin 同款分界）。加根→立即触发摄取；删根→AlertDialog 确认 + 清除该根下
  库行（磁盘不动）；roots 表带 `type` 列（现恒 local，为存储协议战役的 WebDAV 源预留）；
  env MEDIA_ROOTS 降级为首启种子值。守备目录=沙盒外边界，改动走确认流。

## 8. 后端补件（dashboard 战役的后端半场，先于前端）

1. **TMDB 应有集缓存表**：三层格阵第一层现在不落库（check_series_layout 临时查）——新表
   缓存季表/集号（含标题），带 TTL 刷新；虚线缺档格由它渲染。
2. **痕迹通道 C 实现**：agent 工具调用事件的内存环形缓冲 + SSE 端点 + finalize 时快照挂
   runs（新列或旁路 JSON）。
3. **Workflow 聚合 API**：三泳道各自形状（活文档行/orchestrate runs/在跑+近期 worker）。
4. **settings 表 + roots 表 + 列目录 API**（只许浏览容器可见路径）+ 行为项消费改造
   （targetLanguages 等从 env 读改为 settings 优先）。
5. **派发回执面**：pass 卡的 created/coalesced/blocked_dormant 分布——直接从 orchestrate
   run 的收官快照（补件 2 的 C 通道对 orchestrate pass 同样生效，快照里天然含全部 dispatch
   工具回执）解析，不另设事件表。

## 9. 立项登记（不入本战役）

- **救援官战役**（后端）：停车场事实入主代理活文档；识别救援 worker（目录上下文+ffprobe
  时长+TMDB 搜索，判得出写 override、拿不准留停车+人话理由）；特典三级排除（机械铁案
  NCOP/NCED/Menu/PV/CM/Trailer→excluded-extra 可稽核；灰区 SP/OVA 归 agent——实证依据：
  剧情级 OAD 有字幕专包[巨人 OAD1~8 实测]，纯映像特典无；判据=TMDB S0 条目或时长≥15min）；
  README 命名最佳实践。
- **重复源战役**（2026-07-16 傍晚讨论定稿）：照抄 Jellyfin 版本分组的形（绝不动文件，
  Sonarr 式淘汰出局）——新表 item_files 让副本升一等公民（ingest 不再 park 成
  duplicate-content），覆盖语义改逐文件（条目=全部文件各有着落，格阵显示分体态）；
  **传播=普通候选判断**（用户关键洞察：正常安装同样没有"轴已验证"，全系统的字幕都是
  按元数据指纹判断到最好——传播只是候选来自自家磁盘：同源指纹→复制改名零成本，异源→
  agent 按该副本 release 重搜或判"复制比没有强"，无需特殊心虚状态）。schema v13 级改动，
  独立小战役排 dashboard 后；dashboard 格阵按单文件模型先上线，item_files 落地后自然长出
  版本角标。远期可能性登记：音频对轴验证（ffsubsync 式"对轴官"）——另一物种，不排期。
- **鉴权立项（公开发布前置）**：抄 Sonarr/Radarr 单管理员模型（首跑设密码+表单登录+
  API key），不抄 Jellyfin 多用户（媒体服务器需求，对管理工具是伪需求）；现阶段
  DASHBOARD_TOKEN 够用。
- 维持搁置（用户 2026-07-16 再确认）：多语言覆盖（单语言先做完）、存储协议 v2（挂载层
  正经测试都还没做）、公开发布工程（还早）。
- 既有登记沿用：quota 呈报通道、登记册六节十条。

## 10. Non-goals

- 不做逐集手选字幕源/手动搜索面板（C 档干预，拒绝）。
- 不做 SSR/Next.js。
- Workflow 区不做本地化。
- 本战役不实现救援官后端（甄别页先呈现现状）。

## 附：讨论轨迹佐证

视觉伴侣 mockup 序列：media-library-3layer（A+C 点选）→ workflow-page（A 点选）→
full-design（方向 A 点选，执行被判"土"）→ full-design-v2（六台手术，方向过目）。
调研报告三份（本地 skills 盘点 / astryx+awesome-design-md+uibook / 六份 DESIGN.md 精髓+
Trigger.dev 源码 token+Inngest trace+Midday）存 session 任务输出。SP/OVA 字幕存量实测
（assrt/opensubtitles，5 查询谱系）结论已入第 9 节判据。
