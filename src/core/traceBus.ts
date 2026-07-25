// 痕迹通道 C：agent 工具调用的直播总线。哲学：过程证据≠账目——这里是进程级单例、零持久化的
// 环形缓冲，只服务 SSE 直播订阅者；收官快照落 runs.trace_json 是唯一持久化点（见
// findSubtitleWorkerTask.ts/reconcileAll.ts 的 traceBus.snapshot 调用），snapshot 本身会清空
// 缓冲，只应在写那一行 runs 的时刻调用一次。
//
// R2D-13（R2 复审）：单 runKey 的 snapshot/peek 假设"一次 agent 跑=一个 runKey"，realign 字幕
// 先行阶段打破了这个假设（逐集各起一个 `job-${jobId}-${absoluteEpisode}` runKey）——
// snapshotPrefix/peekPrefix 是这一族场景的对应版本：按 runKey 前缀（startsWith）收集/合并多个
// runKey 的缓冲，其余语义（清空 vs 非破坏、cap 512、订阅者过滤）与单 key 版一致。

export interface TraceEvent {
  runKey: string
  seq: number
  tool: string
  argsSummary: string
  resultSummary: string
  tookMs: number
  at: number
}

/** 每个 runKey 最多缓冲这么多条事件——溢出丢最旧（收官快照因此只保证"最近 512 条"完整，不是
 *  全量；直播场景下这已经足够，账目式的完整性从来不是这条通道的职责）。 */
const RING_CAP = 512

/** runKey 键数量上限——崩溃 run 的缓冲会永久残留（snapshot 未被调用），长期运行下缓慢累积。
 *  超过此上限时淘汰最久未写入的键（LRU 语义）。 */
const MAX_BUFFERS = 1000

// 进程级单例状态：一个 runKey 一条环形缓冲；订阅者集合不分 runKey（过滤归客户端，见模块头注）。
const buffers = new Map<string, TraceEvent[]>()
const subscribers = new Set<(e: TraceEvent) => void>()

/** 淘汰最久未写入的键（LRU）：Map 的迭代顺序是插入顺序，第一个键就是最久未更新的。 */
function evictOldestBuffer(): void {
  const oldest = buffers.keys().next().value
  if (oldest !== undefined) buffers.delete(oldest)
}

export const traceBus = {
  /** 追加进该 runKey 的环形缓冲（cap 512，溢出丢最旧）+ 广播给全部订阅者。订阅者回调抛错必须
   *  被吞——直播是增益，绝不能反噬调用方的 agent 循环。键数量超上限时淘汰最久未写入的键（真 LRU：
   *  写入即刷新 recency）。 */
  publish(e: TraceEvent): void {
    let buf = buffers.get(e.runKey)
    if (buf) {
      // 真 LRU：已存在的键被写入时，删除并重新插入以刷新位置（Map 迭代顺序 = 插入顺序）
      buffers.delete(e.runKey)
      buffers.set(e.runKey, buf)
    } else {
      // 键数量上限：淘汰最久未写入的键（崩溃 run 的缓冲永久残留场景）
      if (buffers.size >= MAX_BUFFERS) evictOldestBuffer()
      buf = []
      buffers.set(e.runKey, buf)
    }
    buf.push(e)
    if (buf.length > RING_CAP) buf.shift()
    for (const fn of subscribers) {
      try {
        fn(e)
      } catch {
        // 吞掉——一个订阅者的异常不许打断 publish 本身，也不许波及其他订阅者。
      }
    }
  },

  /** 订阅全部 runKey 的事件（过滤到具体 runKey 是订阅者自己的事）。返回退订函数。 */
  subscribe(fn: (e: TraceEvent) => void): () => void {
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  },

  /** 返回该 runKey 缓冲的全量事件（最多 512 条）并从缓冲中清空——只应在收官落 runs 行的那一刻
   *  调用一次；重复调用第二次起只会拿到空数组。 */
  snapshot(runKey: string): TraceEvent[] {
    const buf = buffers.get(runKey) ?? []
    buffers.delete(runKey)
    return buf
  },

  /** G5：直播补拉专用——非破坏性读该 runKey 缓冲的尾部 limit 条（不清空，可反复调用），与
   *  snapshot 互不干扰（谁都不影响对方看到的数据）。返回的是浅拷贝，调用方改动返回数组不会
   *  污染内部缓冲。runKey 从未出现过、limit<=0 时返回 []。 */
  peek(runKey: string, limit: number): TraceEvent[] {
    if (limit <= 0) return []
    const buf = buffers.get(runKey)
    if (!buf || buf.length === 0) return []
    return buf.length <= limit ? [...buf] : buf.slice(buf.length - limit)
  },

  /** R2D-13（R2 复审）：realign 字幕先行阶段不是单一 runKey——每一集各自起一个
   *  `job-${jobId}-${absoluteEpisode}` runKey（见 realignExecutor.ts 的 deps.runEpisode 调用点），
   *  单 runKey 的 snapshot() 因此永远收不走这些子集缓冲：进程级无上界残留，且收官落 runs 行时
   *  trace_json 永远是空的。这里把"以 prefix 开头"的全部 runKey 缓冲一并收走并清空——语义就是
   *  `key.startsWith(prefix)`，调用方传入的 prefix 自带尾连字符（`job-${job.id}-`），避免
   *  `job-42` 前缀误吞 `job-420-13` 这种数字延伸的不相关 job。合并结果按 (at, seq) 升序返回
   *  （不同子集各自的 seq 从 0 起算，不能直接按 seq 排——at 才是跨子集的真实时间序）。 */
  snapshotPrefix(prefix: string): TraceEvent[] {
    const collected: TraceEvent[] = []
    for (const key of [...buffers.keys()]) {
      if (!key.startsWith(prefix)) continue
      const buf = buffers.get(key)
      if (buf) collected.push(...buf)
      buffers.delete(key)
    }
    collected.sort((a, b) => a.at - b.at || a.seq - b.seq)
    return collected
  },

  /** peek 的前缀合并版——同 snapshotPrefix 服务同一个"realign 逐集 runKey"场景，但非破坏性
   *  （直播补拉用，供 WorkerCard 首屏渲染 realign worker 的多子集尾部事件）。合并全部匹配
   *  runKey 的缓冲、按 (at, seq) 升序排序后只取尾部 limit 条，不清空任何缓冲。 */
  peekPrefix(prefix: string, limit: number): TraceEvent[] {
    if (limit <= 0) return []
    const collected: TraceEvent[] = []
    for (const [key, buf] of buffers) {
      if (key.startsWith(prefix)) collected.push(...buf)
    }
    collected.sort((a, b) => a.at - b.at || a.seq - b.seq)
    return collected.length <= limit ? collected : collected.slice(collected.length - limit)
  },
}

/** 绑定一个 runKey，返回一个补全 runKey + 自增 seq（从 0 开始）后调用 traceBus.publish 的函数。
 *  seq 计数逻辑只活在这里——调用方（reasoningAgent 的 onStepEvent 桥接）不需要也不应该自己管
 *  seq。 */
export function makeRunTracer(runKey: string): (e: Omit<TraceEvent, 'runKey' | 'seq'>) => void {
  let seq = 0
  return (e) => {
    traceBus.publish({ ...e, runKey, seq: seq++ })
  }
}
