# 战役 run-log:F1+F2 上线 + Astronaut live(2026-07-21)

## 授权
除推公开 GitHub 外:commit/部署/烧配额全自主。

## 心跳协议
opencode 官方 **无** 会话 timer。本战役用 `nohup` + `*.done` + 主控短轮询(2–5min)。

## Commits
- `f29d690` feat(translate): F2 jimaku + F1 批重试/超时
- `ff0d442` fix(extract): 内嵌抽轨默认超时 300s

## 时间线

| 时间 | 事件 |
|---|---|
| 21:27 | 1873 绿;commit F2+F1 |
| 21:30 | rsync + 生产 .env TRANSLATE_*/JIMAKU_* |
| 21:31 | docker build+up OK |
| 21:32 | identify_overrides tmdb:1086260;reconcile → movies 入库 missing |
| 21:33 | 首次 translate 误用 **mimo**(compose 未透传 TRANSLATE_*)→ kill |
| 21:34 | 补 docker-compose environment 透传;确认 TRANSLATE_MODEL |
| 21:35 | 再跑 → **extract-failed**(默认 30s 不够 4K 抽轨) |
| 21:40 | fix extract 300s;commit+热部署 |
| 21:42 | Astronaut translate 重开 opus |
| 21:56 | **sidecar 写出** 45KB / 764 cues |
| 22:12 | 进程写盘后挂起(undici/keep-alive 疑);kill;recheck → **already-covered** |
| 22:12 | movies.sub_status=**covered** |

## Astronaut 验收

| 项 | 结果 |
|---|---|
| 片源 | `/media/movies/The Astronaut (2025)/...YTS.MX].mkv` 4K ~4.3GB |
| 路径 | E 内嵌 subrip(非 F1 fetch) |
| 模型 | claude-opus-4-8 + critic 开 |
| 产出 | `....zh-Hans.srt` **764 cues / 45KB** |
| 库状态 | `tmdb:1086260` **covered** |
| 再跑 | `already-covered` ✓ |
| 抽验 | 对白通顺(「你醒了」「完全正常」…「回头见」);heavy_ascii≈0 |
| 尾轴 | 末 cue ~01:20(PGS 片长~01:29,可能片尾无对白/credits) |

## 真机逼出的修
1. compose 必须透传 TRANSLATE_* / JIMAKU_API_KEY(仅写 .env 不够)
2. extract 默认超时 30s→**300s**(4K 长片)
3. 写盘后 CLI 偶发不退出→记债(不挡 covered)

## 生产 compose 补丁(路由侧)
`docker-compose.yml` environment 增加 TRANSLATE_* / JIMAKU_*(bak:`docker-compose.yml.bak-pre-f2`)。公开仓 deploy.sh 不覆盖路由 compose——**勿 rsync 冲掉**。

## 未做 / 非目标
- 未 push 公开 GitHub
- 未做票数 tiebreak
- CLI 写盘后挂起根因未深挖(已 finally+exit 兜底)

## 战役 2:AI 翻译设置页开关(2026-07-21 晚)

**用户拍板**:AI 翻译=默认关、用户显式开的行为级开关(防 token 随无字幕媒体失控)。

| 项 | 结果 |
|---|---|
| `settings.ai_translate_enabled` | 新增(true/false,默认关),白名单+zod |
| daemon 门 | `TRANSLATE_* && ai_translate_enabled==='true'` 才派活;worker 端仍只认 env |
| 手动 CLI | 不受开关限制 |
| 设置页 | BehaviorSection Switch(中/英注记:默认关+需三件套+烧配额) |
| ja 优先 | runSearch ja 时 jimaku 排最前 |
| CLI 挂起 | db close 进 finally;打印结果后立即 exit |
| 测试 | 1877 passed + tsc + web 293 |
| commit | `e3988de`(未 push) |
| 部署 | media-router 已重 build+up,生产 `ai_translate_enabled=false` 落库 |
| 生产自动翻译 | **关闭**(开关未设/false;符合默认关) |

**注意**:dashboard API 当前 `setup required`(未建管理员),UI 验证待用户首登;开关写库路径已被 server/apiV2 单测覆盖。

## 战役 3:从零 live test(2026-07-21 23:15 起,过夜)

**目的**:清全部字幕+清库,弱模型(mimo)跑整夜暴露问题。

| 项 | 值 |
|---|---|
| 备份 | `/mnt/nvme0n1-4/backup/20260721-zerotest/`(subtitles-all.tar.gz 274 条 + scout.db.bak + .env.bak-pre-zerotest) |
| 字幕删除 | 274 → 0(.srt/.ass/.ssa/.sub/.vtt/.sup,Movies/TV/anime) |
| 库 | scout.db 清空重建(schema 自动迁移) |
| LLM_* | mimo-v2.5(未动) |
| TRANSLATE_* | **改指 mimo**(base/key=LLM 同,model=mimo-v2.5)——弱模型才能暴露问题 |
| ai_translate_enabled | **true**(测试期开启,让翻译腿参与) |
| 恢复路径 | 字幕 tar + scout.db.bak + .env.bak 三件套回滚 |

**起步确认(23:18)**:17 series / 231 episodes / 8 movies / 36 parked 已入库,daemon 15s tick 中。
**监控**:主控心跳轮询(nohup+done 不适用——这是 daemon 常驻;改为定期查库+logs 记此文件)。

## 从零 live test 终报(2026-07-22 11:30,~12h)

**队列排空:28 done + 4 failed(held 衰减中)。设计全链路验证通过。**

| 指标 | 值 |
|---|---|
| 字幕安装 | 259(subtitles 行) |
| episodes | covered=246 / embedded=150 / ignored=30 / **unavailable=4** |
| movies | covered=5 / embedded=4 |
| find-subtitle installed | 26 runs |
| translate:installed | 1(Adam's Sweet Agony S01E01,jimaku→mimo 过闸) |
| translate:held | 23 runs(4 条目反复 held) |
| parked | DxD×12(编号歧义,待人工)+ The Astronaut(ambiguous,新库 override 已随清库丢失) |

**4 个 unavailable = 4 个翻译衰减中的任务**(Adam's S01E06/07/08 + Witch Watch E02)。
held 衰减梯真机生效:job29 attempt=11 → 下次 07-25(3 天档);job30 attempt=4 → 07-23(1 天档)。

**mimo 弱模型实测(暴露问题目的达成)**:
- critic 抓到真错:メスゴリラ→"雄性大猩猩"(性别反)、大量日文原句未译、术语符合率 63.3%
- fail-closed 完美:23 次 held 全部**没有**脏字幕进库——弱模型不配过闸,系统拒绝安装
- 相位分隔正确:巡检清空后才切翻译车道;翻译期间 ingest 照常

**开关已复位**:ai_translate_enabled=false(测试结束即关,token 止损)。

**The Astronaut**:新库又被 park ambiguous(override 在旧库)。票数 tiebreak 仍留用户拍板,或手动 dashboard 认领。

**遗留**:恢复路径仍在 backup/20260721-zerotest/(当前新库状态更优,建议不恢复)。

## 战役 4:翻译加固部署证据(2026-07-22 22:52–22:59 CST)

- 本地 `e67e067`(含修复至 `0546f24`):`npm test` = **1918 passed / 1 skipped**(109 files passed / 1 skipped);`npm run check` exit 0、无诊断。
- 部署前:`subtitle-scout` running;SQLite `quick_check=ok`;`ai_translate_enabled=false`。
- 证据包:`/mnt/nvme0n1-4/backup/20260722-225216-task1-deploy/`;含 `VACUUM INTO` 一致快照(`scout.db.snapshot`,snapshot `quick_check=ok`)、近 24h 日志、jobs/runs 聚合、仅配置 key 名、部署日志与前后验收。
- 白名单 rsync 未下发生产 compose;其 SHA-256 部署前后均为 `2e71cf77aaa47d060be24789f513ee5a7fb11a1f05921929950e3b8ba9e5869a`。
- detached build marker exit 0;compose up exit 0;镜像 `sha256:5a22cf46f9efce742f559dc77e8ae3029d1bd6dfdbad890cce72bdbc5f5208dc`。
- 部署后:Compose `Up`,dashboard HTTP 200,restart count 0,SQLite `quick_check=ok`,`ai_translate_enabled=false`;两次观测均 `translate_running=0`,translate runs 保持 `count=24/max_id=73/last_started_at=1784695756355`,未启动失控翻译。
- 备注:镜像未定义 Docker healthcheck(`health=none`);以 Compose 运行态、HTTP 200、启动日志和 DB 体检联合验收。

## 战役 5:Task 1 部署审计阻断修复(2026-07-22 23:31–2026-07-23 00:36 CST)

- 部署机制修复:`deploy/deploy.sh` 现从 `git archive HEAD` 建立白名单 stage，包含 `web/package-lock.json`；stage 与生产受管源码均用 `rsync --delete` 精确同步，路由自治的 `.env` / `docker-compose.yml` 受保护且不覆盖、不删除。
- 串行/取证:路由侧 `mkdir` 原子锁 + trap 释放；每次只跑一条 detached runner，固定 `rollout.log` + `rollout.done`。部署前给旧镜像打时间戳 rollback tag，并保存源码 tar/manifest、Compose 前后 hash、镜像身份和运行态证据。
- 镜像身份:Dockerfile 接收 `IMAGE_REVISION` 并写 OCI `org.opencontainers.image.revision`；label 放在昂贵 APT/npm 层之后，revision 变化不再主动击穿依赖层缓存。
- 本地验证:`npm test` = **1921 passed / 1 skipped**(110 files passed / 1 skipped)；`npm run check` exit 0；focused deploy contract 3/3；外层 Bash 与内嵌 BusyBox/POSIX sh 均通过语法检查。
- 代码 commits:`94cb6e2`(精确同步/锁/回滚/身份)、`90ab383`(runner fail-closed)、`71a9dc9`(显式传播 build/up 状态 + 保留依赖缓存)。未 push。
- 路由 Compose 先备份，再且仅将 dashboard 映射从 all-interface 改为 `127.0.0.1:${DASHBOARD_PORT:-8099}:${DASHBOARD_PORT:-8099}`；归一化后与备份逐字节相同。SHA-256:`2e71cf77...` → `636220bd...`。
- 首次受锁 build 在旧容器仍运行、尚未执行 `compose up` 时因 revision label 位置导致 APT 缓存失效且下载极慢，人工 TERM；attempt marker=`1`、锁正常释放。修复缓存层和显式状态传播后才开始新 attempt，全程无重叠 compose；首轮日志/marker 一并保留。
- 成功 attempt:`20260723-003300-task1-remediation`，marker=`0`、锁释放；成功部署 revision `71a9dc959470197128c1d72668e11059a2fd5f39`。本地镜像内容 ID=`sha256:945c5ee2e4425d90f6f3dae02f10e524f7b909ed088a885814c97eb1cbf798fc`(本地 Compose build 无 registry RepoDigest)。
- 回滚:`subtitle-scout-rollback:20260723-003347` → `sha256:5a22cf46f9efce742f559dc77e8ae3029d1bd6dfdbad890cce72bdbc5f5208dc`。
- Dashboard 资格:容器/内核监听均仅 `127.0.0.1:8099`；路由 localhost HTTP 200；LAN peer `curl` exit 7 / HTTP 000；setup 仍返回 `setup required`，未创建账号/凭据。
- 数据资格:SQLite `quick_check=ok`；`ai_translate_enabled=false`；translate runs 部署前后均 `count=24 / max_id=73 / max_started_at=1784695756355`；translate jobs `count=5 / running=0`。
- 精确源码资格:archive 同时包含根/web lockfile，manifest 全量校验 `ok`；archive 对生产受管树 dry-run exact-sync=`clean`。
- 根权限证据:`/mnt/nvme0n1-4/backup/20260723-003300-task1-remediation-deploy/` 为 `0700 root:root`，证据文件均 `0600`；包含源 archive/manifest、两次 attempt log/marker、Compose 备份/哈希、rollback/current image、DB/settings/runs 和 dashboard bind 证据，无 secret value。

## 战役 6:Task 2 mimo-v2.5 资格矩阵(2026-07-23 10:39–11:53 CST)

**目的**:固定样本上用生产 `TRANSLATE_MODEL=mimo-v2.5` + critic 开，手动 `translate-item` 量测 EN/JA 路径与负例，**不**把 EN/JA 结论合并。

| 项 | 值 |
|---|---|
| 证据根 | `/mnt/nvme0n1-4/backup/20260723-101705-task2-mimo-qual/`(`0700`) |
| 模型 | `TRANSLATE_MODEL=mimo-v2.5`(容器 env 确认) |
| critic | 开 |
| `ai_translate_enabled` | **false**(全程未开;结束后仍 false) |
| CLI | `node /app/dist/cli/index.js translate-item "<path>"`(cache=`/cache`) |
| 跑法 | 删中文 sidecar → detached `docker exec`/`nohup` + log + `.done` 轮询 |

### 样本结果(分类只认 translate-item 日志,不认盘上 sidecar 来源)

| 样本 | 路径要点 | 预检 | 结果 | 分类 |
|---|---|---|---|---|
| **E-EN** Witch Watch E02 | Erai-raws MultiSub mkv | 1453.7s; eng ASS `CR_English` + 多语 ASS | `held` 术语 74.7%(74/99) cues=439 硬违规=1 | **HELD_MODEL_QUALITY** |
| **F1-EN** Peacemaker S01E01 | BluRay ARGUS | 2798s; 仅 PGS eng/chi | `held` critic(大量英文未译); 源 `opensubtitles:11144052`; 闸 pass cues=368 | **HELD_MODEL_QUALITY** |
| **F2-JA** Grieving Soul S01E23 | ToonsHub JPN WEB | 1430s; `origin_lang=ja` `embedded_langs=[]` | `no-source`(jimaku/外源无可用日文) | **NO_SOURCE** |
| **E-JA**(F2 回退) SPY×FAMILY S3E01 | NanakoRaws 4K | 1440s; jpn ASS+SRT 内嵌 | `held` critic(大量日文未译); 闸 pass 术语 100%(13/13) cues=491 | **HELD_MODEL_QUALITY** |
| **NEG** Adam E06 | NanDesuKa AMZN | 210s; 无内嵌 | `no-source`; 无 sidecar; 无模型翻译 | **NO_SOURCE** |
| **NEG** Overflow E01 | TV ver 01 | 210.09s(~3.5min); 无内嵌 | `held` critic(错译+未译+译名混); 源 `opensubtitles:11753599`; 闸 pass cues=295;**非** duration-mismatch | **HELD_MODEL_QUALITY** |

### 关键指标

- **E-EN**:内嵌英轨路径通; fail-closed 因术语闸(非 critic)。**未**由 translate 装盘。
- **F1-EN**:PGS 不可用 → 外抓英文源成功 → 全量译+critic → held。路径=F1 符合预期;质量=mimo 不够。
- **F2-JA**:真 F2 样本 `no-source`(无日文源)。按矩阵规则补跑 **E-JA**(内嵌日文抽轨→译→held),与 F2 分列。
- **NEG Adam**:标题校验/无源,早退,无烧翻译配额。
- **NEG Overflow**:本轮**未**触发 duration-mismatch;外源被接受并完成模型翻译后被 critic 拦下(`model_work=YES`)。与 postmortem「TV 3.5min vs 7min 错版」历史问题不同——本轮是质量 held,不是时长闸。

### 残留 / 干扰

1. **find-subtitle 竞态**:删中文 sidecar 后 daemon 将 ep 标 missing 并派 find,若干样本盘上重新出现 zh sidecar(OpenSubtitles/既有包),**不是** translate 安装(translate 全 held/no-source)。分类以 CLI 日志为准。
2. CLI stdout 在长跑中缓冲,需容器内 log 文件 + `.done` marker。
3. 结束后:`ai_translate_enabled=false`;无 `translate-item` 进程;jobs 无 running translate。

### 对模型策略的含义(不改代码,只记结论)

- mimo-v2.5 **不足以**作为 E/F1/E-JA 生产翻译模型:EN 术语/漏译、JA 大段未译,均被闸或 critic 正确 fail-closed。
- 管道(抽轨 / F1 外抓 / critic / 术语闸)行为符合设计;瓶颈在模型能力,非 PIPELINE_DEFECT。
- F2 jimaku 对本集无源 → 记 **NO_SOURCE**(样本/目录覆盖),不记模型能力。
- Overflow 时长闸仍是 postmortem 🔴 项;本轮负例未打到该闸(外源过了选源后在语义层失败)。

## 战役 7:翻译加固 RC + 二次差分资格(2026-07-23 15:21–16:29 CST)

### 加固与本地门禁

- `86fa1a1`:ASS/SSA override 在译后、闸前剥离;剥离后空 cue fail-closed。
- `710edb5`:源字幕最大 cue end / 视频时长不在 `[0.85,1.15]` 时,进入 LLM 前拒绝。
- `2e1ff2d`:未变化 parked path 按负缓存退避,不再每轮重探。
- `5e19637`:翻译尝试(含失败/critic/write-failed)记入 `runs.llm_calls`。
- `d177507`:F1/F2 外源逐候选做时长验收,错版候选继续试下一项;同时补最大 cue end 与写失败记账审计项。
- focused review:无 Critical/Important 发现。`npm run check`、`npm run build`、`git diff --check` 均通过;串行全量 **1958 passed / 1 skipped**。默认并行全量曾有 4 个无关 5s timeout;两个失败文件独跑全绿,串行全量全绿,根因归为本机 Vitest worker 资源争用,未改无关测试时限。

### RC 部署与迁移阻断修复

- 首轮部署 `d17750720bafcffd2b24ea7ef68c9649cb6df44b`;证据 `/mnt/nvme0n1-4/backup/20260723-152114-task7-rc-d177507-deploy/`;rollback `subtitle-scout-rollback:20260723-152140`。
- 生产旧库暴露 schema 漂移:`runs` 缺 `llm_calls/assrt_calls`,新 worker 写 run 会报 `no such column: llm_calls`;保持 `ai_translate_enabled=false`,未进入资格烧配额。
- `f332bb4` 增加条件式 v22 补偿迁移:旧 `runs` 原地 ADD 两列,新库/无 runs 的历史窄 fixture 幂等;迁移与 schema version 更新同事务。生产部署 revision `f332bb42224ca1daa151737fcd473c41b464bd30`;证据 `/mnt/nvme0n1-4/backup/20260723-155041-f332bb42224c-deploy/`;rollback `subtitle-scout-rollback:20260723-155119`。
- 部署后:SQLite `quick_check=ok`,schema `15`,`runs.llm_calls/assrt_calls` 均存在;容器 running/restart=0;dashboard 仅 `127.0.0.1:8099` 且 HTTP 200;`ai_translate_enabled=false`,running translate jobs=0。

### 二次差分资格:Overflow E01

证据:`/mnt/nvme0n1-4/backup/20260723-160500-task7b-overflow-qual/`(`0700`,文件 `0600`)。

| 项 | Task 2 控制 | 加固后复验 |
|---|---|---|
| 样本 | Overflow TV E01,视频 210.09s | 同一文件 |
| 外源 | `opensubtitles:11753599` 被接受 | 候选时长验收拒绝全部不匹配项 |
| 结果 | `held`,完整翻译+critic 后质量拒绝 | `no-source`,数秒退出 |
| 模型工作 | YES | **NO**(未进入 translate pipeline) |
| 落盘 | translate 未安装 | translate 未安装 |

- 为消除首轮 find-subtitle 竞态,短暂停生产容器;trap runner 在任意退出路径恢复 E01 既有 sidecar 并重启服务。
- sidecar 复原前后 SHA-256 同为 `0c6bf9f5dd4b840b751a4daf2cc641701731dff45d64dc84f474f8c7bb1f8702`。
- 命令 exit 1 是 `translate-item` 对 `no-source` 的预期退出语义;分类 **PASS**。
- Adam E06 与 Grieving Soul E23 在 Task 2 已于候选解析前 `no-source`;Peacemaker 的唯一新变量仍是已知 mimo 质量不足。三者不重复烧配额,二次矩阵只重跑能验证本轮行为变化的 Overflow 对照项。

### 终审补丁(时长闸 fail-closed)

- 终审 Important×2:`videoDurationSec=null` 曾 fail-open;`译后复用预检缓存` 可在路径替换后装错片。
- `eb343c0`:接上探针后 null/<=0 → held(`duration-unavailable`) / F1 no-source;写盘前强制重探;34 focused + 串行全量 **1960 passed / 1 skipped**。
- 部署 revision `eb343c082d9a0f4233e2718c13d59b65499b27b3`;证据 `/mnt/nvme0n1-4/backup/20260723-165847-eb343c082d9a-deploy/`;rollback `subtitle-scout-rollback:20260723-170018`。
- 终态:schema 15、`quick_check=ok`、`ai_translate_enabled=false`、running translate=0、dashboard `127.0.0.1:8099` HTTP 200。

## 战役 8:Translate Workspace Agent · P1(2026-07-23)

**规格**:`docs/design/2026-07-23-translate-workspace-agent-design.md`(全图 C,P1–P3 分期)。
**计划**:`docs/design/2026-07-23-translate-workspace-agent-p1.md`。

### P1 已交付(TDD,全量 1990 passed / 1 skipped,tsc+build 净)

| Commit | 内容 |
|---|---|
| `eeeb34f` | staging 路径 `.subtitle-translate/<jobId>/` + types |
| `d6e8ca3` | materialize 净文 / merge / **ja 永不 eng** resolveSource |
| `721cc69` | `translate-workspace` skill + `runWorkspaceTranslate` 工作台 runner |
| `458703e` | 14 个工作台工具 + task/report schemas |
| `e7f5de7` | `makeTranslateWorker` agent 入口(finalize-tool 循环) |
| `5a1fb72` | CLI `translate-item` 默认走 agent(库内定位;`--legacy`/`TRANSLATE_AGENT=off` 回退) |

### 关键行为(测试钉死)

- ja origin + 仅 eng 内嵌 → **no-source**,绝不英译;工具层 resolve_source 亦不写 canonical。
- agent 翻译 = 模型在工作台上读净文文档、冻结术语表、按行 `update_row` 写译文;最终 SRT **只**来自确定性 merge(canonical timing shells)。
- 工作台文件齐全:canonical / source_clean / terms.json(FROZEN) / bilingual / summary / out。
- 闸:空 tgt / 术语符合率 <85% / 时长(探针失败 fail-closed) → held,不装盘。
- 路径沙盒:`read_workspace_doc` 禁逃逸与 canonical 直读;`update_row` 禁改 src;`freeze_glossary` 一次性。

### 未做(分期明确)

- **P2**:wiki/权威 fetch 工具、critic 写 `critic.md`、reflect-refine。
- **P3**:daemon `translate` 分支切 agent(当前 daemon 仍 legacy `translateItem`,双门不变)、staging GC、runs.llm_calls 对齐。
- 真机/子代理验收(真 mimo + 工作台):接 CLI 后单独跑。

### 备注

- 手动 CLI 无库身份(文件不在库)时自动回退 legacy,日志明示——agent 单跳选源需要 origin_lang。
- 未 push;生产未部署(agent 未接 daemon,零生产行为变化)。

### 终审修复(2026-07-23,`7478fbf` + `c4be203`)

终审发现 1 Critical + 5 Important,全部修复并复评通过:

- **C1 闸强制**:gate pass 写 `work/GATE_PASS.json`(bilingual 内容 sha256);`update_row/update_rows` 后标记失效;`install_sidecar` 无有效标记一律拒绝——fail-closed 由代码强制,不依赖模型自觉。
- **I1**:空 origin_lang + en 内嵌 → 按 en 处理(legacy 对齐);无 en 轨仍诚实 no-source。
- **I2**:already-covered 短路(内嵌中文文本轨 / 既有中文 sidecar),不重复烧配额。
- **I3**:stepCap 默认 500;未 finalize(耗尽/abort) → held 报告,不再抛未捕获异常。
- **I4**:补 `write_workspace_doc`(限 context/work 下 .md)与 `get_row`;加 `update_rows` 批量写(全有或全无)。
- **I5**:删除并行非 agent runner(整集文本灌 glossary、无时长闸,与本战役目标相悖)。
- M 级:`.strict()` + src 守卫双保险;canonical 目录守卫大小写不敏感 + 目录读取拒绝;clean view 剥 `<font>/<i>` 样式标签。

复评:无 Critical/Important 遗留;串行全量 **1996 passed / 1 skipped**,tsc+build 净。

## 战役 9:Translate Workspace Agent · 本地真模型验收(2026-07-23 晚)

**协议**:本地零部署;fixtures=生产抽出的真实字幕轨 + 已知时长;install 落临时目录不碰生产。
脚本 `scripts/live-translate-agent.ts`;样本 `/var/folders/.../opencode/tw-live/`(含 RESEARCH.md)。

### 强模型轮(claude-opus-4-8):6/6 绿

| 样本 | 步数 | 结果 |
|---|---|---|
| WW no-source(ja+仅 eng 内嵌) | 2 | PASS,引用铁律拒英译 |
| Rig E-EN 120c | 21 | installed,术语 100%(富尔默/皮克特/先祖) |
| SPY JA 120c+同剧中字 ctx | 18 | installed,术语 100%(黄昏/阿尼亚/枭行动/东国) |
| SPY JA 全长 304c | 28 | installed,26 术语 100%,12.5min |
| Rig 400c | 23 | installed,46 术语 96.4% |
| covered 负例 | 3 | already-covered 短路 |

### 弱模型轮(mimo-v2.5):发现 1 真 bug,修后 5/5 绿

- **C1 级漏洞**:mimo 冻结的术语表 zh 照抄拉丁原文(Fulmer→"Fulmer"),术语闸虚 100%,拉丁名人混排译文装盘。
  根因=freeze 无中文校验。**修复(commit c0b16aa)**:freeze 拒非 CJK zh;`keepOriginal:true` 显式声明且不计符合率;skill 文案强制简中译名。
- **修后**:Rig 120c installed(法尔默→复跑富尔默,与官方一致);SPY 120c installed(fansub 级锚定);
  **SPY 全长 304c installed(53 步 8.4min,28 术语 100%,304/304,0 空行 0 假名残留)**;WW no-source PASS。
- 验收脚本接线 bug(covered 检查缺失)同轮修复。

### 核心结论

**同一 mimo,批灌=莫里希托式垃圾,工作台=fansub 级术语。** 净文文档 + CJK 冻结术语表 +
窗格写行 + 代码强制闸,让弱模型也产出可装盘译文。P1 逻辑本地真机跑通,循环退出(连续复跑零新问题)。

### 遗留(P2 关注)

- 《》屏幕字标记偶有不配对残留(闸不查,critic 层)
- 跨 job 术语 canonical 方差(东国/奥斯塔尼亚)——剧级术语持久化是 P2 需求证据
- 串行全量 **1997 passed / 1 skipped**;未 push 未部署(daemon 仍 legacy)
