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
export const PROVIDERS = ['assrt', 'opensubtitles', 'zimuku'] as const
export type ProviderName = (typeof PROVIDERS)[number]

// invariant: `index` MUST equal the entry's position within its containing SubtitleCandidate.fileList
// array — downstream resolution (gate.ts's episode-code backstop, pipeline.ts's artifact filename
// lookup) indexes fileList positionally (`fileList[fileIndex]`), never by scanning for `.index === n`.
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

