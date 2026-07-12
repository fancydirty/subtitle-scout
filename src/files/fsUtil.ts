import { writeSync } from 'node:fs'

// 裸 writeSync 不保证一次调用写完全部字节（内核可能短写），不像 writeFileSync 那样内部有循环。
// 忽略其返回值直接 fsync+rename 会把半截数据当成"完整文件"落到最终路径——这正是原子写要防的那类故障。
// 所以显式循环，用剩余字节数重试，直到全部写完。
// 共享自 subtitleWriter.ts / stagingSandbox.ts：两处都在 fd 上做"写完整数据 + fsync + rename"
// 这套原子写模式，写循环本身的正确性要求完全相同，没有理由各存一份。
export function writeAll(fd: number, buf: Buffer): void {
  let written = 0
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written)
    // A 0-byte return without a thrown error is degenerate but technically legal for a raw
    // write() syscall; looping with an unchanged `written` would spin forever, so bail loudly.
    if (n === 0) throw new Error('writeSync wrote 0 bytes; aborting to avoid an infinite loop')
    written += n
  }
}
