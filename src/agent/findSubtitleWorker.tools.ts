import { tool } from 'ai'
import { z } from 'zod'
import { join, basename, extname, dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runResolve, type FetchAdapter } from '../adapters/fetchLib.js'
import { downloadDirect } from '../adapters/download/direct.js'
import { writeSubtitle } from '../files/subtitleWriter.js'
import { inspectSubtitle, subtitleDialogueFingerprint } from '../files/subtitleInspect.js'
import { decodeToUtf8 } from '../files/subtitleEncoding.js'
import { install } from '../files/stagingSandbox.js'
import { isUnderRoots } from '../core/mediaContext.js'
import { formatEpisodeCode, matchesEpisodeCode } from '../core/episode.js'
import { parseCandidateKey } from '../core/schemas.js'
import { coercibleInt, coercibleNullableInt, nullableTolerant } from './coerce.js'

export interface DownloadCandidateDeps {
  adapters: FetchAdapter[]
  /** Sandbox staging root for this ONE task (allocated by the caller via
   *  stagingSandbox.allocate(jobId, mediaRoot) — see findSubtitleWorker.ts). Each call gets its
   *  own subdirectory keyed by a fresh stagedFileId so comparing multiple candidates never
   *  collides (see the correctness note above this task in the plan). */
  stagingDir: string
  /** Opaque handle → real staged path, shared with install_subtitle. Never exposed to the
   *  agent — install_subtitle takes stagedFileId, not a path. */
  stagedFiles: Map<string, string>
  /** Every target video filename in this batch task (Task 5 / R-5: a worker run now covers a whole
   *  season-level range, not one episode). The tool's `videoFilename` input claims ONE of these per
   *  call — see resolveTargetFilename below. */
  targetFilenames: string[]
  /** Parallel to targetFilenames (same index) — each target's itemId, used only to disambiguate a
   *  videoFilename that collides across two-or-more targets (cross-season batch, same basename;
   *  see resolveTarget). Optional: pre-fix callers/tests with no collision in play need not supply
   *  it, and makeFindSubtitleWorker always passes it explicitly from task.targets. Elements may be
   *  null — FindSubtitleTargetFact.itemId is null for an unidentified target (agent must identify
   *  first); resolveTarget already treats a null itemId like a missing one. */
  targetItemIds?: (string | null)[]
  /** task.targetLanguage (BCP-47 primary code, e.g. 'zh'/'en') — drives the provisional langTag
   *  this staging write uses (see execute below). Optional/defaulted to 'zh' only so existing
   *  callers/tests that predate A2 keep working unchanged; makeFindSubtitleWorker always passes
   *  it explicitly from the task. */
  targetLanguage?: string
  fetchImpl?: typeof fetch
  /** 重复源 P4：本地候选读盘用的沙盒边界——local 分支绕过 runResolve/downloadDirect 的网络路径，
   *  直接 readFile 磁盘上的字幕文件，isUnderRoots 复核（defense in depth，同 install_subtitle
   *  既有先例）防一个畸形/被篡改的 providerId 逃出媒体根之外。 */
  mediaRoot?: string
}

/** Canonicalize a filename for tolerant matching: NFKC folds NBSP / narrow NBSP / full-width
 *  space / NFD decomposition into normalized forms, and collapses runs of whitespace to a single
 *  ASCII space. This fixes the 2026-07-18 production incident where the real filename used
 *  U+00A0 (NBSP, bytes c2a0) between "V" and "klenutých", but the model echoed it as a plain
 *  U+0020 space, making the previous exact `filenames.includes(videoFilename)` match fail for
 *  multi-target tasks with no single-target fallback. */
const canonFilename = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim()

/** Shared by download_candidate and install_subtitle (Task 5 / R-5): resolves the agent-supplied
 *  `videoFilename` input against this task's list of target filenames. Three states:
 *  - named + matches one of `filenames` → that filename (claims that target for this call).
 *  - named + matches none → an error (agent named a file that isn't part of this task).
 *  - omitted (null) + exactly one target → defaults to it (single-target tasks stay zero-friction).
 *  - omitted (null) + multiple targets → an error asking the agent to say which one. */
export function resolveTargetFilename(videoFilename: string | null, filenames: string[]): string | { error: string } {
  if (videoFilename === null) {
    return filenames.length === 1
      ? filenames[0]
      : { error: `this task has ${filenames.length} targets — pass videoFilename to say which one this call is for` }
  }

  // ① Exact match first — preserves existing behavior and protects against canonical collisions.
  if (filenames.includes(videoFilename)) {
    return videoFilename
  }

  // ② Tolerant match against canonical forms (NBSP vs space, NFD vs NFC, etc.), returning the
  //    original element from `filenames` so the task's true bytes are used as the disk path.
  const canonVideo = canonFilename(videoFilename)
  const matched = filenames.find(f => canonFilename(f) === canonVideo)
  if (matched) {
    return matched
  }

  // ③ Forensic log before returning the error. This observability was missing during the
  //    2026-07-18 production incident and forced a real-device reproduction; keep it.
  //
  // 2026-08-10 live test 教训：这条日志原来只打 hex，且 targets 侧 `.slice(0, 80)`（= 40 字节）
  // 而 agent 侧不截断。生产里 agent 报的是 78 字节的长文件名，于是每个 target 都在第 40 字节
  // 处被砍断 —— 日志显示的每一项都"不等于" agent 那串，而真实原因无从判断（我为此停机排查了
  // 一轮，最后要手工 `bytes.fromhex(...)` 解码才看出是日志截断，不是数据不匹配）。
  //
  // 修法：明文优先（人能直接读），hex 只对**真正有字节级差异**的那一项输出，且不截断。
  // 取证日志的价值全在"能不能当场定位差异"，截断到看不出差异的长度等于没有这条日志。
  const toHex = (s: string) => Buffer.from(s, 'utf8').toString('hex')
  // 找出与 agent 串"canonical 相同但字节不同"的项——那才是 NBSP/NFD 这类隐形差异的现场，
  // 需要 hex 才看得见。其余项是明显的不同文件，明文就够了。
  const byteLevelSuspects = filenames.filter(f => f !== videoFilename && canonFilename(f) !== canonVideo
    && f.length === videoFilename.length)
  console.error(
    `[find-subtitle-worker] videoFilename mismatch:\n`
    + `  agent  : ${JSON.stringify(videoFilename)} (${Buffer.byteLength(videoFilename, 'utf8')}B)\n`
    + filenames.map((f, i) =>
        `  target${i}: ${JSON.stringify(f)} (${Buffer.byteLength(f, 'utf8')}B)`).join('\n')
    + (byteLevelSuspects.length > 0
        ? `\n  ⚠️ 等长但不等值（疑似 NBSP/NFD 等隐形字节差异，附完整 hex 供比对）：\n`
          + `     agent: ${toHex(videoFilename)}\n`
          + byteLevelSuspects.map(f => `     target: ${toHex(f)}`).join('\n')
        : '')
  )
  return { error: `unknown videoFilename: ${videoFilename} — must be one of the task's target files` }
}

/** A target object resolveTarget can disambiguate between. `itemId` is optional at the type level
 *  so callers that never see a basename collision (single-target tasks, or batches where every
 *  target's filename happens to be distinct) don't have to supply it — see resolveTarget below for
 *  when it actually matters. Nullable because FindSubtitleTargetFact.itemId is null for an
 *  unidentified target; null is handled exactly like an absent itemId (see the `??` fallbacks in
 *  resolveTarget and the install tool's fingerprintKey). */
interface DisambiguatableTarget {
  videoFilename: string
  itemId?: string | null
}

/** Post-audit correctness fix (batch②, 2026-07-18): shared by download_candidate and
 *  install_subtitle. Layers itemId disambiguation on top of resolveTargetFilename's existing
 *  filename resolution (NBSP/NFKC tolerant matching, single-target default, wrong-name error — all
 *  unchanged, see above). Once a filename is resolved, MORE THAN ONE target can legitimately share
 *  it: cross-season batch tasks (findSubtitleWorkerTask.ts's `payload.seasons` /
 *  listMissingEpisodesForSeries, ORDER BY season,episode) routinely produce targets like
 *  "Season 1/01.mkv" and "Season 2/01.mkv" — same basename, different episodes. The OLD code did
 *  `deps.targets.find(t => t.videoFilename === resolvedTarget)!`, which silently returns whichever
 *  target happens to come first — installing S02E01's subtitle into S01E01's directory. Now a
 *  basename collision REQUIRES itemId (shown alongside videoFilename on every target line in the
 *  worker's prompt) to pick between the colliding targets; a single hit still defaults exactly as
 *  before, itemId or not. */
export function resolveTarget<T extends DisambiguatableTarget>(
  videoFilename: string | null,
  itemId: string | null | undefined,
  targets: T[],
): T | { error: string } {
  const resolvedName = resolveTargetFilename(videoFilename, targets.map(t => t.videoFilename))
  if (typeof resolvedName !== 'string') return resolvedName

  const matches = targets.filter(t => t.videoFilename === resolvedName)
  if (matches.length === 1) return matches[0]

  // Basename collision — more than one target claims this exact resolved filename.
  const itemIdList = matches.map(t => t.itemId ?? '(missing itemId)').join(', ')
  if (itemId != null) {
    const found = matches.find(t => t.itemId === itemId)
    if (found) return found
    return {
      error: `itemId "${itemId}" does not match any target sharing filename "${resolvedName}" — ` +
        `must be one of: ${itemIdList}`,
    }
  }
  return {
    error: `multiple targets share filename "${resolvedName}" — pass itemId to disambiguate: ${itemIdList}`,
  }
}

/** download_candidate's provisional staging langTag (A2): for a Chinese target the real Hans/Hant
 *  call is made later by the agent at install_subtitle time, from subtitleInspect's detectedScript
 *  signal — not here, before the file is even inspected — so this keeps the historical 'zh-Hans'
 *  placeholder. Any other target language is used as-is; it's just a staging filename, replaced
 *  wholesale by install_subtitle's own langTag once the agent decides. */
function stagingLangTag(targetLanguage: string): string {
  return targetLanguage === 'zh' ? 'zh-Hans' : targetLanguage
}

type PackCache = Map<string, { bytes: Buffer; artifactFilename: string }>

async function executeDownloadCandidate(
  args: {
    candidateId: string
    fileIndex: number | null
    videoFilename: string | null
    itemId: string | null
    archiveEntryName: string | null
  },
  deps: DownloadCandidateDeps,
  packCache: PackCache,
) {
  const { candidateId, fileIndex, videoFilename, itemId, archiveEntryName } = args
  const targets = deps.targetFilenames.map((f, i) => ({ videoFilename: f, itemId: deps.targetItemIds?.[i] }))
  const resolved = resolveTarget(videoFilename, itemId, targets)
  if ('error' in resolved) return resolved
  const resolvedTarget = resolved.videoFilename

  const parsed = parseCandidateKey(candidateId)
  if (!parsed) {
    return {
      error:
        `unrecognized candidate id: ${candidateId} — pass the candidate's \`id\` exactly as shown ` +
        `by search_source/list_candidates/get_candidate (e.g. "assrt:667241")`,
    }
  }
  const { provider, providerId } = parsed

  // 重复源 P4：provider:'local' 是"该条目另一个文件已有的字幕"，不是真实网络适配器——
  // providerId 直接编码字幕文件的绝对路径（mapper 侧 encodeURIComponent 写入，见
  // findSubtitleWorkerTask.ts 的 buildLocalCandidates），这里解码后直接读盘，完全绕开
  // runResolve/downloadDirect 的网络路径。同一份 writeSubtitle/inspectSubtitle 落盘纪律，
  // 同一个 stagedFileId 机制——install_subtitle 完全不用知道这份字幕是网络下的还是本地复制的。
  if (provider === 'local') {
    const srcPath = decodeURIComponent(providerId)
    if (deps.mediaRoot && !isUnderRoots(srcPath, [deps.mediaRoot])) {
      return { error: `refusing to read local candidate outside sandboxed media root: ${srcPath}` }
    }
    // H3 对齐（read 侧）：isUnderRoots 是纯字符串前缀检查，从不解析链接——srcPath（或其某层
    // 祖先）若是指向沙盒外的符号链接，上面会误判通过。读盘前做 realpath 复核（比 install 侧
    // 更强：连文件本身的 symlink 一并解析），失败一律按"不通过"处理（宁停不猜）。
    if (deps.mediaRoot) {
      let realSrc: string
      let realRoot: string
      try {
        realSrc = realpathSync(srcPath)
        realRoot = realpathSync(deps.mediaRoot)
      } catch (e) {
        return { error: `local candidate file unreadable: ${srcPath} (${e instanceof Error ? e.message : String(e)})` }
      }
      if (!isUnderRoots(realSrc, [realRoot])) {
        return {
          error: `refusing to read local candidate: real path (${realSrc}) escapes the sandboxed ` +
            `media root — possible symlink escape`,
        }
      }
    }
    let bytes: Buffer
    try {
      bytes = await readFile(srcPath)
    } catch (e) {
      return { error: `local candidate file unreadable: ${srcPath} (${e instanceof Error ? e.message : String(e)})` }
    }
    const stagedFileId = randomUUID()
    const attemptDir = join(deps.stagingDir, stagedFileId)
    const written = await writeSubtitle({
      artifact: bytes, artifactFilename: basename(srcPath), videoFilename: resolvedTarget,
      langTag: stagingLangTag(deps.targetLanguage ?? 'zh'), outDir: attemptDir,
      selectFileName: archiveEntryName ?? undefined,
    })
    if ('needsSelection' in written) {
      return {
        archiveEntries: written.entries,
        hint: 'multiple subtitle entries in this archive — call again with archiveEntryName to pick your episode',
      }
    }
    const signals = inspectSubtitle(written.path)
    deps.stagedFiles.set(stagedFileId, written.path)
    return { stagedFileId, bytes: written.bytes, encoding: written.encoding, signals }
  }

  const cacheKey = `${candidateId}#${fileIndex ?? ''}`
  let bytes: Buffer
  let artifactFilename: string
  const cached = packCache.get(cacheKey)
  if (cached) {
    bytes = cached.bytes
    artifactFilename = cached.artifactFilename
  } else {
    const { url, filename, headers } = await runResolve({ provider, providerId, fileIndex }, deps.adapters)
    const dl = await downloadDirect(url, { headers, fetchImpl: deps.fetchImpl })
    // 文件名优先级:resolve 显式给的 → 下载响应 Content-Disposition(zimuku CDN 权威携带
    // .srt/.zip 扩展名,决定 writeSubtitle 走解压还是裸文件)→ 按 content-type 兜底猜测。
    // writeSubtitle also sniffs magic bytes, so a 7z labeled download.srt still unpacks.
    artifactFilename = filename ?? dl.filename ?? (
      dl.contentType?.includes('7z') ? 'download.7z' :
      dl.contentType?.includes('rar') ? 'download.rar' :
      dl.contentType?.includes('zip') ? 'download.zip' :
      'download.srt'
    )
    bytes = dl.bytes
    packCache.set(cacheKey, { bytes, artifactFilename })
  }
  const stagedFileId = randomUUID()
  const attemptDir = join(deps.stagingDir, stagedFileId)
  const written = await writeSubtitle({
    artifact: bytes, artifactFilename, videoFilename: resolvedTarget,
    langTag: stagingLangTag(deps.targetLanguage ?? 'zh'), outDir: attemptDir,
    selectFileName: archiveEntryName ?? undefined,
  })
  if ('needsSelection' in written) {
    return {
      archiveEntries: written.entries,
      hint: 'multiple subtitle entries in this archive — call again with archiveEntryName to pick your episode',
    }
  }
  const signals = inspectSubtitle(written.path)
  deps.stagedFiles.set(stagedFileId, written.path)
  return { stagedFileId, bytes: written.bytes, encoding: written.encoding, signals }
}

export function makeDownloadCandidateTool(deps: DownloadCandidateDeps) {
  // Per-run cache: subhd mint is IP-rate-limited (~5-6 resolves then "已失效"). A season-pack
  // 7z/zip is listed first (archiveEntries) then picked per episode — without this cache each
  // follow-up re-mints and re-downloads the same bytes, which is exactly how Cassandra burned
  // seven downloads of one 165KB .7z and still installed nothing.
  const packCache = new Map<string, { bytes: Buffer; artifactFilename: string }>()

  return tool({
    description:
      'Resolve a candidate to a download URL, download it, unpack/decode it into your ' +
      'sandbox, and inspect its structural signals (cue count, time span, detected script). ' +
      'candidateId is the candidate\'s `id` exactly as shown by search_source / list_candidates / ' +
      'get_candidate (e.g. "assrt:667241") — pass it back whole. ' +
      'This task may cover several target videos at once: pass videoFilename to say which target ' +
      'file this call is for (must be one of the task\'s target files); you can omit it when the ' +
      'task has exactly one target. ' +
      'If more than one target shares that exact file name (e.g. a same-basename episode in two ' +
      'different seasons), also pass itemId — the itemId shown for each target — to say exactly ' +
      'which one; omit it when no other target shares the name. ' +
      'Use fileIndex to pull ONE file out of a season pack / collection BEFORE download: set it to ' +
      'the index of the entry in the candidate\'s fileList (seen via get_candidate) that names your ' +
      'target episode; pass fileIndex: null for a plain single-file candidate. ' +
      'If the downloaded archive is a zip/7z/rar with more than one subtitle file inside (e.g. an ' +
      'un-indexed season pack), this call returns an `archiveEntries` list instead of staging ' +
      'anything — call again with archiveEntryName set to the exact entry name from that list to ' +
      'pick which file INSIDE the archive to use (archiveEntryName picks an entry AFTER download, ' +
      'inside the unpacked archive — a different step from fileIndex, which picks the source file ' +
      'before download). The archive bytes are kept for this run, so the follow-up call does not ' +
      're-download. ' +
      'Does NOT install it — call install_subtitle once you decide it is a match.',
    inputSchema: z.object({
      // The agent only ever sees ONE identifier per candidate — candidateKey(c) = the composite
      // "provider:providerId" surfaced as `id` (resultHandles.ts). Accept that composite here and
      // split it back into a BARE providerId + provider below, so the CandidateRef reaching runResolve
      // carries the provider-native id the adapters' resolve() needs (assrt does Number(ref.providerId)).
      candidateId: z.string(),
      // Real models string-encode numbers ("10") and emit "None"/"null"/"" for a null — coerce them.
      fileIndex: coercibleNullableInt,
      // Which of the task's target videos this call claims (Task 5 / R-5) — see resolveTargetFilename.
      videoFilename: nullableTolerant(z.string()),
      // Disambiguates a videoFilename that collides across targets (basename shared by two-or-more
      // targets, e.g. cross-season batch) — see resolveTarget.
      itemId: nullableTolerant(z.string()),
      // Which entry inside a multi-subtitle zip/7z/rar to pick (C-D1) — matched by exact basename.
      archiveEntryName: nullableTolerant(z.string()),
    }),
    execute: async ({ candidateId, fileIndex, videoFilename, itemId, archiveEntryName }) => {
      try {
        return await executeDownloadCandidate(
          { candidateId, fileIndex, videoFilename, itemId, archiveEntryName },
          deps,
          packCache,
        )
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export interface InstallSubtitleDeps {
  stagedFiles: Map<string, string>
  /** Every target this batch task covers, each with its OWN outDir (dirname(target.videoPath),
   *  never derived from anything the agent supplies — Task 5 / R-5: a worker run installs
   *  episode-by-episode across a whole season, so each target needs its own destination dir). The
   *  tool's `videoFilename` input claims ONE of these per call — see resolveTargetFilename.
   *  `itemId` is optional here only so pre-fix test fixtures with no basename collision in play
   *  don't have to supply it — makeFindSubtitleWorker always passes it from task.targets, and it
   *  becomes REQUIRED at runtime the moment two targets share a basename (see resolveTarget). */
  targets: { videoFilename: string; outDir: string; itemId?: string | null }[]
  /** The ONE sandbox root for this task — checked again here even though each target's outDir is
   *  already fixed (defense-in-depth, mirrors realignExecutor.ts's containingRoot/isUnderRoots use). */
  mediaRoot: string
  /** W1（装机记账修复批·跨集内容近似去重闸，2026-07-18，DxD S3E11/S3E12 案根因修复）：per-run
   *  对白指纹表（itemId → subtitleDialogueFingerprint 结果），与 stagedFiles 同法由调用方
   *  （findSubtitleWorker.ts）每 run 新建注入并跨这一个 run 的多次 execute 调用共享。装机前先查：
   *  若这份内容的指纹与同一 run 里已装的某个**不同** itemId 完全一致，拒装（源头很可能把同一集
   *  内容贴了两个集号标签，见本文件下方 execute 的判词文案）；装机成功后把这次的指纹记入表。
   *  可选——省略时工具构造时惰性建一个空 Map（同 stagedFiles 的构造期生命周期，不是每次
   *  execute 现造），这道闸依旧在同一个工具实例的多次调用之间生效，只是没有调用方自己保留
   *  这份记账的引用；只有从一开始就不会在同一个工具实例上装两个不同 target 的旧测试夹具
   *  才不受影响（它们的行为在这次改动前后本就相同）。 */
  installedFingerprints?: Map<string, string>
}

export function makeInstallSubtitleTool(deps: InstallSubtitleDeps) {
  // W1: constructed ONCE per tool instance (mirrors deps.stagedFiles' per-run lifetime) — every
  // execute() call below shares the SAME map, so a second target's install within this run can see
  // what the first one already installed. Falling back to a fresh Map when the caller doesn't pass
  // one keeps every pre-existing test fixture (and any caller with no cross-target dedup need)
  // unchanged: an empty map can never produce a collision.
  const installedFingerprints = deps.installedFingerprints ?? new Map<string, string>()

  return tool({
    description:
      'Atomically install a previously downloaded+inspected candidate (by stagedFileId) as ' +
      'the final subtitle for this task\'s video. Only call this once you have decided, like ' +
      'a person who opened the file, that this candidate really is the subtitle for this exact video. ' +
      'This task may cover several target videos at once: pass videoFilename to say which target ' +
      'file you are installing for (must be one of the task\'s target files); you can omit it when ' +
      'the task has exactly one target. ' +
      'If more than one target shares that exact file name (e.g. a same-basename episode in two ' +
      'different seasons), also pass itemId — the itemId shown for each target — to say exactly ' +
      'which one; omit it when no other target shares the name.',
    inputSchema: z.object({
      stagedFileId: z.string(),
      // A2 + H2（2026-07-18 数据安全审计——路径注入防线）：langTag 曾接受任意非空字符串，直接拼进
      // finalPath 的文件名段（见下方 finalPath 计算）；一个含 '/' 或 '..' 的 langTag（例如
      // '../OtherShow/ep01'）能在 join() 之后把 finalPath 落到沙盒内别的目录——isUnderRoots 是对
      // 整棵沙盒树的宽检查,拦不住"沙盒内越权"这种子集,配合任何覆盖缺陷就是越权顶掉别的字幕。
      // 收紧为 BCP-47 形态足够用的白名单：字母/数字/连字符，长度上限 20（zh-Hans/en/pt-BR 都合法，
      // '/'和'..'一律在 schema 层被拒绝，tool-arg 校验都不会跑到 execute）。
      langTag: z.string().regex(
        /^[A-Za-z0-9-]{1,20}$/,
        'langTag must look like a BCP-47 tag (letters/digits/hyphens only, e.g. zh-Hans, en, pt-BR)',
      ),
      // Which of the task's target videos this call claims (Task 5 / R-5) — see resolveTargetFilename.
      videoFilename: nullableTolerant(z.string()),
      // Disambiguates a videoFilename that collides across targets (basename shared by two-or-more
      // targets, e.g. cross-season batch) — see resolveTarget.
      itemId: nullableTolerant(z.string()),
    }),
    execute: async ({ stagedFileId, langTag, videoFilename, itemId }) => {
      const resolved = resolveTarget(videoFilename, itemId, deps.targets)
      if ('error' in resolved) return resolved
      const target = resolved

      const stagedPath = deps.stagedFiles.get(stagedFileId)
      if (!stagedPath) return { error: `unknown stagedFileId: ${stagedFileId} — call download_candidate first` }

      // W1（装机记账修复批·跨集内容近似去重闸，DxD S3E11/S3E12 案）：装机前算这份内容的规范化
      // 对白指纹，与本 run 里已经装过的其它 target 比对——同源常见的事故形态是把同一集内容贴上
      // 两个不同的集号标签（DxD 案：assrt:662362/assrt:647484 内容逐句相同，仅时轴偏移 1 秒）。
      // 精确 hash 比对，不做模糊相似度（YAGNI）。fingerprintKey 用 itemId；itemId 缺席（旧测试
      // 夹具/无跨 target 需求）时退化用 videoFilename，行为不变——这两种情形下不同 target 也不会
      // 意外撞上同一个 key。同一 target 内重复安装（同 key 覆盖同 key）不算跨集碰撞，天然放行。
      const fingerprintKey = target.itemId ?? target.videoFilename
      const rawForFingerprint = readFileSync(stagedPath)
      const dialogueFingerprint = subtitleDialogueFingerprint(decodeToUtf8(rawForFingerprint).data.toString('utf8'))
      // dialogueFingerprint 为 null = 无可提取对白,无法指纹 → 不参与跨 target 去重(否则两个内容
      // 各异但都解析不出 cue 的字幕会撞上同一空 hash,让第二个的正确字幕被误判重复而拒装,凭空造缺口)。
      if (dialogueFingerprint !== null) {
        for (const [otherKey, fp] of installedFingerprints) {
          if (otherKey !== fingerprintKey && fp === dialogueFingerprint) {
            return {
              error: `content is nearly identical to the subtitle you already installed for ${otherKey} — ` +
                `the source likely mislabeled the same episode under two labels; pick a different ` +
                `candidate/entry for this target or leave it`,
            }
          }
        }
      }

      const videoBase = basename(target.videoFilename).replace(/\.[^.]+$/, '')
      const ext = extname(stagedPath)
      const finalPath = join(target.outDir, `${videoBase}.${langTag}${ext}`)

      // H2 第二道防线（defense-in-depth，同下面 isUnderRoots 复核的精神）：finalPath 必须恰好落在
      // target.outDir 本身，一层不多一层不少。上面的白名单已经挡掉了几乎所有注入形态，这里再兜
      // 一层——万一 langTag 校验将来被放宽/绕过，这道断言仍能挡住任何试图新建子目录或跳出
      // outDir 的 finalPath。
      if (dirname(finalPath) !== resolve(target.outDir)) {
        return {
          error: `refusing to install to unexpected directory: ${dirname(finalPath)} ` +
            `(expected exactly ${resolve(target.outDir)})`,
        }
      }
      if (!isUnderRoots(finalPath, [deps.mediaRoot])) {
        return { error: `refusing to install outside sandboxed media root: ${finalPath}` }
      }

      // H3（2026-07-18 数据安全审计——符号链接逃逸防线）：isUnderRoots 是纯字符串前缀比较，从不
      // 解析链接（不改 isUnderRoots 本身——它用途广，别的调用方要的就是这个便宜的字符串检查）。
      // 如果 target.outDir（或它的某层祖先目录）本身是指向沙盒外的符号链接，上面两道字符串级
      // 检查会全部误判通过。真实写入前做最后一次 realpath 校验：目标目录的真实路径必须仍在
      // mediaRoot 的真实路径之下。目录不存在/realpath 失败一律按"不通过"处理（宁停不猜）。
      let realDir: string
      try {
        realDir = realpathSync(dirname(finalPath))
      } catch (e) {
        return {
          error: `refusing to install: cannot resolve real path of ${dirname(finalPath)} ` +
            `(${e instanceof Error ? e.message : String(e)})`,
        }
      }
      let realMediaRoot: string
      try {
        realMediaRoot = realpathSync(deps.mediaRoot)
      } catch (e) {
        return {
          error: `refusing to install: cannot resolve real path of configured mediaRoot ${deps.mediaRoot} ` +
            `(${e instanceof Error ? e.message : String(e)})`,
        }
      }
      if (!isUnderRoots(realDir, [realMediaRoot])) {
        return {
          error: `refusing to install: real path of target directory (${realDir}) escapes the sandboxed ` +
            `media root — possible symlink escape`,
        }
      }

      const result = await install(stagedPath, finalPath)
      // H1（2026-07-18 数据安全审计——防静默覆盖）：finalPath 已存在时 install() 不改名、不覆盖，
      // 原样把冲突报回来——这里把它转成给 agent 的 error 文案：agent 据此可以自行判断，比如这份
      // 字幕其实已经在了就直接 finalize 收工，或者换一个 langTag 重新安装。
      if ('conflict' in result) {
        return {
          error: `refusing to overwrite existing file at ${result.path} — a file already exists at this ` +
            `location (a hand-placed subtitle, or a leftover from a previous run). If it is already correct, ` +
            `finalize without reinstalling; otherwise pick a different langTag.`,
        }
      }
      // W1: only record on a genuine successful install — a conflict/error above must never poison
      // the dedup table with content that was never actually written. null(无可提取对白)不入表——
      // 它无法作去重依据,存了也只会让后续空指纹字幕误撞。
      if (dialogueFingerprint !== null) installedFingerprints.set(fingerprintKey, dialogueFingerprint)
      return { path: result.path }
    },
  })
}

/** Optional advisory check — NOT a mandatory gate (north star #2: deterministic checks never
 *  get to be the "is this subtitle right" gatekeeper; they only do factual bookkeeping). The
 *  agent may call this to sanity-check a filename against the season/episode it believes it is
 *  looking for; it is one more piece of evidence, not a pass/fail door the agent must clear. */
export function makeCheckEpisodeCodeSafetyTool() {
  return tool({
    description:
      'Advisory check: does a filename\'s episode code match the given season/episode? This ' +
      'is one signal among several, not a verdict — a false result does not mean reject, a ' +
      'true result does not mean accept.',
    inputSchema: z.object({
      filename: z.string(),
      // Real models string-encode these ("1"/"5") — coerce so the advisory check's tool-arg
      // validation does not fail before execute runs.
      season: coercibleInt,
      episode: coercibleInt,
    }),
    execute: async ({ filename, season, episode }) => {
      const expectedCode = formatEpisodeCode(season, episode)
      return { safe: matchesEpisodeCode(filename, expectedCode), expectedCode }
    },
  })
}
