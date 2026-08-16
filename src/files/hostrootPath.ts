import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** Compose bind of the host filesystem (`/:/hostroot`). Empty on source-run. */
export const HOSTROOT = '/hostroot'

export function hostrootIsMounted(hostroot = HOSTROOT): boolean {
  try {
    return existsSync(hostroot) && statSync(hostroot).isDirectory()
  } catch {
    return false
  }
}

/** Turn a path the user typed (host absolute path) into the path the process can open.
 *  When compose mounted `/:/hostroot`, `/mnt/media/Movies` is `/hostroot/mnt/media/Movies`.
 *  Already-prefixed paths and source-run (no mount) are left alone.
 *  Concatenate rather than path.join: join() discards the prefix when the second arg is absolute. */
export function toContainerPath(userPath: string, hostroot = HOSTROOT): string {
  const resolved = resolve(userPath)
  const root = resolve(hostroot)
  if (resolved === root || resolved.startsWith(root + sep)) return resolved
  if (!hostrootIsMounted(hostroot)) return resolved
  return resolve(root + resolved)
}

/** Inverse of toContainerPath for dashboard display — users see host paths, never `/hostroot`. */
export function toHostPath(containerPath: string, hostroot = HOSTROOT): string {
  const resolved = resolve(containerPath)
  const root = resolve(hostroot)
  if (resolved === root) return '/'
  if (resolved.startsWith(root + sep)) return resolved.slice(root.length)
  return resolved
}
