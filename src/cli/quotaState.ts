import type { FetchEvent } from '../adapters/fetchLib.js'

export const QUOTA_STATE_PREFIX = 'quota_state_'

/** provider 配额事实 → settings 旁路键（债务 D3）。北极星④：机械层只记录事实不下指令——
 *  这里只写"何时耗尽/何时重置"，退避决策仍归各消费方。写/清规则见函数体注释。 */
export function applyQuotaEvent(
  e: FetchEvent,
  repo: { set(key: string, value: string, now: number): void; delete(key: string): void },
  now: number,
): void {
  if ((e.event === 'provider_error' || e.event === 'provider_notice') && e.code === 'quota_exhausted') {
    repo.set(`${QUOTA_STATE_PREFIX}${e.provider}`, JSON.stringify({ resetAt: e.resetAt ?? null, observedAt: now }), now)
    return
  }
  // download 端点成功=配额此刻可用，清键。成功但 remaining<=0 的场合事件顺序是
  // api_call(200) 先、provider_notice 后——先清再写，终态仍是"已耗尽"，正确。
  if (e.event === 'api_call' && e.status === 200 && e.endpoint.endsWith('/download')) {
    repo.delete(`${QUOTA_STATE_PREFIX}${e.provider}`)
  }
}
