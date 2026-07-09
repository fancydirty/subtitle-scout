import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import chardet from 'chardet'
import * as iconv from 'iconv-lite'

const SUBTITLE_EXTS = ['.srt', '.ass', '.ssa']
const SAMPLE_CHARS = 500
const MAX_FILE_BYTES = 5 * 1024 * 1024 // 字幕不会超过这个；超了不是字幕

export interface OrphanSubtitle { filename: string; path: string; sample: string }

/** 扫视频同目录中"命名不符合 Jellyfin 约定"的字幕文件，附解码后的内容头部样本 */
export function scanOrphans(dir: string, videoFilename: string): OrphanSubtitle[] {
  const videoBase = videoFilename.replace(/\.[^.]+$/, '')
  const out: OrphanSubtitle[] = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue
    if (!SUBTITLE_EXTS.includes(extname(name).toLowerCase())) continue
    if (name.startsWith(videoBase)) continue // 已符合约定（含带语言标签者）
    const path = join(dir, name)
    try {
      if (statSync(path).size > MAX_FILE_BYTES) continue
      const bytes = readFileSync(path)
      let encoding = 'utf-8'
      const detected = chardet.detect(bytes)
      if (detected && iconv.encodingExists(String(detected))) {
        encoding = String(detected)
      }
      // chardet 有时把 GB18030/GBK 误判为 Shift_JIS、ISO-8859 等，回退尝试列表
      if (encoding === 'Shift_JIS' || encoding.startsWith('ISO-8859') || encoding === 'windows-1252') {
        const testEncodings = ['gb18030', 'gbk', 'utf-8']
        for (const enc of testEncodings) {
          try {
            const decoded = iconv.decode(bytes.subarray(0, 4096), enc)
            // 简单启发式：中文字符占比
            if (/[一-鿿]/.test(decoded)) {
              encoding = enc
              break
            }
          } catch { /* continue */ }
        }
      }
      const sample = iconv.decode(bytes.subarray(0, 4096), encoding).slice(0, SAMPLE_CHARS)
      out.push({ filename: name, path, sample })
    } catch { /* 读不动的文件直接跳过，收编是尽力而为 */ }
  }
  return out
}
