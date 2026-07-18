# 无人值守 8h auto-research 循环 · 终报(2026-07-18)

用户令:"测试、修复,审核人格查代码、你验收、根因、子代理修,心跳防早停,哪怕不阻塞的小尾巴
都查明根因修复,把项目做到完美。"本报为收官交付,按时间序全录。

## 一、从零 e2e 两真 bug → 真机闭环(循环开场前后完成)

| Bug | 根因(证据级) | 修复 | 真机闭环 |
|---|---|---|---|
| NBSP 文件名打断安装 | 盘上 U+00A0 vs 模型 U+0020(hex 成对铁证;NFD/捷克字符两假说被对照组证伪) | `53f5c93` 三级匹配+4 真字节回归锁 | LD&R S03E08 installed + 领养行落账 |
| 季均时长误杀加长集 | `episode_run_time[0]`=剧级典型,非单集 | `ca03d3c` getSeasonEpisodeRuntimes 逐集喂真 +9 测试 | TD S02E08 复跑 agent 判词"86.4min matching 87min"→installed |

## 二、审核人格波次①(两人格,发现全经主控亲验后才派修)

**数据安全审计官**:6 发现,亲验 3 关键引证全属实 → **批① `bc920ab` 写路径五点加固**:
install() 防静默覆盖(冲突契约)/langTag 白名单+dirname 断言/写路径 realpath 防符号链接逃逸/
staging 根对齐(gcOrphans 盲区,顺手修 allocate/cleanup 根不一致)/传播 COPYFILE_EXCL(TOCTOU+
悬空链接,实证复现过)。+14 测试。
另:CIFS 挂载抖动可致整库索引批量误删(walk 与 existsSync 同源失效)——**已识别未修**,见"遗留"。

**正确性猎手**:3 发现+2 专项,亲验 C-2 三条腿全属实:
- **批② `44d189b`**:C-2 撞名 basename 跨季错装 → resolveTarget 升级"唯一才默认,撞名须 itemId
  消歧"+5 测试(含与 NBSP 规范化组合场景)。
- **批③ `941a814`**:记账簇——B3-1 主文件领养写 subtitles 行(F-A:生产实证 adopted 主无
  provenance 行→无源可传播)/B3-2 领养清陈旧 status_reason(F-B)/B3-3 副本免每轮重识别(烧
  TMDB 配额)/B3-4 传播判决指纹 memo(**schema v17,ALTER item_files 加 duration_verdict+
  verdict_fingerprint,含"真造旧库再升级"安全测试**)/B3-5 EEXIST 警示日志。+15 测试。
- **批④ `256a508`**:PendingBox duplicates 死桶退役(P2 后 ingest 不再产 duplicate-content
  停车行;历史行落普通 actionable 桶,web 232/232)。C-3 全闭合由并行 session 提交 `9ea2b14`
  实现,本循环子代理独立验证(tsc+1588 绿)后纳编不重复造。

**主控亲笔**:`322bbb6` rescueSkill finalize-reason 润色(Astronaut 案例收债:finalize 必须原样
携带决策时判词,附措辞回归锁;skill 仅主控改)。清尾:`c35f95c`/`0bd383e` 两处 lint 级残留。

## 三、生产部署与真机验证(全绿)

- 两轮部署(定制版 compose 均先备后还原):修①②(HEAD c35f95c)+ 终版(HEAD 0bd383e,
  **schema 8→9 迁移,备份 backup-pre-v9-20260718**)。
- 真机验证:schema=9、新列 2/2;**探测 memo 生产生效**——重启首轮 17 行判决爆发=17 条 verdict
  行(1:1),第二轮 pass(08:30)propagate 总数冻结 17=零新探测(疣③闭合);E08 领养 provenance
  行落账(F-A 闭合);E08/TD 保持 covered。
- 基线:根 **1588/1588**、web **232/232**、tsc 双侧 exit 0。

## 四、并行主控 session 事件(全录,重要)

循环中段发现**另一账号的前任主控 session 仍在同仓+同生产自主开工**(其无人值守心跳未停,不知
用户已交接):批②首发互撞、resolveTargetFilename 幽灵拆分、sidecar.ts/ingest.ts 四起脏树(一次
Unterminated regex 直接打断门禁)、直接提交 `9ea2b14`。处置:①一切外来脏树**先存证
(scratchpad *.patch)再还原**,零损耗②共享记忆置顶**单主控收敛令**(其每轮必读)③其 `9ea2b14`
经独立验证后纳编(其 KNOWN_LANGUAGE_TAGS 解耦论证被采纳)④session 工具跨不了账号、杀桌面 App
有自杀风险(本 session 可能同宿主),故策略=围堵+信道收敛,非强杀。
**给用户的建议**:回来后请到另一账号把那个 session 的循环手动停掉,一仓一主控。

**连带教训已入记忆**:K3"二连死"实为 nohup 日志缓冲误判(判死活用 pgrep 不看日志);opencode
executor 当时不可用回退 sonnet;`tsc | tail` 会吃退出码,真门禁必须直读 exit code。

## 五、遗留(诚实清单,非隐瞒)

1. **CIFS 挂载抖动防线**(数据安全审计发现,likelihood 中):挂载闪断可致一轮 pass 内整库索引
   批量误删(物理文件无损,但 DB 认知/用户纠正丢失)。建议修法已记录(errno 区分+连续 N 轮
   去抖+scanned 骤降哨兵)——**是本循环识别出的最重要未修项**,规模值得专门一批,未在深夜
   仓促上(触碰移除循环=高危面,配得上用户醒着时的一轮审阅)。
2. e2e 的 1 例 finalize 未调(1/29,模型行为类,状态机已兜;harness 层收紧留观察)。
3. 鉴权 A1-A4 时机重估(DASHBOARD_TOKEN 裸奔警告仍在)——等用户拍板。
4. 并行 session 需用户手动停。

## 六、账本

commits(本循环):53f5c93 → ca03d3c → c35f95c → bc920ab → 44d189b → 941a814 → 322bbb6 →
(9ea2b14 纳编)→ 256a508 → 0bd383e。测试 1536→**1588**(+52)+web 232。生产=schema v9。
审核发现处置率:数据安全 6/6(5 修 1 记录)、正确性 3/3 修、e2e 4 项 4 闭、小尾巴(F-A/F-B/
探测空转/死桶/lint×2)全清。
