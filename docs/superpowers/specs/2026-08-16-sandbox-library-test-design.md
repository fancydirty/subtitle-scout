# Spec：Sandbox 假片库 —— 不下载正片也能测「找字幕」

日期：2026-08-16 ｜ 状态：已批准（用户：多种子全覆盖 + 写计划 + 子代理 TDD + OrbStack 活体；休息期间连续执行）｜ 上游：开源卫生讨论；用户要求「假 mkv/mp4 + sandbox 提示词 + 中美两种目标语言」

## 1. 我理解的需求（先钉死，再谈设计）

要测的是 **scout 能不能为一部「名叫 X 的片子」找到目标语言字幕**，不是测转码、不是测播放、也不是测从网盘下 4GB 正片。

所以造两套**看起来像媒体库**的目录：

- 文件扩展名是真的 `.mkv` / `.mp4`，目录/文件名按真人片库习惯排。
- 文件本体是空的（0 字节）。不内嵌真实音视频。磁盘占用约 0。
- 空文件的 raw 事实会出卖它们（ffprobe 失败、时长空、体积 0）。**生产 agent 看到这些会合理怀疑「这是 trailer / 损坏 / 不是那部片」**。所以要给识别 / 找字幕 worker 加一份 **sandbox 附录提示词**：这是测试替身，仍按目录名所指向的那部真实作品去识别、去找字幕。
- 两套观众画像，目标语言相反：
  - **中国观众库**：片是外语（英/日等），目标字幕 `zh`。国产片放进来应 `origin-skip`。
  - **美国观众库**：片是中文影视，目标字幕 `en`。英语片放进来应 `origin-skip`。

成功标准是 sidecar 落在假视频旁边（真字幕文件、假视频），以及负例被诚实跳过。

**不是**：再造一个第二套 agent 代码。**不是**：把这套跑进生产 `watch` 或软路由真库。**不是**：本 spec 重做前端。

## 2. 范围

**In**

- 两份片库清单（manifest）+ 物化脚本：在本地目录写下 0 字节 `.mkv`/`.mp4`。
- 独立 sqlite + 独立守备目录；一次 CLI 跑完「扫描 → 识别 → 判定 → 找字幕」。
- 同一套 identify / find-subtitle worker，仅当 sandbox 开关打开时在 system prompt（及 skill 索引可见的一篇短附录）里注入测试世界观。
- 中国观众 / 美国观众两套 profile，含正例（该找字幕）和负例（该 origin-skip）。
- 验收口径：身份对、该装的装上目标语言 sidecar、该跳的 `skip_reason=origin-skip`。
- 明确与现有 v3 live matrix、`npm test` 的边界。

**Out**

- 翻译 agent（假视频抽不出内嵌轨，翻译路径本就会 `no-source`；不在本 spec 测）。
- 生产 daemon 默认行为、生产 DB、软路由真库。
- 把 sandbox 跑进 `npm test`（真模型 + 真字幕站，非确定、烧配额）。
- 前端页面改造（用户认为前端弱，另立案）。
- 开源卫生（独立 spec：`2026-08-16-open-source-hygiene-design.md`）。
- 为了让 ffprobe「看起来真」而去 mux 黑场视频。见 §4.1：短时长会把正片字幕闸死。
- 新字幕站、新匹配算法。

## 3. 已有基建，本 spec 不重造

| 已有 | 测的是什么 | 本 spec 补什么 |
|---|---|---|
| `fixtures/v3-live` + replay + `scripts/run-live-matrix.ts` | 录好的字幕站响应 + 真模型判断 | **没有**磁盘上的假片库，也**没有** `target_languages=en` 的观众画像 |
| `src/agent/dryRun.test.ts` | 工具桩化、磁盘零写入 | 不打真实字幕站 |
| 软路由真库 | 管线 + 真 mkv | 必须先有正片 |
| `findSubtitleWorker` 里现有「sandbox」一词 | **路径隔离**（agent 不许看见 mediaRoot 以外） | 名字撞车。本 spec 的开关叫 **`librarySandbox`**，文案用「假片库测试」，禁止再叫 sandbox 以免和路径沙盒混谈 |

目标语言能力其实已经在代码里：`settings.target_languages` + `resolveTargetLanguages` + `makeFindSubtitleSkill(targetLanguage)`。缺的是 **en 目标的活体片库** 和 **空文件世界观**。

## 4. 已裁决决策

### 4.1 假文件长什么样

**0 字节**的 `.mkv` / `.mp4`，文件名和目录名按真人片库写。

理由（代码已核实，不是拍脑袋）：

- `walkVideoFiles` 只认扩展名，0 字节仍是文件。`isScannable`（`src/v2/scanner.ts`）拒绝的是 `0 < size < 10MB`。**`size === 0` 会过扫描门**。若去造 1KB「文件头」，反而会被当垃圾跳过。
- 必须钉一条回归测试：`isScannable('…/Show.S01E01.mkv', 0).ok === true`。以后若有人「修」成拒绝空文件，假片库会静默扫不进来。更严重：`daemonV2.readRootWithRetry` 把「过完 isScannable 后 entries 为空」当成 R8 挂载抖动，**整根守备目录本轮不入库**。空文件若被拒，假片库看起来像「扫过了其实一行都没有」。
- **禁止** mux 1 秒黑场当真容器。找字幕 skill 用「字幕时间轴跨度约等于片长」做结构体检；1 秒片长会让**正确的** 40 分钟字幕被判脏。翻译路径还有机械闸 `cueEnd/videoDuration ∈ [0.85, 1.15]`，同样会被短时长误杀。本 spec 不跑翻译，但假片库以后可能被误拿去跑翻译——所以片长事实不准来自空文件的 ffprobe。
- 期望片长来自 **TMDB runtime**（identify 富化已经在传 `runtimeMinutes`）。空文件的 `durationSec` 保持 `null`，不要编一个假 ffprobe。

物化脚本用 `openSync` + `closeSync` 建空文件即可，不要 `truncate` 出稀疏大文件（大 `st.size` 会让人以为库很沉，且和「没有容量」相反）。

### 4.2 「sandbox agent」不是第二份 worker

同一份 `identifyWorker` / `findSubtitleWorker`。增加：

```
librarySandbox?: boolean
```

默认 `false`。`true` 时在 **system prompt 最前面** 追加附录（见 §6），并挂一篇短 skill 文档 `library-sandbox-test`（只在开关开时进 `read_doc` 索引——零误触发：生产模型连这个名字都看不见）。

**谁写 / 谁读 / 谁触发**

- 谁写：仅 CLI `sandbox-library`（§7）把 `librarySandbox: true` 传入组装函数。
- 谁读：`identifyWorker` 与 `findSubtitleWorker` 的 instructions 组装；`makeFindSubtitleSkill` **不改生产正文**，附录是独立 skill 文档。
- 谁触发：只有该 CLI。生产 `watch` / 软路由 compose **不许**读这个开关，也不许看 env 里是否存在假片库目录。禁止 `if (size===0) auto-enable sandbox`——空文件在真库里也可能是损坏下载，生产必须继续 fail-closed。

### 4.3 字幕站：真搜，不进 CI

假的是**视频**。字幕仍从 ASSRT / OpenSubtitles 等已配置源 **真搜真下**（和软路由同一条 adapter）。否则测不到「换目标语言还能不能找到」。

- **不进 `npm test`**。和 `run-live-matrix.ts` 同档：out-of-band。
- 不在本 spec 做 replay 录制。以后若要把某格焊进 CI，另开任务，沿用 v3 replay 机器。
- 配额：ASSRT 已有客户端限速；OpenSubtitles 下载计次。剧/番 **每个标题只放一集**，用标题数量换覆盖面，不拿整季换配额。

### 4.4 两套 profile，不是「把中文片和英文片混在一个守备目录里改语言」

`origin-skip` 的规则是：`origin_lang ∈ targetLanguages` 则不找字幕（`subtitleJudge.ts`）。所以：

| Profile | `target_languages` | 守备目录里放什么 | 期望 |
|---|---|---|---|
| `zh-viewer` | `zh`（默认 SKIP 同源） | 外语片（该找中字）+ **若干国产负例** | 外语 → 装中字 sidecar；国产 → `origin-skip` |
| `en-viewer` | `en` | 中文影视（该找英字）+ **若干英语负例** | 中文片 → 装英字 sidecar；英语片 → `origin-skip` |

两套目录、两套 DB，跑两次 CLI。不要在同一次 run 里中途改 `target_languages`——换语言会触发全库重判，把两次实验缠在一起。

美国观众侧技能正文已经语言中性（`makeFindSubtitleSkill('en')` 不含简繁等价段）。本 spec 不改 skill 生产正文，除非 live 跑出「en 目标时模型仍在找中字」——那时才改 skill，并按仓库铁律由人 + 主控改，agent 不得自改。

## 5. 种子清单（覆盖轴全，每标题一文件）

用户修订（2026-08-16）：既然视频是 mock，覆盖必须够宽——电影 / 剧 / 动画、老片 / 新片、中 / 外 / 日 / 韩。**每个剧或番只放 S01E01（或电影一个文件）**，用标题数量换覆盖面。

权威数据在 `fixtures/sandbox-libraries/catalog.json`。下面是必须出现的轴；缺一轴则 catalog 测试红。

**era**：`classic` = 年份 ≤ 1999；`modern` = 年份 ≥ 2000。
**region**：`us` `gb` `fr` `jp` `kr` `cn` `hk`（港片单独标，origin 仍常是 `zh`/`cn`）。
**format**：`movie` | `tv`。动画电影 `animation=true` + `format=movie`；TV 动画 `animation=true` + `format=tv`。

### 5.1 覆盖轴（测试钉死）

`zh-viewer` 的 `role=find` 必须同时含：

| 轴 | 最低数量 |
|---|---|
| 电影 × classic × us | 1 |
| 电影 × classic × jp | 1 |
| 电影 × modern × us | 1 |
| 电影 × modern × kr | 1 |
| 电影 × modern × fr | 1 |
| 动画电影 × jp | 1（classic）+ 1（modern） |
| 动画电影 × us | 1 |
| 剧 × us × classic | 1 |
| 剧 × us × modern | 1 |
| 剧 × gb | 1 |
| 剧 × kr | 1 |
| 剧 × jp（真人，animation=false） | 1 |
| TV 动画 × jp × classic | 1 |
| TV 动画 × jp × modern | 2 |
| `role=origin-skip` 且 region=cn：电影 classic、电影 modern、动画电影、剧 各 ≥1 | |

`en-viewer` 的 `role=find` 必须同时含：

| 轴 | 最低数量 |
|---|---|
| 电影 × classic × cn/hk | 1 |
| 电影 × modern × cn | 1 |
| 动画电影 × cn | 1 |
| 港片 movie × hk | 1 |
| 剧 × cn × classic（按年份 ≤1999 若不够则 modern 再补，但至少两部不同年代的剧） | 2 |
| `role=origin-skip` 且 origin 为英语：classic 电影 + modern 电影 各 ≥1 | |

控制变量：哪吒（movie 612399）与黑客帝国（movie 603）**两套 profile 都要有**，角色相反。

### 5.2 具体种子（写入 catalog.json；TMDB id 以站点为准）

`zh-viewer` find：

| id | 路径 | tmdb | 轴 |
|---|---|---|---|
| casablanca | `Movies/Casablanca (1942)/Casablanca.1942.mkv` | movie 289 | 电影 classic us |
| seven-samurai | `Movies/Seven Samurai (1954)/Shichinin.no.Samurai.1954.mkv` | movie 346 | 电影 classic jp |
| totoro | `Movies/My Neighbor Totoro (1988)/Tonari.no.Totoro.1988.mkv` | movie 8392 | 动画电影 classic jp |
| friends-s01e01 | `TV/Friends (1994)/Season 01/Friends.S01E01.mkv` | tv 1668 | 剧 classic us |
| cowboy-bebop-s01e01 | `TV/Cowboy Bebop (1998)/Season 01/Cowboy.Bebop.S01E01.mkv` | tv 30983 | TV 动画 classic jp |
| matrix | `Movies/The Matrix (1999)/The.Matrix.1999.1080p.mkv` | movie 603 | 电影（1999，classic 边界）us |
| amelie | `Movies/Amelie (2001)/Le.Fabuleux.Destin.d.Amelie.Poulain.2001.mkv` | movie 194 | 电影 modern fr |
| spirited-away | `Movies/Spirited Away (2001)/Sen.to.Chihiro.2001.mkv` | movie 129 | 动画电影 modern jp |
| oldboy | `Movies/Oldboy (2003)/Oldboy.2003.mkv` | movie 670 | 电影 modern kr（偏 00 年代） |
| sherlock-s01e01 | `TV/Sherlock (2010)/Season 01/Sherlock.S01E01.mkv` | tv 19885 | 剧 gb |
| aot-s01e01 | `TV/Attack on Titan (2013)/Season 01/Attack.on.Titan.S01E01.mkv` | tv 1429 | TV 动画 jp mid；算 modern 轴外加分 |
| spider-verse | `Movies/Spider-Man Into the Spider-Verse (2018)/Spiderverse.2018.mkv` | movie 324857 | 动画电影 us |
| parasite | `Movies/Parasite (2019)/Gisaengchung.2019.mkv` | movie 496243 | 电影 modern kr |
| squid-game-s01e01 | `TV/Squid Game (2021)/Season 01/Squid.Game.S01E01.mkv` | tv 93405 | 剧 kr |
| spy-family-s01e01 | `TV/SPY x FAMILY (2022)/Season 01/SPY.x.FAMILY.S01E01.mkv` | tv 120089 | TV 动画 modern jp |
| the-bear-s01e01 | `TV/The Bear (2022)/Season 01/The.Bear.S01E01.mkv` | tv 136315 | 剧 modern us |
| frieren-s01e01 | `TV/Frieren (2023)/Season 01/Frieren.S01E01.mkv` | tv 209867 | TV 动画 modern jp |
| oppenheimer | `Movies/Oppenheimer (2023)/Oppenheimer.2023.mkv` | movie 872585 | 电影 modern us |
| shogun-s01e01 | `TV/Shogun (2024)/Season 01/Shogun.S01E01.mkv` | tv 126308 | 剧 modern us（日本背景，origin 英语，仍该找中字） |
| midnight-diner-s01e01 | `TV/Midnight Diner (2009)/Season 01/Midnight.Diner.S01E01.mkv` | tv 47008 | 剧 jp 真人；若 id 与站点不符以实现期 TMDB search 校正，但轴不得删 |

`zh-viewer` origin-skip（国产，不派找字幕）：

| id | 路径 | tmdb |
|---|---|---|
| red-lantern-skip | `Movies/Raise the Red Lantern (1991)/Dahong.Denglong.1991.mkv` | movie 10494 |
| nezha-skip | `Movies/哪吒之魔童降世 (2019)/Nezha.2019.mkv` | movie 612399 |
| wandering-earth-skip | `Movies/The Wandering Earth (2019)/Liulang.Diqiu.2019.mkv` | movie 535167 |
| nirvana-skip | `TV/Nirvana in Fire (2015)/Season 01/Nirvana.in.Fire.S01E01.mkv` | tv 64197 |

`en-viewer` find（中文影视 → 英字）：

| id | 路径 | tmdb | 轴 |
|---|---|---|---|
| red-lantern | `Movies/Raise the Red Lantern (1991)/大红灯笼高高挂.1991.mkv` | movie 10494 | 电影 classic cn |
| in-the-mood | `Movies/In the Mood for Love (2000)/花样年华.2000.mkv` | movie 843 | 港片 hk |
| hero | `Movies/Hero (2002)/英雄.2002.mkv` | movie 79 | 电影 cn |
| big-fish | `Movies/Big Fish and Begonia (2016)/大鱼海棠.2016.mkv` | movie 271706 | 动画电影 cn；id 以实现期校正 |
| journey-west-s01e01 | `TV/Journey to the West (1986)/Season 01/Journey.to.the.West.S01E01.mkv` | tv 13923 | 剧 cn classic（西游记 1986） |
| nezha | `Movies/Nezha (2019)/哪吒之魔童降世.2019.mkv` | movie 612399 | 动画电影 cn（与 zh-viewer 反转） |
| wandering-earth | `Movies/The Wandering Earth (2019)/流浪地球.2019.mkv` | movie 535167 | 电影 modern cn |
| nirvana-s01e01 | `TV/Nirvana in Fire (2015)/Season 01/琅琊榜.S01E01.mkv` | tv 64197 | 剧 cn |
| untamed-s01e01 | `TV/The Untamed (2019)/Season 01/陈情令.S01E01.mkv` | tv 96111 | 剧 cn modern |

`en-viewer` origin-skip（英语片）：

| id | 路径 | tmdb |
|---|---|---|
| casablanca-skip | `Movies/Casablanca (1942)/Casablanca.1942.mkv` | movie 289 |
| matrix-skip | `Movies/The Matrix (1999)/The.Matrix.1999.mkv` | movie 603 |
| oppenheimer-skip | `Movies/Oppenheimer (2023)/Oppenheimer.2023.mkv` | movie 872585 |

剧/番一律一集。避开黑暗智宅（季包映射残局）和需翻译才有中字的德剧。

Midnight Diner / Big Fish / 西游记 的数字 id 若与 TMDB 当前条目不符：允许改 id，**不允许删轴**。catalog 测试只钉轴，不钉死每一个数字（数字由 json 自洽：`tmdbId` 为正整数）。

## 6. 附录提示词（生产默认不存在）

开关打开时，两份 worker 的 system prompt **最前**追加同一段（中英可只留英文，与现有 worker 提示词语言一致）：

```
LIBRARY SANDBOX TEST (ignore in production — this block is absent there).

The video files in this run are empty placeholders (0-byte .mkv/.mp4). ffprobe will
fail or return no duration and no subtitle streams. File size is not evidence.

Do NOT treat probe failure, missing duration, or 0-byte size as: damaged media, a
trailer, a sample, a fake title, or a reason to skip identification / search.

Identify each file as the real world title implied by its directory and file name.
Then find and install real subtitles for that title in the task's target language,
using the same evidence bar and fail-closed rules as production.

For runtime / subtitle-span checks, use TMDB runtime (and the task's
runtimeMinutes), never the placeholder file's ffprobe duration.

You still must not install a subtitle for the wrong episode or the wrong language.
Empty video is not a license to guess.
```

独立 skill 文档 `library-sandbox-test` 把这段展开三句话：空文件不是 identity 证据；TMDB runtime 替代片长；fail-closed 不放松。`read_doc` 索引只在 `librarySandbox===true` 时列入。

生产路径：该字段缺席或 `false` → 零字节附录、零文档名。用测试钉死：默认组装的 instructions **不含** `LIBRARY SANDBOX TEST`。

## 7. CLI 与隔离

```
npx tsx src/cli/index.ts sandbox-library --profile zh-viewer
npx tsx src/cli/index.ts sandbox-library --profile en-viewer
npx tsx src/cli/index.ts sandbox-library --profile all
```

行为顺序（谁写 / 谁读 / 谁触发写在每步）：

1. **物化**（脚本写磁盘）：读 `fixtures/sandbox-libraries/catalog.json`，在 `os.tmpdir()` 或 `--root` 下建目录 + 0 字节视频。不碰 NAS。
2. **新库**（脚本写 DB）：`openDb(tmp/scout-sandbox.db)`，不打开 `~/.subtitle-scout/cache/scout.db`。
3. **写入行为设置**：该 profile 的 `target_languages`；`engine_enabled=true`；守备目录 = 刚物化的根。
4. **跑一轮管线**：调用 `ScoutDaemonV2.inspectOnce(signal)`（新增的公开方法，内部就是现有 `runInspection`，禁止复制一份扫描/识别/判定/字幕循环）。`librarySandbox: true` 只在这一进程的 worker 组装里打开。
5. **断言并打印人话报告**：见 §8。每一格独立记 PASS / FAIL-PIPE / FAIL-SOURCE / FAIL-SKIP；**不因一格失败中止其余格子**。全部跑完后：有任一对正例/负例失败则 exit 非 0。

凭证：只读进程 env（及 `.env`）里的 TMDB / LLM / ASSRT / OpenSubtitles。v1 **不打开**生产 `scout.db`。没有 key 就诚实 exit，提示去设 env。

活体跑法：本机 OrbStack，脚本 `scripts/run-sandbox-library-in-orbstack.sh`。用仓库 Dockerfile 构建的镜像（自带 ffprobe / better-sqlite3），挂载 catalog + scratch 目录 + `--env-file .env`。**禁止**把宿主机 darwin 编译的 `better-sqlite3` 直接拿进 Linux 容器。不进 `npm test`。

## 8. 验收（每一格都是可观察事实）

对每个正例文件：

1. `works` 行的 TMDB id 等于 catalog 所写。
2. `files.needs_subtitle=1` 且最终 `sub_status=covered`（或 sidecar 磁盘上已存在目标语言——磁盘是真源；若 DB 仍显示 `needs_subtitle=1` 且 `sub_status=covered`，与当前生产记账习惯一致，**以磁盘 sidecar + sub_status 为准**）。
3. sidecar 语言是该 profile 的目标：`zh-viewer` 只允许 `zh-Hans` / `zh-Hant`；`en-viewer` 只允许现有安装路径会写出来的英语标签（今天生产装中字用 `zh-Hans` 这种 BCP-47 形态——实现时先读 `install_subtitle` 对非中文目标写什么，把那一个字符串写进断言；未实现前不得开跑 en-viewer 当验收）。**禁止** en-viewer 装上中字、zh-viewer 装上纯英字。
4. 字幕是**非空**文本（cue 数 > 10）。空文件当成功不算。

对每个负例文件：

1. `skip_reason=origin-skip`，`needs_subtitle=0`。
2. 该 path **没有** find-subtitle run（`runs` 表按 path/work 查为 0）。
3. 旁边没有新装的目标语言 sidecar。

识别失败或字幕站诚实 `no_safe_match`：这一格标 **FAIL-SOURCE**（源站没货或模型判断不装），与 **FAIL-PIPE**（扫不进、认成别的片、装错语言、负例却派了工）分开。v1 种子选熟片，是为了让 FAIL-SOURCE 不该出现；若出现，先查 catalog 是否选错片，再查 agent。

## 9. 与开源的关系

假片库是给 **维护者和贡献者** 的：没有 4GB 正片也能复现「找字幕」。不进公开 README 的「三步上手」（那是真用户拿真库）。README 可以有一节「开发者：假片库」链到本 CLI，放在卫生 spec 的文档工作里。

贡献者跑本 CLI 仍会：消耗他们自己的 LLM/字幕站配额、下载真实字幕文件到临时目录。文档必须写明。

## 10. 非目标与后续

- v1 只各一集正例剧。整季假文件会成倍烧搜索。
- 不在 v1 覆盖「季包映射」（黑暗智宅类）。假文件解不出「包内哪条对哪集」之外的新信息，除非以后专门做 pack fixture。
- 前端用假片库做演示：卫生之后、本 CLI 绿了，再决定要不要给 dashboard 指到 tmp 库。不本 spec。

## 11. 实现顺序（见 `docs/superpowers/plans/2026-08-16-sandbox-library-test.md`）

1. catalog.json + 覆盖轴测试。
2. 物化 0 字节文件 + `isScannable(…, 0)`。
3. `librarySandbox` 附录注入 + 生产路径负测。
4. `ScoutDaemonV2.inspectOnce()`。
5. 报告判定 + `sandbox-library` CLI（机械桩，进 `npm test`）。
6. OrbStack 活体 `zh-viewer` + `en-viewer`（不进 `npm test`）。
