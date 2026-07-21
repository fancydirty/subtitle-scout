# 交接文档 → opencode(2026-07-21 16:30)

> 你(opencode)接手 subtitle-scout。本文档是唯一权威接续点:当前状态、在排任务、铁律、工程惯例、生产环境全在这。读完本文 + 引用的设计文档就能开工,不需要问用户"从哪开始"。

## 一、项目一句话

守备目录内媒体的中文字幕自动猎手(类 Jellyfin 巡检逻辑):多源搜索(assrt/opensubtitles/zimuku/subhd/动漫源)→ agent 甄别安装 → 兜底 AI 翻译。SQLite 状态机 + daemon 派活 + dashboard。TypeScript,vitest,全 TDD。

## 二、当前状态(全部完成、全绿)

- **测试基线:1849 passed | 1 skipped,tsc 零错**。任何改动后必须保持 ≥ 此基线,这是硬验收线。
- **E(AI 翻译·内嵌轨腿)**:✅ 完成+真机验收+已部署生产。The Rig S2E01 真中文字幕(941 cue,opus 译,术语 95.7%)已在库并被记 covered。设计+发现:`docs/design/2026-07-21-e-implementation-and-findings.md`
- **F1(AI 翻译·源语言外挂腿)**:✅ 代码完成(commit 5c757c3),**未真机验收、未部署**——这是你的第一件事,见下节。设计:`docs/design/2026-07-21-f1-source-lang-fetch-translate-design.md`
- **生产**:软路由 docker(`ssh media-router-tunnel`,容器 subtitle-scout),运行 14:35 的镜像(含 E 全部+daemon 自动触发,**不含 F1**)。自动翻译处于休眠:服务器 .env **没配** TRANSLATE_*(用户没拍板启用,别擅自配)。

## 三、在排任务(按优先级)

### 1. F1 真机验收(下一步,用户已批功能本身)
- 本地全绿只证逻辑,fetch 腿没打过真网。验收路径:找一个 unavailable+零内嵌+origin_lang=en 的项(生产库当前没有现成的——The Rig S2E06 有内嵌轨走不到 fetch 腿),可本地造:mkvmerge 剥掉某英剧集的内嵌字幕轨得到零轨样本,入本地库后跑 `subtitle-scout translate-item <该文件>`(需 .env 有 TRANSLATE_*,本机 .env 已有,模型走 opencode company 端点的 claude-opus-4-5,**重 LLM 活优先用该端点,省用户 Anthropic 账号配额——这是用户铁律**)。
- 验收标准不只 gate pass:**人肉抽验中文通顺度/语义准确/术语一致**(用户方法论:测试才是最花时间最出改动的环节,别糊弄)。E 验收的批判性复核范式见 e-implementation 文档"生产字幕批判性复核"节。
- 过了再 rsync+部署(流程见下"生产部署")。

### 2. F2:jimaku.cc 日文字幕源(用户已点名要做)
- 动机:动漫日文字幕现有源全无(实测 Frieren ja=0),jimaku.cc 是日字专门站(有 API)。新写 provider adapter(参考 `src/adapters/providers/` 现有各家 + `src/cli/buildAdapters.ts` 注册模式,env 门控如 `JIMAKU_API_KEY`)。
- 同批:translate prompt 的"英文"字样参数化为源语言名(`src/translate/translateLm.ts:70,82,89` + `translateCritic.ts:37`),`SUPPORTED_SOURCE_LANGS` 加 'ja'(在 `src/v2/translateWorkerTask.ts`,测试锁死了这个常量,改时同步改测试——那是故意的中继防线)。
- **铁原则(用户拍板,写进 F1 spec):只做"源语言→中文"单跳直译,永不英语中继**——用户见过 JP→EN→CN 的灾难翻译。日漫在 F2 前保持 no-source 是正确行为不是 bug。

### 3. 留用户评审的(别擅自做)
- critic reflect-refine(逐句精修替代整档 held)——架构级,E 文档"剩余"节有记录。
- 标签冻结(strip→translate→reinsert)——phase-2。
- 服务器启用自动翻译(配 TRANSLATE_* 三件套)——用户的配额开关。

## 四、铁律(用户设的,违反=严重违规)

1. **TDD 铁律**:先失败测试→亲眼看它红→最小实现→绿。全量必须 ≥1849 绿 + tsc 净才算完。
2. **fail-closed**:质量闸不过绝不装字幕(宁可 held/no-source,不脏库)。
3. **圣文件**:`src/v2/realign*`/`src/files/realignManifest.ts` 等 realign 五重安全层,动前必须用户批准。
4. **翻译模型门控**:daemon 自动路径只认显式 TRANSLATE_* 三件套,**绝不回退 LLM_\*(=mimo,captcha 专用弱模型)烧配额**。
5. **重 LLM 活优先 opencode company 端点**(本机 .env 的 TRANSLATE_* 已指向),省用户 Anthropic 账号配额;配额将尽要主动提醒用户。
6. **别擅删用户设的任何东西**;推公开仓(github.com/fancydirty/subtitle-scout)必须当次明确说明并获准。
7. **别停摆**:能自己做的别问,别拿开放问题堆用户,净赚的小事直接做;但外发/花钱/不可逆的事必须先问。
8. 原 Claude 会话有个 15 分钟心跳 cron——那是会话级的,随旧会话结束自动消失,你不用管。

## 五、工程惯例与坑(实战踩出来的)

- 测试:`npx vitest run <file>`(**绝不用 watch**);内存库 `openDb(':memory:')`;jobs 状态词汇是 `wanted/searching/downloading/verifying/done/failed/dormant`(**没有 'active'**,claim 后是 searching);completeDone/Error 只对已 claim 行生效;series 表**无 updated_at 列**。
- worker 模式:新 taskType 照 `src/v2/rescueWorkerTask.ts` 形状(claims-and-runs + runs 记录 + completeXxx);路由在 `src/cli/index.ts` handleWorkerTask;派活幂等靠 upsertWorkerTask 的 (kind,series,season,movie,taskType) identity,按 item 去重用合成 seriesId(如 `translate:<itemId>`)。
- **生产部署**:`rsync`(白名单 src/package/tsconfig/Dockerfile/web)→ `ssh media-router-tunnel 'cd /mnt/nvme0n1-4/docker/subtitle-scout && docker compose build && docker compose up -d'`。**build 必须 nohup 后台化+落 done 标记轮询**(前台 ssh 会超时);软路由是 **busybox:`ps aux` 是假的**(看不到进程≠没跑,用 `ls /proc/*/cmdline` 验证)——这个坑导致过重复起进程白烧配额。
- 生产库只读查询:写 js 到 `/mnt/nvme0n1-4/docker/subtitle-scout/cache/` 再 `docker exec subtitle-scout node /cache/x.js`,require 用绝对路径 `/app/node_modules/better-sqlite3`。
- OS 搜索免配额、下载耗配额(F1 已限 3 候选);兜底搜索必须带 imdb id(文本 query 有假阴性)。
- 负缓存:手动 run-item 命中负缓存会短路,先清再跑。

## 六、关键文件地图(F 功能相关)

| 文件 | 职责 |
|---|---|
| `src/translate/translateItem.ts` | 端到端编排(双腿获取→管道→写盘),纯逻辑全注入 |
| `src/translate/translatePipeline.ts` | 术语表→分批翻译→确定性闸→critic,fail-closed |
| `src/translate/translateLm.ts` / `translateCritic.ts` | 真 LM 实现 / LLM-judge(F2 要参数化源语言) |
| `src/cli/fetchSourceSub.ts` | F1 fetch 腿(locate→搜→下载→解包→parse 闸) |
| `src/v2/translateWorkerTask.ts` | 候选判定(SUPPORTED_SOURCE_LANGS 在此)+派活+worker |
| `src/cli/translateItemCommand.ts` | 手动 CLI + makeTranslateItemDeps(daemon 共用) |
| `src/cli/index.ts` | handleWorkerTask 路由 + daemonDeps.dispatchTranslate 门控 |
| `docs/design/2026-07-20-overnight-run-log.md` | 战役总日志(历史接续点,已指向本文档) |

## 七、产品愿景(背景,影响优先级判断)

用户野心:不止 sidecar 工具,是 agent 驱动的 Bazarr 替代品,最终"哪怕源文件零字幕数据都有办法"(E+F1+F2 兜底链就是这个故事的落地)。开源仓已发 v0.1.0,README 产品化+CF Pages 宣传页在 backlog(别走 Vercel)。
