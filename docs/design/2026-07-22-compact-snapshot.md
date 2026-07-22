# 当前状态快照（2026-07-22 22:20）

> 供 compact 后接续。读完此文档 + handoff + postmortem 即可开工。

## 一句话

subtitle-scout 的 AI 翻译兜底链（E内嵌 + F1源语言外挂 + F2 jimaku日字）已建成并审计加固；
从零 live test 暴露了**工作流两个 bug（非模型能力）**导致 23 次 held，已修；
接下来是部署修复 + Witch Watch E02 正确条件对照实验 + 代码加固。

## 本会话已完成（全部 commit 在 main，未推公开仓）

### 功能
- `e3988de` AI 翻译设置页开关（ai_translate_enabled，默认关，daemon 派活双门）
- `bf06f31` 巡检后分相翻译 + held 衰减退避（1d→3d→7d）
- `f29d690` F2 jimaku 日字源 + F1 批重试/超时加固
- `ff0d442` extract 默认超时 300s

### 审计修复（agency-agents 4 人格审计）
- `55182ae` 写盘防覆盖源视频 + jimaku 缓存失集 fail-closed + 零 cue vacuous pass
- `b5a4c2f` 崩溃循环隔离（reap_count→park）+ 批重试递增退避
- `5e82c38` DB 耐久层（FULL sync + quick_check + checkpoint + VACUUM INTO 备份 + immediate 事务）
- `b56e03a` critic 超时同门 + ffmpeg -nostdin + 测试水分补齐

### live test 复盘后修复
- `496e437` 时长校验闸（spanRatio ∉ [0.85,1.15] → held）
- `70d9ae5` held 签名熔断（同签名≥2 次 → park dormant）
- `0546f24` **jimaku 标题校验**（entryMatchesQuery 防无关番）+ **sourceLangName 从实际轨语言取**

## 从零 live test 关键发现

### 🔴 held 根因 = 工作流 bug，不是 mimo 能力

1. **Adam E06-E08**：jimaku 没有这部番；变体回退搜 "Adam's" → 匹配到 BanG Dream/DEAD DEAD/高达；翻译的是**不相干的番**。OS 也 0 条。正确行为应是 `no-source`。（已修：entryMatchesQuery 标题校验）
2. **Witch Watch E02**：有内嵌英文轨（源正确），但 origin_lang=ja → prompt 说"日文"却喂英文文本 → 模型困惑。（已修：sourceLangName 从 track.lang 取）
3. **Overflow 全季 8 集**：TV 版(210s) 装了完整版字幕(423s)；critic 没做时长校验。（已修：时长闸）
4. **Adam E01**：唯一 translate:installed 是假的——装了 24 分钟职场剧字幕给 3.5 分钟短片。（已修：时长闸会拦住）

### 还没测过 mimo 真实翻译能力
所有 held 都在"错误源"或"错误语言标签"条件下发生。**Witch Watch E02 用英文内嵌轨 + sourceLangName="英文" 的对照实验还没跑。**

## 下一步计划（已与用户确认方向，待 compact 后继续讨论细节）

### Phase 1：部署 + 清理
- rsync + rebuild 生产（4 道修复上线）
- 删 Overflow 8 集 + Adam E01 坏 sidecar，重置 DB 行
- 重置 4 个 held job（error_attempt=0）

### Phase 2：对照实验
- Witch Watch E02：`docker exec translate-item`，mimo + 英文内嵌轨 + sourceLangName="英文"
- Adam E06：验证 jimaku 标题校验生效 → 应回 no-source
- 结果决定策略（mimo 够不够用）

### Phase 3：代码加固（TDD）
- ASS `{\…}` override 标签剥离
- parked 负缓存（不每 15min 重试）
- runs llm_calls 可观测性

### Phase 4：收口（全量测试 + 部署 + run-log + 交接文档更新）

## 生产环境
- `ssh media-router`（直连）或 `ssh media-router-tunnel`（CF 隧道）
- 容器 `subtitle-scout`，DB `/cache/scout.db`，NAS 挂载 `/media/{movies,tv,anime}`
- compose env 透传了 TRANSLATE_*/JIMAKU_API_KEY（compose 改在路由侧，deploy.sh 不覆盖）
- ai_translate_enabled=false（测试后已关）
- TRANSLATE_* 当前指 mimo（live test 配置）
- 备份三件套在 `/mnt/nvme0n1-4/backup/20260721-zerotest/`

## 关键文档
- `docs/design/2026-07-21-handoff-to-opencode.md`（交接）
- `docs/design/2026-07-22-live-test-postmortem.md`（live test 复盘）
- `docs/design/2026-07-21-campaign-run-log.md`（战役 run-log）
- `docs/design/2026-07-21-robustness-audit-campaign.md`（审计战役）

## 铁律
1. TDD（红→绿→全量≥基线+tsc）
2. fail-closed（闸不过不装）
3. realign 圣文件不动
4. daemon 只认 TRANSLATE_* + ai_translate_enabled
5. 不推公开仓
6. 能自己做的不问；不可逆/花钱先问（用户已授权烧配额/部署）
