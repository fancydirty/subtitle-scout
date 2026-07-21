// jimaku.cc 日文字幕源 client(F2)。Auth=裸 Authorization header;files 直链下载无需 key。
// 契约见 docs/design/2026-07-21-f2-jimaku-ja-source-design.md。
import { z } from 'zod'

export const JIMAKU_BASE = 'https://jimaku.cc/api'
export const JIMAKU_TIMEOUT_MS = 15_000

const EntrySchema = z.object({
  id: z.number(),
  name: z.string(),
  english_name: z.string().nullish(),
  japanese_name: z.string().nullish(),
  anilist_id: z.number().nullish(),
  flags: z.object({
    anime: z.boolean().optional(),
    movie: z.boolean().optional(),
    adult: z.boolean().optional(),
    unverified: z.boolean().optional(),
    external: z.boolean().optional(),
  }).passthrough().nullish(),
}).passthrough()
export type JimakuEntry = z.infer<typeof EntrySchema>

const FileSchema = z.object({
  url: z.string(),
  name: z.string(),
  size: z.number().nullish(),
  last_modified: z.string().nullish(),
}).passthrough()
export type JimakuFile = z.infer<typeof FileSchema>

export class JimakuHttpError extends Error {
  constructor(endpoint: string, public status: number) {
    super(`jimaku ${endpoint} HTTP ${status}`)
  }
}

export interface JimakuClientOpts {
  apiKey: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  onApiCall?: (r: { endpoint: string; status: number | null; durationMs: number; error?: string; droppedEntries?: number }) => void
}

export class JimakuClient {
  private fetchImpl: typeof fetch
  private timeoutMs: number
  private onApiCall?: JimakuClientOpts['onApiCall']

  constructor(private opts: JimakuClientOpts) {
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.timeoutMs = opts.timeoutMs ?? JIMAKU_TIMEOUT_MS
    this.onApiCall = opts.onApiCall
  }

  async search(params: { query?: string; anilistId?: number }): Promise<JimakuEntry[]> {
    const q = new URLSearchParams()
    if (params.anilistId != null) q.set('anilist_id', String(params.anilistId))
    else if (params.query) q.set('query', params.query)
    else throw new Error('jimaku search requires query or anilistId')
    const raw = await this.getJson(`/entries/search?${q}`)
    return this.parseEntries(raw, '/entries/search')
  }

  async files(entryId: number, episode?: number): Promise<JimakuFile[]> {
    const q = episode != null ? `?episode=${episode}` : ''
    const raw = await this.getJson(`/entries/${entryId}/files${q}`)
    return this.parseFiles(raw, `/entries/${entryId}/files`)
  }

  /** 逐条 fail-soft 解析(对齐 assrt/opensubtitles 的 filterMalformedSubs 先例):单条坏数据
   *  不拖死整页——上游 schema drift 时保留好条目;droppedEntries 经 onApiCall 透出。
   *  全灭(非数组/一条不剩)才抛——那是形状级坏,不是"诚实空结果"。 */
  private parseEntries(raw: unknown, endpoint: string): JimakuEntry[] {
    if (!Array.isArray(raw)) throw new Error(`jimaku ${endpoint} schema: not an array`)
    const out: JimakuEntry[] = []
    let dropped = 0
    for (const item of raw) {
      const p = EntrySchema.safeParse(item)
      if (p.success) out.push(p.data)
      else dropped++
    }
    if (dropped > 0 && out.length === 0) {
      throw new Error(`jimaku ${endpoint}: all ${dropped} entries malformed (schema drift?)`)
    }
    if (dropped > 0) {
      this.onApiCall?.({ endpoint, status: 200, durationMs: 0, droppedEntries: dropped })
    }
    return out
  }

  private parseFiles(raw: unknown, endpoint: string): JimakuFile[] {
    if (!Array.isArray(raw)) throw new Error(`jimaku ${endpoint} schema: not an array`)
    const out: JimakuFile[] = []
    let dropped = 0
    for (const item of raw) {
      const p = FileSchema.safeParse(item)
      if (p.success) out.push(p.data)
      else dropped++
    }
    if (dropped > 0 && out.length === 0) {
      throw new Error(`jimaku ${endpoint}: all ${dropped} files malformed (schema drift?)`)
    }
    if (dropped > 0) {
      this.onApiCall?.({ endpoint, status: 200, durationMs: 0, droppedEntries: dropped })
    }
    return out
  }

  private async getJson(path: string): Promise<unknown> {
    const endpoint = path.split('?')[0]
    const t0 = Date.now()
    let status: number | null = null
    try {
      const res = await this.fetchImpl(`${JIMAKU_BASE}${path}`, {
        headers: { Authorization: this.opts.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      status = res.status
      if (!res.ok) throw new JimakuHttpError(endpoint, res.status)
      const body: unknown = await res.json()
      this.onApiCall?.({ endpoint, status, durationMs: Date.now() - t0 })
      return body
    } catch (e) {
      this.onApiCall?.({
        endpoint, status, durationMs: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      })
      throw e
    }
  }
}
