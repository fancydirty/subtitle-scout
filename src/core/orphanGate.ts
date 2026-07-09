import type { OrphanDecision } from './schemas.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'

export interface OrphanGateResult { ok: boolean; failures: string[]; orphan?: OrphanSubtitle }

/** 收编 gate：LLM 只提议，代码验证。不过就放弃收编走 ASSRT，绝不误收。 */
export function runOrphanGate(
  decision: OrphanDecision, orphans: OrphanSubtitle[], minConfidence: number,
): OrphanGateResult {
  if (!decision.adopt) return { ok: false, failures: [] }
  const failures: string[] = []
  const orphan = orphans.find(o => o.filename === decision.file)
  if (!orphan) failures.push(`file ${decision.file} is not in the scanned orphan set`)
  if (decision.confidence < minConfidence) failures.push(`confidence ${decision.confidence} below ${minConfidence}`)
  return failures.length ? { ok: false, failures } : { ok: true, failures: [], orphan }
}
