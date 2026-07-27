/** 有界并发 map，保持 allSettled 语义与输入顺序。
 *
 *  为什么需要它（实测 2026-07-27）：阿里云盘经 rclone WebDAV 的单文件 ffprobe 是 12-16s，
 *  其中 ~12s 是阿里云 CDN 的延迟地板（绕过 FUSE 直读签名 URL 同样 12.1s），**串行不可优化**。
 *  但 4 文件并发实测 16.1s 墙钟（vs FTP 挂载同场景的 86.1s）——WebDAV 每个 range 请求 302 到
 *  CDN，真并行。收益全在并发，不在换协议。
 *
 *  为什么是 allSettled 而不是 all：ingest 的既有铁律是"一个文件/一次抖动不能拖垮整轮 pass"。
 *  `Promise.all` 一个 reject 就丢弃其余已完成结果，会把单文件探针失败升级成整批丢失。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return []
  const effective = Math.max(1, Math.floor(limit))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) }
      } catch (reason) {
        results[i] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(effective, items.length) }, worker))
  return results
}
