# Subtitle Scout 当前状态与待办（权威入口）

**更新**: 2026-08-11（后端全完成；前端设计过四轮审计，待实施）
**用途**: compact 后接续的**单一入口**。先读 §二·五「compact 后从这里开始」。
**配套**:
- `2026-08-08-PIPELINE-SPEC.md` — 后端权威 spec（R1–R26 / D1–D23 / C1–C47）
- `2026-08-11-FRONTEND-SPEC.md` — 前端用户裁决（R-F1~R-F15）
- `2026-08-11-FRONTEND-IMPL-DESIGN.md` — **前端施工图**（v5，四轮审计）
- `DESIGN.md`（项目根）— Linear 视觉基准

---

## 一、项目是什么

自动中文字幕下载器：扫描媒体库 → 识别资源 → 为缺字幕的资源找字幕 → 找不到就翻译 → 落盘。

三个 agent（识别 / 字幕 / 翻译）+ 纯机械的调度层。**数据库是状态机，磁盘是真源。**

---

## 二、进度：第 8 步已完成，正在收尾

```
第 1a-7 步   ✅ 后端重构 + live test + 清理死代码
第 8 步      ✅ **前端全删重做**（12 task，2026-08-12 完成并部署）
收尾轮       🔄 T1-T6，见 `2026-08-13-WRAPUP-PLAN.md` ← **当前在这里**
```

### ⚠️ 验收只用一条命令（这条最重要）

```bash
npm run verify
```

四条判据缺一即失败：① 退出码 0 ② `numFailedTests === 0`
③ **每个 `testResults[].status === 'passed'`** ④ 文件数 >= 基线。

**不许再手敲 `npx vitest ... | node -e "numFailedTests"` 那套口径**——
它对**空 describe** 完全免疫。2026-08-13 栽过一次：commit message 写
「146 文件 / 3272 用例 / 0 失败」**字面为真**，而 vitest **退出码是 1**
（删除脚本把两个 `describe` 掏空只剩壳）。`scripts/verify.mjs` 就是为堵这个洞建的。

**当前基线**：后端 146 文件 / 3284 用例；前端 84 文件 / 975 用例。

---

## 二·五、compact 后从这里开始

**读这三份**：
| 文档 | 作用 |
|---|---|
| `2026-08-13-WRAPUP-PLAN.md` | **当前施工图**：T1-T6 + 通用底座 + 变异验证的十个陷阱 |
| `2026-08-11-FRONTEND-IMPL-PLAN.md` | 前端 12 task 的完整记录与滚动债务清单 |
| `DESIGN.md`（项目根） | Linear 视觉基准 |

**执行模式**（用户明确要求）：每 task 由 subagent **TDD 实现**
（先写红测试 → 实现 → 变异验证）→ **另起 subagent 对抗审计** → 我裁决 → commit。

### 生产环境

```
公司  ssh media-router-wan     家里  ssh media-router
⚠️ GitHub 曾持续 500 → 已加 router remote 可直推：
   git push router HEAD:main   （软路由已设 receive.denyCurrentBranch=updateInstead）
部署  cd /mnt/nvme0n1-4/docker/subtitle-scout
      docker build -t ghcr.io/fancydirty/subtitle-scout:latest .   ← tag 必须是这个全限定名
      docker compose up -d --force-recreate
⚠️ **部署后必须核对镜像 ID**：踩过一次 tag 不匹配，容器 healthy 但跑的是 25 小时前的旧镜像
apiKey  52720d9a83fb9a74eed14c50ed58e1e2
库      容器内 /cache/scout.db（不是 /data/cache）
```

### 115 挂载的排障（踩过一次，手册在机器上）

`/mnt/nvme0n1-4/docker/openlist/MOUNT-RUNBOOK.md`。要点：
**排障从 `rclone lsd Openlist:` 开始**——进程在、挂载点在、openlist HTTP 200
这四个信号在密码失效时**全部正常**，只有那条命令会报 401。
admin 密码在容器内 `/opt/openlist/data/.creds/openlist-admin.txt`。

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

## 六·五、第 6 步 live test 实录（2026-08-10 夜）

**环境**：115 触发风控后改用 NAS（CIFS，稳定、支持硬链接）。测试库
`/mnt/nvme0n1-4/nas_media/_scout_live_test/{Movies,TV,Anime}`，
61 个视频硬链自 NAS 全库（零额外空间），Jellyfin 形状、作品名清洗过、初始零字幕。
含 spec 点名的 Peacemaker（当年装错 8 集的事故案例）。

⚠️ **CI 已不可用**（GitHub Actions 账单额度耗尽），改为在软路由上 `docker build` 直出镜像。
⚠️ **LLM 换端点**：DeepSeek 余额耗尽（`sub:AI_APICallError: Insufficient Balance`），
   改用小米 mimo（`token-plan-sgp.xiaomimimo.com`，key 在 `~/projects/token.txt`）。

### 已验证通过的单元

| 单元 | 结果 |
|---|---|
| 1 扫描 | `scanned=61 upserted=61 skipped=0`，与建库计数精确一致 |
| 1 probe | `probe wrote=61 unavailable=0 failed=0`；实测到 36 语言多轨文件与 `[]` 零轨，三态语义正确 |
| 2 识别 | 9/9 作品、61/61 文件全绑定，零失败；`origin_lang` 全对（ja/de/en）；Peacemaker→tmdb:110492 是正确的 DC 剧 |
| 2.5 judge | `判定 61 个文件——44 需字幕 / 17 跳过`；规则 2 正确排除 17 个带 `chi` 内嵌轨的文件 |
| 3 字幕流 | 35 个字幕装盘成功（Peacemaker 8/8、IT Welcome to Derry 7/7 等） |
| **R24 闭环** | `A档=0 B档=61` → `covered=35`，**精确等于磁盘上的 35 个字幕**；`sub_recheck_at` 全部推回未来（哨兵自清除）；`35 covered + 9 待找 + 17 不需要 = 61` |
| 4 日巡检 | `巡检完成，歇着等明天` —— 日巡检模型（阶段 4）按设计收工 |

### 抓到并修掉的 4 个真实缺陷

**① `FFPROBE_PATH` 空串致探针全静默失效**（`a226c0b`）——最严重的一个。
`docker-compose.yml` 的 `${FFPROBE_PATH:-}` 把变量设成**空串**（不是"不设置"），覆盖了
Dockerfile 里正确的 `ENV`；而代码用 `??` 解析，空串是合法值 → `execFile("")` 抛错 →
被 `catch` 吞成 null → 61 个文件三列全 NULL，日志却报 `probe ok=61`。
四层叠加的静默失效，每一层单独看都"没 bug"。
修：`?.trim() ||` 归一空串 + `if (!bin)` 纵深防御 + compose 给回默认值 + 三层回归测试。

**②③④ 三条「日志误导」缺陷**（`6650bc8` / `7cf655a`）：
- `probe ok=N` 统计的是"没抛异常"而非"写进去了" → 改 `wrote/unavailable/failed` 三态 + 整体不可用时打 warn
- `judge: N 个文件判定需字幕` 把**判定总数**说成需字幕数 → 我据此误判规则 2 失效、停机排查一轮
- mismatch 取证日志 targets 侧截断到 40 字节而 agent 侧不截断 → 每项都"看起来不等"，
  手工 hex 解码才发现是日志问题（实际 8/8 装成功）

三条都不让程序算错，但都让**读日志的人**算错——而 live test 阶段人读日志是唯一观测手段。

**⑤ 装盘与观察之间没有衔接**（`12e4ab6` + `51eb5a4`）——第 5 次同型缺陷的新形态。
worker 按 R24 不写 covered（正确），但刚装字幕的文件既不在扫描 A 档（指纹没变）
也不在 B 档（上一轮已把 `sub_recheck_at` 推到 +7 天）→ **装好的字幕要等 7 天才被观察成
covered**，这 7 天里它仍满足工作台谓词、被反复重找，白烧 LLM。
翻译轨同型且更隐蔽：`daemonV2` 已经调了 `requestIngest()` 踢扫描，但踢的那轮扫描
两档谓词同样选不中它——**踢了扫描而扫描什么都不看**，这条衔接一直是装饰性的。
修：成功轨写 `sub_recheck_at = 0`（哨兵）。**哨兵取 0 而非 `now-1`** 是关键：
该列读者用可注入时钟、写者用调用方的 now，两者不同源时 `now-1` 对读者是"未来 25 年"
→ 谓词永不命中而单测全绿。

### 单元 5：删文件验证「以文件为真源」（R7 + R23/R24）✅

手工删掉 1 个字幕（Peacemaker S02E01 的 .srt）+ 1 个视频（Kraven the Hunter），
只把那一集的 `sub_recheck_at` 拉到点（验 B 档精确性，不是全库雪崩），跑一轮：

```
scan: 删除磁盘上已消失的文件 1 行（R7）: .../Movies    ← 精确 1 行，不多不少
scan: 字幕存在性观察 A档=0 B档=1（R24 / D12）          ← 只查拉到点的那 1 个
S02E01: sub_status 从 covered 回退成 NULL、needs=1、attempt=0
```

**最终对账**（这是第 6 步最硬的一条证据）：
```
covered = 34  ==  磁盘字幕 34
files   = 60  ==  磁盘视频 60
```
用户手删字幕 → 系统回退状态并会重新找它，且**不记它一次失败**（attempt 仍 0）。
这就是 R23/R24「磁盘是真源、covered 是事实观察」在生产中的完整闭环。

### 单元 3 的真实成绩单

| 作品 | 已装 | 待找 | 不需要 |
|---|---|---|---|
| **Peacemaker** | **8** | 0 | 0 | ← 当年装错 8 集的事故案例，这次全对 |
| IT: Welcome to Derry | 7 | 0 | 1 |
| Gachiakuta | 13 | 0 | 8 |
| Adam's Sweet Agony | 5 | 3 | 0 |
| Cassandra（德语） | 0 | 6 | 0 |
| Constellation | 0 | 0 | 7 |
| The Astronaut / Pulp Fiction | 各 1 | 0 | 0 |

**待找的 9 个全是 `sub:retry-later` + `sub_attempt=0` + `sub_retry_streak=1`**——
这正是第 5 步 R9 两条边界在生产中工作的样子：assrt 配额只剩 5（一次成功的 "not now"，
不是 error），agent 正确报 retry_later，scheduler 豁免计数但记了 streak（CAP=3 才折算）。
**没有把源站沉默冤枉成"确实没有"**，也没有因此提前移交翻译。

### 单元 6：翻译单元 —— **首次真实运行，成功出片** ✅

这是文档 §九 一直记着「从未在任何环境跑过」的那条链路。造 `handoff_translate` 态
（Peacemaker S02E02，英语可救、先删掉它的外挂字幕避免 already-covered）后：

```
翻译 Peacemaker (.../Peacemaker S02E02 ....mkv)
[translate-worker] job daemon-1786390499859 finished in 113 step(s)     ← 13 分钟 / 113 步
翻译结果 installed → sub_status=handoff_translate                       ← R24：不写 covered
```

**产物质量**（59558 bytes / 876 cue / SRT 规范）：
```
2
00:00:14,764 --> 00:00:17,058
- (键盘哔哔声)
- 约翰·伊科诺莫斯：很明显，
那是洗手间。
```
人名音译（约翰·伊科诺莫斯 / 阿曼达·沃勒）、说话人标签、音效标注全部保留。

**闭环验证**（翻译轨衔接修复的实证）：
```
翻译装盘后 sub_recheck_at = 0                    ← commit 51eb5a4 生效
下一轮 scan: 字幕存在性观察 A档=0 B档=1           ← 精确捞到那一行，不是全库
S02E02: handoff_translate → covered              ← 闭环完成
```
端到端全程：**移交 → 翻译 → 装盘 → 扫描观察 → covered**。

### 顺带验证的判定正确性（差点被我当成缺陷）

- **Cassandra（德语剧）`translatable=0`** —— 正确。`de` 既不在可抓源集合（MVP=en）也不在
  可抽轨集合（en/ja）；它有 `eng` 内嵌轨也不救，因为 R18 禁英文兜底转译
- **Adam's Sweet Agony（日漫）`translatable=0`** —— 正确。`embedded_langs=[]`（探过、确认零轨）
  = 真的没有日文源，而 jimaku 尚未落地（C6）
- **Constellation `needs_subtitle=0`** —— 正确。它有 `chi` 内嵌中文轨，judge 规则 2 排除。
  我一开始拿它造 7 次移交场景，发现 `needs=0` 时以为是缺陷，查完是我选错了对象

三条都是"看起来像 bug 实际是对的"，判据都能在 `subtitleJudge.ts` 的注释里找到原始论证。

### 单元 7：GC 炸弹 —— 实测坐实，且根因与文档记的不同 ✅

翻译成功后工作台目录 **312KB 留在磁盘上**（`daemon-1786390499859/`）。此前这只是 §八 里的
理论推断，现在有了实测证据。而根因与文档记的**不一样**：

| | 缺陷 | 是否残留成因 |
|---|---|---|
| A | 翻译流**从来没有成功后的清理**（字幕流有 `cleanup(...)`） | ✅ **就是这 312KB** |
| B | in-flight 未登记（§八 原先记的那条） | ❌ 真实风险（boot GC 会误删正在跑的现场），但不是残留成因 |

文档原先把重心放错了：它说"回收机制存在、只是保护没接"，实际是**回收压根没接**。
唯一的清扫者 `gcOrphans` 只在 boot 跑一次 → 长期不重启的 daemon 每翻一集永久留一个目录。

**第三个后果（此前无人记录）**：同一毫秒内两个不同文件会拿到**同一个** jobId
（实测复现 `daemon-1786393875937` 撞名）→ 两个活共用一个工作台、半成品互相污染。

修法（`6944998`）：新增 `translateJobId(workId, path)` = `translate-<workId>-<fileKey>`。
- **不能直接用 `translateItemId` 当目录名**（最省事但错）：它含 `/` → 工作台会埋进
  二级目录而 `gcOrphans` 只**非递归**扫直接子条目 → 够不到 = 永久泄漏；含 `:` → SMB/exFAT
  非法字符，而生产媒体根正是群晖 SMB + rclone FUSE，`mkdir` 直接失败 → 翻译流整支起不来
- 成功回收 / 失败留现场（held 的半成品是数小时付费 LLM 的排障唯一材料）。
  不堆积由三道独立收口保证：稳定 jobId（同文件只占一个目录）+ `TRANSLATE_HELD_LIMIT=3`
  + gcOrphans 的 boot 回收与 mtime 窗口。故不另造第二套超时清理
- 稳定 jobId 引入的新风险已同时处理：残留的 `glossary/FROZEN` 会让 one-shot 的
  `freeze_glossary` 返回 already frozen → 这一次只能拿旧术语表跑；若上次正是术语冲突 held，
  这一行会**永久 held**（每轮烧一个付费 session 却永远过不了闸）。故开工前 `resetWorkspace`

**实测验证**：新 jobId 形态 `translate-tmdb-110492-efc328d47823`（可读出是哪部剧），
翻译成功后工作台只剩 `.subtitle-translate/.ignore`，工作目录已回收。

### 第 6 步最终对账（全部单元跑完）

```
DB files          = 60   ==  磁盘视频 60
DB covered        = 35   ==  磁盘中文字幕 35
embedded_null     = 0        （spec 硬门 1）
provider_ids_null = 0        （spec 硬门 2）
工作台残留        = 0
```

### 单元 8：115 全库实测 —— 抓到两个会造成数据损失的缺陷（C46 / C47）

115（openlist WebDAV + rclone FUSE）的读取**高度不稳定**，同一目录几分钟内在"正常"与"空"
之间反复横跳。一小时实测记录：

| 时刻 | Movies | TV |
|---|---|---|
| 10:47 | 36 目录 ✅ | ✅ |
| 02:48 扫描 | **空** ❌ | 1155 ✅ |
| 11:10 | 51 文件 ✅ | ✅ |
| **04:07 扫描** | ✅ | **只读到 720** ⚠️ |
| 11:35 | ✅ 351 | ✅ 351 |
| 11:40 | **0** ❌ | **0** ❌ |

原有 R8 保护有两道闸，各自都对，但**中间有个洞**：

| 形态 | 防线 |
|---|---|
| 整根抛错 | ✅ 跳过 |
| 整根扫出 0 个 | ✅ 跳过 |
| **扫出 720/1292（部分成功）** | ❌ **当成事实，删了 572 行** |

**C46（`d747533`）：两道闸加当场重试。**
FUSE 瞬时故障几秒就恢复，而原实现只是 `continue` 等 24 小时——一次抖动赔上一整天，
若每天巡检那刻都恰好抖一下就是**永远不处理，日志只平静地说"跳过"**。
2 次重试、1s→3s 递增退避（递增而非等长：抖动多因限流，等长等于同节奏再撞两次）。
重试全失败时行为与原来完全一致，日志带上"已重试 N 次"。

**C47（`c1eff31`）：第三种形态的比例守卫。**
⚠️ **我在这一条上算错了阈值，subagent 用实测纠正了我**：
我说"572/1155 = 50%"，但那是**删除比例**；守卫判据是**存活比例** `720/1292 = 55.7%`。
按我给的 50% 阈值，这次事故**根本不会被拦**。反向验证坐实：阈值设回 0.5，
生产事故用例当场变红、572 行又被删。正确阈值 **0.80**（硬区间 0.623 < x < 0.943）。

它还指出我漏掉的更严重问题：**纯比例守卫会把真实大删永久锁死**
（库 351/盘 200 → 每轮都拦 → 永远删不掉，且日志每轮平静地说"跳过"）。
解法是**重读确认**——真实删除在两次读取间稳定，FUSE 抖动不稳定：
① 重读恢复 → 采用重读结果 ② 重读同数 → 坐实真删 → 照删 ③ 重读又是别的低数 → 跳过。

**实测验证**：修复后重跑，`scanned=1292 upserted=572` **零删除**——上次误删的 572 行
自动补回，数据自愈。1292 正是事故那轮的真实总数。

### 环境实测事实（与本地盘语义不同，值得记）

- `find -delete` **在 CIFS 上静默失效**（报成功但文件还在）——必须用 `rm`
- `rm -rf` 非空目录在 CIFS 上不可靠，要先逐文件 `rm`
- 115（openlist WebDAV）：顶层是虚拟挂载点**不能建目录**（409 Conflict）；
  `MKCOL` 返回 405 但实际执行成功；高频试探会触发**阿里云 WAF 风控**（我踩了）
- CIFS **支持硬链接**（10.9GB 文件瞬间完成、零额外空间）——建测试库的理想方式

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
| ~~翻译工作台 GC 炸弹~~ | **已修（`6944998`）**，且实测发现根因与本条原先的记载不同——详见 §六·五 单元 7。原记载说"回收机制存在只是保护没接"，实际是回收压根没接；另实测到同毫秒撞 jobId 这第三个后果 |
| `server.test.ts` flake | 全套件并行下偶发失败（~1/10，`port: 0` + undici 全局态），单独跑 120/120 稳定绿。会污染「失败必须是同样 7 条」的验收口径 |
| 🔴 **vitest 会静默丢整个测试文件** | 比上一条危险得多：实测出现过 141 vs 142 文件、总数少 220 条，而 `numFailedTests` **照样是 7**——很容易被当成通过。我们全程用「失败必须是那 7 条」当验收门，这个 flake 能直接绕过它。**建议验收时同时断言文件数与总数下界** |
| `recheck_after` 隐式隔离 | 三方共用靠 `sub_status` 白名单，没有 `last_error` 那样的显式前缀机制 |
| probe 失败重试通路 | 隐式靠 D17 回填 pass，没有独立记账 |
| 命名事故 | `recheck_after`（重试调度）vs `sub_recheck_at`（事实复核）语义近但含义完全不同 |
| `db.test.ts` **16 处**版本号字面量 | 每加一条迁移要手改 16 行（15 处 `value: 'NN'` + 1 处 `expect(MIGRATIONS.length).toBe(NN)`）。两个 subagent 分别数成 14 和 15，**都漏了最后那条**——它不是 `value:` 形态所以 grep 不到。应统一写成 `String(MIGRATIONS.length)` |
| 注释硬写行号会腐烂 | 第 7 步实测：`cli/index.ts` 有条注释写 `daemon.ts:327`，删 39 行后指到了另一个函数里。已改成引符号名（重构时工具会带着走）。仓内还有 `watchWiring.ts:7` 等同类实例 |
| `--noUnusedLocals` 下 7 处孤儿 | `cli/index.ts` 的 `verifyAndRecord`/`runVerifySweep`/`verifyRepo`（verifySweep 雪藏，**有意保留**）+ `ReconcileAllResultDTO`/`requireEnv`/`targetLanguages`（疑似真死）+ `handleWorkerTask` |
| `identifyMediaSkill` 教模型调未挂载工具 | 文档仍写 `write_identified_media`，而活路径（daemonV2 字幕 worker）从不传 `identityDeps`。模型会去试、被拒、把失败写进 reason |
| 既有 7 红 | deployContract 3（部署脚本换了测试没跟上）/ buildAdapters 2（zimuku）/ secrets 1 + settingsRepo 1（SECRET_NAMES 从 12 涨到 15） |

---

## 八·五、⭐ 四轮对抗性审计的方法论沉淀（2026-08-11）

前端设计文档经四轮 subagent 对抗审计，共 **17 条 🔴**。
**没有一轮收益递减**——因为每轮换了攻击层面：

| 轮 | 攻击层面 | 🔴 | 代表性发现 |
|---|---|---|---|
| 一 | **事实层**（数字对不对） | 6 | 我引用了一份已被自己销毁的数据快照 |
| 二 | **遗漏层**（该有的有没有） | 3 | DTO 给不出 `skip_reason`——我在警告"第 8 次同型缺陷"的段落里亲手写下第 9 次 |
| 三 | **决策层 + 假修复** | 4 | R-F1 与生产代码打架（识别在推 activity），两条裁决相隔 9 行，我同时引用却没发现 |
| 四 | **可执行性**（新人能做吗） | 4 | `workflow` tab 渲染的是 `ActivityPage`，我写"activity 不在导航里"方向反了 |

### 三条可复用的经验

1. **换角色比换问题有效**。第四轮让审计员扮演"入职第一天的工程师"、
   **真的去执行 12 步**，找到了前三轮从旁边走过去三次的错误
   （前三轮查了 `route.ts` 三次，没有一轮打开 `AppShell.tsx`）。

2. **让审计员实跑，不许推测**。四轮里我被实测纠正 **10 次以上**，
   包括"季集表要新建"（早已存在）、"复用 langOf"（chs/cht 不折叠）、
   "阈值 50%"（混淆删除比例与存活比例，挡不住真实事故）。

3. **要求审计员列出"攻击过但没攻破的"**。这能区分"真没问题"与"没认真找"，
   第三轮列了 8 条、第四轮列了独立评分（推理质量高 / 事实准确度 70% / 可执行度 35%）。

### 本项目的两个招牌病（识别它们）

**病 A：加了能力却没定谁写/谁读/谁触发** —— 已栽 **10 次**
> C12 → C35 → C43 → C21 → `audio_langs` → `tmdb_seasons`（表有函数有没人触发）
> → 通知端点（表有数据读函数有没 HTTP 端点）→ `skip_reason` 零读者
> → SSE `found` 载荷对不上消费方 → **两条裁决互斥、实现挑一条、文档两条都引用却没发现**

**病 B：把中间量说成结论量** —— 已栽 **4 次**
> `probe ok=N` 统计"没抛异常"而非"写进去了" / `judge: N 个文件判定需字幕` 把总数说成需字幕数
> / mismatch 日志截断到看不出差异 / 设计文档引用已销毁的数据快照

---

## 九、翻译的边界（2026-08-10 已实测出片，此节改写）

~~从未在任何环境跑过~~ —— **第 6 步 live test 已验证成功出片**（见 §六·五 单元 6）：
Peacemaker S02E02，113 步 / 13 分钟，产出 876 cue 的规范 SRT，闭环到 `covered`。
`resolveTranslateSource` → workspace agent → `writeSidecarAtomic` 全程真实跑通。

仍未验证的部分（诚实边界）：
- **只跑过 1 集、1 种场景**（英语内嵌轨抽取）。日语源、外挂抓源、`held` 修复循环、
  7 次移交的真实触发（我造的是直接写 `handoff_translate` 态，不是等它真攒满 7 次）都没实测
- 翻译工作台的 GC 在长跑下的行为未验（见下方 jobId 稳定化那条）

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
