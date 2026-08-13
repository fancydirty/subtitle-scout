import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type ScoutDb } from '../v2/db.js'
import { LibraryRepo } from '../v2/libraryRepo.js'
import { SettingsRepo } from '../v2/settingsRepo.js'
import { JobsRepo } from '../v2/jobsRepo.js'
import {
  buildRuns,
  buildSettings, buildDeploySettings, listMediaSubdirs, SETTINGS_KEYS, updateSettings, addMediaRoot,
  buildWorkflowPending, buildWorkflowPasses,
  redispatch, buildRunTrace, buildDormantTasks, dormantTargetLabel,
} from './apiV2.js'
// 2026-08-13 清理：`import { INGEST_ORCHESTRATE_SERIES_ID }` 已删（零引用）。它当初是
// 清算波 R-6（F9b）为"用真实常量而不是陈旧字符串 'self-scan-trigger' 造 ingest 触发器的
// 合成 series_id 测试行"引入的，但那条用例后来随旧库三族端点一并删除。今天本文件里所有
// orchestrate 相关用例造的都是 'orchestrator-shard-N' 这种手写分片 id，与 ingest 触发器的
// 固定 identity 无关，用不到这个常量。常量本体仍活着（ingestTrigger.ts 的去重键）。
// 接缝回归（2026-08-10）：lastScanAt 的**真写入者**。见下方 🔴 用例——这条 import 的存在
// 本身就是那个缺口的修补：此前本文件只手写 INSERT 复述键名，从不碰真正的写入方。
import { ScoutDaemonV2 } from '../v2/daemonV2.js'

let db: ScoutDb
let lib: LibraryRepo
const NOW = 1_700_000_000_000

function insertJob(
  db: ScoutDb,
  fields: { kind: 'series_season' | 'movie'; seriesId?: string; season?: number; movieId?: string; state: string; priority: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, state, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.kind,
      fields.seriesId ?? null,
      fields.season ?? null,
      fields.movieId ?? null,
      fields.state,
      fields.priority,
      NOW,
      NOW,
    )
  return Number(info.lastInsertRowid)
}

/** v3 worker_task job: series_id/season/movie_id land in their own COLUMNS (upsertWorkerTask's
 *  INSERT list, jobsRepo.ts) — payload only carries taskType/reason. Mirrors that shape here so
 *  tests exercise apiV2's dual-source queries against the real column/payload split, not a
 *  simplified stand-in. */
function insertWorkerTaskJob(
  db: ScoutDb,
  fields: {
    seriesId?: string; season?: number | null; movieId?: string; taskType: string; state: string; priority: number
    /** payload.seasons。省略 = payload 不带这个键（解析方视作 null）。
     *  ⚠️ 原注释写的是"buildWorkflowWorkers 的 seasons 解析测试用"——那个 builder 已于
     *  2026-08-13 删除；本字段仍被其它用例（buildWorkflowPending 等）使用，故保留。 */
    seasons?: number[] | null
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, payload, state, priority, created_at, updated_at)
       VALUES ('worker_task', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.seriesId ?? null,
      fields.season ?? null,
      fields.movieId ?? null,
      JSON.stringify(
        fields.seasons !== undefined
          ? { taskType: fields.taskType, seasons: fields.seasons, reason: 'test' }
          : { taskType: fields.taskType, reason: 'test' }
      ),
      fields.state,
      fields.priority,
      NOW,
      NOW,
    )
  return Number(info.lastInsertRowid)
}

function insertRun(db: ScoutDb, jobId: number, startedAt: number, decision: string, detail: string): void {
  db.prepare(
    `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(jobId, startedAt, startedAt + 1000, decision, detail, `/j/${startedAt}/decision.json`)
}

/** 往 `files` 表播 n 行——daemonV2 扫盘写的那张表，也是 meta.files 的唯一数据源。
 *  路径带序号保证 UNIQUE；只填 NOT NULL 列，其余留默认（本用例族只关心 COUNT(*)）。 */
function seedFiles(d: ScoutDb, n: number): void {
  const stmt = d.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, updated_at)
     VALUES (?, '/media/tv', ?, 1, 1, 1)`,
  )
  for (let i = 0; i < n; i++) stmt.run(`/media/tv/seed-${i}.mkv`, `seed-${i}.mkv`)
}

beforeEach(() => {
  db = openDb(':memory:')
  lib = new LibraryRepo(db)

  // Series A: 覆盖各态各一（路径在 /media/tv 下）
  lib.upsertSeries({ id: 's1', name: 'Series A', chineseTitle: '甲剧', posterPath: 'ptag-s1', year: 2021 })
  lib.upsertEpisode({ id: 'e1', seriesId: 's1', season: 1, episode: 1, name: 'E1', path: '/media/tv/Series A/S01/e1.mkv', subStatus: 'covered' })
  lib.upsertEpisode({ id: 'e2', seriesId: 's1', season: 1, episode: 2, name: 'E2', path: '/media/tv/Series A/S01/e2.mkv', subStatus: 'missing' })
  lib.upsertEpisode({ id: 'e3', seriesId: 's1', season: 1, episode: 3, name: 'E3', path: '/media/tv/Series A/S01/e3.mkv', subStatus: 'embedded' })
  lib.upsertEpisode({ id: 'e4', seriesId: 's1', season: 2, episode: 1, name: 'E4', path: '/media/tv/Series A/S02/e4.mkv', subStatus: 'unavailable' })

  // Movie Z（路径在 /media/movies 下）
  lib.upsertMovie({ id: 'm1', name: 'Movie Z', path: '/media/movies/Movie Z/z.mkv', subStatus: 'missing', posterPath: 'ptag-m1', year: 2019 })

  // Jobs: s1 season1 (searching, 100), movie m1 (wanted, 0)
  const seriesJobId = insertJob(db, { kind: 'series_season', seriesId: 's1', season: 1, state: 'searching', priority: 100 })
  insertJob(db, { kind: 'movie', movieId: 'm1', state: 'wanted', priority: 0 })

  // Two runs on the series job
  insertRun(db, seriesJobId, NOW - 2000, 'no_safe_match', '暂时没找到')
  insertRun(db, seriesJobId, NOW - 1000, 'download', '下好一集')
})
// ── parked 族的 7 条用例已删除，2026-08-13 ──────────────────────────────────
// `buildParked` 1 条 + `unexclude` 4 条 + `buildTriage` 2 条。被测函数随 parked_paths 的
// 唯一写入者（src/v2/ingest.ts）一并退役——表从此零写入者，读出面留着就是给一张永远为空的
// 表建界面。没有降级形态可留：这不是"断言变松"，是被断言的东西不存在了。
// 正本论证见 web/src/triage/TriagePage.tsx 头注释的「2.5 parked 族的结局」段。

describe('buildRuns', () => {
  it('全局历史按 id desc，limit/offset 生效', () => {
    const all = buildRuns(db, 0, 50)
    expect(all.length).toBe(2)
    expect(all[0].decision).toBe('download') // 最近插入
    const page = buildRuns(db, 1, 50)
    expect(page.length).toBe(1)
    expect(page[0].decision).toBe('no_safe_match')
  })
})

// dashboard G4：settings/deploy/fs 三个只读端点的纯函数底座。
describe('buildSettings（GET /api/v2/settings：白名单键，未设置=null）', () => {
  it('全部未设置时九键皆 null + engineEnabled 兜底为 true', () => {
    const settings = new SettingsRepo(db)
    expect(buildSettings(settings)).toEqual({
      target_languages: null, hardsub_mode: null, exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      // engine_enabled 未设置 → fail-open 兜底为 true（本任务 ③ 的布尔别名）。
      engineEnabled: true,
    })
  })

  it('已设置的键原样带出字符串值，其余仍为 null', () => {
    const settings = new SettingsRepo(db)
    settings.set('target_languages', 'zh,en', NOW)
    settings.set('hardsub_mode', 'aggressive', NOW)
    expect(buildSettings(settings)).toEqual({
      target_languages: 'zh,en', hardsub_mode: 'aggressive', exclude_extras: null,
      trace_retention_days: null, scan_interval_ms: null, ai_translate_enabled: null,
      engine_enabled: null, 'provider:SUBHD_ENABLED': null, 'provider:ZIMUKU_ENABLED': null,
      engineEnabled: true,
    })
  })

  it('白名单外的 key 不出现在 DTO 里（哪怕 repo 里真有这行）', () => {
    const settings = new SettingsRepo(db)
    settings.set('not_a_real_setting', 'sneaky', NOW)
    const dto = buildSettings(settings)
    expect(Object.keys(dto).sort()).toEqual([...SETTINGS_KEYS, 'engineEnabled'].sort())
  })
})

describe('settings · 启动面三键（spec A §4.4/§4.6）', () => {
  it('PUT 接受 engine_enabled/provider:SUBHD_ENABLED/provider:ZIMUKU_ENABLED 的 true/false', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    const r = updateSettings(repo, { engine_enabled: 'false', 'provider:SUBHD_ENABLED': 'true', 'provider:ZIMUKU_ENABLED': 'true' }, NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.settings.engine_enabled).toBe('false')
      expect(r.settings['provider:SUBHD_ENABLED']).toBe('true')
    }
  })

  it('三键拒绝非 true/false 值（全有或全无）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(updateSettings(repo, { engine_enabled: 'yes' }, NOW).ok).toBe(false)
    expect(updateSettings(repo, { 'provider:ZIMUKU_ENABLED': '1' }, NOW).ok).toBe(false)
    expect(updateSettings(repo, { engine_enabled: 'true', 'provider:SUBHD_ENABLED': 'on' }, NOW).ok).toBe(false)
    expect(repo.get('engine_enabled')).toBeNull()   // 非法批次不落任何键
  })

  it('GET DTO 的 engineEnabled 布尔别名：null→true（fail-open）、false→false、脏值→true', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(buildSettings(repo).engineEnabled).toBe(true)
    repo.set('engine_enabled', 'false', NOW)
    expect(buildSettings(repo).engineEnabled).toBe(false)
    repo.set('engine_enabled', '0', NOW)
    expect(buildSettings(repo).engineEnabled).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-F15 缺口③：换目标语言 → 全库重判的**触发点**就在这里。
// 「谁触发」必须钉死在一条能跑通的链路上——本仓栽过 6 次「加了能力却没定谁写/谁读/谁触发」。
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 R-F15 · PUT target_languages 变更触发全库重判', () => {
  const seedJudged = (d: ScoutDb, needs: number, reason: string) => {
    d.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_id,
                                  needs_subtitle, skip_reason, updated_at)
               VALUES ('/m/a.mkv','/m','a.mkv',1,1,'tmdb:1',?,?,1)`).run(needs, reason)
  }
  const judgedRow = (d: ScoutDb) =>
    d.prepare('SELECT needs_subtitle, skip_reason FROM files').get()

  it('🔴 值真的变了 → 全库 needs_subtitle/skip_reason 清 NULL（下轮 judge 自然重判）', () => {
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 0, 'origin-skip')
    expect(updateSettings(repo, { target_languages: 'en' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: null, skip_reason: null })
  })

  it('🔴 幂等：PUT 同一个值 → 不触发重判（判决列原样保留）', () => {
    // 设置页保存按钮把整个表单一起 PUT，同值反复提交是**常态**。每次都清全库判决 =
    // 每次点保存都让全库重跑一遍 judge，并把 sub_status 按同一批语言重导一遍——
    // 一个纯粹的无变化保存变成周期性全库写。只有真的变了才触发。
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 0, 'origin-skip')
    expect(updateSettings(repo, { target_languages: 'zh' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: 0, skip_reason: 'origin-skip' })
  })

  it('🔴 只改别的键（body 不含 target_languages）→ 不触发重判', () => {
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 1, 'missing')
    expect(updateSettings(repo, { hardsub_mode: 'aggressive' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: 1, skip_reason: 'missing' })
  })

  it('🔴 校验失败的批次 → 一列都不许动（全有或全无，重判也在同一个事务里）', () => {
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh', NOW)
    seedJudged(d, 0, 'embedded')
    expect(updateSettings(repo, { target_languages: 'en', hardsub_mode: 'bogus' }, NOW + 1).ok).toBe(false)
    expect(repo.get('target_languages')).toBe('zh')
    expect(judgedRow(d)).toEqual({ needs_subtitle: 0, skip_reason: 'embedded' })
  })

  it('🔴 等价写法归一：`zh,en` → `zh, en` 只是空白差异，不算变更（不触发重判）', () => {
    // zod 的正则不允许空格，但 settings 表里可能有历史脏值/别的写入路径的产物。
    // 用解析后的语言**列表**比较而不是裸字符串——比较的是"目标语言集合变没变"这个语义，
    // 不是"这个字符串的字节变没变"（字段名必须与真实含义逐字对应）。
    const d = openDb(':memory:')
    const repo = new SettingsRepo(d)
    repo.set('target_languages', 'zh, en', NOW)
    seedJudged(d, 1, 'missing')
    expect(updateSettings(repo, { target_languages: 'zh,en' }, NOW + 1).ok).toBe(true)
    expect(judgedRow(d)).toEqual({ needs_subtitle: 1, skip_reason: 'missing' })
  })
})

describe('媒体根路径形状（spec A §11-1：win32 绝对路径不冤杀）', () => {
  it('listMediaSubdirs/addMediaRoot 接受 C:\\ 形状进入存在性检查（POSIX 上诚实报不存在），相对路径仍拒', () => {
    expect(listMediaSubdirs('C:\\media')).toEqual({ ok: false, error: 'path does not exist' })
    expect(listMediaSubdirs('relative/path')).toEqual({ ok: false, error: 'path must be an absolute path' })
    const repo = new SettingsRepo(openDb(':memory:'))
    expect(addMediaRoot(repo, 'D:/media', NOW)).toEqual({ ok: false, error: 'path does not exist' })
    expect(addMediaRoot(repo, 'media', NOW)).toEqual({ ok: false, error: 'path must be an absolute path' })
  })
})

describe('addMediaRoot 重叠校验（业界标准 overlapping-paths validation）', () => {
  // 真实目录（存在性检查在重叠检查之前，所以测试必须用磁盘上真的存在的路径）
  let tmp: string
  let child: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'scout-roots-'))
    child = join(tmp, 'movies')
    mkdirSync(child)
  })

  it('已登记某根后，其子目录被拒（子树已在扫描范围内）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    repo.addRoot(tmp, NOW)
    const r = addMediaRoot(repo, child, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('already covered by media root')
      expect(r.error).toContain(tmp)
    }
  })

  it('已登记某根后，其父目录被拒（会把已有根重复扫一遍）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    repo.addRoot(child, NOW)
    const r = addMediaRoot(repo, tmp, NOW)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('contains existing media root')
      expect(r.error).toContain(child)
    }
  })

  it('重复提交同一路径仍幂等放行（既有 INSERT OR IGNORE 语义不变）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    repo.addRoot(tmp, NOW)
    expect(addMediaRoot(repo, tmp, NOW)).toEqual({ ok: true })
    expect(repo.listRoots()).toHaveLength(1)
  })

  it('同名前缀的兄弟目录不算重叠（/media/tv 不挡 /media/tv2）', () => {
    const repo = new SettingsRepo(openDb(':memory:'))
    const tv = join(tmp, 'tv')
    const tv2 = join(tmp, 'tv2')
    mkdirSync(tv)
    mkdirSync(tv2)
    repo.addRoot(tv, NOW)
    expect(addMediaRoot(repo, tv2, NOW)).toEqual({ ok: true })
    expect(repo.listRoots()).toHaveLength(2)
  })
})

describe('buildDeploySettings（GET /api/v2/settings/deploy：env 脱敏只读）', () => {
  it('secrets 未配置 → present:false，tail 空', () => {
    const dto = buildDeploySettings({})
    expect(dto.secrets.TMDB_API_KEY).toEqual({ present: false, tail: '' })
    expect(dto.secrets.DASHBOARD_TOKEN).toEqual({ present: false, tail: '' })
  })

  it('secrets 已配置（≥4位）→ present:true，tail 是尾 4 位，不泄露其余部分', () => {
    const dto = buildDeploySettings({ TMDB_API_KEY: 'sk-abcdef1234567890' })
    expect(dto.secrets.TMDB_API_KEY).toEqual({ present: true, tail: '7890' })
    expect(JSON.stringify(dto)).not.toContain('abcdef')
  })

  it('secrets 短于 4 位 → 全遮（不直接回显短密钥的任何字符）', () => {
    const dto = buildDeploySettings({ DASHBOARD_TOKEN: 'ab' })
    expect(dto.secrets.DASHBOARD_TOKEN).toEqual({ present: true, tail: '**' })
  })

  it('非机密项原样字符串带出；未设置为 null', () => {
    const dto = buildDeploySettings({ LLM_BASE_URL: 'https://api.deepseek.com/v1', LLM_MODEL: 'deepseek-chat' })
    expect(dto.nonSecrets.LLM_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(dto.nonSecrets.LLM_MODEL).toBe('deepseek-chat')
    expect(dto.nonSecrets.DASHBOARD_PORT).toBeNull()
  })

  it('已知全部 secret key 枚举：TMDB/LLM/DASHBOARD/ASSRT/OpenSubtitles 均被覆盖', () => {
    const dto = buildDeploySettings({})
    const keys: (keyof typeof dto.secrets)[] = [
      'TMDB_API_KEY', 'LLM_API_KEY', 'DASHBOARD_TOKEN', 'ASSRT_TOKEN', 'OPENSUBTITLES_API_KEY', 'OPENSUBTITLES_PASSWORD',
    ]
    for (const key of keys) {
      expect(dto.secrets[key]).toBeDefined()
    }
  })
})

describe('listMediaSubdirs（GET /api/v2/fs/list：只列子目录名，绝不列文件/读内容）', () => {
  it('列出子目录名，按字典序排序，排除文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-list-'))
    mkdirSync(join(root, 'zeta'))
    mkdirSync(join(root, 'alpha'))
    writeFileSync(join(root, 'not-a-dir.txt'), 'x')
    const result = listMediaSubdirs(root)
    expect(result).toEqual({ ok: true, dirs: ['alpha', 'zeta'] })
  })

  it('相对路径拒绝（4xx 语义：ok:false）', () => {
    const result = listMediaSubdirs('relative/path')
    expect(result.ok).toBe(false)
  })

  it('不存在的路径拒绝', () => {
    const result = listMediaSubdirs('/definitely/does/not/exist/on/this/machine')
    expect(result.ok).toBe(false)
  })

  it('路径指向文件（非目录）拒绝', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-list-file-'))
    const file = join(root, 'a-file.txt')
    writeFileSync(file, 'x')
    const result = listMediaSubdirs(file)
    expect(result.ok).toBe(false)
  })

  it('空目录 → dirs 空数组', () => {
    const root = mkdtempSync(join(tmpdir(), 'fs-list-empty-'))
    const result = listMediaSubdirs(root)
    expect(result).toEqual({ ok: true, dirs: [] })
  })

  // 复审修复 2：权限拒绝（EACCES，NAS 挂载常态）是用户点目录浏览器时的正常路况，必须收敛成
  // ok:false 的 4xx 语义，不能同步抛错炸到 server.ts 变 500。用 chmod 000 真实触发 readdirSync
  // 的 EACCES；root 用户不受权限位约束（chmod 000 后照样能读），该场景下跳过——CI 若以 root
  // 跑，这条护栏由 try/catch 的存在本身兜底，无需 mock fs 层来强行复现。
  it.skipIf(process.getuid?.() === 0)('无读权限的目录（EACCES）→ ok:false，不抛错', () => {
    const parent = mkdtempSync(join(tmpdir(), 'fs-list-eacces-'))
    const locked = join(parent, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      const result = listMediaSubdirs(locked)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/not readable/)
    } finally {
      chmodSync(locked, 0o755) // 恢复权限，让临时目录可被系统正常清理
    }
  })
})

// dashboard G5：workflow/library/甄别聚合 API——纯读聚合 + 两个人类扳手（redispatch/claim）。
// 北极星约束：全部走既有 repo/模块，不新增任何判断逻辑——机械层只产出事实。

describe('buildWorkflowPending（GET /api/v2/workflow/pending：missingBySeason/missingMovies/parked/meta 直译聚合）', () => {
  // 2026-07-31：巡检可观测性。此前巡检只在容器日志里打一行，界面完全看不见——
  // 一个"全是绿点"的库有两种可能（真没问题 / 巡检没在跑），用户无从分辨。
  it('meta 带字幕校验的新鲜度与推进度', () => {
    const settings = new SettingsRepo(db)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_verify_sweep_at', ?)`).run(String(NOW - 600_000))
    // 两条 covered（e1 已有结论、e2 还没）
    db.prepare(
      `INSERT INTO subtitle_verify (item_id, verdict, subtitle_path, checked_at) VALUES (?,?,?,?)`,
    ).run('e1', 'aligned', '/media/tv/a.srt', NOW)

    const r = buildWorkflowPending(db, settings, NOW)
    expect(r.meta.lastVerifySweepAt).toBe(NOW - 600_000)
    expect(r.meta.verifiedItems).toBe(1)
    // verifiableItems = sub_status='covered' 的条目总数，与 fixture 一致即可（>0）
    expect(r.meta.verifiableItems).toBeGreaterThan(0)
    expect(r.meta.verifiedItems).toBeLessThanOrEqual(r.meta.verifiableItems)
  })

  it('从未跑过巡检时 lastVerifySweepAt 为 null（不编造一个时刻）', () => {
    const settings = new SettingsRepo(db)
    const r = buildWorkflowPending(db, settings, NOW)
    expect(r.meta.lastVerifySweepAt).toBeNull()
    expect(r.meta.verifiedItems).toBe(0)
  })

  it('camelCase 直译 + meta 新鲜度行（roots/lastScanAt/files）', () => {
    // 2026-08-13：本用例原先还断言 result.series / result.movies / result.parked 三个字段
    // （s1 两个季的 missing/throttled/nextRecheckAt/sampleReason、m1 电影行、parked 计数）。
    // 那三个字段本轮随 WorkflowPendingDTO 一并删除（零前端消费者，见 apiV2.ts 头注释），
    // 对应断言随之移除。**产出它们的 LibraryRepo.missingBySeason/missingMovies 未删**，
    // 其行为仍由 src/v2/libraryRepo.test.ts 的 6+2 条用例直接覆盖（含退避窗口/throttled
    // 分桶/sampleReason 全部语义），所以删的是重复覆盖，不是覆盖本身。
    //
    // 保留 markUnavailable/upsertParkedPath 两行 fixture：它们建立的是本用例仍在断言的
    // meta 之外的库状态，去掉会让这条用例与下方 files 回归锁的 fixture 形状漂移。
    lib.markUnavailable('e4', 'no_safe_match', NOW)
    lib.upsertParkedPath('/media/tv/Unknown/e1.mkv', 'ambiguous match', NOW)
    const settings = new SettingsRepo(db)
    settings.addRoot('/media/tv', NOW)
    db.prepare(`INSERT INTO meta (key, value) VALUES ('last_inspect_at', ?)`).run(String(NOW))
    // meta.files 数的是 `files` 表（daemonV2 唯一在写的那张），不是 fixture 里的
    // episodes(4)+movies(1)。这里播 3 行，与 5 刻意不等——见下方 🔴 用例。
    seedFiles(db, 3)

    const result = buildWorkflowPending(db, settings, NOW)

    expect(result.meta).toEqual({
      roots: ['/media/tv'], lastScanAt: NOW, files: 3, // COUNT(*) FROM files
      // 2026-07-31 新增：巡检还没跑过 → null + 0；covered 计数来自 fixture
      lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: result.meta.verifiableItems,
    })
  })

  // ── 2026-08-13：顶栏「N files」数错表的回归锁 ───────────────────────────────
  //
  // 🔴 防的是**一句用户当场能看到的假话**：本字段原读
  // `(SELECT COUNT(*) FROM episodes) + (SELECT COUNT(*) FROM movies)`。那两张表在生产
  // 各 0 行（唯一写入链 v2/ingest.ts 已整体退役，upsertEpisode/upsertMovie 的非测试
  // 调用者只剩 testing/seedBacklog.ts），而 `files` 表有 645 行。于是顶栏
  // （web/src/shell/freshness.ts 的 `${meta.files} files`）对一个 645 个文件的库
  // 显示「0 files」。
  //
  // 为什么此前测试全绿：上面那条用例的 fixture 用 `lib.upsertEpisode/upsertMovie`
  // 播了 4+1 行 **episodes/movies**，一行 `files` 都没播——测试自己复述了一份已死的
  // 写入路径，于是读取侧数哪张表都不影响结论。这与本文件 lastScanAt 那条接缝用例
  // （两侧各自复述键名 → 键名漂移无人变红）是同一种盲区，只是换成了表名。
  //
  // 本用例的全部价值是把两张表的行数**造成不相等**（episodes+movies=5，files=7），
  // 于是任何一侧的口径都无法同时满足——读回旧口径当场变红。
  it('🔴 meta.files 数的是 `files` 表，不是恒空的 episodes+movies（顶栏「N files」不许再说假话）', () => {
    const settings = new SettingsRepo(db)
    // fixture 已有 episodes(4) + movies(1) = 5。files 表播 7 行，两者刻意不等。
    seedFiles(db, 7)
    expect(
      (db.prepare(`SELECT (SELECT COUNT(*) FROM episodes) + (SELECT COUNT(*) FROM movies) AS c`)
        .get() as { c: number }).c,
    ).toBe(5) // 旧口径若复活会读出这个数

    expect(buildWorkflowPending(db, settings, NOW).meta.files).toBe(7)
  })

  // 生产形状的直接复刻：episodes/movies 各 0 行（结构上不可填），files 有真实数据。
  // 上面那条用两个非零数分辨口径；这一条钉的是**生产当下那个具体的 0 vs N**——
  // 旧口径在这里读出 0，也就是用户今天在顶栏看到的那句假话本身。
  it('🔴 生产形状（episodes/movies 皆 0、files 非空）下 meta.files 不是 0', () => {
    const prodDb = openDb(':memory:')
    const settings = new SettingsRepo(prodDb)
    expect((prodDb.prepare(`SELECT COUNT(*) AS c FROM episodes`).get() as { c: number }).c).toBe(0)
    expect((prodDb.prepare(`SELECT COUNT(*) AS c FROM movies`).get() as { c: number }).c).toBe(0)
    seedFiles(prodDb, 645) // 生产实测行数

    expect(buildWorkflowPending(prodDb, settings, NOW).meta.files).toBe(645)
  })

  // 2026-08-13：原标题「series/movies 空数组，parked 0，...」——那三个字段本轮随
  // WorkflowPendingDTO 删除。用例保留：它锁的是**空库不编造任何东西**（lastScanAt null
  // 而不是 0 或 Date.now()，files 0，两个 verify 计数 0），那条纪律与字段删除无关。
  // `toEqual` 是全等断言，所以它同时也是"响应体不多长出字段"的锁。
  it('空库：lastScanAt null（meta 表从未写过 last_inspect_at），不编造任何计数', () => {
    const freshDb = openDb(':memory:')
    const settings = new SettingsRepo(freshDb)
    const result = buildWorkflowPending(freshDb, settings, NOW)
    expect(result).toEqual({
      meta: {
        roots: [], lastScanAt: null, files: 0,
        lastVerifySweepAt: null, verifiedItems: 0, verifiableItems: 0,
      },
    })
  })

  // ---- 接缝回归：daemonV2 的写入侧 ↔ dashboard 的读取侧（2026-08-10）----
  //
  // 🔴 防的是：**dashboard 读一个没有任何写入者的 meta 键**，于是"上次扫描"恒为 null，
  //    前端 text.ts lastCheckedLine() 显示"还没扫过"——即使 daemonV2 每天都在正常巡检。
  //    这是一句主动的假话，且已在生产里存活了 5 个 commit（第 2 步 915f3ec 让 ScoutDaemon
  //    不再被构造起，它 tickInner 里那唯一的 `last_ingest_at` 写入点就成了死代码；第 7 步
  //    B 组 d9096ec 删掉的只是尸体）。
  //
  // 为什么之前没被发现：两侧各自都有测试且都是绿的——daemonV2 的用例自己 INSERT
  // 'last_inspect_at'、dashboard 的用例自己 INSERT 'last_ingest_at'，各自复述了一份键名。
  // **没有任何测试同时用真写入者和真读取者**，所以两份键名漂移成两个不同的字符串时，
  // 全套件 3000+ 条一条都不红。这条用例的全部价值就是跨过那道接缝：写入侧必须是真的
  // ScoutDaemonV2（不是手写 INSERT），读取侧必须是真的 buildWorkflowPending（不是手写
  // SELECT）。任何一侧再改键名，这里当场变红。
  it('🔴 daemonV2 真跑一轮巡检后，dashboard 的 lastScanAt 能读到它写的时刻（不再是恒 null 的假话）', async () => {
    const seamDb = openDb(':memory:')
    const settings = new SettingsRepo(seamDb)
    const emptyRoot = mkdtempSync(join(tmpdir(), 'scout-seam-'))
    settings.addRoot(emptyRoot, NOW)

    // 巡检前：从未跑过 → null。text.ts 的"绝不编一个时刻出来"在这里是**真话**。
    expect(buildWorkflowPending(seamDb, settings, NOW).meta.lastScanAt).toBeNull()

    // 真的 daemonV2、真的 run()：冷启动（读不到时间门 ⇒ 0）第一圈就巡检，成功即写键。
    // 守备目录是个空临时目录，巡检本身无事可做——本用例只关心那次写入被读取侧看见。
    const daemon = new ScoutDaemonV2({
      db: seamDb,
      roots: [emptyRoot],
      identify: {
        db: seamDb,
        runIdentify: async () => ({ tmdbId: null, title: null, reason: 'noop' }),
        worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any },
      },
      subtitleWorker: async () => ({ installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [] }),
      targetLanguage: 'zh',
      probe: async () => null,
      probeDuration: async () => null,
      log: () => {},
      now: () => NOW,
    } as any)
    const ctrl = new AbortController()
    const p = daemon.run(ctrl.signal)
    await new Promise((r) => setTimeout(r, 50))
    ctrl.abort()
    await p

    // 巡检后：读取侧拿到的正是写入侧记的那个时刻（daemonV2 记的是巡检**开始**时刻 = NOW）。
    expect(buildWorkflowPending(seamDb, settings, NOW).meta.lastScanAt).toBe(NOW)
    seamDb.close()
  })
})

describe('buildWorkflowPasses（GET /api/v2/workflow/passes：orchestrate runs + receipts 从 trace_json 解析）', () => {
  function insertOrchestrateRun(
    jobId: number, startedAt: number, finishedAt: number, detail: string, traceJson: string | null,
  ): void {
    db.prepare(
      `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
       VALUES (?, ?, ?, 'orchestrate', ?, NULL, ?)`
    ).run(jobId, startedAt, finishedAt, detail, traceJson)
  }

  it('形状：id/jobId/startedAt/finishedAt/detail + receipts（2 created + 1 coalesced + 1 截断→unknown，非 dispatch_ 前缀不计入）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-1', taskType: 'orchestrate', state: 'done', priority: 0 })
    const events = [
      { runKey: `job-${jobId}`, seq: 0, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: '{"dispatched":true,"outcome":"created","remainingCapacity":99}', tookMs: 5, at: NOW },
      { runKey: `job-${jobId}`, seq: 1, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: '{"dispatched":true,"outcome":"created","remainingCapacity":98}', tookMs: 5, at: NOW + 1 },
      { runKey: `job-${jobId}`, seq: 2, tool: 'dispatch_realign_task', argsSummary: '{}', resultSummary: '{"dispatched":false,"outcome":"coalesced","pendingState":"wanted","note":"merged"}', tookMs: 5, at: NOW + 2 },
      // 模拟 summarizeForTrace 的 200 字符截断——outcome 值本身被切断，正则提不出完整枚举词。
      { runKey: `job-${jobId}`, seq: 3, tool: 'dispatch_find_subtitle_task', argsSummary: '{}', resultSummary: '{"dispatched":false,"outcome":"blocked_dorm…', tookMs: 5, at: NOW + 3 },
      // spawn_sibling_orchestrator 不以 'dispatch_' 开头——即使自带 outcome 字段也不计入 receipts。
      { runKey: `job-${jobId}`, seq: 4, tool: 'spawn_sibling_orchestrator', argsSummary: '{}', resultSummary: '{"spawned":true,"outcome":"created"}', tookMs: 5, at: NOW + 4 },
    ]
    insertOrchestrateRun(jobId, NOW - 1000, NOW, 'dispatched 3 find / 0 realign, siblings 0: done', JSON.stringify(events))

    const passes = buildWorkflowPasses(db, 20)
    expect(passes).toHaveLength(1)
    expect(passes[0]).toMatchObject({ jobId, startedAt: NOW - 1000, finishedAt: NOW, detail: 'dispatched 3 find / 0 realign, siblings 0: done' })
    expect(passes[0].receipts).toEqual({ created: 2, revived: 0, coalesced: 1, blocked_dormant: 0, unknown: 1 })
  })

  it('trace_json 为 NULL → receipts 全零（不是新账目，纯解析呈现，无快照即无事实）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-2', taskType: 'orchestrate', state: 'done', priority: 0 })
    insertOrchestrateRun(jobId, NOW - 1000, NOW, 'no dispatches', null)
    const passes = buildWorkflowPasses(db, 20)
    expect(passes[0].receipts).toEqual({ created: 0, revived: 0, coalesced: 0, blocked_dormant: 0, unknown: 0 })
  })

  it('只取 decision=orchestrate 的行，finished_at desc（beforeEach 里两条非 orchestrate 的 runs 不出现）', () => {
    const jobId1 = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-3', taskType: 'orchestrate', state: 'done', priority: 0 })
    const jobId2 = insertWorkerTaskJob(db, { seriesId: 'orchestrator-shard-4', taskType: 'orchestrate', state: 'done', priority: 0 })
    insertOrchestrateRun(jobId1, NOW - 5000, NOW - 4000, 'first', null)
    insertOrchestrateRun(jobId2, NOW - 3000, NOW - 1000, 'second', null)
    const passes = buildWorkflowPasses(db, 20)
    expect(passes.map(p => p.detail)).toEqual(['second', 'first'])
  })
})

describe('buildRunTrace（GET /api/v2/workflow/runs/:id/trace：单 run 痕迹快照回放，F4）', () => {
  it('trace_json 携带事件 → 原样解析成 events 数组', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', taskType: 'find_subtitle', state: 'done', priority: 0 })
    const events = [
      { runKey: `job-${jobId}`, seq: 0, tool: 'search_source', argsSummary: '"silo 中字"', resultSummary: '41 candidates', tookMs: 1200, at: NOW },
      { runKey: `job-${jobId}`, seq: 1, tool: 'get_candidate', argsSummary: '#3', resultSummary: 'fileList 22 entries', tookMs: 400, at: NOW + 1 },
    ]
    const runId = Number(
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'download', 'ok', NULL, ?)`
      ).run(jobId, NOW - 1000, NOW, JSON.stringify(events)).lastInsertRowid
    )

    expect(buildRunTrace(db, runId)).toEqual({ events })
  })

  it('trace_json 为 NULL → events:[]（run 行本身存在，只是没留下痕迹快照）', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', taskType: 'find_subtitle', state: 'done', priority: 0 })
    const runId = Number(
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'download', 'ok', NULL, NULL)`
      ).run(jobId, NOW - 1000, NOW).lastInsertRowid
    )
    expect(buildRunTrace(db, runId)).toEqual({ events: [] })
  })

  it('trace_json 解析失败（脏数据）→ events:[]，不炸整个端点', () => {
    const jobId = insertWorkerTaskJob(db, { seriesId: 's1', taskType: 'find_subtitle', state: 'done', priority: 0 })
    const runId = Number(
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path, trace_json)
         VALUES (?, ?, ?, 'download', 'ok', NULL, ?)`
      ).run(jobId, NOW - 1000, NOW, '{not valid json').lastInsertRowid
    )
    expect(buildRunTrace(db, runId)).toEqual({ events: [] })
  })

  it('行不存在 → null（router.ts 映射 404）', () => {
    expect(buildRunTrace(db, 999_999)).toBeNull()
  })
})

describe('redispatch（POST /api/v2/workflow/redispatch：转调 upsertWorkerTask，与 dispatch_find_subtitle_task 工具逐字段同形）', () => {
  it('合法 body → upsertWorkerTask({seriesId,season:null,movieId:null},{taskType:find_subtitle,...})，原样返回四态回执', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: 's1', seasons: [1, 2], includeThrottled: true }, NOW)
    expect(result).toEqual({ ok: true, outcome: { outcome: 'created' } })

    const row = db.prepare(`SELECT series_id, season, movie_id, payload FROM jobs WHERE kind = 'worker_task'`).get() as
      { series_id: string | null; season: number | null; movie_id: string | null; payload: string | null }
    expect(row.series_id).toBe('s1')
    expect(row.season).toBeNull()
    expect(row.movie_id).toBeNull()
    expect(JSON.parse(row.payload!)).toEqual({
      taskType: 'find_subtitle', seasons: [1, 2], reason: 'manual redispatch from dashboard', includeThrottled: true,
    })
  })

  it('省略 seasons/includeThrottled → seasons:null，includeThrottled:false（同 dispatch 工具默认）', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: 's2' }, NOW)
    expect(result).toEqual({ ok: true, outcome: { outcome: 'created' } })
    const row = db.prepare(`SELECT payload FROM jobs WHERE series_id = 's2'`).get() as { payload: string }
    expect(JSON.parse(row.payload)).toEqual({
      taskType: 'find_subtitle', seasons: null, reason: 'manual redispatch from dashboard', includeThrottled: false,
    })
  })

  it('zod 拒绝：seriesId 空字符串 → ok:false，不写任何行', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: '' }, NOW)
    expect(result).toEqual({ ok: false, error: expect.any(String) })
  })

  it('zod 拒绝：seasons 含非正整数 → ok:false', () => {
    const jobs = new JobsRepo(db)
    const result = redispatch(jobs, { seriesId: 's1', seasons: [0, -1] }, NOW)
    expect(result.ok).toBe(false)
  })
})

describe('dormantTargetLabel（Plan C spec §4.2：后端组标签，前端不拼）', () => {
  const base = {
    id: 1, series_id: 'tmdb:100', movie_id: null, season: null,
    series_name: 'The Rig', movie_name: null, seasons_json: null as string | null,
  }

  it('payload.seasons 单季 → "名, Season N"', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '[2]' })).toBe('The Rig, Season 2')
  })

  it('payload.seasons 多季 → "名, Seasons a, b"（升序）', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '[2,1]' })).toBe('The Rig, Seasons 1, 2')
  })

  it('payload.seasons 缺席但 jobs.season 有值 → 回落用列（存量 series_season 行）', () => {
    expect(dormantTargetLabel({ ...base, season: 3 })).toBe('The Rig, Season 3')
  })

  it('两处季信息都没有 → 只给系列名（全剧任务）', () => {
    expect(dormantTargetLabel(base)).toBe('The Rig')
  })

  it('电影行 → 电影名', () => {
    expect(dormantTargetLabel({
      ...base, series_id: null, series_name: null, movie_id: 'tmdb:777', movie_name: 'Dune',
    })).toBe('Dune')
  })

  it('join 不中（合成 series_id 的通用任务）→ 如实回落 id 本身，不伪造名字', () => {
    expect(dormantTargetLabel({
      ...base, series_id: 'orchestrator-shard-42-1', series_name: null,
    })).toBe('orchestrator-shard-42-1')
  })

  it('连 id 都没有 → 回落 job 号', () => {
    expect(dormantTargetLabel({ ...base, id: 77, series_id: null, series_name: null })).toBe('job #77')
  })

  it('seasons_json 是畸形 JSON 时不抛，按"没有季信息"处理', () => {
    expect(dormantTargetLabel({ ...base, seasons_json: '{oops' })).toBe('The Rig')
  })
})

describe('buildDormantTasks（Plan C spec §4.2）', () => {
  let db: ScoutDb
  beforeEach(() => { db = openDb(':memory:') })

  const insertJob = (over: Record<string, unknown> = {}) => {
    const row = {
      kind: 'worker_task', series_id: 'tmdb:100', season: null, movie_id: null,
      payload: JSON.stringify({ taskType: 'find_subtitle', reason: 'gaps', seasons: [2] }),
      state: 'dormant', attempt: 5, reap_count: 0,
      last_error: '连续 5 次进程崩溃/租约死亡回收未竟全功——疑确定性崩溃(poison task)',
      created_at: NOW, updated_at: NOW,
      ...over,
    }
    db.prepare(
      `INSERT INTO jobs (kind, series_id, season, movie_id, payload, state, attempt, reap_count,
                         last_error, created_at, updated_at)
       VALUES (@kind, @series_id, @season, @movie_id, @payload, @state, @attempt, @reap_count,
               @last_error, @created_at, @updated_at)`,
    ).run(row)
  }

  it('DTO 键集合封闭为四键，中文 reason 串不泄漏', () => {
    db.prepare(`INSERT INTO series (id, name, year) VALUES ('tmdb:100', 'The Rig', 2023)`).run()
    insertJob()
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(1)
    expect(Object.keys(dto[0]).sort()).toEqual(['attempts', 'jobId', 'targetLabel', 'task'])
    expect(dto[0]).toEqual({ jobId: 1, task: 'find_subtitle', targetLabel: 'The Rig, Season 2', attempts: 5 })
    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain('崩溃')
    expect(serialized).not.toContain('poison')
    expect(serialized).not.toMatch(/"(reason|lastError|last_error|updatedAt|updated_at)":/)
  })

  it('只出 dormant——其余六态一律不出', () => {
    for (const state of ['wanted', 'searching', 'downloading', 'verifying', 'done', 'failed'] as const) {
      insertJob({ state, series_id: `tmdb:${state}` })
    }
    insertJob({ state: 'dormant', series_id: 'tmdb:parked', payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(1)
    expect(dto[0].targetLabel).toBe('tmdb:parked')
  })

  it('attempts 取两个计数器的大者——崩溃循环轨（reap_count=5, attempt=0）也报 5', () => {
    insertJob({ attempt: 0, reap_count: 5 })
    expect(buildDormantTasks(db)[0].attempts).toBe(5)
  })

  it('attempts 取两个计数器的大者——内容失败轨（attempt=5, reap_count=1）报 5', () => {
    insertJob({ attempt: 5, reap_count: 1 })
    expect(buildDormantTasks(db)[0].attempts).toBe(5)
  })

  it('payload 无 taskType 时 task 回落 kind，不给空串', () => {
    insertJob({ kind: 'realign', payload: null })
    expect(buildDormantTasks(db)[0].task).toBe('realign')
  })

  it('空表返回空数组', () => {
    expect(buildDormantTasks(db)).toEqual([])
  })

  it('排序钉死 ORDER BY updated_at DESC：最近停车的排前面', () => {
    insertJob({ series_id: 'tmdb:old', updated_at: NOW - 1000, payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    insertJob({ series_id: 'tmdb:new', updated_at: NOW, payload: JSON.stringify({ taskType: 'find_subtitle' }) })
    const dto = buildDormantTasks(db)
    expect(dto).toHaveLength(2)
    expect(dto.map((d) => d.targetLabel)).toEqual(['tmdb:new', 'tmdb:old'])
  })
})