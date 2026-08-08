# agency-agents 五路人格审计 · 综合报告（2026-07-24）

> 人格来源：github.com/msitarzewski/agency-agents（131k⭐）。
> 五路：代码考古 / UX 架构 / 产品经理 / SRE / 软件架构。全证据已附 file:line。

## 共识 Top4（四方交叉验证）

1. **TRANSLATE_* 容器全隐形**：.env.example 无模板、compose 不透传、deploy 区不显示 → 功能在容器里打不开且全程静默
2. **sidecar 三写路径翻译最弱**：stagingSandbox.install(H1 纪律) / writeSidecarAtomic(无冲突检查) / propagation(EXCL) → 归并 files/subtitleInstall.ts
3. **删除清单**（考古 D1-D14）：subtitle-fetch.ts+测试、retireClaimed、MediaIdentitySchema、死 import、concurrency 死字段、POLL_INTERVAL 僵尸、README 化石、fixtures/jellyfin
4. **翻译观测黑箱**：llm_calls 写而不读 / held 落库隐身 / 剧级术语表零入口 / 烧钱开关无确认流

## 生产核验（SRE）

健康 PASS：33 jobs 全 done、schema 16、零热循环、4450b70 已部署。
声明 9 项：7 项完全相符；E07"首行监志"字面部分不符（在 cue 3）；奥本海默为本地测试无落盘（预期）。
隐患🟡：claim 端不认开关（设计内，人工 INSERT wanted 行会照烧）；install 回写会覆盖人工术语清理；dashboard 无管理员（setup pending）。

## 架构矛盾（软件架构师）

C1 fetchLib 住 cli 层(agent 倒挂 9 处) · C2 traceBus 住 dashboard(倒挂 9 处) · C3 claimParked 住 apiV2(daemon 倒挂) · C4 apiV2 平行 SQL 层 · **C5 sidecar 三写路径** · **C6 中文 tag 表×5** · **C7 翻译双轨漂移(强化只落 agent 轨)** · C8 gatherSeriesContext/readSeriesTargetSubs 重复 · C9 mappings 僵尸参数(刻意留痕)

## 波次

- Wave 0 零风险卫生（文档/注释/env 可见性三角）
- Wave 1 删除（subtitle-fetch+测试、retireClaimed、MediaIdentitySchema、concurrency 字段、fixtures/jellyfin）
- Wave 2 架构搬移（traceBus→core、triageOps、fetchLib→adapters）
- Wave 3 功能 UI（观测开仓 + 设置页重组）
- Wave 4 待拍板（legacy 轨退役、apiV2 拆分、术语表 UI、⌘K、CSS 重构）
