import { describe, it, expect } from 'vitest'
import { loadSevenZip } from './sevenZip.js'
import { extractSubtitleEntries } from './sevenZipExtract.js'

/** 用 wasm 自造一个 7z（免二进制 fixture 入库）。 */
async function make7z(entries: Array<{ name: string; data: Buffer }>): Promise<Buffer> {
  const sz = await loadSevenZip({ print() {}, printErr() {}, noExitRuntime: true })
  const dir = '/mk'
  sz.FS.mkdir(dir)
  for (const e of entries) sz.FS.writeFile(`${dir}/${e.name}`, e.data)
  try {
    sz.callMain(['a', '/mk.7z', `${dir}/*`, '-y', '-bd'])
  } catch { /* emscripten exit(0) 走异常通道 */ }
  const out = Buffer.from(sz.FS.readFile('/mk.7z'))
  sz.FS.unlink('/mk.7z')
  for (const e of entries) sz.FS.unlink(`${dir}/${e.name}`)
  sz.FS.rmdir(dir)
  return out
}

describe('extractSubtitleEntries', () => {
  it('文本字幕条目正常返回', async () => {
    const archive = await make7z([{ name: 'movie.zh.srt', data: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n') }])
    const subs = await extractSubtitleEntries(archive)
    expect(subs.map((s) => s.name)).toEqual(['movie.zh.srt'])
  })

  it('位图-only 包（.sup）报出实际条目——agent 需要这个证据来放弃同族候选（2026-08-30 Matrix 实案）', async () => {
    const archive = await make7z([{ name: '00000.track_4609.sup', data: Buffer.alloc(64, 1) }])
    await expect(extractSubtitleEntries(archive)).rejects.toThrow(
      /no text subtitle files.*00000\.track_4609\.sup/s,
    )
  })
})
