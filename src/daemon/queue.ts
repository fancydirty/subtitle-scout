import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const RETRY_LADDER_DAYS = [1, 2, 4, 8]
const DAY_MS = 86_400_000

export interface QueueEntry {
  itemId: string
  name: string
  addedAt: number
  attempts: number
  nextRetryAt: number
  state: 'pending' | 'dormant'
}

interface QueueFile { watermark: string | null; entries: QueueEntry[] }

/** 预热队列：水位线 + 衰减重试 + 休眠/激活。注入时钟，全逻辑可测。原子写（tmp+rename）。 */
export class PrefetchQueue {
  private data: QueueFile

  constructor(
    private file: string,
    private now: () => number = Date.now,
    private onEvent?: (e: {
      event: 'enqueued' | 'decayed' | 'dormant' | 'activated' | 'removed'
      itemId: string
      name: string
      attempts?: number
      nextRetryAt?: number
    }) => void,
  ) {
    mkdirSync(dirname(file), { recursive: true })
    this.data = this.load()
  }

  private load(): QueueFile {
    if (!existsSync(this.file)) return { watermark: null, entries: [] }
    try { return JSON.parse(readFileSync(this.file, 'utf8')) } catch { return { watermark: null, entries: [] } }
  }
  private save() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }

  watermark(): string | null { return this.data.watermark }
  setWatermark(dateCreated: string) { this.data.watermark = dateCreated; this.save() }

  upsert(itemId: string, name: string) {
    if (this.data.entries.some(e => e.itemId === itemId)) return
    this.data.entries.push({ itemId, name, addedAt: this.now(), attempts: 0, nextRetryAt: this.now(), state: 'pending' })
    this.save()
    try { this.onEvent?.({ event: 'enqueued', itemId, name }) } catch { /* 观测不影响主流程 */ }
  }

  due(): QueueEntry | undefined {
    const now = this.now()
    return this.data.entries
      .filter(e => e.state === 'pending' && e.nextRetryAt <= now)
      .sort((a, b) => a.addedAt - b.addedAt)[0]
  }

  recordFailure(itemId: string) {
    const e = this.data.entries.find(x => x.itemId === itemId)
    if (!e) return
    e.attempts += 1
    const wasDormant = e.state === 'dormant'
    if (e.attempts > RETRY_LADDER_DAYS.length) {
      e.state = 'dormant'
      this.save()
      if (!wasDormant) try { this.onEvent?.({ event: 'dormant', itemId, name: e.name, attempts: e.attempts, nextRetryAt: e.nextRetryAt }) } catch { /* 观测不影响主流程 */ }
    } else {
      e.nextRetryAt = this.now() + RETRY_LADDER_DAYS[e.attempts - 1] * DAY_MS
      this.save()
      try { this.onEvent?.({ event: 'decayed', itemId, name: e.name, attempts: e.attempts, nextRetryAt: e.nextRetryAt }) } catch { /* 观测不影响主流程 */ }
    }
  }

  remove(itemId: string) {
    const e = this.data.entries.find(x => x.itemId === itemId)
    this.data.entries = this.data.entries.filter(x => x.itemId !== itemId)
    this.save()
    if (e) try { this.onEvent?.({ event: 'removed', itemId, name: e.name }) } catch { /* 观测不影响主流程 */ }
  }

  dormantFor(itemId: string): boolean {
    return this.data.entries.some(e => e.itemId === itemId && e.state === 'dormant')
  }

  activate(itemId: string) {
    const e = this.data.entries.find(x => x.itemId === itemId)
    if (!e) return
    e.state = 'pending'; e.attempts = 0; e.nextRetryAt = this.now()
    this.save()
    try { this.onEvent?.({ event: 'activated', itemId, name: e.name }) } catch { /* 观测不影响主流程 */ }
  }

  size(): { pending: number; dormant: number } {
    return {
      pending: this.data.entries.filter(e => e.state === 'pending').length,
      dormant: this.data.entries.filter(e => e.state === 'dormant').length,
    }
  }
}
