# 第三轮审计（定稿前最后一轮）

**日期**: 2026-08-08
**对象**: `docs/design/2026-08-08-PIPELINE-SPEC.md`（566 行，已两轮修订）
**范围**: 只审前两轮修订**新引入**的问题（D6–D12、R25–R26）与残留矛盾；C11–C34 已收录者不重复报告
**状态**: ✅ 审计完成

---

## 审计角度进度

- [x] 1. R25 周频复查的长期行为与 LLM 成本 → E1, E2
- [x] 2. R25 与工作台谓词的鸡生蛋问题 → E3, E4, E5
- [x] 3. D8 职责切分的完整性 → E6, E7, E8
- [x] 4. D6 出队凭据的时间窗口 → E9
- [x] 5. D12 低频复核机制缺失 → E10, E11
- [x] 6. D9 与 embedded_langs 存量数据 → E12, E13
- [x] 7. 状态转换表完备性 → E14, E15, E16
- [x] 8. 执行顺序依赖 → E17, E18, E19, E20
- [x] 9. MVP 边界清晰度 → E21, E22
- [x] 10. 整体可实现性 / 语义模糊点 → E23–E28

---

（发现逐条追加于下）

---

## 角度 1：R25 周频复查的长期行为与 LLM 成本

### E1 🔴 「sub_attempt 归零」使停牌文件的搜索频率变成 7 次/14 天，与 R25 原话「每周找一次」直接矛盾

**证据**
- spec:391（第 2 步）：「停牌态文件 recheck_after=+7天；到点回 NULL、**sub_attempt 归零**，重进字幕流」
- spec:401（TDD 红线）：「停牌满 7 天 → 回 NULL 重进字幕流」——把该行为钉进验收
- spec:61（R25 原话）：「停牌期间字幕流**继续每周找一次**（非每天）」
- spec:501（§5 转换表）：`unsolvable | 每周复查到点 | NULL | 字幕流 | sub_attempt 归零，重进字幕流`
- 巡检频率为每日一次：`src/v2/daemonV2.ts:25` `INSPECT_INTERVAL_MS = 24h`；失败退避 `subtitleScheduler.ts:138` `backoffFor = () => 24h`

**失效场景（算术）**
一个永远找不到中文字幕的文件（例：小语种冷门片，translatable=0）：
- 归零方案：第 0 天回 NULL、attempt=0 → 第 0..6 天每天跑一个完整 LLM session（7 次）→ 第 7 天 attempt=7 → 回 unsolvable → 等 7 天 → 循环。
  **周期 14 天，烧 7 个 session** ≈ 182 session/年/文件。
- 不归零方案：attempt 停在 7，第 7 天回 NULL 跑 1 次 → 失败即 attempt=8≥7 → 立刻回 unsolvable + recheck_after=+7天。
  **周期 7 天，烧 1 个 session** ≈ 52 session/年/文件。

按 `CURRENT-STATE` 记录的规模（248 files / 83 works），若其中 30 个文件长期停牌，归零方案 ≈ 5460 session/年，不归零 ≈ 1560 session/年，差 3.5 倍。且归零方案的搜索**并非均匀分布**，是「猛攻 7 天 + 静默 7 天」，与「每周找一次」的字面语义不符。

**判断**：不归零更符合 R25 原意（「每周找一次」= 每 7 天 1 次尝试）。归零是把「重试预算」误当成「状态重置」。
另有副作用：归零后 sub_attempt 失去累计语义，运维再也无法从库里区分「刚失败 1 次」与「找了 100 次」。

**建议修法**
1. 周频复查**只清 sub_status（→NULL）+ 写 recheck_after，不动 sub_attempt**。
2. 因 sub_attempt 已 ≥7，需把「满 7 次分流」的判定从 `sub_attempt >= 7` 改为**在本轮失败后判定**（即：失败 → attempt+1 → 若 attempt>=7 则立即写停牌态 + recheck_after=+7天）。这样第 8/9/... 次失败都是「1 次搜索 + 回停牌 + 等 7 天」，天然实现周频。
3. spec:391 与 spec:401 与 spec:501 三处一并改；TDD 用例改为「停牌满 7 天 → 回 NULL 且 sub_attempt **保持 7** → 本轮失败后立刻重回停牌（不得再连跑 7 天）」。
4. 若用户确实要「归零」，则必须在 spec 里显式记下这个成本取舍（7 次/14 天），不能让实现者以为它等价于「每周一次」。

### E2 🟡 周频复查的间隔与「每日巡检」的对齐方式未定义 → 实际周期可能是 7~8 天且逐轮漂移

**证据**
- spec:391 只写 `recheck_after=+7天`
- 巡检时间闸是「距上次**开始**满 24h」（spec:48 / D4），巡检本身耗时不定（spec:249 假设大库跑 10h）

**失效场景**：recheck_after = T+7d，而下一次巡检发生在 T+7d+Δ（Δ 为巡检起点与 recheck 到点的相位差，最坏接近 24h）。相位差每轮累加巡检耗时抖动 → 实际复查周期在 7~8 天间游走。这本身可接受，但**不能同时把 TDD 写成「满 7 天必复查」**，否则用真实时钟的 e2e 会假红。

**建议修法**：spec 明确「周频 = 至少 7 天，实际由下一次巡检触发」，并把 D12 的低频复核与 R25 的周频复查**统一到同一个「周节拍」**（见 E9），避免两套周期各自漂移。

---

## 角度 2：R25 周频复查的执行者缺失（鸡生蛋）

### E3 🔴 停牌态文件不满足任何工作台谓词，「周频复查」在流水线图里**没有执行者**

**证据**
- 字幕工作台谓词（spec:87）：`needs_subtitle=1 且 sub_status IS NULL 且 recheck_after 已过`
  - 现码 `src/v2/subtitleScheduler.ts:31-32` 也只有 `needs_subtitle = 1 AND (recheck_after IS NULL OR recheck_after <= ?)`（连 sub_status 条件都还没有，spec 要求加）
- 翻译工作台谓词（spec:101）：`sub_status='handoff_translate' 且 tr_recheck_after 已过`
- §5 转换表 spec:501 把这条转换的「写入者」标为**字幕流**
- 但 spec §二 的阶段 1/2/2.5/3/4 五个阶段里，**没有任何阶段负责把 `unsolvable`/`handoff_translate` 改回 NULL**。spec:95 只说「两者都继续每周复查一次（R25）」，是结论不是机制。

**失效场景**：实现者照 §二 与 §5 逐条实现，写完发现 `unsolvable` 行没有任何 SELECT 会捞到它 → R25 静默不生效 → 回归「永久判死刑」，正是 R25 要废止的行为。而且**测试也抓不到**：TDD 用例 spec:401「停牌满 7 天 → 回 NULL」若用「直接调某个函数」写，会绿；接到 daemon 上则永不触发（与 C12「embedded_langs 从未被写入」同型的静默失效）。

**建议修法**：新增显式阶段 **2.6「停牌复查闸」**（纯机械 SQL，无 LLM），位置在 judge 之后、字幕工作台之前，语义为：
```sql
UPDATE files SET sub_status = NULL, recheck_after = NULL, updated_at = ?
WHERE sub_status IN ('handoff_translate','unsolvable')
  AND recheck_after IS NOT NULL AND recheck_after <= ?
```
并在 §二 流水线图、§四第 2 步、§5 转换表三处同时登记该阶段为写入者（不要写成「字幕流」——字幕流的定义就是那个谓词，写成字幕流必然复现本条）。

### E4 🔴 周频复查把 `handoff_translate` 改回 NULL 会**掀掉正在飞行中的翻译**，并让 D10 守卫静默吞掉结果

**证据**
- spec:482：`handoff_translate ... 仍每周复查（R25）`；spec:95：「两者都继续每周复查一次」
- spec:107 / spec:432 / spec:546（D10）：翻译回写带守卫 `WHERE sub_status='handoff_translate'`
- spec:184-185（C14）：要求两工作台谓词互斥（`IS NULL` vs `='handoff_translate'`）
- 翻译是 `SELECT → await LLM（数分钟~更久）→ UPDATE`（spec:319）

**失效场景**：文件 X 处于 `handoff_translate`，tr_recheck_after 到点，翻译流领走并开始 await LLM。同一进程的主巡检（R19 主进程内独立循环，spec:38）跑到停牌复查闸，发现 X 的 recheck_after 也到点 → 把 sub_status 改成 NULL。
1. X 立刻同时满足**字幕工作台谓词**（needs_subtitle=1, sub_status IS NULL, recheck_after 已清）→ 字幕流也开始为它跑 agent → **两条付费流同时处理同一文件**，违背 C14 互斥不变量。
2. 翻译 LLM 返回后回写，D10 守卫 `WHERE sub_status='handoff_translate'` 匹配 0 行 → **tr_attempt 不涨、tr_recheck_after 不写** → 翻译流下一圈立刻重领同一行 → 付费 LLM 热循环（正是 D6/C26 要防的东西，被 R25 从侧门放回来了）。

**建议修法（三选一，spec 须明确择一）**
- (a) **`handoff_translate` 不参与周频复查**——它不是「无能为力」，它有明确归属者（翻译流），其重试节奏由 `tr_recheck_after` 全权负责。只有 `unsolvable` 参与周频复查。这与 R25 原意（「翻译开关没开也不该判死刑」）的兼容做法是：翻译开关关闭时满 7 次**不写 handoff_translate 而写 unsolvable**，或让停牌复查闸只处理 `unsolvable`，而 handoff_translate 的「找不到就再等」由 tr 轨自己周频。**推荐此项**（最简单、无并发面）。
- (b) 保留 handoff_translate 的周频复查，但停牌复查闸必须加 in-flight 排除条件（需要一个 in-flight 集合——注意 C34 已记 `gcStaging` 的 in-flight 集合就是空的，本项会引入第二个同型缺陷）。
- (c) 把「周频复查」实现为**不改 sub_status**，而是另开一列 `sub_recheck_at`，字幕工作台谓词改为 `(sub_status IS NULL OR sub_recheck_at <= now)`。互斥性靠翻译流用 `tr_recheck_after` 独立管。此项改动面最大。

### E5 🟡 停牌复查闸复用 `recheck_after` 一列表达两种语义（「每日重试」与「每周复查」）→ C7 型一列多主

**证据**
- spec:91：找不到 → `recheck_after=明天`
- spec:391：停牌 → `recheck_after=+7天`
- spec:90（D6）：装盘成功 → `recheck_after=明天`（出队凭据）
- 而 C7/D3 的原则明确写着「一列多主必然语义污染」（spec:147, spec:52 D3）

**失效场景**：`recheck_after` 现在同时是「字幕流下次重试时刻」「装盘后的出队冷却」「停牌周频复查时刻」。三者的读者不同（字幕工作台读前两个，停牌复查闸读第三个）。当 E3 的复查闸 SQL 写成 `WHERE sub_status IN (...) AND recheck_after <= now` 时，它无法区分「停牌时写的 +7 天」与其他来源；而当停牌文件被复查回 NULL 又立刻失败时，字幕流会把 recheck_after 改成「明天」——**下一轮停牌时若忘记重写 +7 天，就退化成每天复查**（E1 的极端版：每天 1 session）。

**建议修法**：按 D3 同样的原则加独立列 `park_recheck_at`（或至少在 spec 里把「停牌态文件的 recheck_after 必须且只能由停牌分流写入 +7 天」列为不变量 + TDD 用例）。

---

## 角度 3：D8 职责切分的完整性

### E6 🟡 D8 未交代 `hasSidecarSubtitle` 入参与 daemonV2 里那段 sidecar 探测代码的去向 → 死参数 / 死代码留存

**证据**
- `src/v2/subtitleJudge.ts:14` `hasSidecarSubtitle: boolean`（JudgeInput 字段）、`:19` `hasSidecar?: (videoPath: string) => boolean`（JudgeDeps 里的另一个、当前**根本没被用**）、`:39` 规则 3、`:23` verdict 的 `'sidecar'` reason
- `src/v2/daemonV2.ts:135-141`：judgeOnce 内联的 sidecar 探测（`readdirSync` + 正则）——正是 C30 记录的「漏 `cht`」那份
- spec:379（第 1 步用例）只写「judge 规则 3（sidecar 检测）**从 needs_subtitle 移除**，改由扫描写 sub_status」

**失效场景**：「移除规则 3」有三种实现：(i) 删规则但保留入参恒传 false；(ii) 删规则 + 删入参 + 删 `'sidecar'` reason；(iii) 只在 daemonV2 里把 `sidecar` 变量恒传 false，judge 函数不动。三者的测试面完全不同，且 (i)(iii) 会把 `daemonV2.ts:135-141` 那段有 bug 的探测代码留在原地——将来有人「顺手复用」它就复活 C30 的误归属与漏 tag。

**建议修法**：spec 第 1 步用例改为显式的删除清单：删 `JudgeInput.hasSidecarSubtitle`、删 `JudgeDeps.hasSidecar`（本就未用）、删 verdict 的 `'sidecar'` 分支、删 `daemonV2.ts:135-141` 的内联探测，并声明「sidecar 探测在全仓只剩扫描侧一处实现」（与 C30「两处标签集统一为单一函数」咬合）。

### E7 🟡 D8 的切分标准未写明，「内嵌中字留在 needs_subtitle 而 sidecar 不留」看起来任意

**证据**
- spec:52（D8）：`needs_subtitle` 只表达「原则上需要中文字幕」（**语言/内嵌轨事实**，装盘不改它）；`sub_status` 表达「磁盘上当前有没有」
- 但内嵌轨同样是「磁盘上的事实」，`subtitleJudge.ts:33-37` 规则 2 与 `:39` 规则 3 在代码里是完全同构的两个布尔判断

**分析**：实际存在一条自洽的判据，只是 spec 没写出来——
> `needs_subtitle` = **该视频文件自身的内在属性**（origin_lang、容器内的轨道），只随**该文件被替换**而改变；C11 已规定指纹变化时清 embedded_langs，正好触发重判。
> `sub_status` = **同目录旁的其他文件**的存在性，可独立于视频文件变化。

判据成立，但 spec 现在的表述（「语言/内嵌轨事实」）是**列举**而非**判据**。实现者遇到未列举的情形（例：`.idx/.sub` 图形字幕、目录级 `Subs/` 子目录、内嵌中文**图形**轨 PGS）无从推断该归哪列。

**建议修法**：把上述判据一句话写进 D8：「凡随视频文件本体变化的事实归 needs_subtitle（由 judge 写，指纹变化时重判）；凡可独立于视频文件变化的旁路文件事实归 sub_status（由扫描写）」。

### E8 🟡 `needs_subtitle=0` 的行 `sub_status` 永远是 NULL，而 §5 把 NULL 定义为「磁盘无中字，待处理/重试中」→ 语义重载，界面必然误显示

**证据**
- spec:480（§5 状态表）：`NULL | 磁盘无中字，待处理/重试中（含"搜过确实没有"） | 字幕工作台排它`
- D8 后，国产片（规则 1 origin-skip，`subtitleJudge.ts:29-31`）与内嵌中字片（规则 2）都是 `needs_subtitle=0`；而扫描只在**扫到同名中文 sidecar** 时写 covered（spec:73）——内嵌中字片旁边没有 sidecar 文件 → `sub_status` 永久 NULL
- §5 的 NULL 行明确写「字幕工作台排它」，但这些行不会被排（谓词有 `needs_subtitle=1`）

**失效场景**
1. 界面若按 `sub_status` 渲染（§5 自称是「界面语义」的权威，spec:509），一部内嵌中字的日漫会永远显示成「磁盘无中字，待处理」——用户看到的是「系统一直没搞定」，事实是「本来就不用搞」。
2. 更实际的后果：旧 schema 曾有 `'embedded'` 这个值承担此语义（`src/v2/db.ts:513` 注释 `NULL=未处理；'missing'/'covered'/'embedded'/'unavailable'`），R17 的「恰好四态」把它废了，但**没有指定替代的表达方式**。
3. 反向的双重记账风险：若实现者为了修 1，让扫描/judge 给内嵌中字片也写 `covered`，就出现「needs_subtitle=0 且 sub_status=covered」——而 covered 的定义（spec:481）是「扫描确认磁盘上有同名中文字幕**文件**」，内嵌轨不是文件 → covered 的语义被污染，且字幕消失回退逻辑（spec:494）会去找一个从来不存在的 sidecar 并把它回退成 NULL。

**建议修法**：spec §5 明确「`sub_status` 的语义只对 `needs_subtitle=1` 的行有效；`needs_subtitle=0` 的行 sub_status 恒为 NULL 且界面须显示为『无需中文字幕』（不是待处理）」，并加 TDD：内嵌中字片 → needs_subtitle=0 且**不得被写 covered**。§7 的「停牌在界面上的具体呈现」条目应同时登记这第三种界面态。

---

## 角度 4：D6 出队凭据的时间窗口

### E9 🟡 D6 的 `recheck_after=明天` 与巡检节拍**同频**，装盘成功的文件在下一轮巡检里会与扫描确认发生赛跑

**证据**
- spec:90（阶段 3）：装盘成功 → 「只写 recheck_after=**明天** 出队（D6），等下次扫描确认」
- spec:490（§5 转换表）：`NULL | 字幕 worker 装盘成功 | NULL（不变） | 字幕流 | 写 recheck_after 出队（D6）`
- 巡检节拍恰为 24h（`src/v2/daemonV2.ts:25`），且时间闸按 D4 = 距**开始**满 24h（spec:48）
- 阶段顺序：扫描（`daemonV2.ts:76` scanOnce）→ 识别 → judge → 字幕（`:94-103`）；即**同一轮内扫描先于字幕**

**分析**：顺序上是安全的——第 N+1 轮巡检里扫描（阶段 1）先跑，把 sub_status 写成 covered；字幕工作台谓词含 `sub_status IS NULL`，所以阶段 3 时该行已被 covered 排除，**不会**被重选。这一点 spec 是自洽的，**不构成阻塞**。

但存在两个真实的边界问题：
1. **`recheck_after = 明天` 与 `巡检间隔 = 24h` 精确同频**。装盘发生在第 N 轮的阶段 3（设为 T+h，h = 该轮已耗时），recheck_after = T+h+24h。第 N+1 轮巡检在 T+24h 开始（D4 按开始计），其阶段 1 扫描时刻约 T+24h+ε。若装盘发生在巡检早期（h 小），阶段 1 早于 recheck_after 到点 → 扫描写 covered，安全。若 **装盘发生在巡检晚期**（大库跑 10h，h=10h），recheck_after = T+34h，而第 N+1 轮阶段 1 在 T+24h 就扫到了 → 也安全（covered 更早）。所以 **扫描先跑确实能保证正确**——但只在「扫描能扫到该字幕」的前提下成立。
2. **装盘成功但字幕未落地（R24 明确要覆盖的场景）时，该文件的重试被推迟了整整一轮**：第 N+1 轮阶段 1 扫不到字幕 → sub_status 仍 NULL；阶段 3 谓词还要求 `recheck_after 已过`，而 recheck_after=T+h+24h 可能 > 阶段 3 时刻 → **本轮不重试，要等第 N+2 轮**。且 **sub_attempt 未递增**（spec:490 只写 recheck_after，不写 attempt+1）。这意味着「装盘声称成功但反复不落地」的文件：既不计数、又每两轮才试一次 → **永远攒不到 7 次**，永不进翻译流。这是 C15/C13「永攒不到 7 次」缺陷在 D6 上的复活。

**失效场景（具体）**：115 只读挂载（`daemonV2.ts:105-115` 的 writableRoots 会过滤，但生产上 rclone 挂载可能"可写但静默丢写"，spec:60 R24 明言要覆盖"装盘成功但文件没落地"）→ worker 每次报 installed → 每两轮试一次 → sub_attempt 恒为 0 → 无限循环，无终点，且无任何告警。

**建议修法**
1. 装盘成功也**递增 sub_attempt**（或另设 `install_unconfirmed_count`），使「声称成功但未落地」有终点。§5 转换表 spec:490 的「附带」列须补。
2. 为避免与巡检同频，装盘后的 recheck_after 建议写「**当前时刻**（不推迟）」——出队靠的是同轮内不再重选，而同轮不重选可以用「本轮已处理集合（内存 Set）」保证，比时间戳更精确。或者写 `recheck_after = 下一轮巡检必定已过的一个值`（如 +1h），确保下一轮阶段 3 一定能重试。
3. spec 须明确「装盘成功 → 下一轮扫描未确认 → 会发生什么」这条转换。**当前 §5 转换表里没有这一行**（见 E12）。

---

## 角度 5：D12 低频复核机制缺失

### E10 🔴 D12 的「低频复核」只有括号里的两个「如」，无可实现定义 → 两个实现者必然写出不同东西

**证据**
- spec:56（D12）：「未变化文件走**低频复核**（如每周一轮或按 covered 抽样）」
- spec:307：「未变化文件走低频复核（每周一轮或对 covered 抽样）」
- spec:376（第 1 步 TDD 用例）：「**未变化文件不做全量 45 次 stat**，走低频复核（D12 性能约束）」——这条用例**无法写**：它只是否定式约束，没说肯定式行为是什么

**语义分歧点（各自都符合 spec 字面）**
| 实现 A | 实现 B | 实现 C |
|---|---|---|
| 每 7 天做一轮全量 sidecar 检测（所有未变化文件） | 每轮巡检随机抽 5% 的 covered 行检测 | 每行加 `sidecar_checked_at`，每轮只检测最旧的 N 行 |

三者的**覆盖延迟**分别是 ≤7 天 / 20 轮（期望）/ 总数÷N 天，性能特征、可测试性完全不同。且 A 需要一个「上次全量复核时刻」的 meta 键（spec 未定义），C 需要一个新列（spec 未列入 schema 变更清单 spec:384-386）。

**建议修法**：spec 须定一个。推荐 C（逐行 `sidecar_checked_at` + 每轮限额 N），理由：(i) 无「雪崩式全量周」的性能尖峰；(ii) 覆盖延迟有硬上界且可从库里查（运维可观测）；(iii) 抽样（B）的覆盖延迟是概率性的，无法写确定性 TDD。并把 `sidecar_checked_at INTEGER` 补进第 2 步（或第 1 步）的 schema 变更清单。

### E11 🔴 若低频复核只覆盖 `covered`，则 **R23「用户手放字幕也认」对停牌态文件几乎永不生效**

**证据**
- spec:56 / spec:307 的「按 covered 抽样」措辞
- spec:500（§5 转换表）：`unsolvable | 扫描发现字幕出现 | covered | 扫描 | 停牌自然解除；用户手放的也认`
- spec:521：「用户自己手动放了一个字幕进去 → 同样扫到就认（R24 的附带收益）」
- spec:371（第 1 步用例）：「停牌中（handoff_translate/unsolvable）的文件突然出现字幕 → 变 covered」
- 关键：**用户手放字幕不改变视频文件的 mtime/size**（正是 C19 的根因，spec:220-221 已确认扫描指纹只看视频文件，sidecar 不产生 files 行）

**失效场景**：用户看到界面上某集「停牌」，手动下载一个字幕丢进目录。该视频文件指纹未变 → 不在「新增/指纹变化」集合内 → 只能靠低频复核发现。若低频复核按 spec 的「对 covered 抽样」实现，则 **停牌态文件（sub_status 非 covered）根本不在复核范围内** → 界面永远显示停牌，直到用户去动一下视频文件。这与 spec:371 的 TDD 用例、spec:500 的转换表、R23/R24 的整个设计意图**直接冲突**——而 TDD 用例（spec:371）会绿，因为它必然是「直接调扫描函数 + 造好字幕文件」写的，不会经过「低频复核采样是否命中」这一层。

**这是本轮最隐蔽的一条**：spec 的两处（D12 的性能优化 与 R23/R24 的事实观察）单独看都对，合起来把「用户手放字幕」这条最重要的解除路径掐死了，而且测试抓不到。

**建议修法**
1. 低频复核的范围必须是 **`needs_subtitle=1` 的全部行**（covered / NULL / handoff_translate / unsolvable 都要），而不是只有 covered。
2. 优先级排序：**停牌态（handoff_translate/unsolvable）应优先复核**——这些是用户最可能手动干预的行，且数量远小于 covered。建议每轮先复核全部停牌态行（数量小，代价可控），再按 E10 的配额复核其余。
3. spec:376 的 TDD 用例改为可验证形式：「停牌态文件被手放字幕、视频指纹未变 → **≤1 轮巡检内**变 covered」（这条能真正抓住本缺陷）。
4. 顺带：D12 的 45 次 stat 可用**单次 `readdirSync(dir)` + 内存匹配**替代（`daemonV2.ts:133` 的 judgeOnce 已经这么做了），把 45 次 syscall 降到每目录 1 次。这样「性能」与「全覆盖」不再是取舍关系，D12 的整个低频复核机制**可能根本不需要**。这是最优修法，建议 spec 直接改 D12 的实现方向。

---

## 角度 6：D9 与 embedded_langs 的存量数据

### E12 🔴 存量 248 行的 embedded_langs 全 NULL，且 judge 谓词是 `needs_subtitle IS NULL` → 存量行**永不重判**，D9 对它们全部退化为「只看 origin_lang」

**证据**
- judge 谓词：`src/v2/daemonV2.ts:125` `WHERE f.work_id IS NOT NULL AND f.needs_subtitle IS NULL`
- judge 已在 115 上跑完：`docs/design/2026-08-08-CURRENT-STATE.md:60` 「judge：**248 文件判定需字幕**」→ 这 248 行的 `needs_subtitle` 已全部为 1（非 NULL）
- 同时 C12 确认 `files.embedded_langs` **从未被任何代码写入**（spec:172-174，已验证 `daemonV2.ts:157-162` 的 upsert 列清单里无 embedded_langs）→ 这 248 行 embedded_langs 全 NULL
- D9 判据（spec:386）：`origin_lang ∈ 可抓源集合` **或** `embedded_langs 含同语言文本轨`
- 扫描的指纹跳过：`daemonV2.ts:167-168` `if (existing && existing.mtime === ... && existing.size === st.size) continue` → 未变化文件不 upsert，C12 的 probe 补写（spec:365「新增/指纹变化文件 → 写入 embedded_langs」）**也不会覆盖它们**

**失效场景**：第 2 步上线，translatable 在 judge 阶段写入。但存量 248 行 needs_subtitle 已是 1 → 不进 judge 谓词 → `translatable` 永远 NULL。spec:385 定义 `NULL=未判`，而 spec:390 的分流只写了 `=1` 和 `=0` 两个分支 → **NULL 落进哪个分支未定义**（见 E13）。
即便实现者补了 judge 谓词让存量行重判，embedded_langs 仍全 NULL → D9 的「或存在同语言内嵌文本轨」这一半恒为假 → 对存量数据 D9 **完全等价于被 D9 废止的 R21 原判据**，C31（BD 压制日漫被误判死）在存量数据上原样复活。

而 spec 只为 works.provider_ids 安排了存量回填（C21 / spec:428），**没有为 files.embedded_langs 安排任何存量 probe 回填**。第 1 步的用例（spec:365）明确限定「新增/指纹变化文件」。

**建议修法（三项都要）**
1. 第 1 步补一个**存量 probe 回填 pass**：`WHERE embedded_langs IS NULL AND work_id IS NOT NULL` 逐行 ffprobe（纯机械、无 LLM、一次性）。248 行规模完全可行，且它是 D9、judge 规则 2、C12 三者的共同前提。列为第 2 步的前置。
2. 第 1 步/第 2 步补一个**存量重判 pass**：把已有行的 needs_subtitle 与 translatable 重算一遍（或在迁移里把 needs_subtitle 置回 NULL 让 judge 自然重跑——注意这会同时清掉 judge 规则 3 已写的 needs_subtitle=0，正好符合 D8 的切分，是顺路的）。
3. spec §四第 6 步（e2e）的前置清单里，把「embedded_langs 回填完成」与「provider_ids 回填完成」并列——否则 e2e 会在 D9 半瘫的状态下验证，得出虚假的「translatable 判定正确」结论（与 C21 记的同型陷阱）。

### E13 🟡 `translatable IS NULL`（未判）在满 7 次分流时的行为未定义

**证据**
- spec:385：`translatable INTEGER`（**NULL=未判** / 0=不可救 / 1=可救）
- spec:390 分流只有两支：`translatable=1 → handoff_translate；=0 → unsolvable`
- spec:492-493（§5 转换表）同样只有 `=1` / `=0` 两行

**失效场景**：NULL 既不满足 `=1` 也不满足 `=0`（SQL 三值逻辑下 `translatable = 0` 对 NULL 返回 UNKNOWN）。实现者若写 `if (translatable === 1) ... else ...` → NULL 落进 unsolvable（误判死）；若写 `if (translatable === 0) ... else ...` → NULL 落进 handoff_translate（送进翻译流白跑）；若写 `if/else if` 两个显式分支 → **NULL 什么都不做，sub_status 保持 NULL 且 sub_attempt 继续涨** → 该文件永远每天跑一次字幕 agent，永不停牌 → 无限 LLM 消耗（比 E1 更糟：365 session/年/文件）。

三种实现都符合 spec 字面。结合 E12（存量行 translatable 恒 NULL），第三种实现会让**存量 248 行全部进入每日无限重试**。

**建议修法**：spec 明确 NULL 的处置，并加 TDD。推荐：`translatable IS NULL` 视为「judge 尚未完成，不分流、不计数、写 recheck_after 等下一轮 judge」；同时把 judge 阶段设为「保证在字幕工作台之前把所有 needs_subtitle=1 行的 translatable 补齐」的不变量（即 judge 谓词须含 `OR translatable IS NULL`）。或更简单：把 translatable 定义为 `NOT NULL DEFAULT 0`，取消第三态——但那样必须先做 E12 的回填，否则等于把存量全判死。

---

---

## 角度 7：状态转换表的完备性（spec §5，:485-505）

### E14 🔴 转换表缺 5 条真实可达的转换行 → 实现者只能自行发明

逐条核对 spec:487-502 的 13 行，缺失以下事件（每条都可达）：

- **(a) `NULL` + 「装盘成功但下一轮扫描未确认」**：R24 明言要覆盖「装盘成功但文件没落地」（spec:60）。现表只有 spec:490「装盘成功 → 不变 + 写 recheck_after」，没有后续。见 E9。
- **(b) `handoff_translate` + 「周频复查到点」**：spec:482 明写 handoff_translate「仍每周复查（R25）」，但表只有 spec:501 的 `unsolvable + 每周复查到点` 一行，**handoff_translate 无对应行**。见 E4。
- **(c) `handoff_translate` + 「视频指纹变化」**：换片源与停牌态互不排斥。表只有 spec:495 的 `covered + 指纹变化 → NULL`。停牌态换片源后 tr_attempt 该不该清？未定义。
- **(d) `unsolvable` + 「视频指纹变化」**：同上。
- **(e) 任意态 + 「needs_subtitle 由 1 变 0」**：D8 后 needs_subtitle 由 judge 独立管，且 E12 要求存量重判。表无 needs_subtitle 维度——一个 covered 的行被重判成 needs_subtitle=0 后 sub_status 该不该清？见 E8。

**失效场景（以 c/d 最具体）**：用户把一部停牌的片子换成带内嵌日文轨的 BD 版 → 指纹变化 → 按 C11（spec:363）清 sub_status/sub_attempt/recheck_after/embedded_langs/duration_sec。但 **spec:363 的清空清单里没有 `translatable`，也没有 `tr_attempt`/`tr_recheck_after`**。结果：embedded_langs 被清空待重 probe，而 `translatable` 保留旧片源的判定值（可能是 0）→ 新片源明明可救，仍按 0 分流成 unsolvable。**D9 的整个目的（不误判死能救的片子）被指纹变化路径绕过。**

**建议修法**
1. spec:363 的清空清单补 `translatable`、`tr_attempt`、`tr_recheck_after`（与 D3 的独立列一致：指纹变化 = 换了个新东西，所有与「这个文件的字幕处置」相关的状态都该归零）。
2. 转换表补齐上述 5 行。spec:485 自称「唯一权威，实现须逐条对照」——**不完备的权威表比没有表更危险**，因为实现者会以为已经穷尽。

### E15 🟡 转换表的「写入者」列有 3 处与代码/spec 其他章节对不上

- **spec:501（`unsolvable` + 每周复查到点 → NULL，写入者标「字幕流」）**：不可能是字幕流——字幕流的唯一入口 `listSubtitleQueue`（`subtitleScheduler.ts:26-33`）的谓词按 spec:87 含 `sub_status IS NULL`，看不见 unsolvable 行。见 E3。
- **spec:494（`covered` + 扫描发现字幕已消失 → NULL，写入者「扫描」）**：写入者正确，但该转换**依赖 D12 的低频复核实际覆盖 covered**，而 D12 只给了「如…」。见 E10。
- **spec:499-500（停牌态 + 扫描发现字幕出现 → covered，写入者「扫描」）**：同样依赖低频复核覆盖**停牌态**，而 D12 的措辞（「按 covered 抽样」）把停牌态排除在外。见 E11。

**建议修法**：转换表每行补一列「触发机制」，写明该转换由哪个**具体阶段**执行（阶段 1 扫描全量 / 阶段 1 低频复核 / 阶段 2.5 judge / 阶段 2.6 停牌复查闸 / 阶段 3 字幕流 / 翻译循环）。这一列能机械地暴露 E3 这类「无执行者」的转换——这是本轮之所以能发现 E3 的方法，应固化进 spec。

### E16 🟡 `translatable` 的重算时机在 spec 中完全缺失

**证据**
- spec:385-386 只说「judge 阶段写入」
- judge 谓词（`src/v2/daemonV2.ts:125`）是 `needs_subtitle IS NULL` → 一旦判过就永不再判
- 而 translatable 的两个输入都会变：`works.origin_lang`（识别修正 / 用户改绑 TMDB 时变）、`files.embedded_langs`（换片源时变，见 E14）

**失效场景**：(i) 识别把一部日漫误绑成美剧 → origin_lang=en → translatable=1；用户改正绑定 → origin_lang=ja → translatable 不重算，仍为 1 → 满 7 次送进翻译流 → resolveSource ja 分支按 R18 返回 no-source → unsolvable。多绕一圈，尚可接受。(ii) 反向（en 被误绑成 ja，translatable=0）则是**把能救的判死，且永不自愈**——只有周频复查会让它回 NULL 重找字幕，但 translatable 恒为 0，永远进不了翻译流。

**建议修法**：spec 明确 translatable 的重算触发（至少：指纹变化时清空；`works.origin_lang` 被更新时清空该 work 下所有 files 的 translatable）。并把 judge 谓词改为 `needs_subtitle IS NULL OR translatable IS NULL`——一并解决 E12（存量行不重判）与 E13（NULL 无归宿）。

---

## 角度 8：执行顺序的依赖再检查

### E17 🟡 D7 的等价实现**已存在于 HTTP 层**——spec:297 的「无嵌套检测」是不准确断言，会导致重复实现

**证据（本轮新发现，前两轮未记）**
- `src/dashboard/apiV2.ts:809-818` `findOverlappingRoot`：双向（parent/child）重叠检测，带 `sep` 边界感知（正是 D7 要的东西）
- `src/dashboard/apiV2.ts:852-860`：`addMediaRoot` **已在调用它并拒绝重叠**，错误文案齐备
- `apiV2.ts:797-801` 注释记有实案：「4 个重叠根让 scanned 从 492 涨到 3140」
- 而 spec:297（C29）断言「`settingsRepo.addRoot`（`:115`）是裸 `INSERT OR IGNORE`，**无嵌套检测**」——对 `addRoot` 本身成立，但对**用户可达的加根路径**不成立

**结论**：C29/D7 的风险被高估。真实缺口只剩两条旁路：
1. `settingsRepo.seedRootsFromEnv`（`src/v2/settingsRepo.ts:124-129`）直接循环调 `addRoot`，**绕过 findOverlappingRoot** → `MEDIA_ROOTS=/media,/media/115` 这类 env 会种出嵌套根。两处调用：`src/cli/index.ts:193`、`src/cli/index.ts:268`。
2. 历史存量：`findOverlappingRoot` 加入之前落库的嵌套根（spec:300 已提到迁移告警）。

**建议修法**：D7 改写为「把 `findOverlappingRoot` **下移**到 settingsRepo 并在 `addRoot` 内部强制执行，使 `seedRootsFromEnv` 自动获得保护」+「启动时对存量嵌套根告警」。这比新写一套小得多，且避免两份实现漂移（C30「两处标签集互不兼容」的同型陷阱）。spec:297/spec:349 的表述须更正。

### E18 🟡 第 1 步范围过大且横跨 4 个模块，难以独立验收

**证据**
- spec:340 标题含 8 个条目：`C1 + C11 + C12 + C19 + R24 + D7 + D11 + D12`
- 涉及模块：`daemonV2.ts`/`scanner.ts`（扫描、删除、指纹、probe、sidecar 观察）、`settingsRepo.ts`（D7 + D11）、`subtitleJudge.ts`（D8 移除规则 3，spec:379）、`db.ts`（若 D12 采纳新列则含 schema 变更）
- TDD 用例数：spec:355-381 共 **19 条**

**分析**：第 1 步混了三种性质不同的工作——(i) 纯机械 SQL/文件系统（删除、指纹重置）可完全单元测；(ii) 需 ffprobe 的 probe 回填（C12 + E12 存量回填）需真实媒体或 mock；(iii) 性能敏感且**定义尚缺**的 sidecar 观察机制（D12，见 E10）。(iii) 的定义没定就无法开工，会把 (i)(ii) 一起卡住。

**建议修法**：拆成 **1a（地界管理：D1 删除作用域 + D7 + D11，纯 repo/扫描层）** 与 **1b（文件事实：指纹重置 + probe + 存量回填 + sidecar 观察机制）**。1a 可立即开工并独立验收；1b 需先补 E10 的机制定义。

### E19 🔴 第 2 步的所有巡检侧改动（含 R25 周频复查）在第 3 步之前**在生产上不生效**

**证据**
- spec:391 把「周频复查」列在第 2 步；按 E3 它需要一个新阶段挂在 `ScoutDaemonV2.runInspection`（`daemonV2.ts:74-103`）
- 但第 3 步才把 daemonV2 接上容器：spec:120-122（C2）「`Dockerfile` CMD = `dist/cli/index.js watch` → `cmdWatch()` → **旧 Daemon（30s tick）**」
- 第 2 步的其他巡检侧改动同理：冻结快照（spec:392）、7 次分流（spec:390）、废止 unavailable 的新失败轨（spec:387）

**失效场景**：第 2 步完成并部署 → 生产跑的仍是旧 daemon（`src/v2/daemon.ts`，其翻译候选谓词还是 `sub_status='unavailable'`，`translateWorkerTask.ts:69`）→ 新写的分流/复查/快照代码**一行都不执行**，而旧 daemon 因 unavailable 被废止而饿死（C34 已记）。即第 2→3 步窗口期内生产**既没有新行为、又失去了旧行为**。第 2 步的单测会全绿。

**建议修法**：**把第 3 步提到第 2 步之前**（顺序改为 1 → 3 → 2 → 4）。第 3 步只是「在 `cmdWatch()` 内部把 ScoutDaemon 换成 daemonV2」+ 4 个运维器官接线（spec:410-419），**不依赖第 1/2 步的任何 schema 变更**，依赖关系上完全可以先做。这样第 2 步之后的每一步都能在生产上被真实验证，也让 C34 记的「翻译窗口期不可用」从两步缩到一步。若不调换，spec 必须在第 2 步验收记录里显式注明「本步巡检侧改动在第 3 步之前不在生产生效」。

### E20 🟢 第 4 步的翻译循环对第 3 步的硬依赖未声明

**证据**
- spec:38（R19）：翻译流 = 主进程内独立循环；spec:430-431：「主巡检每轮末尾推进一次翻译」——「主巡检」即 `daemonV2.runInspection`
- 第 3 步才把 daemonV2 接上容器（spec:409-419）
- 旧 daemon 的翻译接线（`src/cli/index.ts:676-680` `dispatchTranslate` → `dispatchTranslateTasks`）走的是 **jobs 表派活模型**，与 R19 的「主进程内独立循环」是两套完全不同的东西

**结论**：第 4 步硬依赖第 3 步。现有顺序（1→2→3→4）恰好满足，但依赖未写明——若有人为了「先修翻译」调换 3/4，翻译循环无处可挂。

**建议修法**：第 4 步开头显式写「前置：第 3 步已完成」。

---

## 角度 9：MVP 边界的清晰度

### E21 🔴 D9 使日语**实质进入 MVP 范围**，spec 三处口径互相矛盾，且第二轮已识别此矛盾但只修了一半

**证据（六处口径）**
1. spec:39（R20）：「MVP 只需**英语源**跑通，其他语言后续再说」
2. spec:83（阶段 2.5）：「判 translatable（R21）：works.origin_lang 是否在可抓源集合内（**MVP=仅 en**）」
3. spec:386（第 2 步）：判据 = `origin_lang ∈ 可抓源集合` **或** `embedded_langs 含同语言文本轨`（D9）
4. spec:404（TDD 红线）：「**origin=ja 且有日文内嵌轨 → translatable=1**」
5. 代码：`src/v2/translateWorkerTask.ts:49` `SUPPORTED_SOURCE_LANGS = ['en', 'ja']`
6. 代码：`src/translate/workspace/resolveSource.ts:56-65` ja 分支**已实现**日文内嵌轨抽取→翻译（`isJa(origin)` → `jaIdx>=0` → `deps.extract` → `sourceLangName: '日文'`），R18 只废止其后的 eng 兜底（`:72-77`），**ja 内嵌抽取那一段不受影响**

**分析**：D9 + spec:404 的组合意味着——带日文内嵌轨的日漫 `translatable=1` → 满 7 次进 `handoff_translate` → 翻译流 → resolveSource ja 分支命中 `jaIdx>=0` → 抽日文轨 → 译中文 → 装盘。**整条路径的代码已经存在且会被走通。** 所以日语（限「自带日文内嵌文本轨」子集）**确实在 MVP 范围内**，spec:39/spec:83 的「仅 en」是错的。

spec:313（C31 末尾）已经指出「spec 写『MVP 仅 en』，而 `translateWorkerTask.ts:49` 实为 `['en','ja']`，口径不一」，但**修法 spec:314 只改了 translatable 的判据，没回头修正 spec:39/spec:83，也没裁定 `SUPPORTED_SOURCE_LANGS` 该不该保留 `'ja'`**。这是第二轮修订留下的未闭合项——审计发现了矛盾，裁决只处理了矛盾的一侧。

**实际危害**：`SUPPORTED_SOURCE_LANGS` 承载了两个不同语义：
- (i) 「可**抓取外挂源**的语言集合」= 实际仅 `en`（jimaku 未落地，C6/spec:141-142）
- (ii) 「可作为**单跳源**的语言集合」= `en` + `ja`（ja 靠内嵌轨可抽）

D9 判据（spec:386）第一支写的是「`origin_lang ∈ 可抓源集合`」——用的是语义 (i)。但实现者手边唯一的现成常量是 `SUPPORTED_SOURCE_LANGS`（含 ja，语义 (ii)），**极可能直接代入**。后果：**无日文内嵌轨**的日漫也被判 translatable=1 → 满 7 次进 handoff_translate → 翻译流 → resolveSource：无 ja 轨、`fetchSourceSub` 抓不到日文源 → no-source → unsolvable。绕一圈浪费一次翻译调度，与 R21「O(1) 可判的终局不该塞在延迟之后」的省钱意图直接相违。

**建议修法（三项）**
1. spec:39/spec:83 改为：「MVP 可救范围 = `origin_lang=en`（可抓外挂源 + 可抽 en 内嵌轨）∪ 任意 origin_lang 且**自带同语言内嵌文本轨**（纯本地抽取，当前实际主要是 ja）」。
2. 代码层把两个集合拆成两个常量：`FETCHABLE_SOURCE_LANGS = ['en']`（抓取腿 + D9 判据第一支用）与 `SINGLE_HOP_SOURCE_LANGS = ['en','ja']`（内嵌抽取腿用）。写进第 2 步与第 4 步的清单。
3. spec §七 待确认第 1 条（spec:563）「日漫走翻译流需 jimaku 落地，属另一轮任务」在 D9 之后**已不准确**，须更正。

### E22 🟡 e2e 测试计划主动避开日漫 → D9 这条**新引入的核心判据在第 6 步得不到验证**

**证据**
- spec:460（第 6 步翻译单元）：「**不用动画**（日文源未支持，见 C6）」
- 但 spec:404 把「origin=ja + 日文内嵌轨 → translatable=1」列为**红线 TDD**
- spec:459：「有内嵌 / 无内嵌 两种场景各测」——用的是英语剧，其「有内嵌」测的是 en 内嵌轨（resolveSource `:93-98` 的 en 分支），**不覆盖 ja 分支（`:60-65`）**

**失效场景**：D9 是本轮修订引入的关键判据，其唯一的实际收益就是救日漫；而 e2e 明确排除动画 → D9 只有单测覆盖（造假的 embedded_langs JSON），**从未在真实 ffprobe + 真实 mkv + 真实 resolveSource ja 分支上验证过**。这与 C21 记录的陷阱同型：「第 6 步会在退化状态下验证，误以为这就是真实命中率」。

**建议修法**：第 6 步翻译单元补一条「日漫（自带日文内嵌文本轨）」场景，明确它**不需要 jimaku**。若用户仍坚持 MVP 不测日漫，则应把 D9 的第二支（内嵌轨）也一并推迟到 jimaku 那轮，让 MVP 真正「仅 en」——但那等于接受 C31（日漫误判死），需用户重新裁决。**这两条路必须择一，不能同时保留 D9 与「不测动画」。**

---

## 角度 10：整体可实现性——需要澄清的语义模糊点清单

以下每条都是「两个实现者会写出不同东西」或「实现者会停下来问」的点。已在上文单列的（E3/E10/E13/E21 等）不重复，此处只列**新增**的模糊点。

### E23 🔴 「满 7 次」的判定时机与计数语义未定义

**证据**
- spec:29（R10）：「满 **7 次真实尝试**未果」
- spec:390：「`sub_attempt≥7` 时分流」
- spec:492-493（转换表）：「`sub_attempt` 达 7 且 translatable=…」
- spec:181（C13 修法）：「把『**领取即计数**』或『finally 保证回写』作为不变量」——**给了两个互斥的选项，没选**

**分歧**：
- 若「领取即计数」：attempt 在派发前 +1，则第 7 次尝试**开始时** attempt 已是 7 → 判定 `>=7` 会在该次尝试**尚未执行**时就分流 → 实际只搜了 6 次。
- 若「finally 回写」：attempt 在尝试结束后 +1，第 7 次失败后 attempt=7 → 下一轮才分流 → 实际搜了 7 次，但多占一轮。
- 且「7 次真实尝试」的定义本身模糊：spec:392 明确「快照中文件已消失 → 剔除且不计数」（不算），spec:220（编造门）的 `fabricated-no-match` 走 `bump` 算不算？现码 `subtitleScheduler.ts:220` 会 bump（即算）；但「agent 编造」显然不是「真实尝试」，与 R9/R17 的精神不符。`no-outcome`（`:261`）、`timeout`（`:162`）呢？

**建议修法**：spec 定一张「哪些结局计入 sub_attempt」的表（真实搜索未果=计入；编造=不计入且告警；文件消失=不计入；超时/抛错=计入但需与 R9「不许撂挑子」区分）。并明确判定时机（推荐 finally 回写 + 在回写后立即判 `>=7` 同轮分流，避免多占一轮）。

### E24 🟡 「冻结快照」的粒度未定义：按作品还是按文件

**证据**
- spec:88：「开跑冻结快照（R4），消费前逐文件 stat」
- spec:392：「巡检开始时取一次队列」
- 但队列的单位是**作品**（`listSubtitleQueue` 返回 `SubtitleQueueItem[]`，每项含 `files[]`，`subtitleScheduler.ts:12-21`），而字幕 agent 一个 session 处理一个作品（spec 零章、CURRENT-STATE:36）

**分歧**：「巡检开始时取一次队列」若冻结的是**作品列表**，则本轮期间新识别出的作品（阶段 2 在阶段 3 之前，但阶段 2 跑空才进阶段 3，所以阶段 3 期间不会有新识别——**除非**阶段 3 耗时中 judge 未覆盖的行……实际不会）；若冻结的是**文件列表**，则同一作品内某文件在本轮被装盘后，快照里的其他文件仍按旧状态处理。更关键：**冻结与 D6 的出队凭据冲突**——D6 靠 recheck_after 出队，但冻结快照根本不重查队列，所以同一轮内 D6 的出队机制**不起作用**（C26 的热循环在冻结后本来就消失了）。spec 同时保留两套机制（spec:90 的 D6 与 spec:392 的冻结），未说明二者关系。

**建议修法**：spec 明确「冻结 = 阶段 3 开始时取一次作品列表，之后 `for` 遍历，不重查」；并说明 D6 的 recheck_after 是**跨轮**出队凭据（防下一轮重选），冻结是**同轮**防重选——两者互补不冲突。这一句话能省掉实现者半天的困惑，也能避免有人为了「实现 D6」而保留 `while + queue[0]` 的重查结构（那就没冻结了）。

### E25 🟡 D10 的乐观守卫在「守卫失配」时该做什么，未定义

**证据**
- spec:432 / spec:546：「全部回写带乐观守卫 `WHERE sub_status='handoff_translate'`」
- 但未说明：`UPDATE ... WHERE sub_status='handoff_translate'` 返回 `changes===0` 时怎么办

**分歧**：(a) 静默忽略（认为扫描已写 covered，翻译成果被采纳，正常）；(b) 记日志告警；(c) 回滚已装盘的字幕文件。且**如果 changes===0 的原因是 E4 那种「周频复查把状态改成 NULL」，静默忽略会导致热循环**（tr_recheck_after 没写）。

**建议修法**：spec 明确「changes===0 → 记 info 日志 + **仍写 tr_recheck_after 出队**（用不带 sub_status 守卫的独立 UPDATE，只更新 tr_* 列）」。这样守卫保护 sub_status 不被覆盖，同时保证出队凭据一定写入（不受守卫影响）。**这是 D6 与 D10 的交互点，spec 目前完全没写。**

### E26 🟡 R9 的两条边界（第 5 步）与 R17 的「普通失败」在 prompt 层如何区分，未给判据

**证据**
- spec:441-443（第 5 步）：「不许撂挑子：还有未探索的源/查询变体时不得报『没有』；穷尽后方可」、「明确区分『限流等待』与『确实没有』」
- 现有 skill 已有相关措辞：`src/agent/skills/findSubtitleSkill.ts:250`（`no_safe_match`: 「targets you genuinely exhausted the real candidates for」）、`:229`（「MAY call search_source again with different queries」——注意是 **MAY**，不是 MUST）
- 而机械层的反编造门只检查「trace 里有没有 `search_source`」（`subtitleScheduler.ts:168-169`），**不检查次数/变体数**

**分歧**：「穷尽」在 prompt 里是主观判断，在机械层只被验证成「至少调过一次 search_source」。实现者若只改 prompt 措辞（spec:440 说「纯 prompt 改动」），无法验收「不许撂挑子」——因为**没有可观测的机械判据**。第 5 步的验收标准缺失。

**建议修法**：为「不许撂挑子」补一个机械下限（如：trace 中 `search_source` 调用次数 < N 且报 no_safe_match → 按「未穷尽」走短退避 + 告警，与现有反编造门同轨）。若不做机械化，则 spec 须承认第 5 步「不可自动验收，只能靠 live test 观察」，并在第 6 步为它指定观察项（Peacemaker 那一集，spec:461）。

### E27 🟢 界面态与 sub_status 的映射不完整（第三态缺失）

见 E8：`needs_subtitle=0` 的行界面该显示什么，spec §5 与 §七第 4 条都未覆盖。前端重做时会撞上。

### E28 🟢 「可抓源集合」这个词在 spec 中出现 3 次但从未定义为具体常量

spec:83、spec:386、spec:57（R21）都用「可抓源集合」，spec:142 说「实际可抓源语言**仅 en**」。结合 E21，这个词须绑定到一个具名常量（建议 `FETCHABLE_SOURCE_LANGS`），否则每个引用点各自解释。

---

## 按严重度汇总

### 🔴 阻塞实现（8 条）

| # | 一句话 | 证据 |
|---|---|---|
| E1 | 周频复查「sub_attempt 归零」使成本变成 7 次/14 天，与 R25「每周找一次」矛盾（3.5 倍 LLM 开销） | spec:391, 401, 501, 61 |
| E3 | 停牌态文件不满足任何工作台谓词 → 周频复查**无执行者**，R25 静默失效且测试抓不到 | spec:87, 95, 501；`subtitleScheduler.ts:26-33` |
| E4 | 周频复查把 `handoff_translate` 改回 NULL → 掀掉飞行中的翻译 + 双流并发 + D10 守卫吞掉结果 → 热循环 | spec:482, 95, 107, 184-185 |
| E10 | D12「低频复核」只有两个「如」，无可实现定义；spec:376 的 TDD 用例无法写 | spec:56, 307, 376 |
| E11 | 若低频复核只覆盖 covered → **R23「用户手放字幕也认」对停牌态文件永不生效**（最隐蔽，测试必绿） | spec:56, 500, 371, 521 |
| E12 | 存量 248 行 embedded_langs 全 NULL + judge 谓词 `needs_subtitle IS NULL` → 存量行永不重判，D9 全面退化 | `daemonV2.ts:125,167-168`; CURRENT-STATE:60; spec:365, 428 |
| E14 | 状态转换表缺 5 条可达转换；spec:363 的清空清单漏 `translatable`/`tr_*` → D9 被指纹变化路径绕过 | spec:485-502, 363 |
| E19 | 第 2 步全部巡检侧改动（含 R25）在第 3 步之前**生产不生效**，且旧 daemon 同时饿死 | spec:120-122, 391；`translateWorkerTask.ts:69` |
| E21 | D9 使日语实质进入 MVP，spec:39/83 的「仅 en」是错的；第二轮识别了矛盾但只修一半 | spec:39, 83, 386, 404, 313；`translateWorkerTask.ts:49`; `resolveSource.ts:56-65` |
| E23 | 「满 7 次」的判定时机（领取即计数 vs finally）与「哪些结局计入」均未定；C13 修法给了两个互斥选项没选 | spec:29, 390, 181, 392；`subtitleScheduler.ts:220,261,162` |

### 🟡 该修（10 条）

E2（周频与巡检相位漂移）、E5（`recheck_after` 一列三主，违背 D3 自己的原则）、E6（D8 未交代 `hasSidecarSubtitle` 与 `daemonV2.ts:135-141` 死代码去向）、E7（D8 切分标准是列举而非判据）、E8（`needs_subtitle=0` 行的 sub_status 语义重载 → 界面必然误显示 + 双重记账风险）、E9（D6 装盘成功不计数 → 「声称成功但不落地」永攒不到 7 次）、E13（`translatable IS NULL` 分流行为未定义，三种实现都符合字面，最坏是每日无限重试）、E15（转换表「写入者」列 3 处对不上）、E16（`translatable` 重算时机完全缺失）、E17（D7 的等价实现已在 `apiV2.ts:809-818`，spec:297 断言不准确 → 会写第二份）、E18（第 1 步跨 4 模块 19 用例）、E22（e2e 主动避开日漫 → D9 得不到真实验证）、E24（冻结快照粒度未定 + 与 D6 的关系未说明）、E25（D10 守卫失配时的处置未定义，与 D6 的交互点空白）、E26（R9 两条边界无机械判据 → 第 5 步不可验收）

### 🟢 建议（3 条）

E20（第 4 步对第 3 步的硬依赖未声明）、E27（界面第三态缺失）、E28（「可抓源集合」未绑定具名常量）

---

## 总结论：**不能进入实现阶段**

理由不是「问题多」——前两轮已经把 34 条缺口收进 spec，这份 spec 的**代码事实层已经相当扎实**。不能开工的原因是：**本轮最新引入的 R25/R26 与 D6–D12 之间存在结构性未闭合**，其中三条会让核心裁决在生产上静默失效，且**单元测试全部会绿**：

1. **E3 + E4**：R25（周频复查）没有执行者；一旦按 §5 转换表的字面（「写入者=字幕流」）实现，它要么不生效（E3），要么撞翻译流（E4）。R25 是本轮用户最新裁决，也是整份 spec 里唯一没有对应代码位置的机制。
2. **E11**：D12（性能优化）与 R23/R24（事实观察）单独看都对，合起来把「用户手放字幕解除停牌」这条最重要的路径掐死。spec:371 的 TDD 用例会绿，生产不生效。
3. **E12**：D9 依赖 embedded_langs，而存量 248 行全 NULL 且永不重判。spec 为 provider_ids 安排了回填（C21），**唯独漏了 embedded_langs**——而 embedded_langs 是 D9、judge 规则 2、C12 三者的共同前提。

这三条的共同形态与 C12（「embedded_langs 从未被写入」）完全同型：**spec 层逻辑自洽，实现层缺一个写入者/触发者，测试层因为直接调函数而绿。** 这是本项目已经栽过一次的坑。

### 必须先补的条目（按优先级）

**P0 — 不补则核心裁决失效（必须在第 2 步开工前定稿）**
1. **新增阶段 2.6「停牌复查闸」**，并裁定 `handoff_translate` 是否参与周频复查（推荐 E4 的方案 (a)：只有 `unsolvable` 参与）。同步修 §二流水线图、§四第 2 步、§5 转换表三处的写入者。（E3, E4）
2. **裁定周频复查是否归零 sub_attempt**。推荐不归零 + 改「失败后立即判 >=7」，使成本从 7 次/14 天降到 1 次/7 天。（E1, E23）
3. **定义 D12 低频复核的具体机制**，且范围必须含停牌态（推荐：`sidecar_checked_at` 列 + 每轮限额 + 停牌态优先；或按 E11 修法 4 用 `readdirSync` 单次列目录彻底取消低频复核）。（E10, E11）
4. **补 embedded_langs 存量 probe 回填 pass + 存量重判 pass**，列为第 2 步前置。（E12）
5. **补齐 §5 转换表的 5 行**，并把 spec:363 的清空清单补上 `translatable`/`tr_attempt`/`tr_recheck_after`。（E14）
6. **裁定 `translatable IS NULL` 的分流行为**。（E13）

**P1 — 不补则会写出错的东西或验收不了**
7. **统一 MVP 边界表述 + 拆分两个语言常量**（`FETCHABLE_SOURCE_LANGS` / `SINGLE_HOP_SOURCE_LANGS`），并决定 e2e 是否测日漫。（E21, E22, E28）
8. **定义「满 7 次」的计数时机与计入表**。（E23）
9. **把第 3 步提到第 2 步之前**（顺序改为 1 → 3 → 2 → 4），或在第 2 步验收里明写「巡检侧改动本步不在生产生效」。（E19）
10. **明确 D10 守卫失配的处置**（changes===0 时仍须写 tr_recheck_after）。（E25）
11. **更正 D7 的表述**为「下移 `apiV2.ts:809` 的 `findOverlappingRoot` 到 settingsRepo」，避免写第二份。（E17）

**P2 — 开工后可边做边定**
12. D8 的删除清单显式化 + 切分判据成文（E6, E7）；`needs_subtitle=0` 的界面第三态（E8, E27）；D6 装盘成功计数（E9）；冻结快照粒度与 D6 关系（E24）；第 1 步拆 1a/1b（E18）；第 5 步的机械判据或「不可自动验收」声明（E26）；translatable 重算时机（E16）。

### 若用户决定「先开工，边做边补」——实现时必须特别小心的前 3 个点

1. **任何「状态转换」都必须能指出执行它的具体阶段函数。** 写完 spec 的每一行转换后，去 `daemonV2.runInspection`（`daemonV2.ts:74-103`）里找那一行代码；找不到就是 E3 型缺陷。这是本轮唯一有效的审计方法，应固化为实现纪律。
2. **凡「靠扫描发现磁盘事实」的转换，都要问一句：这一轮扫描真的会看这个文件吗？** 指纹跳过（`daemonV2.ts:167-168`）与 D12 的低频复核是两道过滤，E11/E12 都是从这两道漏下去的。TDD 若直接调扫描函数就绕过了这两道过滤，必须写「经过完整 scanOnce + 指纹未变」的用例。
3. **付费 LLM 的每一条路径都要算一遍「最坏情况一年烧多少 session」。** E1（182/年）、E13 第三种实现（365/年）、E4（无上限热循环）、E9（无终点循环）四条都是本轮新引入的烧钱路径，且都不会让测试变红。建议在实现时给字幕/翻译流各加一个「单文件年度尝试次数」的可查询指标，作为回归防线。

---

**状态**: ✅ 审计完成（10/10 角度）
**发现**: 28 条（🔴 11 / 🟡 14 / 🟢 3），全部为本轮新引入或前两轮未闭合，与 C11–C34 无重复
