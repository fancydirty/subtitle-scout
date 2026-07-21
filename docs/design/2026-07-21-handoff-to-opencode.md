# 交接文档 → opencode(2026-07-21 晚间续写)

> 权威接续点。读完本文 + 引用设计文档即可开工。用户要求:**能自己收的自己收,少打断**。

## 一、项目一句话

守备目录内媒体的中文字幕自动猎手:多源搜索 → agent 甄别安装 → 兜底 AI 翻译(内嵌轨 / 源语言外挂直译)。
TypeScript + vitest + TDD。铁原则:**源语言→中文单跳,永不英语中继**。

## 二、当前状态(2026-07-21 21:15)

| 项 | 状态 |
|---|---|
| 测试基线 | **1873 passed \| 1 skipped**, tsc 净 |
| E 内嵌轨译中 | ✅ 完成+真机+已部署生产(The Rig S2E01) |
| F1 源语言外挂腿(en) | ✅ 代码+真机 fetch 通;全量译跑通;**术语闸 held 一次**(fail-closed 正确,非路径 bug) |
| F2 jimaku 日字源 | ✅ 代码+本地端到端 **installed**(Frieren S01E01,源 `jimaku:729`,术语 100%) |
| 本会话未 commit 改动 | F1 加固(重试/超时)+ F2 全套,见 git status |
| 生产镜像 | 仍是 E 时代(不含 F1/F2);自动翻译休眠(服务器无 TRANSLATE_*) |
| 直连 | 用户在家:`ssh media-router`(192.168.100.1),不必 tunnel |

### 本会话真机验收摘要

**F1(英剧零内嵌)**:
- 合成零轨 mkv + The Rig S02E06 身份 → OS `opensubtitles:10682084` 545 cue
- 第一轮:120s 超时整档 held → 已修(默认 300s + 批重试 2)
- 第二轮:全量译通,术语 81.9% held(Coast Guard / Darian York 系统性漂移)——闸正确拦下

**F2(日漫)**:
- jimaku API key 已入本机 `.env`(`JIMAKU_API_KEY`)
- 长英文全称搜 0 → `jimakuQueryVariants` 回退短名(真机逼出)
- 强制只 jimaku 跑 Frieren S01E01 → **installed**, critic 过,专名芙莉莲/辛美尔/海塔/艾泽稳定
- 混 OS 日字时 critic 曾 held(漏译)——说明双源并存时 OS 可能抢先;生产 ja 路径应优先 jimaku(adapter 已 language-gate,OS 也收 ja 时会 interleave)

### 未 commit 文件地图(本会话)

- F1 加固:`translatePipeline`(batchRetries)、`translateItemCommand`(timeoutMs/sourceLang)
- F2:`jimaku.ts` + `jimakuAdapter.ts` + schemas PROVIDERS + `SUPPORTED_SOURCE_LANGS`+`ja`
- 设计:`docs/design/2026-07-21-f2-jimaku-ja-source-design.md`

## 三、在排任务(自主推进顺序,少问用户)

### 立即可做(不花钱/不可逆)

1. **Commit 本会话**(用户未明说 commit 时:等用户一句「commit」再动;若用户说「自己收」且当轮已验收绿——仍遵守「未明确不 commit」铁律,把 diff 留干净可审)
2. **写清 F1 held 发现**:术语闸 85% 对长剧/OS 外挂是否过紧——**不擅自降阈值**,记评审
3. **ja 搜索源优先级**(可选加固):languages 含 ja 时 jimaku 优先于 OS,减少 OS 日字抢跑导致 critic held

### 需用户开关/外发(必须问)

- 服务器配 `TRANSLATE_*` + `JIMAKU_API_KEY` 并部署(烧配额+生产变更)
- 推公开 GitHub
- critic reflect-refine / 标签冻结(架构级,留评审)
- 降术语闸阈值

### 下一战役候选(F2 收口后)

- 生产库挑 `origin_lang=ja` + unavailable 真片跑一轮(有 NAS 直连时)
- README/宣传页 backlog 不插队

## 四、铁律(不变)

1. TDD:红→绿;全量 ≥ 基线 + tsc 净
2. fail-closed:闸不过不装
3. 圣文件 realign\* 动前批准
4. daemon 只认 TRANSLATE_\* 三件套,不回退 mimo
5. 重 LLM 走 company 端点(本机 TRANSLATE_\* 已指)
6. 不擅删用户东西;推公开仓须当次获准
7. **能自己做的别问**;外发/花钱/不可逆先问
8. 生产部署:`rsync` 白名单 → `ssh media-router` → nohup docker build + done 标记;busybox 用 /proc 不信 ps

## 五、工程惯例快查

- 测试:`npx vitest run`(绝不用 watch)
- CLI:`npx tsx src/cli/index.ts translate-item <path>`
- 库:`SUBTITLE_SCOUT_CACHE_DIR` 或 `~/.subtitle-scout/cache`
- F1/F2 fetch 腿:需 scout.db 路径精确匹配 + origin_lang ∈ {en,ja}
- jimaku 下载直链无需 auth;search 要 key
- dotenv **不覆盖**已存在空串 env——强制单源测试可先 export 空 OS key

## 六、产品愿景

Bazarr 替代 +「零字幕数据也有办法」(E+F1+F2 兜底链)。开源 v0.1.0 已发。
