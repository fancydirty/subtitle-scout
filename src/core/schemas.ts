import { z } from 'zod'

// LLM 边界归一化：MiMo 等模型会把数字输出成字符串、把空值输出成 "-"。
// 明确无歧义的表示做确定性转换；垃圾值仍然拒绝。
const NULLISH_STRINGS = new Set(['', '-', 'null', 'none', 'unknown', 'n/a'])
// 可空字符串字段同样需要归一化：模型会把空值写成 "None"/"null" 等
function looseNullableString(): z.ZodType<string | null | undefined> {
  return z.preprocess(
    v => (typeof v === 'string' && NULLISH_STRINGS.has(v.trim().toLowerCase()) ? null : v),
    z.string().nullish(),
  )
}
function looseNumeric(inner: z.ZodNumber): z.ZodType<number | null | undefined> {
  return z.preprocess(v => {
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase()
      if (NULLISH_STRINGS.has(t)) return null
      if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    }
    return v
  }, inner.nullish())
}

// ---------- 输入 ----------
export const MediaContextSchema = z.object({
  request_id: z.string(),
  trigger: z.enum(['library_scan', 'manual_search', 'playback_start']),
  media: z.object({
    type: z.enum(['movie', 'episode']),
    path: z.string(),
    filename: z.string(),
    title: z.string(),
    original_title: z.string().nullish(),
    year: z.number().int().nullish(),
    season: z.number().int().nullish(),
    episode: z.number().int().nullish(),
    runtime_minutes: z.number().nullish(),
    provider_ids: z.record(z.string(), z.string()).default({}),
    production_locations: z.array(z.string()).default([]),
    existing_subtitles: z.array(z.object({
      language: z.string(),
      format: z.string(),
      source: z.string(),
    })).default([]),
    alternative_titles: z.array(z.string()).default([]),
    overview: z.string().nullish(),
  }),
  preferences: z.object({
    language: z.enum(['zh-Hans', 'zh-Hant']).default('zh-Hans'),
    prefer_bilingual: z.boolean().default(true),
    allow_traditional: z.boolean().default(true),
    allow_machine_translated: z.boolean().default(false),
  }),
})
export type MediaContext = z.infer<typeof MediaContextSchema>

// ---------- 判断点输出 ----------
export const MediaIdentitySchema = z.object({
  canonical_title: z.string(),
  original_title: looseNullableString(),
  year: looseNumeric(z.number().int()),
  type: z.enum(['movie', 'episode']),
  season: looseNumeric(z.number().int()),
  episode: looseNumeric(z.number().int()),
  edition: looseNullableString(),
  confidence: z.preprocess(
    v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
    z.number().min(0).max(1),
  ),
  evidence: z.array(z.string()),
})
export type MediaIdentity = z.infer<typeof MediaIdentitySchema>

export const SearchPlanSchema = z.object({
  queries: z.array(z.object({
    q: z.string().min(1),
    reason: z.string(),
  })).min(1).max(3),
})
export type SearchPlan = z.infer<typeof SearchPlanSchema>

// 身份三态判决：自动下载闸的核心。标量 confidence 仅作参考，判决驱动 gate。
// fail-soft 铁律（judgeOrphan 教训）：模型漏字段或吐非法枚举值时，一律归一为 'uncertain'
// 走旧标量门兜底，绝不因这一个字段炸掉整个 run。
export const IDENTITY_MATCHES = ['confirmed', 'mismatch', 'uncertain'] as const
export type IdentityMatch = (typeof IDENTITY_MATCHES)[number]
export const IdentityMatchSchema: z.ZodType<IdentityMatch> = z.preprocess(
  v => (typeof v === 'string' && (IDENTITY_MATCHES as readonly string[]).includes(v) ? v : 'uncertain'),
  z.enum(IDENTITY_MATCHES).default('uncertain'),
)

// LLM 边界容错：模型（MiMo 教训同款）可能把 candidate_id 输出成 JSON number
// （尤其 assrt 裸数字 id 的历史惯性）。数字确定性转字符串；空值归一为 null。
function looseCandidateId(): z.ZodType<string | null | undefined> {
  return z.preprocess(v => {
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string' && NULLISH_STRINGS.has(v.trim().toLowerCase())) return null
    return v
  }, z.string().nullish())
}

export const RankedCandidateSchema = z.object({
  /** "<provider>:<providerId>"，与 prompt 里 candidates[].id 完全一致 */
  candidate_id: looseCandidateId(),
  file_index: looseNumeric(z.number().int()),
  // 身份判决：confirmed=同作品/季/集，uncertain=信息不足。mismatch 理论上不会出现在
  // order[] 里（prompt 要求丢进 rejected[]），但 schema 层不禁止——gate.ts 会防御性剔除。
  identity_match: IdentityMatchSchema,
  reason: z.string(),
})
export type RankedCandidate = z.infer<typeof RankedCandidateSchema>

export const RankDecisionSchema = z.object({
  /** 按偏好排序的候选队列，最可能匹配的排最前。这是初筛，不是终局——每个留下的候选
   *  之后都会被下载、打开、体检，写盘前还有一轮终审。 */
  order: z.array(RankedCandidateSchema).default([]),
  rejected: z.array(z.object({
    candidate_id: z.preprocess(v => (typeof v === 'number' ? String(v) : v), z.string()),
    reason: z.string(),
  })).default([]),
  reasons: z.array(z.string()).default([]),
})
export type RankDecision = z.infer<typeof RankDecisionSchema>

// ---------- ASSRT 响应（宽松：只锁我们用的字段） ----------
// 实测：search 的 filelist 可能是 {} 或 [{s,f}]；detail 的 filelist 项带 url。
const FileListSchema = z.preprocess(
  v => (Array.isArray(v) ? v : []),
  z.array(z.object({ s: z.string().optional(), f: z.string(), url: z.string().optional() })),
)
const AssrtSubSchema = z.object({
  id: z.number().int(),
  videoname: z.string().nullish(),
  native_name: z.union([z.string(), z.array(z.string())]).nullish(),
  release_site: z.string().nullish(),
  subtype: z.string().nullish(),
  lang: z.object({
    desc: z.string().nullish(),
    langlist: z.record(z.string(), z.boolean()).nullish(),
  }).nullish(),
  filename: z.string().nullish(),
  size: z.number().nullish(),
  url: z.string().optional(),
  filelist: FileListSchema.default([]),
}).passthrough()
export type AssrtSub = z.infer<typeof AssrtSubSchema>

export const AssrtSearchResponseSchema = z.object({
  status: z.number(),
  // 实测：零结果时 subs 是 {} 空对象（与 filelist 同款怪癖），归一化为数组
  sub: z.object({
    subs: z.preprocess(v => (Array.isArray(v) ? v : []), z.array(AssrtSubSchema)).default([]),
  }).default({ subs: [] }),
})
export const AssrtDetailResponseSchema = AssrtSearchResponseSchema
export const AssrtQuotaResponseSchema = z.object({
  status: z.number(),
  user: z.object({ quota: z.number() }).optional(),
})

// ---------- Provider-neutral candidate (multi-source) ----------
export const PROVIDERS = ['assrt', 'opensubtitles'] as const
export type ProviderName = (typeof PROVIDERS)[number]

export const SubtitleFileSchema = z.object({
  index: z.number().int(),
  name: z.string(),
})
export type SubtitleFile = z.infer<typeof SubtitleFileSchema>

export const SubtitleCandidateSchema = z.object({
  provider: z.enum(PROVIDERS),
  providerId: z.string(),
  videoName: z.string().nullish(),
  nativeName: z.string().nullish(),
  /** provider 原始语言描述（assrt: lang.desc；opensubtitles: 'zh-CN' 等），仅供 LLM 参考 */
  language: z.string().nullish(),
  subtype: z.string().nullish(),
  releaseSite: z.string().nullish(),
  uploadDate: z.string().nullish(),
  fileList: z.array(SubtitleFileSchema).default([]),
})
export type SubtitleCandidate = z.infer<typeof SubtitleCandidateSchema>

export interface CandidateRef { provider: ProviderName; providerId: string; fileIndex: number | null }

export function candidateKey(c: { provider: string; providerId: string }): string {
  return `${c.provider}:${c.providerId}`
}
export function parseCandidateKey(key: string): { provider: ProviderName; providerId: string } | null {
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) return null
  const provider = key.slice(0, i)
  if (!(PROVIDERS as readonly string[]).includes(provider)) return null
  return { provider: provider as ProviderName, providerId: key.slice(i + 1) }
}

// ---------- 最终 decision ----------
export const FinalDecisionSchema = z.object({
  request_id: z.string(),
  decision: z.enum(['download', 'no_safe_match', 'retry_later', 'already_exists', 'error', 'adopted_local']),
  // confidence 保留（nullish）仅为向后兼容历史 journal 文件的形状；判定链不再产出真实值，
  // pipeline.ts 今后恒写 null。
  confidence: z.number().nullish(),
  selected: z.object({
    provider: z.string(),
    provider_id: z.string(),
    subtitle_name: z.string(),
    language: z.string(),
    format: z.string(),
  }).nullish(),
  reasons: z.array(z.string()).default([]),
  verification: z.object({
    downloaded: z.boolean(),
    path: z.string().nullish(),
    bytes: z.number().nullish(),
    encoding: z.string().nullish(),
  }).nullish(),
})
export type FinalDecision = z.infer<typeof FinalDecisionSchema>

// ---------- 终审 agent 输出(staging 沙盒体检后的二选一表态) ----------
export const VerifyDecisionSchema = z.object({
  match: z.boolean(),
  reason: z.string().min(1),
})
export type VerifyDecision = z.infer<typeof VerifyDecisionSchema>

// Production case (S04E12): LLM rejection path outputs {"adopt":false,"file":"None","language":"None"}
// — valid decision, but schema enum enforcement killed the run. Widen rejection path, keep adoption strict.
export const OrphanDecisionSchema = z.object({
  adopt: z.boolean(),
  file: looseNullableString().optional(), // Allow "None"/"null" strings → null, or omitted entirely
  language: z.preprocess(
    v => (typeof v === 'string' && NULLISH_STRINGS.has(v.trim().toLowerCase()) ? null : v),
    z.enum(['zh-Hans', 'zh-Hant']).nullish(),
  ).optional(), // Allow "None"/"null" strings → null, or omitted entirely; enum enforced only when present & non-null
  confidence: z.preprocess(
    v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
    z.number().min(0).max(1),
  ),
  reasons: z.array(z.string()),
}).refine(v => !v.adopt || (v.file != null && v.language != null), {
  message: 'file and language required when adopt=true',
})
export type OrphanDecision = z.infer<typeof OrphanDecisionSchema>

export const SeasonMapSchema = z.object({
  pairs: z.array(z.object({
    filelist_index: looseNumeric(z.number().int()),
    episode_code: z.string(),
    confidence: z.preprocess(
      v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
      z.number().min(0).max(1),
    ),
    reason: z.string(),
  })).default([]),
  unmapped_files: z.array(z.number().int()).default([]),
  reasons: z.array(z.string()).default([]),
})
export type SeasonMap = z.infer<typeof SeasonMapSchema>

export const LooseEpisodesMapSchema = z.object({
  assignments: z.array(z.object({
    episode_code: z.string(),
    // fail-soft：单行 candidate_id 缺失/为数字不炸整季 sweep——nullish 放行，下游 filter 剔除
    candidate_id: z.preprocess(v => (typeof v === 'number' ? String(v) : v), z.string()).nullish(),
    confidence: z.preprocess(
      v => (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v),
      z.number().min(0).max(1),
    ),
  })).default([]),
  reasons: z.array(z.string()).default([]),
})
export type LooseEpisodesMap = z.infer<typeof LooseEpisodesMapSchema>
