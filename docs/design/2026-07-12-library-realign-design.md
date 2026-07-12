# 媒体库对齐(Library Realign):agent 自动矫正与 TMDB 不一致的剧集排布

日期:2026-07-12。状态:spec 待用户批准(HARD-GATE:批准前零实现)。
前置:调研报告(FileBot/Sonarr/Shoko 先例、SMB rename 原子性、Jellyfin 排除与重刮机制,存会话 tasks 输出,要点已并入本文)。验收素材:间谍过家家(40 集绝对编号平铺被刮成 S1E1-40)。

## 用户裁定(设计公理)

1. **TMDB 排布 = 唯一权威。** 不给乱库全面兜底;但当排布 ≠ TMDB 且**挡住了找字幕**时,agent 必须整理媒体资源本身。
2. 触发限定在字幕工作流内(不是通用整理器)。
3. 全自动,无人工确认环节;但**零删除、全程可回滚**是不可让步的安全底线。

## 触发:季级诊断

现有 executor 在某季 job 反复 no_safe_match 时,新增「诊断」环节(一次 LLM 调用+确定性检查):

- **主信号(确定性)**:镜像里该季集数 > TMDB 该季 `episode_count`(间谍过家家:"S1"40 集 vs TMDB 25 集)。
- **佐证(证据复用)**:该季 runs 里 rank/verify 的拒绝理由潮(如 15 条 "wrong season entirely")。
- 判定为「绝对编号平铺」→ 创建 `realign` 任务(新 job kind,走既有 jobs 状态机:租约/心跳/退避全继承)。
- 判不出/信号矛盾 → 维持现状(诚实 unavailable),绝不猜。

## 映射:绝对集号 → (季, 集)

- 拉 TMDB 季表(`season_number`/`episode_count`/air dates),做累计偏移:间谍过家家 abs 1-25→S1E1-25,26-37→S2E1-12,38+→S3E(n-37)。
- 动漫剧种交叉验证 **Anime-Lists/Fribb JSON**(社区权威绝对→季集映射,免费无 key);两源冲突 → 该剧放弃整理(诚实退出)。
- 文件名解析:anitomy 式分词 + 自研 CJK 层(`第N话/第N話/[26]/E26`);集号取不出的文件 → 隔离区,不猜。
- **LLM 的位置**:身份甄别(这文件夹到底是哪部剧,TMDB id 钉死)与脏文件名裁读——即 FileBot/Sonarr 甩给人类的那一格;但 **LLM 无权推翻确定性闸门**。
- **确定性闸门(全过才准动一个文件)**:映射无重复目标;各季集数 ≤ TMDB 上限;集号集合合理连续;可选 ffprobe 时长 vs TMDB `episode_run_time` ±10% 抽查(业界没人做,我们白捡的便宜校验)。任一不过 → 整剧不动。

## 执行:同 share 原子 rename + 先行清单

- **机制**:开机探测挂载是否支持硬链接(现挂载 CIFS `nounix`,预期不支持)→ 支持则硬链接(保种),否则**同 share `rename()`**(服务端原子、瞬时、零拷贝;碰撞原子失败=白捡的安全性)。**绝不 copy**(除非两者都不可用,则整剧放弃)。
- **目标结构**(Jellyfin 官方口径+FileBot `{jellyfin}` 绑定):
  `剧名 (年份) [tmdbid-XXXX]/Season 01/剧名 (年份) S01E01 - 001 - [原画质/组名/CRC等标记原样保留].ext`
  ——`Season` 全拼零填充;`[tmdbid-]` 钉死刮削身份(CJK 标题匹配从此不背锅);**原绝对集号保留在文件名里**(免费的回滚/排障信息,TRaSH 动漫命名同款)。
- **先行清单(write-ahead manifest)**:JSON 落在归档目录(旧路径/新路径/尺寸/mtime/判定依据/时间戳),**每条先写后搬**。崩溃恢复=读清单看新旧哪个存在接着走;重跑=幂等 no-op;回滚=`realign-rollback <manifest>` 逆序重放。
- **碰撞**:目标已存在 → 同尺寸视为已完成跳过;不同 → 隔离并标记,不覆盖。
- **哨兵防线**:动手前验证挂载活着(库目录本体存在+读写探针)——SMB 掉挂载看起来像空目录,是整理型守护毁库的经典死法;空挂载 → 拒绝执行。

## 归档:库外+同 share

- 位置:`<share根>/.archive/<剧名>-<时间戳>/`——在 Movies/TV 两个库根**之外**(Jellyfin 根本不看),但在**同一 SMB share 内**(rename 保持原子)。内放空 `.ignore` 双保险(调研:点前缀目录被 Jellyfin 各版本反复横跳,不可单独依赖)。
- rename 模式下归档内容=旧目录残骸(nfo/海报/隔离文件)+清单;硬链接模式下=完整旧结构(继续做种)。**永不删除**;保留期交给用户(dashboard 显示占用,不自动清)。

## 时序(调研红线:扫描中挪文件=重复条目灾难)

1. 查 Jellyfin ScheduledTasks API,确认无扫描进行中(必要时等待);建议同时把 Jellyfin 的 12h 定时扫描关掉,扫描时机全权由守护掌控(SMB 上无 inotify,Jellyfin 看不见中间态——这是优势)。
2. 建新结构(全部 rename 完成)。
3. **字幕先行**:此刻 Jellyfin 尚未刮新结构、镜像无条目,故由 realign 任务**自构上下文直接调用找字幕流水**(runPipeline 的 MediaContext 所需身份/tmdbid/季集/视频路径全在整理计划里,identify 可钉死跳过;staging 沙盒等机制原样生效)。字幕文件名从视频**实际落盘的字节级 basename** 拷贝派生(防 NFC/NFD 断配)。
4. 旧目录一次 rename 进归档。
5. 触发**单库** refresh(`/Items/{libraryId}/Refresh`),轮询 ScheduledTasks 到 idle。
6. 验收:API 查该剧各季集数=计划值;旧条目残留 → `.forcerescan` 重扫或按 item ID 删除;元数据串味 → 该剧 `FullRefresh&replaceAllMetadata=true`。
7. 镜像收编新条目,realign job 落 done,runs 记人话("把 40 集平铺整理成 3 季,字幕已就位")。

## 影响面与不做清单

- **改动面**:新模块 `src/files/libraryRealign.ts`(计划/执行/回滚)+ `src/agent/diagnoseSeason.ts`(诊断)+ jobs 状态机加 `realign` kind + Jellyfin 客户端加 ScheduledTasks/单库 refresh/条目删除三个端点 + dashboard 呈现。现有找字幕流水零改动(它只是被在新结构上复用)。
- **不做(YAGNI)**:通用库整理器;电影重命名;S0/特别篇智能归类(隔离区伺候);跨 share 迁移;自动清归档;做种保护之外的硬链接花活。
- **风险台账**:动用户媒体文件是本项目最高危操作类别——靠"确定性闸门全过才动 + 原子 rename + 先行清单 + 永不删除 + 空挂载哨兵"五重防线兜底;首个实弹目标间谍过家家在 mock 库先彩排全流程(造平铺假库),NAS 真库后行。
