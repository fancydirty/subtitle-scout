import { tool } from 'ai'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { evaluateTranslationGate, parseSrtCues } from '../translate/qualityGate.js'
import { materializeAgentView } from '../translate/workspace/materialize.js'
import { mergeBilingualToSrt } from '../translate/workspace/merge.js'
import { resolveTranslateSource, type ResolveSourceDeps } from '../translate/workspace/resolveSource.js'
import { seriesKeyOf } from '../v2/glossaryRepo.js'
import type { BilingualRow, GlossaryTerm, WorkspacePaths } from '../translate/workspace/types.js'
import type { TranslateTask } from './translateWorker.schemas.js'

export interface TranslateToolDeps {
  task: TranslateTask
  paths: WorkspacePaths
  resolveDeps: ResolveSourceDeps
  /** Write the final Chinese sidecar; returns the installed path. Only ever called with
   *  merge-produced content. */
  install: (videoPath: string, srtContent: string) => string
  /** Optional duration gate: max cue end / video duration must sit in [0.85, 1.15].
   *  When provided, a failed/absent probe fails closed (see translateItem hardening). */
  videoDurationSec?: (videoPath: string) => Promise<number | null>
  /** Legacy-parity coverage check: existing Chinese sidecar path, or null. */
  readExistingChineseSidecar?: (videoPath: string) => string | null
  /** Optional context enrichers (P1: TMDB + same-series target-language subs). */
  fetchTmdbContext?: (task: TranslateTask) => Promise<string | null>
  fetchSeriesTargetSubs?: (task: TranslateTask) => Promise<string | null>
  /** P2: 剧级术语持久化——freeze 合并 prior(prior 胜),install 成功后回写。 */
  glossaryStore?: {
    load: (seriesKey: string) => GlossaryTerm[]
    save: (seriesKey: string, terms: GlossaryTerm[], updatedAt: number) => void
  }
  /** P2.2b: run_critic 工具可选接线(legacy translateCritic)。 */
  critic?: {
    evaluate: (src: string[], tgt: string[], glossary: Array<{ en: string; zh: string }>) => Promise<string>
  }
}

// ---------- jsonl helpers ----------

function readRows(paths: WorkspacePaths): BilingualRow[] {
  if (!existsSync(paths.bilingualPath)) return []
  return readFileSync(paths.bilingualPath, 'utf8')
    .trim().split('\n').filter(Boolean)
    .map((l) => JSON.parse(l) as BilingualRow)
}

function writeRows(paths: WorkspacePaths, rows: BilingualRow[]): void {
  writeFileSync(paths.bilingualPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
}

function readTerms(paths: WorkspacePaths): GlossaryTerm[] {
  if (!existsSync(paths.glossaryPath)) return []
  return JSON.parse(readFileSync(paths.glossaryPath, 'utf8')) as GlossaryTerm[]
}

function cueEndSec(timing: string): number {
  const m = timing.match(/-->\s*(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

/** max end-sec across a SRT text. */
function maxCueEndSec(srt: string): number {
  let max = 0
  for (const c of parseSrtCues(srt)) max = Math.max(max, cueEndSec(c.timing))
  return max
}

// ---------- gate-pass enforcement (fail-closed must be code, not model manners) ----------

function gateMarkerPath(paths: WorkspacePaths): string {
  return resolve(paths.workDir, 'GATE_PASS.json')
}

function bilingualHash(paths: WorkspacePaths): string {
  if (!existsSync(paths.bilingualPath)) return ''
  return createHash('sha256').update(readFileSync(paths.bilingualPath, 'utf8')).digest('hex')
}

function writeGateMarker(paths: WorkspacePaths): void {
  writeFileSync(gateMarkerPath(paths), JSON.stringify({ hash: bilingualHash(paths), at: Date.now() }))
}

function clearGateMarker(paths: WorkspacePaths): void {
  try { rmSync(gateMarkerPath(paths), { force: true }) } catch { /* best-effort */ }
}

function gateMarkerValid(paths: WorkspacePaths): boolean {
  const p = gateMarkerPath(paths)
  if (!existsSync(p)) return false
  try {
    const marker = JSON.parse(readFileSync(p, 'utf8')) as { hash?: string }
    return marker.hash != null && marker.hash === bilingualHash(paths)
  } catch {
    return false
  }
}

// ---------- tools ----------

export function makeTranslateWorkspaceTools(deps: TranslateToolDeps) {
  const { paths, task } = deps

  const resolve_source = tool({
    description:
      'Resolve the single-hop source subtitle for this video (origin-language only: ja→Japanese ' +
      'embedded/jimaku, en→English embedded/fetch). Writes canonical/source.srt and meta.sourceRef. ' +
      'Returns no-source when no valid same-language source exists — never fall back to another language.',
    inputSchema: z.object({}),
    execute: async () => {
      // Legacy parity: already covered → never re-translate (embedded zh text track / sidecar).
      const probeTracks = await deps.resolveDeps.probe(task.videoPath)
      if (probeTracks === null) return { status: 'probe-failed', reason: 'subtitle probe unavailable' }
      if (probeTracks.some((t) => {
        const l = (t.lang ?? '').toLowerCase()
        return !t.isImageBased && (l.startsWith('zh') || l === 'chi' || l === 'zho' || l === 'chs' || l === 'cht')
      })) {
        return { status: 'already-covered', reason: 'embedded Chinese text track present' }
      }
      if (deps.readExistingChineseSidecar?.(task.videoPath)) {
        return { status: 'already-covered', reason: 'Chinese sidecar already exists' }
      }
      // Duration-aware fetch predicate (fail-closed when probe missing).
      let preVideoSec: number | null | undefined
      const accept = deps.videoDurationSec
        ? async (srtText: string) => {
            if (preVideoSec === undefined) {
              const s = await deps.videoDurationSec!(task.videoPath)
              preVideoSec = s !== null && s > 0 ? s : null
            }
            if (preVideoSec === null) return false
            const end = maxCueEndSec(srtText)
            if (end <= 0) return false
            const ratio = end / preVideoSec
            return ratio >= 0.85 && ratio <= 1.15
          }
        : undefined
      const r = await resolveTranslateSource({
        originLang: task.originLang,
        videoPath: task.videoPath,
        deps: {
          ...deps.resolveDeps,
          fetchSourceSub: deps.resolveDeps.fetchSourceSub
            ? (vp, _a) => deps.resolveDeps.fetchSourceSub!(vp, accept ?? _a)
            : undefined,
        },
      })
      if (r.status !== 'ok') return r
      writeFileSync(paths.canonicalSourcePath, r.srtText.endsWith('\n') ? r.srtText : r.srtText + '\n')
      const meta = existsSync(paths.metaPath)
        ? JSON.parse(readFileSync(paths.metaPath, 'utf8'))
        : {}
      meta.videoPath = task.videoPath
      meta.itemId = task.itemId
      meta.originLang = task.originLang
      meta.sourceRef = r.sourceRef
      meta.resolvedAt = Date.now()
      writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2))
      return r
    },
  })

  const materialize_agent_view = tool({
    description:
      'After resolve_source succeeds: build agent_view/source_clean.jsonl (no timestamps) and the ' +
      'pending bilingual table from canonical/source.srt.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!existsSync(paths.canonicalSourcePath)) return { error: 'canonical source missing — call resolve_source first' }
      const srt = readFileSync(paths.canonicalSourcePath, 'utf8')
      const { cues } = materializeAgentView(paths, srt)
      return { ok: true, cueCount: cues.length }
    },
  })

  const fetch_tmdb_context = tool({
    description: 'Fetch TMDB synopsis/cast for this title into context/tmdb.md (may be empty).',
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.fetchTmdbContext) return { ok: true, written: false, chars: 0 }
      const md = await deps.fetchTmdbContext(task)
      if (!md) return { ok: true, written: false, chars: 0 }
      writeFileSync(resolve(paths.contextDir, 'tmdb.md'), md)
      return { ok: true, written: true, chars: md.length }
    },
  })

  const fetch_series_target_subs = tool({
    description:
      'Write excerpts of SAME-SERIES existing target-language (e.g. Chinese) subtitles into ' +
      'context/series_subs.md — the highest-value term anchor. Empty is fine.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!deps.fetchSeriesTargetSubs) return { ok: true, written: false, chars: 0 }
      const md = await deps.fetchSeriesTargetSubs(task)
      if (!md) return { ok: true, written: false, chars: 0 }
      writeFileSync(resolve(paths.contextDir, 'series_subs.md'), md)
      return { ok: true, written: true, chars: md.length }
    },
  })

  const read_workspace_doc = tool({
    description:
      'Read a document INSIDE this job workspace (relative path like agent_view/source_clean.jsonl, ' +
      'context/tmdb.md, work/bilingual.jsonl). offset/limit are 0-based line numbers.',
    inputSchema: z.object({
      path: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(400).optional(),
    }),
    execute: async ({ path, offset, limit }) => {
      const abs = resolve(paths.jobRoot, path)
      if (!abs.startsWith(paths.jobRoot + '/') && abs !== paths.jobRoot) {
        return { error: `path escapes the job workspace: ${path}` }
      }
      if (abs.toLowerCase().includes('/canonical/')) {
        return { error: 'canonical/ is not agent-readable — use agent_view/source_clean.jsonl instead' }
      }
      if (!existsSync(abs)) return { error: `no such workspace doc: ${path}` }
      if (statSync(abs).isDirectory()) return { error: `path is a directory, not a doc: ${path}` }
      const lines = readFileSync(abs, 'utf8').split('\n')
      const start = offset ?? 0
      const end = limit != null ? Math.min(lines.length, start + limit) : lines.length
      return { path, totalLines: lines.length, offset: start, lines: lines.slice(start, end) }
    },
  })

  const write_workspace_doc = tool({
    description:
      'Write/replace a SMALL markdown note inside context/ or work/ (e.g. context/notes.md, ' +
      'work/summary.md). Cannot write canonical/, glossary/, or .jsonl tables — those have ' +
      'their own tools.',
    inputSchema: z.object({
      path: z.string().min(1),
      content: z.string().max(8000),
    }),
    execute: async ({ path, content }) => {
      const abs = resolve(paths.jobRoot, path)
      if (!abs.startsWith(paths.jobRoot + '/')) {
        return { error: `path escapes the job workspace: ${path}` }
      }
      const allowed = abs.startsWith(paths.contextDir + '/') || abs.startsWith(paths.workDir + '/')
      if (!allowed || !abs.endsWith('.md')) {
        return { error: 'write_workspace_doc only allows .md files under context/ or work/' }
      }
      writeFileSync(abs, content.endsWith('\n') ? content : content + '\n')
      return { ok: true, path, chars: content.length }
    },
  })

  const CJK = /[　-鿿豈-﫿]/

  const freeze_glossary = tool({
    description:
      'Freeze the termbase for this job: [{src, zh, note?, keepOriginal?}] — every proper noun in ' +
      'the source must appear here with ONE canonical SIMPLIFIED-CHINESE rendering (zh must ' +
      'contain Chinese characters). If a term genuinely must stay in the original script (rare, ' +
      'e.g. an acronym the audience reads as-is), set keepOriginal:true — such terms are excluded ' +
      'from term-conformance accounting. One-shot: re-freezing is rejected.',
    inputSchema: z.object({
      terms: z.array(z.object({
        src: z.string().min(1),
        zh: z.string().min(1),
        note: z.string().optional(),
        keepOriginal: z.boolean().optional(),
      })).min(1),
    }),
    execute: async ({ terms }) => {
      if (existsSync(paths.glossaryFrozenPath)) {
        return { error: 'glossary is already frozen for this job' }
      }
      // 弱模型实证坑:zh 照抄原文(如 Fulmer→"Fulmer")会让术语闸形同虚设(conformance 虚 100%)。
      // 冻结时强制 zh 含 CJK,除非显式 keepOriginal——把"名从主人但留原文"变成显式声明而非默认摆烂。
      const bad = terms.filter((t) => !t.keepOriginal && !CJK.test(t.zh))
      if (bad.length) {
        return {
          error:
            'these terms have a zh that is not Chinese (no CJK characters) — translate them into ' +
            'Simplified Chinese, or set keepOriginal:true only if the audience must read the ' +
            `original script: ${bad.map((t) => `${t.src}→"${t.zh}"`).slice(0, 8).join(', ')}`,
        }
      }
      // P2 剧级持久化:prior(同剧历史冻结)优先,按 src 去重——canonical 跨 job 稳定,
      // 新集只需补新术语,不重决旧译名(消除同剧 东国/奥斯塔尼亚 方差)。
      const prior = deps.glossaryStore?.load(seriesKeyOf(task.itemId)) ?? []
      const seen = new Set<string>()
      const merged: GlossaryTerm[] = []
      for (const t of [...prior, ...terms]) {
        const k = t.src.trim().toLowerCase()
        if (!k || seen.has(k)) continue
        seen.add(k)
        merged.push(t)
      }
      writeFileSync(paths.glossaryPath, JSON.stringify(merged, null, 2))
      writeFileSync(paths.glossaryFrozenPath, 'frozen\n')
      return {
        ok: true,
        count: merged.length,
        inherited: prior.length,
        keepOriginal: merged.filter((t) => t.keepOriginal).length,
      }
    },
  })

  const lookup_glossary = tool({
    description: 'Look up terms in the frozen glossary (substring match on src).',
    inputSchema: z.object({ term: z.string().min(1) }),
    execute: async ({ term }) => {
      const hits = readTerms(paths).filter((t) => t.src.toLowerCase().includes(term.toLowerCase()))
      return { hits }
    },
  })

  const list_rows = tool({
    description: 'List bilingual table rows (id/src/tgt/status), optionally filtered by status.',
    inputSchema: z.object({
      status: z.enum(['pending', 'draft', 'ok', 'needs_review', 'failed']).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(400).optional(),
    }),
    execute: async ({ status, offset, limit }) => {
      let rows = readRows(paths)
      if (status) rows = rows.filter((r) => r.status === status)
      const start = offset ?? 0
      const end = limit != null ? Math.min(rows.length, start + limit) : rows.length
      return { total: rows.length, offset: start, rows: rows.slice(start, end) }
    },
  })

  const get_row = tool({
    description: 'Read ONE bilingual row in full (id/src/tgt/status/notes).',
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async ({ id }) => {
      const row = readRows(paths).find((r) => r.id === id)
      if (!row) return { error: `no bilingual row with id=${id}` }
      return { row }
    },
  })

  const rowStatusEnum = z.enum(['pending', 'draft', 'ok', 'needs_review', 'failed'])

  /** tgt 文本净化(zerotest2 验收实证):①字面 \n 两字符序列→真换行(模型把 JSON 转义当文本写);
   *  ②连续空行压成单换行(空行会让 serialize 产出无 cue 头的孤儿块)。 */
  const sanitizeTgt = (tgt: string): string =>
    tgt.replace(/\\n/g, '\n').replace(/\n{2,}/g, '\n').trim()

  const applyRowPatch = (
    rows: BilingualRow[], id: string,
    patch: { tgt?: string; status?: 'pending' | 'draft' | 'ok' | 'needs_review' | 'failed'; notes?: string },
  ): { ok: true; row: BilingualRow } | { error: string } => {
    const row = rows.find((r) => r.id === id)
    if (!row) return { error: `no bilingual row with id=${id}` }
    if (patch.tgt !== undefined) row.tgt = sanitizeTgt(patch.tgt)
    if (patch.status !== undefined) row.status = patch.status
    if (patch.notes !== undefined) row.notes = patch.notes
    return { ok: true, row }
  }

  const update_row = tool({
    description:
      'Write your translation into ONE bilingual row (KV-style): set tgt (Simplified Chinese text, ' +
      'multi-line via \\n), and status. src is immutable and cannot be changed.',
    inputSchema: z.object({
      id: z.string().min(1),
      tgt: z.string().optional(),
      status: rowStatusEnum.optional(),
      notes: z.string().optional(),
    }).strict(),
    execute: async (input) => {
      // .strict() 在生产已被 schema 拦;此处 defense-in-depth(直接 execute 的调用方同样被拒)。
      if ('src' in (input as Record<string, unknown>)) {
        return { error: 'update_row cannot modify src — only tgt/status/notes' }
      }
      const rows = readRows(paths)
      const r = applyRowPatch(rows, input.id, input)
      if ('error' in r) return r
      writeRows(paths, rows)
      clearGateMarker(paths) // any row edit invalidates a prior gate pass
      return { ok: true, row: r.row }
    },
  })

  const update_rows = tool({
    description:
      'Batch-write translations for MANY rows in one call (preferred for a window): ' +
      'rows: [{id, tgt, status?, notes?}]. src is immutable. All-or-nothing: one bad id → error, nothing written.',
    inputSchema: z.object({
      rows: z.array(z.object({
        id: z.string().min(1),
        tgt: z.string().optional(),
        status: rowStatusEnum.optional(),
        notes: z.string().optional(),
      }).strict()).min(1).max(100),
    }),
    execute: async ({ rows: patches }) => {
      if (patches.some((p) => 'src' in (p as Record<string, unknown>))) {
        return { error: 'update_rows cannot modify src — only tgt/status/notes' }
      }
      const rows = readRows(paths)
      const updated: BilingualRow[] = []
      for (const p of patches) {
        const r = applyRowPatch(rows, p.id, p)
        if ('error' in r) return { error: r.error }
        updated.push(r.row)
      }
      writeRows(paths, rows)
      clearGateMarker(paths)
      return { ok: true, count: updated.length }
    },
  })

  const get_window = tool({
    description:
      'Read a window of cleaned cues around centerId (radius cues each side) — your working set ' +
      'for translation. Never contains timestamps.',
    inputSchema: z.object({
      centerId: z.string().min(1),
      radius: z.number().int().min(0).max(40).default(10),
    }),
    execute: async ({ centerId, radius }) => {
      const rows = readRows(paths)
      const idx = rows.findIndex((r) => r.id === centerId)
      if (idx < 0) return { error: `no row with id=${centerId}` }
      const start = Math.max(0, idx - radius)
      const end = Math.min(rows.length, idx + radius + 1)
      return {
        centerId,
        range: [rows[start]?.id, rows[end - 1]?.id],
        cues: rows.slice(start, end).map((r) => ({ id: r.id, text: r.src })),
      }
    },
  })

  const update_summary = tool({
    description: 'Overwrite work/summary.md with a SHORT rolling bilingual summary (≤1000 chars).',
    inputSchema: z.object({ content: z.string().max(1000) }),
    execute: async ({ content }) => {
      writeFileSync(paths.summaryPath, content.endsWith('\n') ? content : content + '\n')
      return { ok: true, chars: content.length }
    },
  })

  const run_structural_gate = tool({
    description:
      'Non-LLM quality gate over the bilingual table: no empty tgt, term conformance vs the frozen ' +
      'glossary (≥85%), row/cue count. Also duration-checks the merged output when a duration probe ' +
      'is wired. Returns verdict pass/fail with reasons.',
    inputSchema: z.object({}),
    execute: async () => {
      clearGateMarker(paths) // every gate evaluation resets the pass state first
      const rows = readRows(paths)
      if (rows.length === 0) return { verdict: 'fail', reasons: ['no bilingual rows — materialize first'] }
      const emptyRows = rows.filter((r) => r.status !== 'pending' && !r.tgt.trim())
      if (emptyRows.length) {
        return { verdict: 'fail', reasons: [`${emptyRows.length} row(s) with status=${emptyRows[0].status} have empty tgt`] }
      }
      // P2.2a deterministic 括号配对闸(验收实证:mimo 残留《呼……而非《呼……》)——
      // 《》「」【】每行左右数必须相等;常规()（）不强制(字幕里单边括号合法)。
      const bracketPairs: [string, string][] = [['《', '》'], ['「', '」'], ['【', '】']]
      const unbalanced: string[] = []
      for (const r of rows) {
        for (const [L, R] of bracketPairs) {
          const left = (r.tgt.match(new RegExp(L.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
          const right = (r.tgt.match(new RegExp(R.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
          if (left !== right) {
            unbalanced.push(`row ${r.id}: unbalanced ${L}${R} (${left} left, ${right} right)`)
            break
          }
        }
      }
      if (unbalanced.length) {
        return { verdict: 'fail', reasons: [`bracket pairing violation: ${unbalanced.slice(0, 5).join('; ')}`] }
      }

      const terms = readTerms(paths)
      // keepOriginal 术语不参与符合率统计(期望输出=原文,谈不上"漂移";计入只会虚增分子)。
      const gateTerms = terms.filter((t) => !t.keepOriginal)
      const srcCues = rows.map((r) => ({ index: r.id, timing: '00:00:00,000 --> 00:00:01,000', text: r.src.split('\n') }))
      const tgtCues = rows.map((r) => ({ index: r.id, timing: '00:00:00,000 --> 00:00:01,000', text: r.tgt.split('\n') }))
      const gate = evaluateTranslationGate(
        srcCues, tgtCues,
        gateTerms.map((t) => ({ en: t.src, zh: t.zh, note: t.note })),
      )
      const reasons: string[] = [...gate.hardViolations]
      if (gate.verdict === 'pass' && deps.videoDurationSec && existsSync(paths.canonicalSourcePath)) {
        const videoSec = await deps.videoDurationSec(task.videoPath)
        if (videoSec === null || videoSec <= 0) {
          return { verdict: 'fail', reasons: ['duration-unavailable: video duration probe failed'] }
        }
        const end = maxCueEndSec(readFileSync(paths.canonicalSourcePath, 'utf8'))
        const ratio = end / videoSec
        if (ratio < 0.85 || ratio > 1.15) {
          reasons.push(`duration-mismatch: source ${Math.round(end)}s vs video ${videoSec}s`)
        }
      }
      const verdict = gate.verdict === 'pass' && reasons.length === 0 ? 'pass' : 'fail'
      if (verdict === 'pass') writeGateMarker(paths)
      return {
        verdict,
        reasons,
        termConformance: gate.glossary.conformance,
        termHits: gate.glossary.hits,
        termChecks: gate.glossary.checks,
      }
    },
  })

  const merge_to_srt = tool({
    description:
      'Deterministically merge bilingual tgt into canonical timing shells → out/target.srt. ' +
      'Non-LLM. Fails when rows are missing/empty.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        const srt = mergeBilingualToSrt(paths)
        return { ok: true, cueCount: parseSrtCues(srt).length }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  const install_sidecar = tool({
    description:
      'Install out/target.srt as the Chinese sidecar next to the video. ONLY call after ' +
      'run_structural_gate passed and merge_to_srt succeeded.',
    inputSchema: z.object({}),
    execute: async () => {
      if (!existsSync(paths.targetSrtPath)) {
        return { error: 'out/target.srt missing — run merge_to_srt first' }
      }
      // fail-closed 必须代码强制(终审 C1):没有有效的 gate-pass 标记(或标记后又有行编辑)
      // 一律拒绝装盘——闸不过绝不装,不依赖模型自觉。
      if (!gateMarkerValid(paths)) {
        return { error: 'no valid structural-gate pass for the current bilingual table — run run_structural_gate and do not edit rows afterwards' }
      }
      try {
        const sidecarPath = deps.install(task.videoPath, readFileSync(paths.targetSrtPath, 'utf8'))
        // P2:安装成功 → 回写剧级术语表(下一集/下一次 job 继承同一 canonical)。
        if (deps.glossaryStore && existsSync(paths.glossaryPath)) {
          try {
            deps.glossaryStore.save(seriesKeyOf(task.itemId), readTerms(paths), Date.now())
          } catch { /* 持久化失败不反噬已成功的安装 */ }
        }
        return { ok: true, sidecarPath }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  const run_critic = tool({
    description:
      'Run LLM quality critic over a window of bilingual rows ([fromId, toId]). Writes work/critic.md ' +
      'with feedback. Model should read critic.md, decide whether to fix flagged rows (via update_row ' +
      'which clears the gate marker), then re-run gate, or accept and finalize. Only available if deps.critic wired.',
    inputSchema: z.object({
      fromId: z.string().optional(),
      toId: z.string().optional(),
    }),
    execute: async ({ fromId, toId }) => {
      if (!deps.critic) return { error: 'critic not available (TRANSLATE_CRITIC=off or unwired)' }
      const rows = readRows(paths)
      if (rows.length === 0) return { error: 'no bilingual rows to critique' }
      const start = fromId ? rows.findIndex((r) => r.id === fromId) : 0
      const end = toId ? rows.findIndex((r) => r.id === toId) : rows.length - 1
      if (start < 0 || end < 0 || start > end) {
        return { error: `invalid window: fromId=${fromId} toId=${toId}` }
      }
      const window = rows.slice(start, end + 1)
      const terms = readTerms(paths).map((t) => ({ en: t.src, zh: t.zh }))
      try {
        const feedback = await deps.critic.evaluate(
          window.map((r) => r.src), window.map((r) => r.tgt), terms,
        )
        writeFileSync(join(paths.workDir, 'critic.md'), `# Translation Quality Critique\n\n${feedback}\n`)
        return { ok: true, windowSize: window.length, feedbackChars: feedback.length }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  const fetch_wiki_context = tool({
    description:
      'Fetch Wikipedia context (zh.wikipedia.org API) for a title/topic. Writes context/wiki.md. ' +
      'Network-dependent; failure returns ok:false without throwing.',
    inputSchema: z.object({ query: z.string().min(1).max(200) }),
    execute: async ({ query }) => {
      try {
        const url = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
        const data = await res.json() as { query?: { search?: Array<{ title?: string; snippet?: string }> } }
        const hits = data.query?.search ?? []
        if (hits.length === 0) return { ok: false, reason: 'no results' }
        const md = hits.slice(0, 3).map((h, i) =>
          `## ${i + 1}. ${h.title ?? 'Untitled'}\n${(h.snippet ?? '').replace(/<[^>]*>/g, '')}`,
        ).join('\n\n')
        writeFileSync(join(paths.contextDir, 'wiki.md'), `# Wikipedia: ${query}\n\n${md}\n`)
        return { ok: true, hits: hits.length, charsWritten: md.length }
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
  })

  return {
    resolve_source,
    materialize_agent_view,
    fetch_tmdb_context,
    fetch_series_target_subs,
    read_workspace_doc,
    write_workspace_doc,
    freeze_glossary,
    lookup_glossary,
    list_rows,
    get_row,
    update_row,
    update_rows,
    get_window,
    update_summary,
    run_critic,
    fetch_wiki_context,
    run_structural_gate,
    merge_to_srt,
    install_sidecar,
  }
}
