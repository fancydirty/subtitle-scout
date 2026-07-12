import type { OrphanDecision } from './schemas.js'
import type { OrphanSubtitle } from '../files/orphanScanner.js'

export interface OrphanGateResult { ok: boolean; failures: string[]; orphan?: OrphanSubtitle }

/** 收编 gate：LLM 只提议，代码验证结构（文件确实在本次扫描到的孤儿集合里）。adopt 本身
 *  已经是模型的二选一判断——不再叠加一层置信度阈值二次质疑它。不过就放弃收编走搜索，
 *  绝不误收。 */
export function runOrphanGate(
  decision: OrphanDecision, orphans: OrphanSubtitle[],
): OrphanGateResult {
  if (!decision.adopt) return { ok: false, failures: [] }
  const orphan = orphans.find(o => o.filename === decision.file)
  if (!orphan) return { ok: false, failures: [`file ${decision.file} is not in the scanned orphan set`] }
  return { ok: true, failures: [], orphan }
}
