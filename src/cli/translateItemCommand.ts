// E AI 翻译 · CLI 入口 `subtitle-scout translate-item <videoPath>`:对单个视频跑端到端翻译
// (探内嵌轨→抽→译→fail-closed 闸→过闸写中文 sidecar)。薄 I/O 胶水,核心逻辑在
// src/translate/translateItem.ts(已单测)。真机验收 E 用它。
import { existsSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { makeModel } from '../agent/llm.js'
import { probeEmbeddedSubtitles } from '../files/streamProbe.js'
import { extractEmbeddedSubtitle } from '../files/extractEmbeddedSub.js'
import { findExternalSidecar } from '../files/sidecar.js'
import { makeTranslationLM } from '../translate/translateLm.js'
import { makeTranslationCritic } from '../translate/translateCritic.js'
import { translateItem, type TranslateItemDeps } from '../translate/translateItem.js'
import type { TranslationContext, TranslationCritic } from '../translate/translatePipeline.js'

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

export async function cmdTranslateItem(videoPath: string): Promise<void> {
  if (!existsSync(videoPath)) {
    console.error(`文件不存在: ${videoPath}`)
    process.exit(2)
  }
  const cfg = translateLlmCfg()
  const model = makeModel(cfg)
  // LLM-judge critic 默认开(质量 > 省一次调用);TRANSLATE_CRITIC=off 关闭。critic 模型默认同翻译模型,
  // TRANSLATE_CRITIC_MODEL 可单独指定(如更强的判官)。
  const criticOn = (process.env.TRANSLATE_CRITIC ?? 'on').toLowerCase() !== 'off'
  const critic: TranslationCritic | undefined = criticOn
    ? makeTranslationCritic(process.env.TRANSLATE_CRITIC_MODEL ? makeModel({ ...cfg, model: process.env.TRANSLATE_CRITIC_MODEL }) : model)
    : undefined
  console.log(`[translate-item] 模型=${cfg.model} critic=${criticOn ? '开' : '关'}`)
  const deps: TranslateItemDeps = {
    probe: (v) => probeEmbeddedSubtitles(v),
    extract: (v, i) => extractEmbeddedSubtitle(v, i),
    lm: makeTranslationLM(model),
    critic,
    readExistingChineseSidecar: (v) => findExternalSidecar(v, CHINESE_TAGS, existsSync)?.path ?? null,
    gatherContext: async (v) => gatherSeriesContext(v),
    writeSidecar: (v, content) => {
      const out = v.replace(/\.[^.]+$/, '.zh-Hans.srt')
      writeFileSync(out, content, 'utf8')
      return out
    },
  }
  console.log(`[translate-item] 开始: ${videoPath}`)
  const r = await translateItem(videoPath, deps)
  const tail = (r.sidecarPath ? ` → ${r.sidecarPath}` : '') + (r.reason ? ` (${r.reason})` : '')
  console.log(`[translate-item] 结果: ${r.status}${tail}`)
  if (r.gate) {
    console.log(`[translate-item] 闸: verdict=${r.gate.verdict} 术语符合=${r.gate.glossary.conformance}% (${r.gate.glossary.hits}/${r.gate.glossary.checks}) cues=${r.gate.cueCount.candidate} 硬违规=${r.gate.hardViolations.length}`)
    for (const h of r.gate.hardViolations) console.log(`  ✗ ${h}`)
  }
  process.exit(r.status === 'installed' ? 0 : 1)
}
