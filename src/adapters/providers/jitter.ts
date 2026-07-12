/**
 * 请求节奏随机化的最小构件——设计文档要求 zimuku 单站请求间"2-5s 随机延迟",而不是恒定值:
 * 恒定节流间隔本身就是一种可指纹的行为特征(节拍完全一致的请求间隔,比人类浏览的抖动更容易
 * 被识别成脚本)。base + rng() * jitterRangeMs 而不是 min + rng() * (max - min):base 是一个
 * 显式、易读的下限常量,不会因为 rng() 恰好落在 0 附近而滑到比设计约定的下限更低。
 *
 * rng 可注入(默认 Math.random)——测试用确定性桩验证边界(rng()=0 → 恰好等于 base;
 * rng()→1 → 逼近 base+jitterRangeMs)与"每次都不同"这两件事,不必依赖对真实随机数取样断言分布。
 */
export type RandomFn = () => number

export function jitteredDelayMs(baseMs: number, jitterRangeMs: number, rng: RandomFn = Math.random): number {
  return baseMs + rng() * jitterRangeMs
}

/**
 * 请求间隔限流器:每次 wait() 都重新掷一次随机延迟目标(而不是像固定间隔限流器那样复用同一个
 * 常量),因此请求节奏不呈现固定周期指纹。结构上与 assrt.ts 的 MinIntervalLimiter 兼容(同为
 * `wait(): Promise<void>`),ZimukuClientOpts.limiter 可以互换接受两者——比如测试里想要一个
 * 恒定的极短间隔时,直接传 MinIntervalLimiter 覆盖默认的抖动版本即可,不需要额外的适配层。
 */
export class JitteredIntervalLimiter {
  private last = 0
  constructor(
    private baseMs: number,
    private jitterRangeMs: number,
    private rng: RandomFn = Math.random,
  ) {}

  async wait(): Promise<void> {
    const now = Date.now()
    const delta = now - this.last
    const target = jitteredDelayMs(this.baseMs, this.jitterRangeMs, this.rng)
    if (delta < target) await new Promise(r => setTimeout(r, target - delta))
    this.last = Date.now()
  }
}
