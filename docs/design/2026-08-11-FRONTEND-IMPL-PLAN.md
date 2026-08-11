# 前端第 8 步 · 实施计划（subagent driven）

**建立**: 2026-08-11
**上游**: `2026-08-11-FRONTEND-IMPL-DESIGN.md`（v5，四轮审计 17 条 🔴）
**执行模式**: 每个 task 由 subagent 实现 → **另起 subagent 对抗审计** → 我裁决 → commit

---

## 零、给每个实施 subagent 的通用底座（**必须贴进每次 prompt**）

### 项目铁律

1. **数据库是状态机，磁盘是真源。**
2. **不许假修复**：不许为了让测试过而改断言、加 `?.`、吞异常、`as any`。
3. **不许扩大范围**：只改本 task 声明的文件。遇到相邻的坑 → **报告，不要顺手改**。
4. **⭐ 不许为了用户自己仔细点就能解决的问题，把自己折腾得鸡飞狗跳**（用户原话）。

### 本仓两个招牌病（提交前自查）

| 病 | 形态 | 已栽次数 |
|---|---|---|
| **A** | 加了能力却没定**谁写 / 谁读 / 谁触发** | **10** |
| **B** | 把**中间量**说成**结论量**（如 `ok=N` 统计的是"没抛异常"而非"写进去了"） | **4** |

> 病 A 自查法：新加的字段/表/函数/端点，**逐个说出它的写入点、读取点、触发点**。
> 三者缺一 → 这个 task 没做完。

### 验收基线（2026-08-11 实测，每 task 都要对照）

```bash
# 后端：142 文件 / 3217 用例 / 失败恰好 7 条
npx vitest run --exclude '**/web/**' --reporter=json > /tmp/be.json
node -e "const j=require('/tmp/be.json');console.log('files='+j.testResults.length,'total='+j.numTotalTests,'failed='+j.numFailedTests)"

# 前端：78 文件 / 863 用例 / 0 失败
cd web && npx vitest run --reporter=json > /tmp/fe.json

# 类型（vitest 不查类型！两条都要退出码 0）
npm run check          # tsc --noEmit（后端）
cd web && npx tsc --noEmit
```

**那 7 条既有失败**（接手前的债务，**不得增加、不得变脸**）：
`deployContract`×3 / `buildAdapters`×2 / `secrets`×1 / `settingsRepo`×1

⚠️ **三条验收陷阱**（都实测踩过）：
1. **vitest 不查类型** → 58 处类型错误能全绿交差，必须单独跑 `npm run check`
2. **vitest 会静默丢整个测试文件** → 出现过 141 vs 142、总数少 220，而失败数照样是 7。
   **必须同时断言文件数**
3. **默认 reporter 虚报** → 用 `--reporter=json`

### 迁移的隐含规则（③⑥ 各会踩一次）

**新列只能写进 `src/v2/db.ts` 迁移数组末尾的条件式 ALTER entry，
绝不能同时改顶部 CREATE TABLE 终态定义。** 先例：`media_roots.content_type`(v30)、`works.provider_ids`(v36)。

同时改 `src/v2/db.test.ts` 的 **16 处**版本号字面量
（15 处 `value: 'NN'` + **1 处 `expect(MIGRATIONS.length).toBe(NN)`**——
后者不是 `value:` 形态，两个 subagent 分别数成 14 和 15 都漏了它）。

### 本地怎么跑

```bash
SUBTITLE_SCOUT_CACHE_DIR=./cache-local npm run cli watch   # 后端 8099
cd web && npm run dev                                       # 前端 5173
```
⚠️ **SSE 必须跑 watch**：`events` 只在 `cmdWatch` 注入（`src/cli/index.ts:662`），
否则 `/api/v2/events` 恒 503。**没有轻量模式。**

---

## 一、依赖图与批次

```
批次 1（六步全并行，互不依赖）
  ⓪ workbench 字段    ① notifications 端点   ② EpisodeState 八态
  ③ media_roots 健康列 ④ current 快照源       ⑥ backdrop_path

批次 2   ⑤ health 端点        ← ③ + ④
批次 3   ⑦ shell 改造         ← ⑤
批次 4   ⑧ 媒体库页 ← ②+⑦    ⑨ 活动页 ← ⑥+⑦+⓪    ⑩ 通知页 ← ①+⑦
批次 5   ⑪ _legacy + docker build
```

**并行策略**：批次 1 的六个 task 可同时派 subagent，但**②③⑥ 都动 `db.ts`/SQL**，
③⑥ 都加迁移 → **③ 与 ⑥ 必须串行**（迁移版本号会撞）。
实际排布：`[⓪ ① ② ④]` 并行 → `③` → `⑥` → `⑤` → `⑦` → `[⑧ ⑨ ⑩]` 并行 → `⑪`

---

## 二、逐 task 规格

### Task ⓪ — `ScoutEventInput` 加**可选** `workbench` + progress 节流改 per-workbench

**为什么**：前端拿到 `{done:3,total:47}` 无法区分是识别还是字幕还是翻译（教训七）。

**改哪**：`src/core/scoutEvents.ts`（`ScoutEventInput` 加 `workbench?`、
`lastProgressAt` 从**全局单标量**改成 per-workbench Map）、`src/v2/daemonV2.ts` 7 个工作台级 emit 点。

**🔴 必须可选，不能必填**（教训十二）：实测 **13 个** emit 点里 **6 个填不了**——
`:519/:531/:542` 是巡检级、`:1300/:1306/:1375` 是阶段 1 扫描级，都不属于任何工作台。
判别靠 `workbench !== undefined`。**`current.kind` 保持三态**（它只描述工作台）。

**波及**：13 生产点 + 45 测试构造点 = **58 处**。**必跑 `npm run check`**。

**验收**：
- 三个工作台的 progress 各自独立节流（造两个工作台交替 publish 的用例，验不互相吃掉）
- 6 个非工作台 emit 点**不填** `workbench`，且编译通过
- `npm run check` 退出码 0

---

### Task ① — 补 `GET /api/v2/notifications`

**为什么**：第 7 次同型缺陷——表有、数据有、读函数有（`listRecentFoundGrouped`），**就是没端点**。

**改哪**：`src/dashboard/server.ts` 加路由；复用 `src/v2/notificationsRepo.ts:48` 的 `FoundGroup`。

**验收**：
```sql
-- 端点返回条数必须 == 这个（按 work+season 聚合，不是逐集行数）
SELECT COUNT(DISTINCT work_id||'/'||COALESCE(season,-1)) FROM notifications WHERE found_at > now-7d
```
⚠️ v3 原写 `COUNT(*)` 是**逐集行数**，与实现口径不符、永远不通过——同一份文档里两条验收对同一端点给了两个口径。

---

### Task ② — `mediaLibraryApi` 补 `EpisodeState` 八态

**为什么**：**第 9 次同型缺陷**——我在警告"第 8 次"的那段里亲手写下的。
DTO 现在只有 `SubtitleDot = 'none'|'blue'|'green'` 三态，**给不出** `skip_reason`/`needs_subtitle`/`sub_status`。

**改哪**：`src/dashboard/mediaLibraryApi.ts` 两条 SQL + DTO。

**优先级链在后端实现**（不透传原值让前端算——前端不知道 `target_languages` 是什么，那是 R-F15 的后端判据）：

```ts
export type EpisodeState =
  | 'covered'      // ✓ 绿   sub_status='covered'
  | 'translating'  // ⇄      sub_status='handoff_translate'
  | 'unsolvable'   // ⊘      sub_status='unsolvable'
  | 'origin-skip'  // ◇      skip_reason='origin-skip'
  | 'embedded'     // ◆      embedded_langs 含目标语言
  | 'pending'      // ···    needs_subtitle=1
  | 'unjudged'     // ?      needs_subtitle IS NULL（第 8 态）
  | 'absent'       // 虚线   onDisk=false（不染色）
```

⚠️ **`SubtitleDot` 保持三态不动**——它被**三个 DTO 共用**，扩它会波及列表页海报卡
（列表页是"底部渐变嵌进度条"不是点）。**新增字段，不改旧字段。**

**验收**：对每个 `sub_status` 值域（含 `unsolvable`/`handoff_translate`）**造一行测试数据**验透传。
⚠️ 生产当前这两态各 **0 行**、`skip_reason` 1192 行全 NULL——**不能靠生产样本验**，
查不到样本的状态记为**未验**写进遗留，**不许拿"没样本"当"通过"**。

---

### Task ③ — `media_roots` 加 `last_error` + `last_checked_at`

**为什么**：不做则 `/health` 的 `roots.ok` **只能撒谎**。

**改哪**：`src/v2/db.ts` 迁移（**读上面的隐含规则**）+ `daemonV2.ts` 四个 health 发射点各加 UPDATE。

**🔴 单点收敛要用 `try/finally`**（教训九）：v3 说"每根循环末尾统一写一次"，
但那个循环里**有多处 `continue`，末尾根本到不了**。
**且必须包含成功路径清空 `last_error`**——只写不清 = 错误永久粘住。

**验收（注入式，不许 umount）**：
喂 `readRootWithRetry` 四种结局：
1. 抛 EIO → 验 `:1300` 写入 `last_error`
2. 返回 `[]` → 验 `:1306`
3. 返回 40% 文件 → 验 `:1375`（C47，**生产真出过的那档**）
4. 恢复正常 → 验 `last_error` **被清空**（教训九说的缺失点）

⚠️ **不许用 umount**：容器把宿主 `/` 挂进 `/hostroot`，卸掉 115 的 rclone 挂载 = 全库不可访问；
且 R8 三道闸里 umount 只触发第一道，而生产真实出事那次（04:07）走的是第三道 C47——**只验三分之一**。

---

### Task ④ — `current` 快照数据源

**为什么**：`activity` 事件是**变化**不是快照。断线期间巡检跑完、缓冲被 progress 冲掉 →
前端永远停在"正在处理 X"（审计 F-6）。

**🔴 选型已定（compact 后实测决策，v5 留着"二选一"未定）**：
- **实测**：`src/cli/index.ts:662` 注入 `events: scoutEvents` 给 dashboard，
  **:745 才构造 daemon** → dashboard 先启动，**拿不到 daemon 引用**（否定 holder 注入方案）
- **实测**：`meta` 表**无任何读写封装**，全是散落的裸 SQL（`INSERT INTO meta`/`SELECT ... FROM meta`）
- **实测**：`ScoutEventBus` **已是双方共用的单例**且自带状态（`buffer`/`nextId`/`lastProgressAt`）

→ **裁决：`current` 快照挂在 `ScoutEventBus` 上**（`publish()` 时顺手更新 `private current`，
加 `getCurrent()` 供 `/health` 读）。**零新增连线**，写入点=已有的 emit，读取点=health，触发点=publish。

**改哪**：`src/core/scoutEvents.ts` 单文件。

**验收**：巡检期间 `curl /api/v2/health` 的 `current.title` ==
`docker logs` 当前那行「字幕 X (N 文件, 第 i/n 个)」的 X。

---

### Task ⑥ — `works.backdrop_path` + 回填 + `identifyScheduler` 写入点

**为什么**：R-F13 活动页"在跑"卡片要横版 backdrop。TMDB 客户端**已在取**，`identifyScheduler` 落库时漏了。

**改哪**：`db.ts` 迁移（**隐含规则**）+ 回填 pass + `identifyScheduler` 写入点。

**🔴 只补回填不补写入 = 只修一半**（病 A 的典型形态）。

**验收**：回填后 `SELECT COUNT(*) FROM works WHERE backdrop_path IS NULL` ≈ 0，
**且新识别一部作品后再查一次**，验写入点也补了。

---

### Task ⑤ — 补 `GET /api/v2/health`（← ③④）

**实测**：当前 `/api/v2/health` 返回 `{"error":"not found"}`，**确系从零新建**。

**返回**：`lastInspectAt`（对 `meta`）、`engineEnabled`（对 `settings`）、
`roots[]`（对 `media_roots`，来自 ③）、`current`+`queue`（来自 ④）。

⚠️ v5 说"生产从未跑完一轮、`lastInspectAt` 恒 0"——**2026-08-11 实测推翻**
（13:49:34Z 已跑完一轮，巡检失败 0 次）。前端**仍要**保留冷启动分支（全新部署确实是 0），但别当常态。

---

### Task ⑦ — shell 改造（← ⑤）

**🔴🔴 动手前必读（教训十一，v3 的处置是反的）**：
```
AppShell.tsx:94   route.tab === 'workflow' && <ActivityPage />
```
**`#/workflow` 这个 tab 渲染的就是活动页。** 且 `activity/` **四处 import `workflow/`**
（`RunDetail`/`RerunDialog`/`useLiveTrail`/`phrases`）——**判「删 workflow」会立刻编译失败。**

**要改 6 处**（改错**不报错只静默失效**的已标注）：
```
web/src/shell/route.ts      Tab/TAB_IDS/isTab/ShellRoute.tab/go()
web/src/shell/tabs.ts       TabMeta.id / NavLabelKey / TABS   ← 头注释就是现成模板
web/src/shell/Sidebar.tsx   TAB_ICONS: Record<Tab,...> 穷尽映射
web/src/shell/NavIcons.tsx  补 2 个图标（18×18、笔画 1.8px、currentColor）
web/src/shell/AppShell.tsx  5 处 route.tab === 分支   ⚠️ 静默失效
web/src/i18n/{en,zh}.ts     3 个新 nav_* key          ⚠️ 静默失效（只显示 key）
```

**SSE Context 放 `web/src/events/`，必须拆四层**（单 Context 会让 progress 每秒触发全树重渲染）。

---

### Task ⑧⑨⑩ — 三个页面

视觉基准 `DESIGN.md`（Linear：四层 surface 阶梯 + 三层 hairline，**拒绝投影**）。

- **⑧ 媒体库页**（← ②+⑦）：R-F2 按 `work_id` 合并不管来源、任一份有字幕就算已获取；
  R-F5 实线=实有集/虚线=应有集；R-F12 **集号染色**（`E01 ✓`），不用圆点、不用左竖线。
  **符号统一走 `<EpisodeMark state={...} />` 内联 SVG 12×12**（笔画 1.8px 照 `NavIcons.tsx`）——
  不用 Unicode 文本，`···`(U+22EF) 与 `⇄`(U+21C4) 字宽基线不一致会歪。
  新页面用 **`#/media`**，不复用 `#/library`。
- **⑨ 活动页**（← ⑥+⑦+⓪）：R-F13 全背景式卡片，图渐隐进 `surface-1` **实色**；
  在跑=横版 backdrop（60% 宽 / 186px 高）、排队=竖版 poster（59×88px，渐变区 118px）。
  **R-F1：识别不进活动页**——⚠️ 生产 `daemonV2.ts:626` 正在推识别 activity（教训七），
  前端**必须过滤**，或在 ⓪ 里给它标 `workbench:'identify'` 由前端剔除。
- **⑩ 通知页**（← ①+⑦）：保留一周、倒序、**不做已读**。

---

### Task ⑪ — 收尾

旧页面移入 `_legacy`；`docker build` 退出码 0。

⚠️ **只删 `_legacy/library` 与 `_legacy/workflow`**；`_legacy/verify` **不在本次范围**
（它有 6 个活端点，删 UI 留端点 = 本仓招牌缺陷形态），其去留单独裁决。

⚠️ **CI 账单已耗尽**，`docker build` 在软路由上跑：
```bash
ssh media-router-wan   # 公司；家里用 media-router
cd /mnt/nvme0n1-4/docker/subtitle-scout && git reset --hard && docker build ... && docker compose up -d
```

---

## 三、每个 task 完成后的对抗审计（**固定动作**）

实施 subagent 交付后，**另起一个 subagent** 做对抗审计。审计 prompt 必须包含：

```
你是对抗性审计员。目标：证明这次实施是错的 / 不完整的 / 是假修复。

【不许推测，必须实跑】——四轮设计审计里我被实测纠正 10 次以上。
每条结论都要附上你跑过的命令与它的真实输出。

审计四个层面（这四层在设计阶段各自都抓到过 🔴，没有一层是空的）：
1. 事实层：文档/注释/commit message 里的每个数字，实跑核对
2. 遗漏层：新加的字段/端点/函数，逐个说出【谁写 / 谁读 / 谁触发】——
   三者缺一即病 A（本仓已栽 10 次）
3. 决策层：这个实现与 R-F1~R-F15 任一条冲突吗？与生产现有代码冲突吗？
   （设计阶段抓到过 R-F1 与 daemonV2.ts:626 打架，两条裁决相隔 9 行）
4. 假修复：有没有为了让测试过而改断言 / 加 ?. / 吞异常 / as any？
   有没有把中间量说成结论量（病 B，已栽 4 次）？

【验收必须跑满】：
  npx vitest run --exclude '**/web/**' --reporter=json   → 文件数 142、失败恰好 7 条
  cd web && npx vitest run --reporter=json               → 文件数 78、失败 0
  npm run check  且  cd web && npx tsc --noEmit          → 均退出码 0
  ⚠️ vitest 不查类型；⚠️ vitest 会静默丢整个测试文件，必须同时断言文件数

最后必须回答：
  A. 找到的问题，按 🔴 必须修 / 🟡 该修 / 🔵 可不修 分级
  B. 【你攻击过但没攻破的】——这条用来区分"真没问题"与"你没认真找"
```

**审计通过 → 我 commit。审计有 🔴 → 打回重做，不进下一个 task。**

---

## 四、进度

| Task | 状态 | commit |
|---|---|---|
| ⓪ workbench | ⬜ | |
| ① notifications | ⬜ | |
| ② EpisodeState | ⬜ | |
| ③ media_roots | ⬜ | |
| ④ current | ⬜ | |
| ⑥ backdrop | ⬜ | |
| ⑤ health | ⬜ | |
| ⑦ shell | ⬜ | |
| ⑧ 媒体库页 | ⬜ | |
| ⑨ 活动页 | ⬜ | |
| ⑩ 通知页 | ⬜ | |
| ⑪ 收尾 | ⬜ | |
