import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ResultSetStore {
  create(items: unknown[]): string
  count(id: string): number
  list(id: string, offset: number, limit: number): unknown[]
  get(id: string, index: number): unknown | null
}

/** File-backed handle store for search_source's full result sets (design: "写 DB/文件,只返回
 *  {result_set_id,count,top-N}"). Deliberately file-backed, not a new DB table — keeps phase ②
 *  independent of any schema migration (the only migration in this plan is phase ④'s, on the
 *  jobs table). Atomic tmp+rename write mirrors the existing ProfileStore idiom
 *  (src/agent/profile.ts) already used in this codebase. */
export function makeFileResultSetStore(dir: string): ResultSetStore {
  mkdirSync(dir, { recursive: true })
  const pathFor = (id: string) => join(dir, `${id}.json`)
  const read = (id: string): unknown[] => {
    const p = pathFor(id)
    if (!existsSync(p)) throw new Error(`unknown result set: ${id}`)
    return JSON.parse(readFileSync(p, 'utf8'))
  }
  return {
    create(items) {
      const id = randomUUID()
      const finalPath = pathFor(id)
      const tmpPath = `${finalPath}.tmp`
      writeFileSync(tmpPath, JSON.stringify(items))
      renameSync(tmpPath, finalPath)
      return id
    },
    count(id) {
      return read(id).length
    },
    list(id, offset, limit) {
      return read(id).slice(offset, offset + limit)
    },
    get(id, index) {
      const items = read(id)
      return items[index] ?? null
    },
  }
}
