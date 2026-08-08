# 审计报告 · 第四轮（聚焦验证型）

状态：**已完成**

日期：2026-08-08
审计员：架构审计（round4）
范围：验证 round3 三条致命问题（C35/C37/C38）是否闭合；审 D13–D17 五条新裁决；审执行顺序调整影响。
不重复 C1–C40 已记录问题。

---

## 验证 1 · C35（R25 周频复查无执行者）

### 结论摘要
**部分闭合**。执行者（D13 阶段 2.6）、谓词互斥（D14）、成本节奏（D15）三项确实修好了，
但**新引入两个同型洞**：`handoff_translate` 的最终归宿与 R25/R26 直接冲突；翻译流写 `unsolvable` 时的入闸凭据未定义。

### 1a 阶段 2.6 有明确执行位置吗？—— 部分有
- spec §2（:93-97）把 2.6 排在 judge（2.5）与阶段 3 之间，**流水线图层面位置明确**。
- 但 §4 第 3 步实现清单（:476-478）只写"新增阶段 2.6 停牌复查闸：独立阶段，不由字幕流执行"，
  **未指定它在 `runInspection` 里的插入点**。
- 现有结构可容纳：`daemonV2.ts:75-104` 依次为 `scanOnce()` → identify while（81-88）→ `judgeOnce()`（91）→ subtitle while（95-103）。
  在 `:91` 与 `:95` 之间插一个 `await this.recheckParkedOnce()` 是可实现的、无结构障碍。
- **可实现性 ✓**，但位置未写进 spec → 见 F11。

### 1b 两个谓词互斥吗？—— 是，无重叠
- 阶段 2.6：`sub_status='unsolvable' AND recheck_after <= now`
- 字幕工作台：`needs_subtitle=1 AND sub_status IS NULL AND recheck_after <= now`
- `sub_status` 一个是 `IS NULL`、一个是 `='unsolvable'`，SQL 三值逻辑下**天然互斥、不可能同时命中**。✓
- 且 2.6 改回 NULL 后 `recheck_after` 仍是 7 天前写的（已过期）→ 同轮阶段 3 立刻选中它 → 跑一次 → 失败 → ≥7 → 回停牌 + `recheck_after=+7天` 出队。
  **单轮内闭环，不产生热循环。** ✓ 这条设计是对的。

### 1c sub_attempt 无限增长 / 判据是 `>=7` 还是 `==7`？
- spec **口径不一致**：§4 第 3 步（:475）写"sub_attempt≥7 时分流"、D15（:59）写"立即判 `≥7`"——正确；
  但 §5 状态转换表（:569-570）两行写的是"sub_attempt **达 7**"，字面可读成 `=== 7`。
- 若实现者写 `=== 7`：首次到 7 → 停牌 → 2.6 放回 → 失败 → `sub_attempt=8` → `8===7` 为假 →
  **不停牌、保持 NULL + recheck_after=明天 → 退回每日重试（约 365 session/年）**，
  比 D15 想避免的 182 次/年更糟一倍，且**单元测试只测"第一次到 7"会全绿**。→ F10
- sub_attempt 会无限增长（每周 +1，一年 +52）。数值上无溢出风险，但界面/日志语义与任何"阶梯"计算都会失真。→ F18

### 1d `handoff_translate` 在用户永不开翻译时的归宿？—— **spec 明确了归宿，但这个归宿违背 R25/R26**
- spec §5（:640-642）明确写："翻译开关关闭时满 7 次的文件仍写 `handoff_translate`……只是翻译流不启动、它一直显示停牌；开关一开翻译流自然领到它。"
  → 归宿 = **永久停在 `handoff_translate`**。
- 而 D14（:58/:628）把 `handoff_translate` 排除出阶段 2.6 → 字幕流永远看不见它（谓词 `sub_status IS NULL`）。
- 于是该文件的**全部主动搜索通道同时关闭**：字幕流不找（D14 排除）、翻译流不启动（开关关）。
  唯一残余通道是 D16 的 B 档存在性复核——但它只能发现"字幕已经躺在磁盘上"，**不会去找**。
- 这与 R25 原话"停牌期间字幕流**继续每周找一次**，直到真找到字幕为止"、
  R26"**没有真正的永久终态**"**直接冲突**，且 R25 的立论依据恰是"用户没开翻译不该被判死刑"。
  → **round3 E1 的"永久停牌"问题在 D14 里原地复活。** 见 F1（🔴）

---

## 验证 2 · C37（D12 与 R23 互相掐死）

### 结论摘要
**部分闭合**。D16 把"范围含停牌态"这一原则写清了（spec:605-607），A/B 两档也具体化了（:595-603），
但 B 档有 **3 个未定义行为**，其中首轮雪崩是可确定发生的。

### 2a `sub_recheck_at` 与 `recheck_after` 会混淆吗？—— 会，高风险
- 现有列（`db.ts:570`，v31 迁移）：`recheck_after INTEGER`，注释（`db.ts:552-559`）明写语义="字幕『找不到』的退避标记"。
- 新增列：`sub_recheck_at INTEGER`，语义="下次该复核字幕存在性的时刻"（spec:600）。
- 两名字都是 `_recheck_<after|at>`，**同一张表、同为 INTEGER 毫秒、同为 7 天量级**
  （阶段 2.6 写 `recheck_after=+7天`(:108)，B 档写 `sub_recheck_at=+7天`(:601)）。
  spec §5(:609-612) 专门加了"与阶段 2.6 的分工（勿混淆）"一节——**作者本人也意识到易混**。
- 更糟：旧表里 `recheck_after` 出现 5 次（`db.ts:40,53,158,232,247`），注释语义是"unavailable 的衰减复查"，
  与新 `sub_recheck_at` 的语义**反而更接近**——实现者按名字直觉会选错列。→ F5（🟡）

### 2b 首次上线 `sub_recheck_at` 全 NULL → 二选一都是坑（spec 未定义）
- 新列由 ALTER TABLE 加入 → **存量全部行 = NULL**（同 `db.ts:568-570` recheck_after 的加法）。
- spec 只写谓词 `sub_recheck_at <= now`（:602 / :441）。SQL 三值逻辑下 `NULL <= now` → NULL → 不为真。
  两种实现必然分歧：
  - 照字面写 `WHERE sub_recheck_at <= ?` → **全库永不被 B 档选中**，D16/C37 修复完全不生效
    （静默失效；测试用手造的非 NULL 数据会全绿——**与 C12 完全同型**）。
  - 照本仓既有习惯补 `IS NULL OR`（`subtitleScheduler.ts:32` 就是 `recheck_after IS NULL OR recheck_after <= ?`）→
    **首轮全库命中 → 上万文件 × 45 次 stat 挤在一轮 → 正是 D12 要防的 115 FUSE 雪崩**。
- 一条静默失效、一条雪崩，spec 没有第三条路。→ F2（🔴）
- 修法：迁移时把存量行打散——`sub_recheck_at = now + abs(random()) % (7*86400000)`，并把谓词固定为不含 `IS NULL OR`。

### 2c B 档会对已删除的文件做 45 次 stat 吗？—— 会，spec 未定义阶段内顺序
- spec §2 把"字幕存在性观察"（:78-80）与"磁盘已消失 → DELETE"（:81）**都放在阶段 1 内**，
  **未定义两者先后**。
- 若观察先于删除：本轮已消失但库里仍有行的文件会先被 B 档挑中做 45 次 ENOENT stat。
- 更坏的是 R8 保护生效时（115 断连、walk 返回 0 个文件 → 跳过删除）：幽灵行**永远不被删**，
  于是**每轮都对全部幽灵行重复 45 次 stat** ——"网盘断连时最该省 IO 的时刻做最多 IO"。→ F6（🟡）
- 修法：B 档挑中的行先 stat 视频本体（1 次），ENOENT 则跳过 45 次探测、交给删除逻辑。

### 2d A 档与 B 档同时命中同一文件 → 重复检测，spec 无去重
- 新增文件同时满足：A 档触发对象（"新增文件"，:596-597）+ `sub_recheck_at IS NULL`。
- 若 2b 按 `IS NULL OR` 实现 → 同一文件同一轮被两档各检测一次 = **90 次 stat/文件**，
  且恰好发生在"首轮全库新增"这个最重时刻。
- spec :595-603 分别定义两档触发对象，**无一句说两档取并集去重**。→ F7（🟡）
- 影响限于成本（结果一致，不致状态错误）。修法：spec 明确"两档合并为一个待检 Set，每文件每轮最多检测一次"。

---

## 验证 3 · C38（D9 前提在存量数据不存在）

### 结论摘要
**未闭合**。D17 只写了"需要有一个回填 pass"这一句意图（spec:61 / :382 / :470），
三个关键问题（执行者、性能约束、**重判通路**）全部未定义，其中**重判通路缺失使整条修复归零**。

### 3a 回填 pass 的触发者与执行位置？—— **完全未定义**（C12/C35 同型高发点）
- spec 全文关于 D17 只有三处：
  - :61 裁决行"embedded_langs 需存量回填 pass（与 C21 的 provider_ids 回填并列）"
  - :382 修法"补 embedded_langs 存量回填 pass，与 C21 并列，**列为第 2 步前置**"
  - :470 第 3 步清单"**前置**：embedded_langs 存量回填 pass"
- **无任何一处说谁调它、在哪调、跑一次还是每轮跑、如何判断"已回填完"**。
- 且 :382 与 :470 **自相矛盾**：一处说第 2 步前置（第 2 步是 daemonV2 接容器，与 embedded_langs 毫无关系），
  一处放在第 3 步内部。→ F8（🟡 口径矛盾）
- 参照物 C21 的 provider_ids 回填同样只有一句（:505），而 C21 本身就是"回填无触发者"的缺口——
  **spec 用一个已知缺乏触发者的条目当作新条目的并列参照**，等于把同一个洞复制了一份。→ F3（🔴）

### 3b 性能约束 / 分批 / 失败重试？—— **完全未定义**
- 回填需对每行跑 ffprobe。规模证据：CURRENT-STATE 记 115 上 248 个文件（spec:378），生产库"可能上万"。
- ffprobe 对 FUSE 网盘上的大 mkv 需读文件头，单次数百 ms 到数秒；上万行 = 数小时级串行阻塞。
- spec 未定义：并发度、单轮预算、跨轮续跑、ffprobe 失败的记录方式（写 `'[]'` 还是留 NULL）。
- **NULL 与 `'[]'` 不可区分是致命的**：`daemonV2.ts:134` 与 `judgeSubtitle`（`subtitleJudge.ts:32`）
  都只判 `embedded_langs != null` / `!= null`，
  **"未探测"与"探测过、确实无内嵌轨"在库里长得一样** → 回填 pass 无法判断哪些行还没回填 →
  要么每轮重复 probe 全库（永不收敛），要么漏掉真正 NULL 的行。→ F4（🔴）
- 修法：引入 probe 完成标记（`probed_at INTEGER` 或约定失败写 `'[]'` 且 `duration_sec` 非 NULL），
  并给回填 pass 定单轮预算 + 跨轮续跑（按 `probed_at IS NULL ORDER BY id LIMIT N`）。

### 3c 回填后如何重判？—— **这个洞没补上，且它使 D17 整体归零** 🔴
- judge 谓词（`daemonV2.ts:125`）：`WHERE f.work_id IS NOT NULL AND f.needs_subtitle IS NULL`。
- 回填只写 `embedded_langs`（+ `duration_sec`），**不会把 `needs_subtitle` 改回 NULL**。
- → 已跑完 judge 的存量行（`needs_subtitle` 已是 0 或 1）**永远不再进 judge**。
- 后果链（比 round3 E12 更严重，因为多了 `translatable`）：
  1. judge 规则 2（内嵌中字跳过）对存量行永不重判 → 本该 `needs_subtitle=0` 的内嵌中字片继续白跑字幕流（C12 原症状**未消除**）。
  2. `translatable` 是**新列**，存量行全 NULL，而 spec:467 明确"**judge 阶段写入**"→ judge 不看它们 →
     `translatable` 对存量行**永远是 NULL**。
  3. spec:582 规定 `translatable IS NULL` → "不得判死，视为暂不可判，继续留在字幕流"。
  4. 合起来：**存量 248 行永远攒不到"分流"这一步的有效判据，永远不会进 `handoff_translate` 也不会进 `unsolvable`**
     → 每天重试一次、永不停牌、永不移交翻译。
     这比 round3 E12 的"退化为只看 origin_lang"**更坏**：不是判错，是整条 R21/R10 的 7 次终点机制对存量数据彻底失效。
- spec:582 那句"待 D17 回填后重判"是**唯一提到重判的地方，但它只是期望，没有任何机制**——
  spec 中不存在任何把 `needs_subtitle` 或 `translatable` 置回 NULL 的写入者。
  这与 C35（周频复查无执行者）**完全同型**：逻辑自洽 + 缺写入者 + 测试会绿。→ F3（🔴）
- 修法（二选一，须写进 spec）：
  - (a) 回填 pass 在写 `embedded_langs` 的同时**把该行 `needs_subtitle` 与 `translatable` 一并置 NULL**，
    由 judge 自然重判（注意：这会让已 `covered` 的行重进 judge，但 D8 已把 sidecar 判断移出 needs_subtitle，风险可控）；
  - (b) 给 judge 加第二个谓词分支 `translatable IS NULL AND work_id IS NOT NULL`，让它能重看已判 needs_subtitle 的行。

---

## 任务二 · D13–D17 五条新裁决本身的洞

### 相互冲突
1. **D14 × D15 冲突（真冲突）**：D15 说"不归零 → 下次失败立即判 ≥7 → 直接回停牌"，
   但 D14 排除 `handoff_translate`。若一个 `unsolvable` 行被 2.6 放回 NULL，
   而这一轮**字幕流恰好成功装盘**（spec:567：不写 covered、只写 recheck_after 出队），
   下一轮扫描确认前它的 `sub_status` 是 NULL 且 `sub_attempt=7`。
   若此时装盘的文件其实没落地（D6/R24 正是为这种情况设计的）→ 下一轮阶段 3 选中它 → 失败 → ≥7 →
   分流看 `translatable`：若 =1 → 写 `handoff_translate` → **从此被 D14 永久排除**（见 F1）。
   即：**D15 让每周一次的失败都可能把文件推进 D14 的黑洞**，两条合起来把 R25 的"永不判死刑"变成"最多再活一周"。
2. **D14 × R25/R26 冲突（已在验证 1d 详述）** → F1。
3. **D13 × D16 不冲突但节奏重叠**：两者都是 7 天。spec:609-612 已明确分工，✓ 无洞。
   但同一文件的 `recheck_after`（2.6 用）与 `sub_recheck_at`（B 档用）在同一天到点是常态（都从同一次失败起算 7 天），
   → 同一轮里 B 档先查存在性、2.6 再放回重搜，顺序影响结果（若 B 档发现字幕已在 → covered → 2.6 谓词不再命中，省一次 LLM）。
   spec §2 的阶段顺序（阶段 1 在 2.6 之前，:76 vs :93）恰好是对的 ✓，但这是巧合而非声明。→ F12（🟢 建议写明）

### 与已有 R/D 条目的冲突
4. **D16 × D8 的组合破坏了 judge 规则 3 的迁移路径**：D8（:52）要求 judge 规则 3（sidecar 检测）从 needs_subtitle 移除。
   但 `subtitleJudge.ts:38` 的规则 3 与 `daemonV2.ts:137-140` 的 sidecar 探测代码是一体的
   （探测在 daemonV2 里、判定在 judge 里）。spec 第 1 步用例（:446）写"judge 规则 3 从 needs_subtitle 移除"，
   **但没说 `judgeSubtitle` 的 `hasSidecarSubtitle` 入参与 `JudgeVerdict` 的 `reason:'sidecar'` 分支怎么处置**。
   这是 round3 E6 提出的问题，**本轮修订未采纳**（spec 全文无一处交代）→ 留下死参数/死代码，
   且更危险的是：若实现者只删了 judge 的 `if`、保留了 daemonV2 的探测调用，探测成本（每 judge 行一次 readdirSync）白付。→ F13（🟡，非新引入，但 D16 的两档机制让它更重要）
5. **D17 × C11 的组合**：C11（:183）要求指纹变化时清空 `embedded_langs`。若回填 pass 与扫描在同一轮，
   顺序错了（先回填、后扫描清空）→ 刚回填的值被清掉、下轮再回填 → **每轮 probe 同一批文件**。
   spec 未定义回填相对扫描的位置（呼应 3a）。→ F9（🟡）
6. **D13 与 `attempt` 列的冲突（回归风险）**：阶段 2.6 谓词用 `recheck_after`，
   而 `recheck_after` 目前是 `subtitleScheduler.ts:146` 的 bump 唯一写入者、语义是"每日退避"。
   2.6 把它当"7 天复查到点"读。这是 round3 E5 报的"一列多主"，**本轮修订未新增列**，
   spec 仍让 `recheck_after` 承担两种语义（:104 的"明天"与 :108 的"+7天"）。
   影响：可容忍（两者都是"到这个时刻再看"，时长不同而已），不构成阻塞。→ F14（🟢）

### 回归风险（破坏前三轮已修好的东西）
7. **D14 使 R25/R26 对 `handoff_translate` 回归为"永久终态"** —— 前三轮花了 R23/R25/R26 三条裁决建立"无永久终态"，
   D14 在 `handoff_translate` 上把它推翻了。这是本轮最重的回归。→ F1（🔴）
8. **D15 的 `≥7` 若被实现成 `==7` 会使 R10 的"7 次终点"回归为无终点** → F10（🟡，spec 口径不一致导致）
9. **D17 缺重判通路使 C12 的原症状（内嵌中字白跑字幕流）在存量数据上完全未修** → F3（🔴）
10. D13 本身无回归风险 ✓；D16 本身无回归风险 ✓（它是修 C37 的，方向正确，只是 B 档细节缺失）。

---

## 任务三 · 执行顺序调整（1→2→3→4）的影响

### 3-1 第 2 步先接容器，会把未修的 `unavailable` 写入带进生产吗？—— **会，且后果比 spec 预估的更重** 🔴
- `subtitleScheduler.ts:227-228` 在"有 search_source 证据但没找到"时写 `files.sub_status='unavailable'` 且**不递增 attempt**。
  这是最常见失败路径（spec:645-646 自己也这么说）。
- 第 2 步只做"cmdWatch 内把 ScoutDaemon 换成 daemonV2"（spec:454），**不动状态机** →
  接容器当天起，生产库的 `files` 表开始积累 `sub_status='unavailable'` 行。
- 后果 A（可自愈）：第 3 步废止该值时需要一个**存量清洗**——把 `files.sub_status='unavailable'` 改回 NULL。
  spec 第 3 步清单（:472）只写"删除 `unavailable` 写入"，**没有存量清洗项**。
  若不清洗：这些行 `sub_status` 非 NULL → 不满足字幕工作台谓词、也不满足阶段 2.6 谓词（那只认 `unsolvable`）→
  **永久隐形，比 C15 描述的还彻底**（C15 时代至少 `needs_subtitle=1` 还在）。→ F15（🔴 顺序调整**新引入**的项）
- 后果 B（更重，spec 完全没提）：**第 2 步会立刻杀死旧翻译流，比 spec 预估的窗口早一整步**。
  证据链：
  - 旧翻译候选谓词读的是 `episodes`/`movies` 表（`translateWorkerTask.ts:67-71`：`WHERE e.sub_status='unavailable'` / `movies WHERE sub_status='unavailable'`）；
  - 写这两张表 `unavailable` 的是**旧 ingest**（`ingest.ts:238-244` 的 `preserveUnavailable`）；
  - 旧 ingest 由 `daemonDeps.ingestTrigger`/`ingestEveryMs` 驱动（`cli/index.ts:645,693`），
    而 `DaemonV2Deps`（`daemonV2.ts:27-39`）**没有 ingestTrigger、没有 dispatchTranslate**；
  - → 换成 daemonV2 后旧 ingest 与 `dispatchTranslate`（`cli/index.ts:675-680`）**双双停跑** →
    episodes/movies 不再有新 `unavailable` 行 → 翻译从**第 2 步就饿死**。
- spec:495-496 写"本步（第 3 步）废止 unavailable 后旧翻译候选谓词会饿死，窗口期已缩短为一步"。
  **这个判断是错的**：真正的饿死点是第 2 步（停 ingest + 停 dispatchTranslate），不是第 3 步（废值）。
  → 窗口期实际是 **第 2 步 → 第 4 步 = 两步**，顺序调整**没有缩短窗口，只是把起点提前了一步**。→ F16（🟡 spec 结论错误）

### 3-2 第 1 步含 D7 + D11（都在 settingsRepo，不在 scanner）—— 范围确实过大
- 第 1 步现覆盖 4 个模块：`scanner.ts`/`daemonV2.scanOnce`（C1/C11/C12）、`sidecar.ts`（C30 标签统一）、
  `settingsRepo.ts`（D7 addRoot 嵌套检测 + D11 removeRoot 清 files）、`db.ts`（新增 `sub_recheck_at`）。
  外加把 `apiV2.ts:809-818` 的 `findOverlappingRoot` 下移（D7/C39）。
- 且 TDD 用例清单（spec:416-448）已达 **22 条**，横跨"删除保护/指纹重置/sidecar 归属/两档轮转/D8 切分"五个主题。
- 这是 round3 E18 已报的问题，**本轮修订未拆分**。范围过大的真实代价：
  D7/D11 与扫描删除**无代码耦合**（settingsRepo 与 scanner 互不 import），可以独立验收，
  却被绑在同一步 → 若扫描删除部分卡住，D7 这个"防删库前置"也一起卡住，而它恰恰是最该先上的。→ F17（🟡）
- 建议拆：**1a = D7 + D11（settingsRepo，纯防御、无 schema 变更、可立即上线）**；
  1b = 扫描删除 + 指纹重置；1c = sidecar 统一 + 两档机制 + `sub_recheck_at`。

### 3-3 "翻译功能窗口期不可用"具体是哪一步到哪一步？—— spec 说"缩短为一步"，**不对**
- spec:452 与 :496 两处都声称窗口缩短为一步（第 3→4 步）。
- 按 3-1 后果 B 的证据链，真实窗口 = **第 2 步（daemonV2 上容器，ingest + dispatchTranslate 停跑）→ 第 4 步（翻译接新架构）**，
  跨越第 2、第 3 两步。
- 顺序调整（把接容器从第 3 步后提到第 3 步前）的实际效果是：窗口**起点提前一步、长度不变**。
  换来的收益（后续每步都能在生产上真实验证）是真实的，但**代价被 spec 记错了**，
  验收记录若照 spec:496 写"窗口一步"会低估影响。→ F16

---

## 按严重度汇总（本轮新发现 F1–F18）

### 🔴 阻塞（5 条）

#### F1 D14 使 `handoff_translate` 成为真正的永久终态，直接推翻 R25/R26
- 证据：D14（spec:58 / :628）排除 `handoff_translate`；字幕工作台谓词 `sub_status IS NULL`（:100）；
  spec:640-642 明确"翻译开关关闭时仍写 handoff_translate……一直显示停牌"。
- 失效场景：用户从不开翻译（TRANSLATE_* 三件套未配，这是默认状态）。某英语剧满 7 次 + `translatable=1` →
  `handoff_translate`。此后：字幕流看不见它（sub_status 非 NULL）、阶段 2.6 不碰它（D14）、翻译流不启动（开关关）。
  → **永远不再有任何主动搜索**。而 R25 的立论原话正是"用户没开翻译不该被判死刑"，R26 明写"没有真正的永久终态"。
- 修法（三选一，须用户拍板）：
  (a) 让阶段 2.6 也处理 `handoff_translate`，**但只在翻译流未启用时**（`tryAutoTranslateCfg` 为 null 或 `ai_translate_enabled!=='true'`）——
      不启用时没有"飞行中的翻译"可掀，D14 的立论前提不成立；
  (b) judge/分流时若翻译未启用则直接写 `unsolvable` 而非 `handoff_translate`（但违反 spec:640 的"客观归属"设计）；
  (c) 给翻译流自己加周频兜底：`handoff_translate` 且 `tr_recheck_after` 过期且翻译未启用 → 交还字幕流（写回 NULL）。
  推荐 (a)：改动最小，且保留 spec:640-642 的解耦设计。

#### F2 B 档 `sub_recheck_at` 的 NULL 语义未定义 → 静默失效 或 首轮雪崩
- 证据：新列由 ALTER 加入（同 `db.ts:568-570` 口径）→ 存量全 NULL；谓词只写 `sub_recheck_at <= now`（spec:602/:441）；
  本仓既有习惯是补 `IS NULL OR`（`subtitleScheduler.ts:32`）。
- 失效场景：见验证 2b。照字面写 = D16 修复完全不生效且测试全绿（C12 同型）；补 `IS NULL OR` = 上万文件 × 45 stat 挤一轮。
- 修法：迁移里给存量行写 `sub_recheck_at = now + abs(random()) % 604800000`（7 天内随机打散），
  并在 spec 明确"谓词**不含** `IS NULL OR`；新增行由 A 档写入，不依赖 NULL 兜底"。

#### F3 D17 回填 pass 缺"重判通路"，使 D17 与 C12/C38 的修复在存量数据上整体归零
- 证据：judge 谓词 `needs_subtitle IS NULL`（`daemonV2.ts:125`）；回填只写 `embedded_langs`；
  spec:582 仅写"待 D17 回填后重判"这一句期望，**全文无任何把 needs_subtitle / translatable 置回 NULL 的写入者**。
- 失效场景：存量 248 行回填完 `embedded_langs` 后，judge 仍不看它们 →
  ① C12 原症状（内嵌中字白跑字幕流）未消除；
  ② `translatable` 永远 NULL → 按 spec:582"不得判死" → **永远攒不到分流终点，永不停牌、永不移交翻译，每天重试到世界尽头**。
- **与 C35 完全同型**：逻辑自洽 + 缺写入者 + 测试会绿。
- 修法：回填 pass 在写 `embedded_langs` 的同一条 UPDATE 里把 `needs_subtitle` 与 `translatable` 一并置 NULL；
  或给 judge 加分支谓词 `(needs_subtitle IS NULL OR translatable IS NULL)`。

#### F4 "未 probe" 与 "probe 过但无内嵌轨" 在库里不可区分 → 回填 pass 无法收敛
- 证据：`embedded_langs` 单列表达两义；`daemonV2.ts:134` 与 `subtitleJudge.ts:32` 都只判 `!= null`；
  spec 未定义 probe 失败/无轨时写什么。
- 失效场景：回填 pass 想按 `embedded_langs IS NULL` 挑活。真·无内嵌轨的文件若写 `'[]'` 则能收敛；
  若写 NULL（或 probe 失败留 NULL）→ **每轮重新 probe 同一批**，在 FUSE 网盘上每轮数小时，永不收敛。
- 修法：加 `probed_at INTEGER` 作为完成标记（推荐，语义干净），或 spec 明确约定"无轨写 `'[]'`、失败写 `'[]'` 并 last_error 记因"。

#### F15 第 2 步先上容器会积累 `sub_status='unavailable'` 存量，第 3 步无清洗项 → 永久隐形行
- 证据：`subtitleScheduler.ts:227-228` 写 `unavailable` 未修；第 2 步只换 daemon 不动状态机（spec:454）；
  第 3 步清单（spec:472）只写"删除 unavailable **写入**"，无存量清洗。
- 失效场景：第 2 步到第 3 步之间生产跑了 N 天，积累若干 `sub_status='unavailable'` 行。
  第 3 步上线后，这些行 `sub_status` 非 NULL → 不在字幕工作台（要 IS NULL）、不在阶段 2.6（只认 `unsolvable`）、
  不在翻译工作台（只认 `handoff_translate`）→ **三个工作台全不认，永久隐形**。
  且 D16 的 B 档能把它转成 covered（如果磁盘上真有字幕），但转不成任何"待处理"态。
- 修法：第 3 步 schema 迁移里加一条 `UPDATE files SET sub_status=NULL WHERE sub_status='unavailable'`，
  并在验收清单加"迁移后 `SELECT COUNT(*) FROM files WHERE sub_status='unavailable'` 必须为 0"。

### 🟡 该修（9 条）

#### F5 `sub_recheck_at` 与 `recheck_after` 命名过近，易实现错列
证据：`db.ts:570` vs spec:600；旧表 5 处 `recheck_after` 语义（`db.ts:40,53,158,232,247`）反而更接近新列语义。
修法：新列改名 `sub_presence_check_at`，或把 `recheck_after` 语义在 spec 里改称 `sub_retry_after`（列名不变但文档统一叫法）。

#### F6 B 档会对已消失/断连的幽灵行做 45 次 ENOENT stat
证据：spec §2 把"存在性观察"（:78-80）与"DELETE"（:81）都放阶段 1 内，未定义先后；R8 保护跳过删除时幽灵行长期存在。
修法：B 档挑中的行先 stat 视频本体 1 次，ENOENT 则跳过 45 次探测。

#### F7 A 档与 B 档可同时命中同一文件 → 90 次 stat/文件，无去重声明
证据：spec:595-603 分别定义触发对象，无并集去重语句。
修法：spec 明确"两档合并成一个待检 Set，每文件每轮最多检测一次"。

#### F8 D17 回填 pass 的归属步骤自相矛盾（第 2 步前置 vs 第 3 步内）
证据：spec:382 写"列为第 2 步前置"，spec:470 写在第 3 步清单内。第 2 步（接容器）与 embedded_langs 无任何关系。
修法：统一为"第 3 步内、judge 改造之前"。

#### F9 回填 pass 与扫描（C11 清空 embedded_langs）的相对顺序未定义
证据：C11（spec:183）要求指纹变化清空 `embedded_langs`；spec 未说回填在扫描前还是后。
失效场景：若回填先于扫描且该文件本轮指纹变化 → 刚回填的值被清 → 下轮再 probe → 每轮重复。
修法：回填 pass 固定排在阶段 1 之后、judge 之前。

#### F10 `≥7` 与 `达 7` 口径不一致 → 若实现成 `===7` 则 R10 的终点机制回归为无终点
证据：spec:475/:59 写 `≥7`；spec:569-570 转换表两行写"sub_attempt **达 7**"。
失效场景：`===7` 下，2.6 放回后 `sub_attempt` 变 8 → 永不再分流 → 退回每日重试（约 365 session/年，比 D15 要避免的 182 更糟）；
单测只覆盖"首次到 7"会全绿。
修法：转换表两行改为"sub_attempt **≥7**"，TDD 补一条"sub_attempt=8 时失败 → 必须停牌"。

#### F13 D8 未交代 `judgeSubtitle` 的 `hasSidecarSubtitle` 入参与 `daemonV2.ts:137-140` 探测代码的去向
证据：`subtitleJudge.ts:14,38`（入参 + 规则 3）、`daemonV2.ts:137-140`（readdirSync 探测）；spec:446 只说"规则 3 从 needs_subtitle 移除"。
失效场景：只删 judge 的 `if`、保留 daemonV2 的探测调用 → 每 judge 行白付一次 readdirSync；
或反之删了探测、留了入参 → 永远传 false，语义上等价于删除但留下误导性死参数。
（这是 round3 E6，本轮未采纳，因 D16 两档机制的存在而更重要：探测应统一走 sidecar.ts 单一实现。）
修法：spec 明确"删 `JudgeInput.hasSidecarSubtitle` 与 `reason:'sidecar'` 分支，删 `daemonV2.ts:137-140`，
sidecar 探测唯一实现落在扫描侧的 `findExternalSidecar`"。

#### F16 spec 关于"翻译窗口期缩短为一步"的结论错误，真实窗口是第 2→4 步（两步）
证据链：`DaemonV2Deps`（`daemonV2.ts:27-39`）无 `ingestTrigger`/`dispatchTranslate`；
旧翻译候选读 episodes/movies 的 `unavailable`（`translateWorkerTask.ts:67-71`）；
该值由旧 ingest 写（`ingest.ts:238-244`）；旧 ingest 与 `dispatchTranslate` 都挂在 `daemonDeps`（`cli/index.ts:645,675-680`）。
→ 第 2 步换掉 ScoutDaemon 即同时停掉 ingest 与 dispatchTranslate，翻译从第 2 步饿死。
修法：spec:452/:496 改为"窗口 = 第 2 步 → 第 4 步（两步）；顺序调整把起点提前一步、长度不变，
换来的是后续每步可在生产验证"。验收记录按此写。

#### F17 第 1 步范围过大：D7/D11 与扫描删除无代码耦合却被绑在同一步，22 条 TDD 用例横跨 4 模块
证据：D7/D11 在 `settingsRepo.ts:115,159-215`（+ `apiV2.ts:809-818` 下移），扫描在 `daemonV2.scanOnce`（:154-186）/`scanner.ts`；
两者互不 import。spec:416-448 共 22 条用例。
修法：拆为 1a（D7+D11，纯防御无 schema 变更，可最先上线）/ 1b（扫描删除+指纹重置）/ 1c（sidecar 统一 + 两档 + `sub_recheck_at`）。

### 🟢 建议（3 条）

- **F11** 阶段 2.6 在 `runInspection` 中的插入点未写进 spec。可实现（`daemonV2.ts:91` 与 `:95` 之间），但应在 spec §4 第 3 步明确写"插在 `judgeOnce()` 之后、字幕 while 之前"。
- **F12** 同一文件的 `recheck_after`（2.6）与 `sub_recheck_at`（B 档）常同日到点；现顺序（阶段 1 在 2.6 前，spec:76 vs :93）恰好最优（先确认已有字幕可省一次 LLM），但这是巧合而非声明 → 建议 spec 写明"B 档必须先于阶段 2.6"。
- **F14** `recheck_after` 仍一列两义（spec:104 的"明天"与 :108 的"+7天"）。可容忍（都是"到此刻再看"），记为已知取舍即可，不必新增列。
- **F18** `sub_attempt` 长期单调增长（每周 +1）。数值安全，但任何按 attempt 算阶梯的逻辑（如 `subtitleScheduler.ts:144-145` 的旧注释思路）会失真；界面若显示"已尝试 N 次"需说明语义。建议 spec 注明"sub_attempt 停牌后只作 ≥7 的布尔判据，不再有阶梯含义"。

---

## 总结论

### 三条致命问题是否真的闭合？

| 编号 | 判定 | 理由 |
|---|---|---|
| **C35**（R25 复查无执行者） | **部分闭合** | 执行者（D13 阶段 2.6）已给出且**可实现**（`daemonV2.ts:91/95` 之间有明确插入位）；两个谓词**严格互斥**（`IS NULL` vs `='unsolvable'`）；成本节奏（D15，52 次/年）正确。**但 D14 排除 `handoff_translate` 后，在"用户不开翻译"这个默认场景下该状态成为真正的永久终态（F1）**，与 R25/R26 直接冲突——round3 E1 的"永久停牌"问题原地复活。另 `≥7` vs `达 7` 口径不一（F10）。 |
| **C37**（D12 与 R23 互掐） | **部分闭合** | D16 的原则（复核范围含停牌态、B 档不按 sub_status 过滤）**方向正确且写清了**（spec:605-607），A/B 两档具体化到可实现（:595-603）。**但 B 档的 NULL 语义未定义（F2，静默失效或首轮雪崩二选一）、幽灵行 stat（F6）、A/B 重复检测（F7）三项缺失**，其中 F2 是确定发生的。 |
| **C38**（D9 前提不存在） | **未闭合** | D17 只写了"需要一个回填 pass"这一句意图，**触发者与执行位置完全未定义（3a，且 :382 与 :470 自相矛盾）、性能约束/分批/失败重试完全未定义（3b）、"未 probe" 与 "无内嵌轨" 不可区分使 pass 无法收敛（F4）**。最致命的是**重判通路缺失（F3）**：回填不改 `needs_subtitle` → judge 谓词 `needs_subtitle IS NULL`（`daemonV2.ts:125`）永不再看存量行 → C12 原症状未消除，且新列 `translatable` 对存量行永远 NULL → 按 spec:582"不得判死" → **存量行永远攒不到分流终点，永不停牌永不移交翻译**。这与 C35 **完全同型**（逻辑自洽 + 缺写入者 + 测试会绿）。 |

### spec 现在能否进入实现阶段？

**不能全量开工，但可以部分开工。**

- **不能**的理由：F3（D17 无重判通路）与 F1（D14 造出永久终态）都是"整条裁决在真实数据/默认配置下归零"级别的洞，
  且 F3 与 C12/C35 是同一个反复出现的模式——本轮已是**第三次**栽在"spec 写了要写某列，但没写谁来写/谁来重读"上。
  F2 与 F15 是确定发生（非概率性）的实现分歧点。这四条不补，第 3 步做完仍会得到一个"测试全绿、生产静默失效"的系统。
- **可以**的理由：**第 1 步的 D7 + D11 部分（拆分后的 1a）已经完全可实现**——
  它不依赖 D13–D17 任何一条、无 schema 变更、检测逻辑已存在（`apiV2.ts:809-818`）只需下移、
  清理位置已确认（`settingsRepo.ts:159-215` 一行 files 都不碰）。且它是防"删库灾难"（C29）的前置，最该先上。

### 还必须补的条目（少而精，只列真正阻塞的 4 条）

1. **F3** — D17 回填 pass 必须同时把 `needs_subtitle` 与 `translatable` 置 NULL（或给 judge 加 `translatable IS NULL` 分支）。
   这是"回填有没有意义"的开关，不补则 D17 = 白跑 ffprobe。
2. **F1** — D14 必须给"翻译未启用时的 `handoff_translate`"一条出路（推荐：阶段 2.6 在翻译未启用时也处理它）。
   需用户拍板，因为它触及 R25 与 D14 的取舍。
3. **F2** — B 档 `sub_recheck_at` 的 NULL 处理必须写死（推荐：迁移时 7 天内随机打散 + 谓词不含 `IS NULL OR`）。
4. **F15** — 第 3 步 schema 迁移必须含 `UPDATE files SET sub_status=NULL WHERE sub_status='unavailable'` 存量清洗
   （这是执行顺序调整**新引入**的，第 2 步先上容器才有的问题）。

（F4 强烈建议一并补——加一个 `probed_at` 列，成本极低，否则回填 pass 永不收敛。
 F5/F16/F17 属"该修但不阻塞"：F16 只需改 spec 两句话与验收记录口径；F17 只需把第 1 步拆成 1a/1b/1c。）

### 若决定先开工（只做拆分后的第 1a 步：D7 + D11），最需小心的 3 个点

1. **D7 必须是"下移"而非"重写"**（C39/D7）。`apiV2.ts:809-818` 的 `findOverlappingRoot` 已是完整双向重叠检测且 `addMediaRoot` 在用；
   要把它移进 `settingsRepo`，让 `addRoot`（`:115`，现为裸 `INSERT OR IGNORE`）与 `seedRootsFromEnv`（`:126-131`，它调 `addRoot`）
   **共用同一份**。注意 `seedRootsFromEnv` 是循环调 `addRoot`，逐条检测时**后加的 root 要与本批已加的比对**，
   不能只与库里既有的比对（否则 env 里同时写 `/media,/media/115` 会全部种进去）。
2. **D11 的测试必须走 `removeRoot` 真实入口**（D11 明文要求）。`settingsRepo.removeRoot`（`:159-215`）已有一个 `tx.immediate()` 事务，
   新增的 `DELETE FROM files WHERE substr(path,1,length(?))=?` 必须**放进这个事务内部**，
   并沿用它既有的 `substr` 前缀比较手法（**不要用 LIKE** —— 注释 `:147-150` 记了原因：媒体路径合法含 `%`/`_`，
   如 "100% Pascal-sensei"、"Look_Back"）。且 root 后缀补 `/` 防 `/media/tv` 误伤 `/media/tv2`。
3. **既有嵌套配置的存量处置**。D7 只拒绝**新增**嵌套；生产库里可能**已经**存在嵌套 root
   （`addRoot` 至今无检测，`seedRootsFromEnv` 是旁路）。上线 D7 的同时必须跑一次检测并**告警**（spec:313 提到"迁移时告警"），
   否则 C29 的删库场景在存量配置上依然成立——而第 1b 步（扫描删除 + D1 逐根差集）一上线就会引爆它。
   顺序铁律：**D7 的存量检测/告警必须早于 D1 的删除逻辑上线**。

---

状态：**已完成**
