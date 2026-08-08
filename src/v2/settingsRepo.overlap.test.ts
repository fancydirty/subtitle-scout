import { describe, it, expect } from 'vitest'
import { findOverlappingRoot } from './settingsRepo.js'

/** D7 / C39：嵌套守备目录检测。
 *
 *  这个函数原本是 dashboard/apiV2.ts 的模块私有函数（那里的 addMediaRoot 端点用它做入口校验）。
 *  第 1a 步把它下移到 settingsRepo——因为 D7 要求 addRoot **本身**成为闸门，堵住
 *  seedRootsFromEnv 那条绕过 HTTP 层的旁路。apiV2 改为 import 同一份实现。
 *
 *  为什么必须堵：D1 的删除逻辑是「逐守备目录比对差集」。若 /media 与 /media/115 同时是根，
 *  115 挂载掉线时 /media 的 walk 仍成功 → 115 下的行落进 /media 的差集 → 被当成「消失的文件」
 *  全部删除。这正是 R8 保护要防的灾难（缺口 C29）。 */
describe('findOverlappingRoot · 嵌套守备目录检测（D7）', () => {
  it('候选是既有根的子目录 → relation=child', () => {
    expect(findOverlappingRoot('/media/tv/anime', ['/media/tv']))
      .toEqual({ root: '/media/tv', relation: 'child' })
  })

  it('候选是既有根的父目录 → relation=parent', () => {
    expect(findOverlappingRoot('/media', ['/media/tv']))
      .toEqual({ root: '/media/tv', relation: 'parent' })
  })

  it('候选与既有根相等 → null（相等是重复提交，幂等交给 addRoot，不算重叠）', () => {
    expect(findOverlappingRoot('/media/tv', ['/media/tv'])).toBeNull()
  })

  it('无重叠 → null', () => {
    expect(findOverlappingRoot('/media/movies', ['/media/tv', '/data/anime'])).toBeNull()
  })

  it('同名前缀不误判：/media/tv2 与既有 /media/tv 无关（防裸 startsWith 陷阱）', () => {
    // 裸 candidate.startsWith(root) 会把 /media/tv2 误判成 /media/tv 的子目录。
    // 正确实现必须比对 root + 路径分隔符。
    expect(findOverlappingRoot('/media/tv2', ['/media/tv'])).toBeNull()
    expect(findOverlappingRoot('/media/tv', ['/media/tv2'])).toBeNull()
  })

  // 不锁定返回顺序：唯一调用方 listRoots() 是 ORDER BY path，测试若锁死数组顺序
  // 就是在锁一个生产永不出现的形态（审校 F4）。契约只保证"必须报冲突且指出某个真实撞上的根"。
  it('多个既有根都命中时，返回其中一个真实撞上的根', () => {
    const hit = findOverlappingRoot('/media/tv/anime', ['/data', '/media', '/media/tv'])
    expect(hit).not.toBeNull()
    expect(['/media', '/media/tv']).toContain(hit!.root)
    expect(hit!.relation).toBe('child')
  })

  // ── 审校 F3（2026-08-08）：尾部斜杠漏检，真实可达且直通 C29 删库 ──
  // seedRootsFromEnv 只做 trim()、零路径规范化（settingsRepo.ts:157-161），
  // 所以 MEDIA_ROOTS=/media/tv/ 能种出带尾斜杠的根。此后 `'/media/tv/' + sep` 变成
  // '//'，startsWith 不命中 → 加子目录绕过 D7 闸门 → D1 逐根差集把子根当"消失文件"全删。
  // HTTP 入口有 resolve() 兜住，但 env 种子这条旁路没有——而 D7 的全部意义就是堵旁路。
  it('既有根带尾部斜杠时，子目录候选仍须判为 child（F3 防 C29 绕过）', () => {
    expect(findOverlappingRoot('/media/tv/anime', ['/media/tv/']))
      .toEqual({ root: '/media/tv/', relation: 'child' })
  })

  it('候选带尾部斜杠时，父目录关系仍须判出（F3 对称面）', () => {
    expect(findOverlappingRoot('/media/', ['/media/tv']))
      .toEqual({ root: '/media/tv', relation: 'parent' })
  })

  it('两侧都带尾部斜杠也须判出（F3）', () => {
    expect(findOverlappingRoot('/media/tv/anime/', ['/media/tv/']))
      .toEqual({ root: '/media/tv/', relation: 'child' })
  })

  it('尾斜杠不制造假重叠：/media/tv/ 与 /media/tv 视为同一根（相等语义）', () => {
    // 归一化后两者相等 → 不是重叠，是重复提交，交给 addRoot 幂等处理
    expect(findOverlappingRoot('/media/tv/', ['/media/tv'])).toBeNull()
    expect(findOverlappingRoot('/media/tv', ['/media/tv/'])).toBeNull()
  })

  it('尾斜杠归一化后同名前缀仍不误判：/media/tv2 vs /media/tv/', () => {
    expect(findOverlappingRoot('/media/tv2', ['/media/tv/'])).toBeNull()
  })

  it('既有根为空 → null', () => {
    expect(findOverlappingRoot('/media/tv', [])).toBeNull()
  })
})
