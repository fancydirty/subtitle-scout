# Agent 判断 + Staging 沙盒:字幕获取判定与落盘全链重设计

日期:2026-07-12。状态:spec 待用户批准。前置调研:staging 最佳实践报告(*arr 生态/原子改名/SMB-NFS-群晖-CJK 坑,存会话 tasks 输出,要点已并入本文)。

## 用户钉死的两条原则(设计公理,不可退让)

1. **无计算器**:候选是不是目标资源的字幕,由 agent 的理解力判断,输出只有「是 / 不是」。
   任何置信度数字、阈值(0.86 之类)、加权评分从决策路径上彻底消失。
2. **无人工环节**:用户使用本产品时不存在任何需要拍板/确认/审核的东西。needs_review、
   ask_user 及其 UI 全部拔除。dashboard 只呈现:已覆盖 / 自带 / 暂无 / 忽略 / 处理中。

「拿不准」不是终态,只是「还没看仔细」:agent 像人类一样把候选下载下来打开看,然后必须表态。
看完仍说不出「是」的,就是「不是」(有就有,没有就没有;错写盘是永久污染,宁缺勿错)。

## 流程(每个 episode/movie 目标)

```
搜索(多源) → 粗筛(agent 判断,是/不是/拿不准)
  是      → 进沙盒下载 → 开箱体检(结构信号) → agent 终审「是」→ 原子安装 → 完成
  拿不准   → 同样进沙盒下载 → 开箱体检 → agent 终审(证据在手,必须二选一)
              是 → 原子安装;不是 → 弃(留在沙盒等整体删除),看下一个候选
  不是    → 跳过
全部候选「不是」→ 诚实「暂无」(现有 content 退避阶梯照旧)
job 结束(无论成败)→ rm -rf 整个沙盒目录,试错垃圾零残留
```

## Staging 沙盒(调研结论落地)

- **位置**:`<mediaRoot>/.subtitle-staging/<jobId>/` —— 必须在媒体挂载点内部,
  这是「安装=单次原子 rename、无 EXDEV 跨设备拷贝」的唯一保证(容器视角 SMB 挂载=一个文件系统)。
  目录带点前缀 + 内放 `.ignore`,Jellyfin 双保险扫不到。
- **按 job 隔离**:目录名=job id,并发不撞车,GC 可与 jobs 表精确对账。
- **安装**:`rename(沙盒/胜者, 媒体目录/<视频名>.zh-Hans.srt)` + 尽力 fsync 目录。
  文件名一律 **NFC 归一化**(群晖 SMB 的 NFD/NFC 乱码坑),存在性判断两侧都先归一再比较。
  rename 遇 EEXIST/EPERM/EBUSY 退避重试(SMB oplock 抖动);不用 O_TMPFILE(网络盘不支持)。
  跨设备兜底(理论上不该发生):拷到目标目录内点前缀临时名→fsync→同盘 rename。
- **崩溃 GC**(镜像既有的孤儿 job 收割):启动时 `rmrf` 所有不对应活跃 job 的
  `.subtitle-staging/*`,外加年龄阈值扫除;安装先 rename 后删沙盒,崩在中间只留可回收垃圾,
  永无半安装状态。
- **实现**:自写 ~20 行原子移动 helper(现成库解决的是「原子写内容」不是「原子移动」,不引依赖)。

## 开箱体检(喂给 agent 终审的定性信号,非评分)

便宜信号(本期全做):cue 数量级(整集应有数百条)/时间轴跨度 vs 片长(22min 的剧配 45min 的轴=错片)/
台词语言与简繁判定(采样多条 cue 拼接后判,单行简繁不可靠)/ASS `[Script Info]` Title 与字幕组头注释原文/
编码可解码性(HTML 错误页伪装的 .srt 直接毙)。
进阶信号(**本期不做**,记 backlog):ffsubsync 式音频 VAD 互相关对轴验证(最强信号但要解音频,容器算力/复杂度大)。
信号以原始值呈交 agent 推理,不合成任何数字。

## 拔除清单

- gate/rank:身份判决保留「是/不是」两态;uncertain 不再是 gate 的出口,改为触发「下载进沙盒→体检→终审」环节。
  `auto_download_min_confidence` 及横扫映射置信阈值删除(横扫的结构校验——文件名/元数据必须匹配集号——保留,那是证据不是计算器)。
- schema/prompt 中 confidence 字段:从决策逻辑移除;journal 里保留 agent 的文字理由(可观测性)。
- executor:ask_user 分支删除;markNeedsReview 删除。
- db:episodes/movies 现存 needs_review 行迁移回 missing + recheck=now(下轮按新逻辑重跑);
  CHECK 里的枚举值容忍保留(YAGNI,不再做整表重建)。
- dashboard/web:review 徽章/图例/tooltip/CoverageDTO.needsReview 拔除。

## 影响与代价

- 下载量上升:拿不准的候选要先下载才能验。ASSRT 下载不限;OS 20/天配额由既有配额停车管住。
  沙盒试错的下载不再直接写媒体库,**写错风险反而下降**(先验后装)。
- LLM 调用增加一轮终审(仅拿不准的尾部触发),用既有 maxApiCallsPerJob 预算管。
- 生产现存 8 集 needs_review(Peacemaker,0.85 那批):迁移后按新流程重跑,预期开箱验证通过直接转绿。

## 不做(本期)

音频对轴验证;确认队列类任何 UI;Phase 2 新源;numeric 评分的任何变体。
