# Subtitle Scout 当前状态与待办（权威入口）

**更新**: 2026-08-10（第 5.5 步完成）
**用途**: compact 后接续的单一入口。读完这份 + PIPELINE-SPEC.md 就能继续干活。
**配套**: `2026-08-08-PIPELINE-SPEC.md`（26 条用户裁决 + 23 条实现裁决 + 45 个缺口，权威 spec）

---

## 一、项目是什么

自动中文字幕下载器：扫描媒体库 → 识别资源 → 为缺字幕的资源找字幕 → 找不到就翻译 → 落盘。

三个 agent（识别 / 字幕 / 翻译）+ 纯机械的调度层。**数据库是状态机，磁盘是真源。**

---

## 二、进度：7 步里做完 6 步

```
第 1a 步  守备目录地界加固              ✅  4 task
第 1b 步  扫描删除清理 + 字幕存在性观察  ✅  5 task ← 用户最早点名的地基
第 2 步   daemonV2 接容器 + 运维器官     ✅
第 3 步   状态机改造                    ✅  4 task + 1 跨轨修复
第 4 步   翻译接回新架构                ✅  3 task
第 5 步   字幕 skill 两条边界            ✅  2 commit（prompt + 计数轨）
第 5.5 步 skill/工具一致性审计 + 干测压测 ✅  3 commit
第 7 步   清理死代码（A+B+C1 三批）      ✅  7 commit，净删 ~3600 行
第 6 步   115 改可写 + 单元式 live test   ⬜  ← 后端最后一步
第 8 步   前端全删重做                    ⬜  ← 用户裁决：并入下列三件事
          ├─ 4 个 builder 迁到 files/works（修海报墙冻结快照）
          ├─ 删 jobs 生产者 + redispatch 假按钮
          └─ 之后四张旧表才真正无活读者，那时才轮到删表
```

**测试**: 2984 条 / 7 失败（全是接手前的既有债务）/ tsc 干净 / 零新增回归

⚠️ **第 6 步的硬约束**：dashboard 现在显示的不是真相（见 §八 第 1 条），
所以 live test **不许拿界面当验收依据**——必须直接查 DB 与磁盘上的字幕文件。

---

## 三、第 5.5 步做了什么（最近一批，compact 前刚完成）

### ① 删 orchestrator 及其旧架构（14 个文件）
用户从未同意过这个 agent，它的依赖面全是旧表（`missingBySeason`/`listParkedPaths`/`jobs`），
新架构的 files/works 一个都不碰——活代码接死架构。

连带删掉：`reconcileAll`、CLI 的 `reconcile-all` 命令、dashboard 的
`POST /api/v2/reconcile-all` 端点。**dashboard 上那个按钮现在会 404**，
用户已确认可接受（前端反正要重做）。

### ② 删冗余工具 2 个 + 补 prompt 缺口 5 处
- 删 `get_row`（被 `get_window` 完全覆盖）、`write_workspace_doc`（`context/` 是系统写的，agent 只读）
- 字幕 skill 补：`check_episode_code_safety` + 三个参数（`candidateId`/`stagedFileId`/`langTag`）
- 翻译 skill 补：`fetch_tmdb_context`、`fetch_series_target_subs`、`list_rows`、`run_critic`

审计发现的关键事实：**`list_rows` 原本被我判为"冗余"，实际是必需的入口工具**——
`get_window` 必须给中心行 ID 才能读，agent 开局手上没有任何 ID。方向正好相反。

### ③ 干测压测 26 项全绿（真实 LLM + 工具桩化，磁盘零写入）
mimo-v2.5（弱）vs mimo-v2.5-pro（强）双模型对比。

字幕 agent 8 场景：限流误判 / 只有 pack / **Peacemaker 同名陷阱** / 首搜空 /
绝对集号 / 结构可疑 / 跨季同名 / 混语言包 → 16 项全绿
翻译 agent 5 场景：正常流程 / **闸门修复循环** / **日漫无日文源** /
已有字幕 / 装盘闸门 → 10 项全绿

**最有说服力的三条**：
- Peacemaker 陷阱守住了（真实事故：当初装错全部 8 集）。两个模型都重搜 4-6 次
  试 `DC Peacemaker`/`和平使者`/`John Cena`/`HBO Max`，只在确实找不到后才放弃
- R18 禁令被读进去了：日漫无日文源时第 1 步就收工，pro 的理由明写
  `English relay is forbidden per playbook`
- 修复循环干净：gate 报"Pictor 应为皮克托，错在 cue 2/4" → `lookup_glossary`
  查权威译名（不凭记忆）→ 只改被点名的两行 → 重跑 → PASS，没有直接 held

**弱模型没有暴露 skill 的模糊处**——两个模型判断质量没有实质差距，只是风格不同
（pro 爱写详细 reason，v2.5 爱多跑几次搜索）。

---

## 四、⚠️ 我在第 5.5 步犯的三个错（教训，别再犯）

### ① 误判了一个回归的归属（最严重）
我断言那 4 个 dashboard 失败"与 orchestrator 删除无关"——**错的**。
用 `git checkout 532f82e~1` 实测才发现：删除前 `server.test.ts` 是 **0 失败**，
删除后变 4 失败，是我造成的回归。

根因：删 `reconcileAll` 位置参数时 `startSub` 少减了一个 `undefined`，
`stubDeps()` 从第 7 位（`subtitleWriteDeps`）落到第 8 位（`subtitleCompareDeps`），
于是 correct/revert 接了真实模块去读真磁盘 → 409/400 而非 200。

**教训：「看起来不相关」不等于不相关，必须用 git 实测对比。**

### ② 桩不像真实工具 → 测出的是测试自己的 bug
S2（只有 pack）首轮判 agent 失败。实际是我的桩假装"整包下载就是那一集"，
跳过了真实工具的二段式选集（`fileIndex` 为空 + 多条目包 → 返回 `archiveEntries`
让 agent 二次选集，见 `assrtAdapter.ts:58`「宁停不猜，silent 装错比留缺口更糟」）。
桩补上这段后两个模型都走了正确的二段式。**我差点据此去改一份没问题的 prompt。**

### ③ 测试 schema 与生产不一致 → 结论完全反了
S6（结构可疑）判 pro 不如弱模型。实际是生产的 `FindSubtitleBatchReportSchema`
三桶是 `{itemId, reason}` 对象数组，我写成了 `string[]`：pro 按生产格式输出被拦下
判为失败，而弱模型凑巧写字符串反而"通过"。pro 的理由其实写得更好。

---

## 五、核心数据模型

```
files 表（机械扫描产出，每行一个媒体文件）：
  path / dir / filename / size / mtime / duration_sec / embedded_langs / audio_langs
  work_dir / season / episode / parse_confidence
  work_id（NULL=未识别 / 'tmdb:<id>'=已识别）
  needs_subtitle（原则上是否需要中文字幕，语言事实，装盘不改它）
  sub_status（NULL / covered / handoff_translate / unsolvable，**只有扫描能写 covered**）
  sub_attempt（NOT NULL DEFAULT 0，满 7 次移交翻译）
  sub_retry_streak（连续 retry_later 计数，满 3 折算一次 sub_attempt）
  translatable（NULL=暂不可判 / 0=不可救 / 1=可救）
  recheck_after / sub_recheck_at / tr_attempt / tr_recheck_after / last_error

works 表（识别 agent 产出，每行一个作品）：
  id（tmdb:<id>）/ title / original_title / year / media_type / origin_lang
  overview / poster_path / chinese_titles / provider_ids（含 imdb）

media_roots：守备目录（禁嵌套，addRoot 是闸门）
```

**跨轨共用列的隔离约定**（踩过三次）：
- `last_error` 三方共用 → 各轨加前缀（`sub:` / `probe:` / 识别轨的 `tmdb-404` 是终态凭据）
- `attempt`（识别）vs `sub_attempt`（字幕）vs `tr_attempt`（翻译）→ 一列一主
- `recheck_after` 三方共用，今天靠 `sub_status` 白名单**隐式**隔离（无显式机制，遗留项）

---

## 六、环境

- 软路由：192.168.100.1（SSH root，密码见密码管理器，不入库）。公司环境走 cf tunnel
- 容器：subtitle-scout（ghcr.io/fancydirty/subtitle-scout:latest）
- 测试目录：115 网盘 Mediary Scout（83 作品，Jellyfin 约定，**目前只读**）
- 生产媒体：nas_media（用户裁决：不再当测试目录用）
- LLM（干测用）：`LLM_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1`，
  key 在 `~/projects/token.txt` 的 `XIAOMI_API_KEY`，模型 `mimo-v2.5` / `mimo-v2.5-pro`
  ⚠️ 端点是 `token-plan-sgp.xiaomimimo.com`（不是 xiaomitoken.com，我一开始搞错过）

---

## 七、第 7 步已完成（A+B+C1 三批，7 commit，净删 ~3600 行）

**做法**：静态可达性分析（从 `cli/index.ts` 爬 import 图）定位候选 → 用户过一眼 →
subagent 分批实施 + 每批两阶段审查（spec 合规 → 代码质量）→ 每批 git 实测对比失败集。

- **A 组**：删 7 个不可达整文件（dispatcher / 4 个 *Command / watchV2 /
  extractEpisodeStructure）+ orchestrate 兜底心跳残留。顺手根治两条遗留项——
  `scanCommand` 是 C42 第二扇侧门、`watchV2` 是漏接 4 器官的旁路入口，
  它们之所以是漂移源正因为是无人调用的第二份实现
- **B 组**：删 `daemon.ts`（504 行）。`ScoutDaemon` 自第 2 步起零构造；
  `DaemonDeps` 15 字段里 daemonV2 只消费 4 个，已内联进 `buildDaemonV2Deps`，
  4 处 `!` 非空断言随之消失。**顺带修了 `lastScanAt` 恒 null 的功能退化**（见 §四）
- **C1 组**：删 `agent/identityTools.ts`——三张旧表最后的 INSERT 通道。
  删掉它，「旧表不再新增行」从注释变成**结构性保证**（生产代码零调用方）。
  另删 `listTranslateCandidates`（查旧表 + 谓词被 v33 洗掉，双重死亡）、
  `hasActiveRealignWorkerTask`（零调用者）

**⛔ 明确没做**：四张旧表本身不能删。dashboard 海报墙与详情页仍在读它们，
接着活的 HTTP 端点和 15 秒轮询的 React 组件。删表是功能迁移不是清理。

**删表的正确路径（用户已裁决并入前端重做）**：
前端重做时把 4 个 builder 迁到 `files`/`works` + 删 jobs 生产者与假按钮
→ 那时四张旧表才真正无活读者 → 才轮到删表。
删表时选「删代码 + DROP TABLE 迁移」而非只删代码：数据可从磁盘完全重建
（`db.ts` 开头就写了「DB 只是索引」），留个空 schema 只会让未来的人再考据一遍。
注意两个坑：`episodes.series_id` 有外键指向 `series`，得先删 episodes；
且要放在既有的 `foreign_keys=OFF` 迁移窗口内。

**过程中我犯的错**：验收命令写错了——我让 subagent 确认「三张旧表再无 INSERT」
且断言「应该为空」，但我的 grep 排除了调用方却没排除**方法体所在文件**，
只要 `libraryRepo.ts` 里三个方法体还在就不可能为空。正确的保证是「生产代码零调用方」。
subagent 纠正了我。

---

## 八、遗留项

### 🔴 第 7 步探查暴露的三条（都不是第 7 步造成的，但都是它查出来的）

> **用户裁决（2026-08-10）：第 1、2 条并入前端重做，现在不单独修。**
> 理由：前端要全删重做，那 4 个 builder 与 redispatch 端点反正要重写，
> 现在改一遍、重做时再改一遍是白费功。
>
> ⚠️ **但这条裁决对第 6 步有一个硬约束**：dashboard 现在显示的不是真相，
> 所以 live test **不许拿界面当验收依据**——必须直接查 DB（`files`/`works` 表）
> 和磁盘上的字幕文件。否则界面这个老毛病会跟新 bug 混在一起，分不清根因。

**1. 海报墙显示的是旧表冻结快照 —— 已裁决并入前端重做**

`buildLibrary` 读 `series`/`episodes`/`movies`；V2 识别（`identifyScheduler.writeIdentified`）
只写 `files`/`works`。**两者之间没有数据迁移，也没有双写。**
所以自第 2 步切入口起，所有新获取的内容在 UI 上都不可见——海报墙展示的是
迁移前那个库的冻结快照，还会随 ingest 删除消失文件的行而缓慢衰减。

**前端重做时要做的**：把 4 个 builder（`buildLibrary` / `buildSeriesDetail` /
`buildLibrarySeriesDetail` / `buildLibraryMovieDetail`）迁到 `files`/`works`。
迁完之后，四张旧表才真正没有活读者，那时才轮到删表（见 §七 的分批路径）。

**2. jobs 队列只剩生产者没有消费者 —— 已裁决并入前端重做**

`claimNext()` 生产零调用点（第 2 步切入口那刻就死了）。后果：
- dashboard 的 redispatch 按钮返回 200 + 一个四态回执 DTO，**但那行永远不会被执行**
- `ingestTrigger` 每个 changed pass 还打一行 `orchestrator pass enqueued` 的**假日志**
- 活动页的「已进行 N 秒」秒表永远显示没有任务在跑
- `hasActiveRealignWorkerTask` 的 ingest/realign 互斥门无生效路径

活着的生产者两个：`ingestTrigger`（有 identity-dedup 兜底，卡成一行不会无限增长）、
dashboard redispatch。

**前端重做时的取向**：删生产者 + 那个按钮，**不要**给 jobs 接消费者——
接消费者等于把刚清理掉的旧队列机制again接回来，与日巡检模型（R4：工作台有活跑到空）
是两套调度哲学。新架构要重派一件活，正确做法是清对应行的状态列让下次巡检自然捞到，
而不是往 jobs 表塞待办。

**3. `last_verify_sweep_at` 只有读者没有写者**

与 B 组修掉的 `last_ingest_at` **完全同型**。`apiV2.ts` 读它渲染「字幕校验巡检」
新鲜度，但全仓无写入者——`runVerifySweep` 被 import 但从未调用，成因是
2026-08-07「巡检注入本轮雪藏」（用户拍板的产品决策）。
界面上「字幕校验巡检」永远显示没跑过。已在注释里写明事实，恢复注入是产品决策。

### 其他

| 项 | 说明 |
|---|---|
| **翻译工作台 GC 炸弹** | 翻译循环没把 jobId 登记进 `gcStaging` 的 in-flight 集合（字幕流有）。根因是翻译 jobId 是 `daemon-${Date.now()}`，每次不同、循环层无法预知。跑几小时的工作台唯一保护是 mtime 活性窗口。`translateItemId` 已提供稳定身份可作派生源 |
| `server.test.ts` flake | 全套件并行下偶发失败（~1/10，`port: 0` + undici 全局态），单独跑 120/120 稳定绿。会污染「失败必须是同样 7 条」的验收口径，值得单独定位 |
| `recheck_after` 隐式隔离 | 三方共用靠 `sub_status` 白名单，没有 `last_error` 那样的显式前缀机制 |
| probe 失败重试通路 | 隐式靠 D17 回填 pass，没有独立记账 |
| 命名事故 | `recheck_after`（重试调度）vs `sub_recheck_at`（事实复核）语义近但含义完全不同 |
| `db.test.ts` 14 处版本号字面量 | 每加一条迁移就要手改 14 行，应写成 `String(MIGRATIONS.length)` |
| 注释硬写行号会腐烂 | 第 7 步实测：`cli/index.ts` 有条注释写 `daemon.ts:327`，删 39 行后指到了另一个函数里。已改成引符号名（重构时工具会带着走）。仓内还有 `watchWiring.ts:7` 等同类实例 |
| `--noUnusedLocals` 下 7 处孤儿 | `cli/index.ts` 的 `verifyAndRecord`/`runVerifySweep`/`verifyRepo`（verifySweep 雪藏，**有意保留**）+ `ReconcileAllResultDTO`/`requireEnv`/`targetLanguages`（疑似真死）+ `handleWorkerTask` |
| `identifyMediaSkill` 教模型调未挂载工具 | 文档仍写 `write_identified_media`，而活路径（daemonV2 字幕 worker）从不传 `identityDeps`。模型会去试、被拒、把失败写进 reason |
| 既有 7 红 | deployContract 3（部署脚本换了测试没跟上）/ buildAdapters 2（zimuku）/ secrets 1 + settingsRepo 1（SECRET_NAMES 从 12 涨到 15） |

---

## 九、翻译的诚实边界

**管道全程接通、每个接缝都有断言，但真正产出字幕的那一段
（`resolveTranslateSource` → workspace agent → `writeSidecarAtomic`）
从未在任何环境跑过。** 干测验的是 agent 的决策流程（桩返回假数据），
不是真实的抽轨/翻译/写盘。这与 spec 第 6 步"翻译单元最后修最后测"一致，
但别把"26 项全绿"读成"翻译能出片"。

另外 MVP 边界（R20）：外挂抓取仅 en；内嵌轨抽取 en/ja 皆可。
日漫无日文内嵌轨时走 jimaku，而 **jimaku 尚未落地**（C6），所以那类会直接 no-source。

---

## 十、干测怎么跑（compact 后要用）

```bash
export LLM_API_KEY="$(grep XIAOMI_API_KEY ~/projects/token.txt | cut -d= -f2)"
export LLM_BASE_URL="https://token-plan-sgp.xiaomimimo.com/v1"

# 字幕 agent（8 场景 × 2 模型）
npx vitest run src/agent/dryRun.test.ts -t 'S3'          # 单场景
# 翻译 agent（5 场景 × 2 模型）
npx vitest run src/agent/dryRunTranslate.test.ts -t 'T2'

# 无 key 时自动 skip，不会红
```

单场景约 30-110 秒。全跑一遍两个文件约 20 分钟（26 项 × 双模型）。
