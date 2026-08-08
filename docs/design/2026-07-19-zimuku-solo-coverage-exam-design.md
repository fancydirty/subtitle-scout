# zimuku 单源覆盖力大考 · Spec(2026-07-19,用户亲自设计)

用户令原文:"再度把所有字幕全删,然后让字幕提供商只有 zimuku,从而测试它的资源覆盖实力。"
背景:zimuku 生产首航(2026-07-19 点火)在 24 判无入学考中参战 0 命中——样本太窄(4 部本就
难啃的剧),无法评估真实价值。单源隔离 + 全库从零 = 最干净的覆盖力度量:每一个它装上的都
纯归它,每一个装不上的都纯怪它。

## P0 前置修复(必须先落,否则大考数据失真)

**领养 tag 表补 BCP-47 地区变体**:2026-07-19 实证,agent 在 A2 泛化后可自由选 langTag,
zimuku 入学考探针装出 `.zh-CN.srt`(H2 白名单合法),但 scanner 领养 tag 集(zh-Hans/zh-Hant/
zh/chs/cht/chi/zho)不含 `zh-CN` → **盘上真实字幕对领养臂隐形**(Witch Watch 6 份实锤,文件
在、内容对、DB 全瞎)。修:`tagsForLanguage('zh')` 补 zh-CN/zh-TW/zh-HK/zh-SG(比对不分大小
写),+回归测试(`.zh-CN.srt` sidecar 在目标含 zh 时被领养)。大考中 agent 若再选这类 tag,
harvest 路径本就落库无碍,但**崩溃恢复/探针/手放场景全靠领养臂**,不能瞎。
(顺带把 Witch Watch 那 6 份 zh-CN 存量领养回来,作为该修复的真机验证。)

## 考试协议(全程可回滚,沿用 e2e-zero 取证协议)

1. **取证归档**(照抄 e2e-zero-20260718 先例):当前全部 sidecar 字幕 manifest + tar 归档;
   cache 全退休(scout.db+journals 等)进 `e2e-zimuku-solo-<date>/cache-before/`;DB 是从零
   重建材料,归档后删。持久日志 follower 挂 `from-zero-zimuku.log`(容器轮转仅 30MB 必丢)。
2. **单源隔离**:`.env` 先备份(`.env.bak-zimuku-solo`)→ 置空/注释 `ASSRT_TOKEN`、
   `OPENSUBTITLES_API_KEY/USERNAME/PASSWORD`(**保留 TMDB_API_KEY 与 LLM_***——识别与判断
   不是考试对象),保持 `ZIMUKU_ENABLED=true` → 重启容器。
   **隔离验证(硬门)**:启动日志/探针确认 adapters 列表 == [zimuku] 仅一项;若 assrt/OS 在
   无凭据时仍装载(buildAdapters 行为待现场核),用其各自 env 开关或临时置 `enabled` 门控,
   总之**不见单源列表不开考**。
3. **从零重建**:容器起 → 识别浪潮(492 文件,预期 ~8 分钟,验证层与三源版一致)→
   orchestrator 派活 → agent 逐单真打(唯一源=zimuku)。
4. **观察重点**(zimuku 是抓取型源,行为面即考点):
   - 验证码求解器实弹频率与成功率(墙①后走朴素 generateText 多模态);
   - 会话(ZimukuSessionStore)持久性;限速/封禁迹象(连续失败模式、HTTP 状态);
   - agent 面对单源枯竭时的判无质量(判词应明说仅 zimuku 可用);
   - **礼貌性**:若观察到疑似反爬升级,允许中止考试恢复三源——度量不值得烧号。
5. **判卷口径**:
   - 主指标:zimuku-only covered 数 / 三源基线 covered 数(2026-07-19 基线=237 covered
     +150 embedded,gap 需求集 ≈262);
   - 分类细目:动漫/欧美剧/电影 各自捞回率(对照 E 片区生态情报:假说=zimuku 强于 assrt 弱
     于 OS 的位置在哪);
   - 行为面:验证码次数/成功率、平均步数、判无判词质量抽查;
   - 内容抽验:装机件按 War② 审计法抽 15-20 份(语言/时轴/归属锚点)。
6. **恢复协议**(考完必做):还原 `.env` 三源 → 重启 → 让 daemon 自主补齐 zimuku 没啃动的
   缺口 → 终态覆盖必须 ≥ 考前基线(240 covered 上下)。取证目录永久保留供对比分析。

## 风险与边界

- 媒体文件零风险(只动 sidecar 字幕与 scout DB,全归档);生产容器全程在线(考试即生产
  daemon 自身运行);Jellyfin/其它容器不碰。
- 时长预期:数小时(228+ 缺口 × 单源真打;比三源版慢,zimuku 无季包 fileIndex 直下时更慢)。
- 配额:LLM 照烧(用户已授权);zimuku 无官方配额但有反爬,见礼貌性条款。
- **不做**(YAGNI):不改 provider 代码来"支持单源模式"(纯 env 隔离);不为考试加任何
  度量代码(判卷全靠 DB+日志事后统计);不与鉴权战役混做。

## 执行位置

compact 后新 session 按本 spec 执行:P0 修复(写者)→ 亲核+门禁 → 部署 → 考试协议 1-6。
台账续写 audit-tally.md 模式;终报入 docs/design/。
