// E AI 翻译 · CLI 入口 `subtitle-scout translate-item <videoPath>`:对单个视频跑端到端翻译
// (探内嵌轨→抽→译→fail-closed 闸→过闸写中文 sidecar)。薄 I/O 胶水,核心逻辑在
// src/translate/translateItem.ts(已单测)。真机验收 E 用它。
import { existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { homedir } from 'node:os'
import { makeModel } from '../agent/llm.js'
import { probeEmbeddedSubtitles } from '../files/streamProbe.js'
import { extractEmbeddedSubtitle } from '../files/extractEmbeddedSub.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { makeTranslationLM } from '../translate/translateLm.js'
import { makeTranslationCritic } from '../translate/translateCritic.js'
import { translateItem, type TranslateItemDeps } from '../translate/translateItem.js'
import type { TranslationContext, TranslationCritic } from '../translate/translatePipeline.js'
import { makeRealFetchSourceSub } from './fetchSourceSub.js'
import { buildAdapters } from './buildAdapters.js'

const CHINESE_TAGS = ['zh-Hans', 'zh-Hant', 'zh', 'zh-CN', 'zh-TW', 'chs', 'cht', 'chi', 'zho']

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`translate-item 需要 ${name}(在 .env 配 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL,同一 AI 服务商)`)
    process.exit(2)
  }
  return v
}

/** 扫同目录既有中文 sidecar 当上下文播种术语表(库内直读、零网络;取前 3 份各截断 3000 字)。 */
function gatherSeriesContext(videoPath: string): TranslationContext {
  const dir = dirname(videoPath)
  const self = basename(videoPath)
  const subs: string[] = []
  try {
    for (const f of readdirSync(dir)) {
      if (f === self || !/\.(srt|ass|ssa)$/i.test(f)) continue
      const lower = f.toLowerCase()
      if (!CHINESE_TAGS.some((t) => lower.includes(`.${t.toLowerCase()}.`))) continue
      try { subs.push(readFileSync(join(dir, f), 'utf8').slice(0, 3000)) } catch { /* 单份读失败跳过 */ }
      if (subs.length >= 3) break
    }
  } catch { /* 目录读失败 → 无上下文 */ }
  return subs.length ? { seriesExistingSubs: subs } : {}
}

/** E 翻译用的 LLM 配置。TRANSLATE_MODEL 一旦设置 → 走 TRANSLATE_* 三件套(让 E 用强模型,与
 *  captcha 用的 LLM_MODEL=mimo 分开——真机实测 mimo 对翻译太弱);否则回退 LLM_*。 */
function translateLlmCfg(): { baseUrl: string; apiKey: string; model: string } {
  if (process.env.TRANSLATE_MODEL) {
    return { baseUrl: requireEnv('TRANSLATE_BASE_URL'), apiKey: requireEnv('TRANSLATE_API_KEY'), model: process.env.TRANSLATE_MODEL }
  }
  return { baseUrl: requireEnv('LLM_BASE_URL'), apiKey: requireEnv('LLM_API_KEY'), model: requireEnv('LLM_MODEL') }
}

/** daemon 自动翻译的配置门(与上面手动 CLI 的区别):**只认显式 TRANSLATE_* 三件套,绝不回退
 *  LLM_***——自动路径拿 LLM_MODEL(mimo,太弱且非用户对本功能的 opt-in)烧配额是事故。三件套
 *  不全 → null = 功能休眠(daemon 不注入派活钩子,translate 任务也拒跑),同 SUBHD_ENABLED 模式。 */
export function tryAutoTranslateCfg(env: NodeJS.ProcessEnv = process.env): { baseUrl: string; apiKey: string; model: string } | null {
  const { TRANSLATE_MODEL, TRANSLATE_BASE_URL, TRANSLATE_API_KEY } = env
  if (!TRANSLATE_MODEL || !TRANSLATE_BASE_URL || !TRANSLATE_API_KEY) return null
  return { baseUrl: TRANSLATE_BASE_URL, apiKey: TRANSLATE_API_KEY, model: TRANSLATE_MODEL }
}

/** 组装 translateItem 的真实 I/O deps(probe/extract/LM/critic/sidecar 读写/同剧上下文)。
 *  手动 CLI(cmdTranslateItem)与 daemon 的 translate worker(cli/index.ts 路由分支)共用,
 *  防两处组装漂移。critic 默认开(TRANSLATE_CRITIC=off 关);TRANSLATE_CRITIC_MODEL 单指定判官。
 *  F1:fetchSourceSub 可选注入(makeRealFetchSourceSub 组装,需要 db+adapters,由调用方各自
 *  提供——daemon 分支必接;手动 CLI 在库文件存在时接)。未注入=行为不变(零合格轨→no-embedded)。 */
export function makeTranslateItemDeps(
  cfg: { baseUrl: string; apiKey: string; model: string },
  fetchSourceSub?: TranslateItemDeps['fetchSourceSub'],
): TranslateItemDeps {
  const model = makeModel(cfg)
  const criticOn = (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  const critic: TranslationCritic | undefined = criticOn
    ? makeTranslationCritic(process.env.TRANSLATE_CRITIC_MODEL ? makeModel({ ...cfg, model: process.env.TRANSLATE_CRITIC_MODEL }) : model)
    : undefined
  return {
    probe: (v) => probeEmbeddedSubtitles(v),
    extract: (v, i) => extractEmbeddedSubtitle(v, i),
    lm: makeTranslationLM(model),
    critic,
    fetchSourceSub,
    readExistingChineseSidecar: (v) => findExternalSidecar(v, CHINESE_TAGS, existsSync)?.path ?? null,
    gatherContext: async (v) => gatherSeriesContext(v),
    writeSidecar: (v, content) => {
      const out = v.replace(/\.[^.]+$/, '.zh-Hans.srt')
      writeFileSync(out, content, 'utf8')
      return out
    },
  }
}

export async function cmdTranslateItem(videoPath: string): Promise<void> {
  if (!existsSync(videoPath)) {
    console.error(`文件不存在: ${videoPath}`)
    process.exit(2)
  }
  const cfg = translateLlmCfg()
  const criticOn = (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  console.log(`[translate-item] 模型=${cfg.model} critic=${criticOn ? '开' : '关'}`)
  // F1:手动 CLI 也接同一 fetchSourceSub(与 daemon 分支共用 makeRealFetchSourceSub 组装,防漂移)。
  // 需要库定位(origin_lang/imdb),故只在 scout.db 已存在时接线——库还没建(从没跑过 watch)时
  // 不为一次手动翻译凭空创建空库(openDb 会落盘建表),此时 fetch 腿关闭,行为同 F1 前(no-embedded)。
  // db/adapters 组装失败(如 ZIMUKU_ENABLED=true 缺 LLM_*)同样降级关腿,不拦手动翻译主线。
  let fetchSourceSub: TranslateItemDeps['fetchSourceSub']
  let db: import('../v2/db.js').ScoutDb | undefined
  const cacheRoot = process.env.SUBTITLE_SCOUT_CACHE_DIR || join(homedir(), '.subtitle-scout', 'cache')
  const dbPath = join(cacheRoot, 'scout.db')
  if (existsSync(dbPath)) {
    try {
      const { openDb } = await import('../v2/db.js')
      db = openDb(dbPath)
      fetchSourceSub = makeRealFetchSourceSub(db, await buildAdapters())
    } catch (e) {
      console.log(`[translate-item] 源语言外挂搜索腿未启用(${e instanceof Error ? e.message : String(e)}),仅走内嵌轨`)
    }
  } else {
    console.log(`[translate-item] 未找到库 ${dbPath}(先跑一次 watch 建库),源语言外挂搜索腿未启用,仅走内嵌轨`)
  }
  const deps = makeTranslateItemDeps(cfg, fetchSourceSub)
  console.log(`[translate-item] 开始: ${videoPath}`)
  const r = await translateItem(videoPath, deps)
  db?.close()
  const tail = (r.sidecarPath ? ` → ${r.sidecarPath}` : '') + (r.reason ? ` (${r.reason})` : '') + (r.sourceRef ? ` [源: ${r.sourceRef}]` : '')
  console.log(`[translate-item] 结果: ${r.status}${tail}`)
  if (r.gate) {
    console.log(`[translate-item] 闸: verdict=${r.gate.verdict} 术语符合=${r.gate.glossary.conformance}% (${r.gate.glossary.hits}/${r.gate.glossary.checks}) cues=${r.gate.cueCount.candidate} 硬违规=${r.gate.hardViolations.length}`)
    for (const h of r.gate.hardViolations) console.log(`  ✗ ${h}`)
  }
  process.exit(r.status === 'installed' ? 0 : 1)
}
