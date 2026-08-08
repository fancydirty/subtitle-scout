# 从零 live test 复盘(2026-07-22)

> 目的:不是看落了多少字幕,是看过程给了什么信息。三个子代理审计(落盘正确性/工作流/held根因)。

## 🔴 最高优先级发现

### 1. Overflow 全季 8 集装错版本(critic 缺时长校验)
- 视频=TV 版 3.5 分钟(210s);装的字幕=完整版 7 分钟(423s)
- critic status_reason 写着"423s span, structurally consistent with 7-min episode"——**脑补时长,没 ffprobe 实测**
- 前半对白能对上、后半全乱,比没装更糟
- **根因:确定性闸 + critic 都没有"源字幕时长 vs 视频时长"硬校验**

### 2. translate 源选择零校验(Adam E01 装了错的源)
- Adam E01 是 3.5 分钟短片动画(葬前)
- 翻译源是 24 分钟职场剧字幕(内容"总编催稿/大学")——完全不相干
- 产出 1430s 字幕给 210s 视频,spanRatio=6.8
- **唯一的 translate:installed 是假的**——质量通顺但内容张冠李戴
- **根因:fetchSourceSub 选源只过 SRT parse 闸,不做时长/内容相关性校验**

### 3. critic held 死循环(同签名重复无熔断)
- job29 重试 11 次全 held,失败签名反复出现"专名系统性漂移"/"术语符合率 83.1%"
- 固定 ~50-60min 重试节奏(旧退避),23/27 个 translate run held
- 10.6 小时只产出 1 集(且那 1 集还是错的源)
- **根因:同一失败签名重复≥2 次时没有策略变化或认栽机制**

## 🟡 次优先级发现

### 4. held 根因分类(23 次)
| 类型 | 占比 | 证据 |
|---|---|---|
| 日文原句未译(模型丢 cue) | ~50% | "译文为日文原文'今日は行けるよな？',未翻译" ×30+条 |
| 语义错译(性别/归属/方向) | ~25% | メスゴリラ→雄性大猩猩(メス=雌性);台词归属错误 |
| 术语符合率不足 | ~20% | 63.3%(高畑/徳島/Ａ線漂移);83.1%(こうすけ→浩介 0/4) |
| 上下文一致性 | ~5% | Class 1-3→三年二班 vs 一年级三班 |

**根因标签:MODEL_CAPA(主)+ PIPELINE(辅)**
- mimo 日→中翻译能力不足:词汇级错误(性别)、整段漏译、术语表不遵守
- 非 prompt/管道/闸的问题——critic 和闸**工作正确**,它们抓到的全是真错

### 5. parked 无负缓存
- 13 个 parked 文件每 15 分钟被 ingest 重试识别(约 80 轮 × 13 次 TMDB 搜索)
- The Astronaut rescue worker 跑了 11 次,8 次结果一字不差

### 6. DxD 认领缺 season(永远解不开)
- rescue 认领 tmdb:45950 season=NULL;Hero 是第四季
- 库里 tmdb:45950 只有 S1-S3,绝对集号必然撞 park
- rescue LLM 工具没用上 season 字段

### 7. ASS 标签泄漏
- translate:installed 产出混入 `{\an8}` override 标签到 SRT

### 8. 可观测性缺口
- runs 表 llm_calls/assrt_calls 全部 NULL——一整夜 LLM 密集作业零成本台账

## ✅ 验证通过的设计

| 设计 | 结论 |
|---|---|
| ingest 巡检链 | A:零抖动、零重复 |
| find-subtitle→download | A:25 job 零重复,负缓存生效 |
| 瞬时错误退避轨 | A:subhd 限流自愈、LLM 协错自愈 |
| 租约恢复 | A:两次重启后 orphan 回收无缝续跑 |
| 相位分隔(新版) | B+:巡检清空后切翻译,不互堵 |
| fail-closed 闸 | A:23 次 held 全部正确拦下弱模型垃圾 |
| held 衰减梯(新版) | A:job29 attempt=11→3 天档,不再日级热循环 |

## 优化建议(按 ROI 排序)

1. **🔴 加时长校验闸**(同时堵 Overflow 错版 + translate 错源):translateItem 写盘前,ffprobe 实测视频时长,源字幕 span / 视频时长 ∉ [0.85,1.15] → held
2. **🔴 held 签名去重熔断**:同一 last_error 摘要出现≥2 次→停止自动重试,转 needs_review
3. **🔴 fetchSourceSub 选源时长校验**:候选字幕时长与视频时长差>50%→跳过该候选
4. **🟡 弱模型 + 强判官组合**:翻译用 mimo,critic 换 opus(省配额,保住语义层;单集 1 次 critic ≈ 1 批翻译的 token)
5. **🟡 parked 负缓存**:park_reason 不变时指数退避(1h→4h→24h),不每 15min 重试
6. **🟡 ASS→SRT 剥离 override 标签**
7. **🟡 runs 表补 llm_calls 记账**
8. **🟡 rescue 强制输出 season**

## 更正附注(2026-07-23 Task 2 mimo 资格矩阵,不擦历史)

证据:`/mnt/nvme0n1-4/backup/20260723-101705-task2-mimo-qual/`。`TRANSLATE_MODEL=mimo-v2.5`,手动 `translate-item`,EN/JA 分列。

| 历史表述 | Task 2 复核 |
|---|---|
| mimo 日→中能力不足(held 主因 MODEL_CAPA) | **维持并加宽**:E-JA(内嵌 jpn)critic 因大段日文未译 held;E-EN 术语 74.7% held;F1-EN critic 因英文未译 held。fail-closed 仍全部正确,无 translate 装盘。 |
| Overflow=时长错版主病理 | **不推翻历史装错版事实**;本轮同一 E01 在删 sidecar 后走外源 translate → **critic held**,**未**出现 duration-mismatch 结果码。说明:时长闸仍缺(历史🔴仍在),但「再跑 Overflow」也可能先死在模型质量而非时长。 |
| F2 jimaku 为 ja 源主路径 | 真 F2 样本(Grieving Soul S01E23,embedded=[]) → **no-source**;回退 E-JA 才进入翻译车道。F2 覆盖/匹配仍是独立风险,与 mimo 质量正交。 |
| 弱模型+强判官可省配额 | 本轮 critic 与翻译同为 mimo 仍拦住全部不合格产出;若生产要「能装上」,翻译侧仍需强模型(与建议 4 一致),不能指望 mimo 过闸。 |
