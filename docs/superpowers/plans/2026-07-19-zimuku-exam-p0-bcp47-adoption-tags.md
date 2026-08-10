# zimuku 大考 P0:领养 tag 表 BCP-47 地区变体 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让磁盘上 `.zh-CN.srt` / `.zh-cn.srt` 等 BCP-47 地区变体命名的中文 sidecar 对领养臂可见(spec: docs/design/2026-07-19-zimuku-solo-coverage-exam-design.md §P0),并以生产上 5 份存量文件的自动领养作真机验证。

**Architecture:** 纯表驱动两处扩表——`languages.ts` 的探测 tag 集(供 `findExternalSidecar` 构造探测路径)+ `sidecar.ts` 的 tag→语言换算表(领养入账的 language 值)。零机制改动:探测机制是"构造 `<base>.<tag><ext>` 后 fileExists"(不是列目录比对),在大小写敏感 FS 上不存在"机制性不分大小写",spec 的"比对不分大小写"落地为**显式枚举两种真实世界大小写形态**:`zh-CN`(BCP-47 规范形,agent H2 白名单装机产物,生产实锤)与 `zh-cn`(Bazarr 装机遗留惯例,`#recycle` 里成片实锤)。

**Tech Stack:** TypeScript ESM,vitest,better-sqlite3(in-mem 测试),生产=docker\@media-router。

## 事实底座(2026-07-19 现场核查)

- 探测集现状 `tagsForLanguage('zh')` = `['zh-Hans','zh-Hant','zh','chs','cht','chi','zho']`——无任何地区变体。`CHINESE_SIDECAR_TAGS` 注释明言 "Kept verbatim — do not change its contents",修法=新增兄弟数组合并,不动原数组。
- 换算表现状 `LANGUAGE_BY_TAG`(sidecar.ts)同样无地区变体键;未表列 tag 原样返回→若只扩探测集不扩换算表,领养行 language 会落 'zh-CN' 而非规范二值域 zh-Hans/zh-Hant。
- **cheap path 每轮对所有既有条目重跑 classify()**(ingest.ts:520-559),`resolveStatusToWrite` 只挡 computed missing→prior unavailable;computed **covered 可覆写 unavailable**。故部署后下一轮 pass 自动领养,无需外科手术。
- 生产基线(2026-07-19 03:40 前后,schema v11):待领养活文件 **5 份**(记忆中"6 份"系笔误)——WITCH WATCH E02/E05/E11/E20 四份 `.zh-CN.srt` + anime/Adam's Sweet Agony E05 一份;对应 5 条 episodes 全部 `unavailable` 带判无叙事;`subtitles` 表 zh-CN/zh-cn 行数 = 0。WW E7/E24 也 unavailable 但**无盘上文件,修复后应保持 unavailable**(对照组)。总账:episodes covered 237 / unavailable 25。
- 生产触发一轮 pass:`docker exec subtitle-scout node dist/cli/index.js reconcile-all`(需 TMDB_API_KEY,生产 .env 已有;daemon watch 也会自行跑,kick 只为立等可查)。

---

### Task 1: languages.ts 探测 tag 集扩表

**Files:**
- Modify: `src/agent/languages.ts:20-37`
- Test: `src/agent/languages.test.ts:18-30`

- [ ] **Step 1: 改/加失败测试**

`src/agent/languages.test.ts` 中现有断言全量数组的测试改为(原第 19-21 行):

```ts
  it('zh maps to the historical Chinese sidecar tag set plus BCP-47 region variants', () => {
    expect(tagsForLanguage('zh')).toEqual([
      'zh-Hans', 'zh-Hant', 'zh', 'chs', 'cht', 'chi', 'zho',
      'zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg',
    ])
  })
```

同 describe 内追加:

```ts
  it('P0(zimuku大考): 地区变体两种大小写形态都必须在探测集内——探测机制是构造路径后 fileExists,大小写敏感 FS 上只能显式枚举(zh-CN=agent白名单装机形态,zh-cn=Bazarr遗留惯例)', () => {
    const tags = tagsForLanguage('zh')
    for (const t of ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']) {
      expect(tags).toContain(t)
    }
  })
```

- [ ] **Step 2: 跑测确认失败**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx vitest run src/agent/languages.test.ts; echo "exit: $?"`
Expected: FAIL ×2(数组不含地区变体),exit: 1。(纪律:直读 exit code,勿管道 tail。)

- [ ] **Step 3: 实现**

`src/agent/languages.ts`,在 `CHINESE_SIDECAR_TAGS`(不动)之后新增,并改 `LANGUAGE_TAGS.zh`:

```ts
/** BCP-47 地区变体(P0,zimuku 单源大考前置修复,2026-07-19)。A2 泛化后 agent 可自由选
 *  langTag(findSubtitleWorker H2 白名单),生产实证装出 `.zh-CN.srt` 而领养臂全瞎(Witch
 *  Watch E02/05/11/20 + Adam's E05:文件在、内容对、subtitles 零行、状态停 unavailable);
 *  NAS #recycle 里的 Bazarr 时代存量则是小写 `.zh-cn.srt`。探测机制是"构造
 *  `<base>.<tag><ext>` 后 fileExists"(files/sidecar.ts),在大小写敏感 FS 上不存在机制性
 *  不分大小写,故两种真实世界大小写形态都显式枚举。排在历史 tag 集之后——findExternalSidecar
 *  按序首中即返,规范装机形态(zh-Hans/zh-Hant)并存时继续优先。 */
const CHINESE_BCP47_REGION_TAGS = ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']

const LANGUAGE_TAGS: Record<string, string[]> = {
  zh: [...CHINESE_SIDECAR_TAGS, ...CHINESE_BCP47_REGION_TAGS],
  en: ['en', 'eng'],
  ja: ['ja', 'jpn'],
  ko: ['ko', 'kor'],
}
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run src/agent/languages.test.ts; echo "exit: $?"`
Expected: PASS 全绿,exit: 0。

- [ ] **Step 5: Commit**

```bash
git add src/agent/languages.ts src/agent/languages.test.ts
git commit -m "fix(adoption): 领养探测tag集补BCP-47地区变体两种大小写形态(zimuku大考P0)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: sidecar.ts 换算表 + 新单测文件

**Files:**
- Modify: `src/files/sidecar.ts:22-36`
- Create: `src/files/sidecar.test.ts`

- [ ] **Step 1: 写失败测试(新文件)**

`src/files/sidecar.test.ts` 全文:

```ts
import { describe, it, expect } from 'vitest'
import { findExternalSidecar, languageForTag, KNOWN_LANGUAGE_TAGS } from './sidecar.js'
import { tagsForLanguage } from '../agent/languages.js'

// P0(zimuku 单源大考前置,2026-07-19):BCP-47 地区变体 tag 的语言换算与探测接线。
// 区码→简繁:CN/SG=简体(zh-Hans),TW/HK=繁体(zh-Hant);小写形态=Bazarr 装机遗留惯例。
describe('languageForTag — BCP-47 地区变体', () => {
  it.each([
    ['zh-CN', 'zh-Hans'], ['zh-cn', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'], ['zh-sg', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'], ['zh-tw', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'], ['zh-hk', 'zh-Hant'],
  ])('%s → %s', (tag, lang) => {
    expect(languageForTag(tag)).toBe(lang)
  })

  it('KNOWN_LANGUAGE_TAGS(传播 EEXIST 分支的"认不认识"判据)包含全部地区变体', () => {
    for (const t of ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']) {
      expect(KNOWN_LANGUAGE_TAGS).toContain(t)
    }
  })
})

describe('findExternalSidecar × tagsForLanguage 接线(P0 生产场景)', () => {
  it('盘上只有 .zh-CN.srt(agent 白名单装机形态) → 目标含 zh 命中,语言 zh-Hans', () => {
    const disk = new Set(['/media/T/ep1.zh-CN.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-CN.srt', language: 'zh-Hans' })
  })

  it('盘上只有 .zh-cn.srt(Bazarr 遗留小写) → 同样命中', () => {
    const disk = new Set(['/media/T/ep1.zh-cn.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-cn.srt', language: 'zh-Hans' })
  })

  it('繁体区码 .zh-TW.srt → 语言换算 zh-Hant', () => {
    const disk = new Set(['/media/T/ep1.zh-TW.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-TW.srt', language: 'zh-Hant' })
  })

  it('规范形态优先:.zh-Hans.srt 与 .zh-CN.srt 并存 → 返回 zh-Hans 那份(tag 序在前)', () => {
    const disk = new Set(['/media/T/ep1.zh-Hans.srt', '/media/T/ep1.zh-CN.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit!.path).toBe('/media/T/ep1.zh-Hans.srt')
  })
})
```

(注:`Set.has` 天然大小写敏感——精确模拟 Linux/CI 文件系统,防"macOS 不分大小写"假绿。)

- [ ] **Step 2: 跑测确认失败**

Run: `npx vitest run src/files/sidecar.test.ts; echo "exit: $?"`
Expected: FAIL——`languageForTag('zh-CN')` 兜底原样返回 'zh-CN' ≠ 'zh-Hans':8 例换算 + KNOWN_LANGUAGE_TAGS + 接线前 3 例(Task 1 已落地故探测命中,但 language 换算值错)共 12 例 FAIL;"规范形态优先"1 例只断言 path,实现前即绿。exit: 1。

- [ ] **Step 3: 实现**

`src/files/sidecar.ts` 的 `LANGUAGE_BY_TAG` 表尾(`kor: 'ko'` 之后)追加:

```ts
  // P0(zimuku 单源大考前置,2026-07-19):BCP-47 地区变体。区码→简繁按业界惯例:CN/SG 简体、
  // TW/HK 繁体;小写形态是 Bazarr 装机遗留惯例(NAS #recycle 实锤),大写规范形是 agent H2
  // 白名单装机产物(生产实锤)。探测集侧的对应扩表见 agent/languages.ts CHINESE_BCP47_REGION_TAGS。
  'zh-CN': 'zh-Hans',
  'zh-cn': 'zh-Hans',
  'zh-SG': 'zh-Hans',
  'zh-sg': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'zh-tw': 'zh-Hant',
  'zh-HK': 'zh-Hant',
  'zh-hk': 'zh-Hant',
```

- [ ] **Step 4: 跑测确认通过**

Run: `npx vitest run src/files/sidecar.test.ts; echo "exit: $?"`
Expected: PASS 全绿,exit: 0。

- [ ] **Step 5: Commit**

```bash
git add src/files/sidecar.ts src/files/sidecar.test.ts
git commit -m "fix(adoption): tag→语言换算表补BCP-47地区变体(CN/SG→zh-Hans,TW/HK→zh-Hant)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: ingest 端到端回归锁(spec 点名的那条)

**Files:**
- Modify: `src/v2/ingest.test.ts`(追加一个 describe,放在 B3-1 领养 describe 之后)

- [ ] **Step 1: 写回归测试**

复用该文件既有测试设施(`lib`/`db`/`fakeDisk`/`makeDeps`/`makeIngestPass`,样板=第 820-881 行 B3-1 describe):

```ts
// P0(zimuku 单源大考前置,2026-07-19)生产实证回归锁:探针以 langTag 'zh-CN' 装机(H2 白名单
// 合法),`.zh-CN.srt` 落盘且内容正确,但领养 tag 集无 BCP-47 地区变体 → 领养臂全瞎——episodes
// 停 unavailable(判无叙事还挂着),subtitles 零行(WITCH WATCH E02/05/11/20 + Adam's E05)。
// 本 describe 锁死修复后行为:cheap path 下一轮 pass 即领养,unavailable→covered(covered 可
// 覆写 unavailable,resolveStatusToWrite 只挡 missing),判无叙事清除,subtitles 行落账。
describe('makeIngestPass — P0 BCP-47 地区变体 sidecar 领养', () => {
  it('.zh-CN.srt + 条目 unavailable(带判无叙事) → cheap path 领养:covered + 叙事清除 + subtitles 行 zh-Hans', async () => {
    const path = '/media/WITCH WATCH/ep5.mkv'
    lib.upsertSeries({ id: 'tmdb:261868', name: 'Witch Watch' })
    lib.upsertEpisode({ id: 'tmdb:261868/s1e5', seriesId: 'tmdb:261868', season: 1, episode: 5, name: 'E5', path, subStatus: 'missing' })
    db.prepare(`UPDATE episodes SET sub_status = 'unavailable', status_reason = 'No Chinese subtitle found on any provider' WHERE id = 'tmdb:261868/s1e5'`).run()
    lib.setProbeMemo('tmdb:261868/s1e5', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/WITCH WATCH/ep5.zh-CN.srt')

    await makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()

    expect(lib.getEpisode('tmdb:261868/s1e5')!.sub_status).toBe('covered')
    const narrative = db.prepare(`SELECT status_reason r FROM episodes WHERE id = 'tmdb:261868/s1e5'`).get() as { r: string | null }
    expect(narrative.r).toBeNull()
    const row = db.prepare(`SELECT path, language, source FROM subtitles WHERE item_id = ?`).get('tmdb:261868/s1e5')
    expect(row).toEqual({ path: '/media/WITCH WATCH/ep5.zh-CN.srt', language: 'zh-Hans', source: 'preexisting' })
  })

  it('.zh-cn.srt(Bazarr 遗留小写) missing→covered 同样领养', async () => {
    const path = '/media/Show/Season 1/ep9.mkv'
    lib.upsertSeries({ id: 'tmdb:9', name: 'Show' })
    lib.upsertEpisode({ id: 'tmdb:9/s1e9', seriesId: 'tmdb:9', season: 1, episode: 9, name: 'E9', path, subStatus: 'missing' })
    lib.setProbeMemo('tmdb:9/s1e9', 5000, 12345, [])

    const disk = fakeDisk()
    disk.setVideo(path, 5000, 12345)
    disk.addSidecar('/media/Show/Season 1/ep9.zh-cn.srt')

    await makeIngestPass(makeDeps({
      listVideoFiles: () => [path],
      fileExists: disk.fileExists, statFile: disk.statFile,
    }))()

    expect(lib.getEpisode('tmdb:9/s1e9')!.sub_status).toBe('covered')
    const row = db.prepare(`SELECT path, language, source FROM subtitles WHERE item_id = ?`).get('tmdb:9/s1e9')
    expect(row).toEqual({ path: '/media/Show/Season 1/ep9.zh-cn.srt', language: 'zh-Hans', source: 'preexisting' })
  })
})
```

- [ ] **Step 2: 跑测——预期直接 PASS(接线锁,不是驱动锁)**

Run: `npx vitest run src/v2/ingest.test.ts; echo "exit: $?"`
Expected: PASS,exit: 0——Task 1+2 已落地,本测锁的是端到端接线(探测集→classify rule 3→resolveStatusToWrite 覆写 unavailable→recordAdoptedSidecar→叙事清除)。**若 FAIL,停下走 systematic-debugging 查根因,严禁改断言凑绿**(最可疑处:fakeDisk 的 sidecar 命名、upsertEpisode 对 status_reason 的处理)。

- [ ] **Step 3: Commit**

```bash
git add src/v2/ingest.test.ts
git commit -m "test(adoption): P0回归锁——BCP-47地区变体sidecar领养端到端(unavailable→covered+叙事清除)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 全量门禁

- [ ] **Step 1: tsc**

Run: `cd /Users/dirtyfancy/projects/subtitle-scout && npx tsc --noEmit; echo "tsc exit: $?"`
Expected: tsc exit: 0。

- [ ] **Step 2: 根测试全量**

Run: `npx vitest run; echo "vitest exit: $?"`
Expected: 全绿(基线 1617 + 本计划新增 ~8),vitest exit: 0。web 侧无改动,免跑(计划外若有人动了 web,补 `cd web && npx vitest run`)。

---

### Task 5: 生产部署 + 真机领养验证(spec 的"顺带领养回存量")

沿用既定部署协议(P5/v11 先例)。全程只动部署目录与容器,媒体文件零触碰。

- [ ] **Step 1: 部署前基线复核(应与事实底座一致)**

```bash
ssh media-router 'sqlite3 -readonly /mnt/nvme0n1-4/docker/subtitle-scout/cache/scout.db "SELECT id, sub_status FROM episodes WHERE id IN (\"tmdb:261868/s1e2\",\"tmdb:261868/s1e5\",\"tmdb:261868/s1e11\",\"tmdb:261868/s1e20\",\"tmdb:261868/s1e24\",\"tmdb:261868/s1e7\",\"tmdb:241002/s1e5\"); SELECT count(*) FROM subtitles WHERE path LIKE \"%zh-CN%\" OR path LIKE \"%zh-cn%\"; SELECT sub_status, count(*) FROM episodes GROUP BY 1"'
```
Expected: 7 条全 unavailable;zh-CN 行数 0;covered 237 / unavailable 25。

- [ ] **Step 2: 备份定制 compose + 校验指纹**

```bash
ssh media-router 'cd /mnt/nvme0n1-4/docker/subtitle-scout && md5sum docker-compose.yml && cp docker-compose.yml docker-compose.yml.bak-p0-20260719'
```
Expected: md5 以 `ba45ee77` 开头(生产定制版,与 repo 版不同,绝不能被覆盖)。

- [ ] **Step 3: 发码(git archive,回填 compose)**

```bash
cd /Users/dirtyfancy/projects/subtitle-scout && git archive HEAD | ssh media-router 'tar -x -C /mnt/nvme0n1-4/docker/subtitle-scout'
ssh media-router 'cd /mnt/nvme0n1-4/docker/subtitle-scout && cp docker-compose.yml.bak-p0-20260719 docker-compose.yml && md5sum docker-compose.yml'
```
Expected: 回填后 md5 仍 `ba45ee77…`。

- [ ] **Step 4: 构建 → 停 → DB 备份 → 起**

```bash
ssh media-router 'cd /mnt/nvme0n1-4/docker/subtitle-scout && docker compose build 2>&1 | tail -3 && docker compose stop && mkdir -p backup-pre-p0-20260719 && cp -v cache/scout.db backup-pre-p0-20260719/ && for f in cache/scout.db-wal cache/scout.db-shm; do [ -f "$f" ] && cp -v "$f" backup-pre-p0-20260719/; done; docker compose up -d && sleep 8 && docker logs subtitle-scout --tail 15'
```
Expected: build 成功;备份就位;启动日志健康、**无 schema 迁移**(纯表扩容,停在 v11)。

- [ ] **Step 5: 踢一轮 pass 并等它跑完**

```bash
ssh media-router 'docker exec -d subtitle-scout node dist/cli/index.js reconcile-all'
sleep 120
```
(识别浪潮全 cheap path,~492 文件几分钟内过完;两分钟后先查,未齐再等。)

- [ ] **Step 6: 真机验收(P0 收官判据)**

```bash
ssh media-router 'sqlite3 -readonly /mnt/nvme0n1-4/docker/subtitle-scout/cache/scout.db "SELECT id, sub_status, coalesce(status_reason,\"NULL\") FROM episodes WHERE id IN (\"tmdb:261868/s1e2\",\"tmdb:261868/s1e5\",\"tmdb:261868/s1e11\",\"tmdb:261868/s1e20\",\"tmdb:241002/s1e5\"); SELECT id, sub_status FROM episodes WHERE id IN (\"tmdb:261868/s1e7\",\"tmdb:261868/s1e24\"); SELECT path, language, source FROM subtitles WHERE path LIKE \"%zh-CN%\" OR path LIKE \"%zh-cn%\"; SELECT sub_status, count(*) FROM episodes GROUP BY 1"'
```
Expected(五条判据,全中才算过):
1. WW E02/E05/E11/E20 + Adam's E05 → **covered**,status_reason 全 NULL(判无叙事清除);
2. **对照组** WW E07/E24 保持 unavailable(无盘上文件,不许误翻);
3. subtitles 出现恰好 **5 行**,path=那 5 份真实文件,language 全 **zh-Hans**,source 全 **preexisting**;
4. 总账 covered 237→**242**,unavailable 25→**20**,其余桶不动;
5. 容器日志无新 ERROR。

- [ ] **Step 7: 记录新基线**

把"episodes covered 242 / unavailable 20(2026-07-19 P0 后)"写进大考台账(scratchpad audit-tally 模式)与记忆断点——**这才是 zimuku 大考判卷用的三源基线**,spec 里的 237 作废。

---

## ✅ 执行记录(2026-07-19 03:30-03:50,全绿收官)

- Task 1-4 由 sonnet 写者子代理按计划逐字执行,主控逐 diff 亲核+亲跑门禁:commits `75f8b67`/`968ec9c`/`0cf56df`,tsc exit 0,vitest **1633/1633** 绿(基线 1616+新增 17;计划估的 1617+8 系 it.each 计数口径差,无实质)。
- Task 5 部署:compose md5 实为 `368491fe`(非计划预期的 `ba45ee77`——zimuku 点火加 ZIMUKU_ENABLED 透传后的合法演进,已 diff 核实定制内容[jellyfin 服务/build:./anime 挂载]后放行);DB 备份 `backup-pre-p0-20260719/`;**无需手动 kick**,容器起身首轮 watch pass 即完成领养。
- **真机验收超预期**:计划的"对照组 E7/E24 应保持 unavailable"前提错误——盘上躺的是 `.zh-TW.srt`(入学考探针给这两集装了繁体;此前 find 只搜 zh-CN 漏数,记忆"WW 6 份"实为 4×zh-CN + 2×zh-TW,无误)。实际领养 **7 份**(WW×6 + Adam's E5),两种区码两种简繁换算全部实弹命中:zh-CN→zh-Hans ×5、zh-TW→zh-Hant ×2,source 全 preexisting,判无叙事全清,容器日志零 ERROR。
- **新基线(zimuku 大考判卷用,spec 的 237 作废)**:episodes **covered 244 / embedded 150 / ignored 30 / unavailable 18**;movies covered 6 / embedded 4。
