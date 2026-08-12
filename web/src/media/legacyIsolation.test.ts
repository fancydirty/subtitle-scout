// web/src/media/legacyIsolation.test.ts：任务书点名的债务①——**两套同名异义的状态枚举
// 必须隔离**的执行守卫。
//
// ── 背景 ────────────────────────────────────────────────────────────────
// `web/src/library/episodeState.ts` 有一套七态 `EpisodeCellState`：
//   covered / hardsub / missing / throttled / error / dashed / partial
// 长在**旧** `episodes` 表上（经 LibraryOnDiskEpisodeDTO.subStatus）。
// 本目录用的是后端 mediaLibraryApi.ts 的八态 `EpisodeState`：
//   covered / translating / unsolvable / origin-skip / embedded / pending / unjudged / absent
// 长在**新** `files` 表的 sub_status/needs_subtitle/skip_reason 三列上。
//
// 裁决（完整论证见 episodeStateMeta.ts 头注释）：**新页面绝不复用旧的，一行都不 import**。
//
// ── 这个文件的前身是装饰品，以下是它被推翻的经过 ────────────────────────────
// 旧版本花 18 行头注释论证自己"走 import 图 + 值层面集合运算"。**两句都是假的**：
// 它的 6 条断言全是 `NEW_STATES`（派生自 EPISODE_STATE_LABEL）与 `LEGACY_STATES`
// （**手抄的字符串字面量**）两个常量数组的集合运算——比对的是"两套枚举值域不同"这个
// **恒真的静态事实**，与"新页面有没有 import 旧文件"零相关。变异审计实测：让
// MediaDetailPage.tsx 真的 import 并调用 buildGridCells、把旧七态的值渲染进 DOM，
// **1045 条用例无一变红**。更讽刺的是那个文件**自己 import 了 buildGridCells**——
// 它连"import 图里不该出现旧模块"都做不了，因为它自己就在图里。
//
// ── 现在这个文件怎么做（真·import 图）──────────────────────────────────────
// `import.meta.glob(..., { query: '?raw', eager: true })` 把 src 下全部 233 个 .ts/.tsx
// 的**源文本**取进来（实测可用：episodeStateMeta.ts 取到 2329 字符真内容；⚠️ 注意 CSS 的
// `?raw` 在 vitest 里恒空串，那是 css:false 处理链的问题，.ts/.tsx 不受影响，见
// vitest.config.ts:11 记的那个坑），然后从两个入口出发**跟着相对路径 import 递归走闭包**，
// 断言闭包里不出现 `library/`。
//
// 🔴 **本文件自己不在被检查的图里**：它只把源码当数据读，不 import 任何被测模块的实现。
// 这正是旧版本做不到的那件事。
//
// 🔴 **防空转**（这份守卫最容易退化成的样子：解析器坏掉 → 闭包为空 → 恒绿）：
//   · 断言闭包规模与已知成员（入口自身、EpisodeMark、episodeStateMeta、api/types 都得在）
//   · 断言**未解析的相对 specifier 数为 0**（解析器漏掉一条边 = 那条边后面的子树全逃检）
//   · **阳性对照**：从 library/SeriesPage.tsx 出发走同一套解析器，必须**能**抓到
//     library/episodeState.ts。抓不到就说明解析器根本不工作，此时禁令那条的"绿"无意义。
import { describe, it, expect } from 'vitest'
import { EPISODE_STATE_LABEL, LEGEND_STATES } from './episodeStateMeta.js'
import { en } from '../i18n/en.js'
import { zh } from '../i18n/zh.js'
import type { EpisodeState } from '../api/types.js'

// ═══════════════════════════════════════════════════════════════════════════
// 源码虚拟文件系统：键是**相对 src/ 的路径**（如 'media/MediaDetailPage.tsx'），值是源文本。
// ═══════════════════════════════════════════════════════════════════════════
const RAW = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** glob 的键相对本文件所在目录（'./x.ts' / '../api/types.ts'）→ 归一成相对 src/ 的路径。 */
const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k.startsWith('./') ? `media/${k.slice(2)}` : k.slice(3), v]),
)

/** 剥注释。**必须先剥**：本仓的头注释里大量出现 `import { buildGridCells } from '…'` 这类
 *  举例文字（本文件自己上面就有两处），不剥的话它们会被当成真边，闭包凭空多出模块。
 *  行注释那条用 `[^:]` 排除 `http://`。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** 静态 import/export-from + 动态 import() 的字面量 specifier。 */
const STATIC_RE = /(?:^|[\s;{}()])(?:import|export)\s*(?:[\s\S]*?\sfrom\s*|\s*)['"]([^'"]+)['"]/g
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function specifiersOf(src: string): string[] {
  const bare = stripComments(src)
  const out: string[] = []
  for (const m of bare.matchAll(STATIC_RE)) out.push(m[1]!)
  for (const m of bare.matchAll(DYNAMIC_RE)) out.push(m[1]!)
  return out
}

/** 'media/a.tsx' + '../api/types.js' → 'api/types.ts'。解析不出返回 null（调用方要记账）。
 *  本仓写的是 NodeNext 风格的 `.js` 后缀（源文件其实是 .ts/.tsx），所以要做后缀回译。 */
function resolveSpec(fromPath: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null // 裸包名（react 等）不进图
  const segs = fromPath.split('/').slice(0, -1)
  for (const s of spec.split('/')) {
    if (s === '.' || s === '') continue
    if (s === '..') segs.pop()
    else segs.push(s)
  }
  const base = segs.join('/')
  const cands = [base]
  if (base.endsWith('.js')) cands.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`)
  if (base.endsWith('.jsx')) cands.push(`${base.slice(0, -4)}.tsx`)
  cands.push(`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`)
  for (const c of cands) if (c in SOURCES) return c
  return null
}

/** 从若干入口出发的模块依赖闭包（含入口自身）。`unresolved` 记下每一条**指向相对路径却没
 *  解析出文件**的边——它必须是 0，否则闭包是残缺的，"不含旧模块"这句话就没有效力。 */
function importClosure(entries: string[]): { modules: Set<string>; unresolved: string[] } {
  const modules = new Set<string>()
  const unresolved: string[] = []
  const queue = [...entries]
  while (queue.length > 0) {
    const cur = queue.pop()!
    if (modules.has(cur)) continue
    modules.add(cur)
    const src = SOURCES[cur]
    if (src === undefined) {
      unresolved.push(`<入口不存在> ${cur}`)
      continue
    }
    for (const spec of specifiersOf(src)) {
      if (!spec.startsWith('.')) continue
      const next = resolveSpec(cur, spec)
      if (next === null) unresolved.push(`${cur} -> ${spec}`)
      else if (!modules.has(next)) queue.push(next)
    }
  }
  return { modules, unresolved }
}

const ENTRIES = ['media/MediaDetailPage.tsx', 'media/EpisodeCell.tsx']

describe('债务①：新页面的 import 图里不许出现旧 library 模块', () => {
  it('解析器自检：源码 VFS 装到了全部 src 文件，且入口都在里面', () => {
    // 空 VFS / 少半个目录都会让下面的禁令恒真。
    expect(Object.keys(SOURCES).length).toBeGreaterThan(200)
    for (const e of ENTRIES) {
      expect(SOURCES[e], `${e} 不在源码 VFS 里——glob 模式坏了`).toBeTruthy()
      expect(SOURCES[e]!.length).toBeGreaterThan(500)
    }
    // 被禁的那个模块**确实存在**——它要是被删/改名了，禁令同样会退化成恒真，
    // 那时该改的是这份守卫（或它已随 Task ⑪ 完成使命），不是让它继续假绿。
    expect(SOURCES['library/episodeState.ts'], '旧模块不在了——这份守卫要重新评估').toBeTruthy()
  })

  it('解析器自检（阳性对照）：同一套解析器从 library/SeriesPage.tsx 出发**抓得到** library/episodeState.ts', () => {
    // 🔴 这条是整份文件的地基。SeriesPage.tsx:13 真的写着
    // `import { buildGridCells, tallyGridCells } from './episodeState.js'`。
    // 抓不到 = 解析器不工作 = 下面那条禁令的"绿"是空转。
    const { modules, unresolved } = importClosure(['library/SeriesPage.tsx'])
    expect(modules.has('library/episodeState.ts'), '解析器抓不到一条真实存在的 import 边').toBe(true)
    expect(unresolved, '阳性对照里有解析不出的相对 import').toEqual([])
  })

  it('闭包完整：两个入口的依赖闭包无一条相对 import 解析失败，且已知成员都在', () => {
    const { modules, unresolved } = importClosure(ENTRIES)
    // 解析失败 = 那条边后面的整棵子树逃过检查（旧模块可能就藏在那后面）。
    expect(unresolved, '有相对 import 没解析出文件——闭包不完整，禁令失去效力').toEqual([])
    // 规模与已知成员：闭包坍缩成"只有入口自己"时下面的禁令也会绿。
    expect(modules.size).toBeGreaterThanOrEqual(10)
    for (const m of [
      'media/MediaDetailPage.tsx', 'media/EpisodeCell.tsx', 'media/EpisodeMark.tsx',
      'media/episodeStateMeta.ts', 'api/types.ts', 'i18n/useT.ts',
    ]) {
      expect(modules.has(m), `闭包里缺 ${m}——走图走漏了`).toBe(true)
    }
  })

  // 🔴 债务①的**真判据**：不是"两套枚举值域不同"（那是恒真的静态事实），
  // 而是"新页面的模块依赖闭包里没有旧模块"。
  it('MediaDetailPage / EpisodeCell 的依赖闭包**不含 library/episodeState**', () => {
    const { modules } = importClosure(ENTRIES)
    expect(
      modules.has('library/episodeState.ts'),
      '新详情页（直接或间接）import 了旧七态模块——债务①的隔离被打破',
    ).toBe(false)
  })

  it('更强：闭包里**一个 library/ 模块都没有**（目录级隔离，见 episodeStateMeta.ts 理由③）', () => {
    // 旧页面整个随 Task ⑪ 移入 `_legacy`。今天在它任何一个文件上建依赖，那天都要还债。
    const { modules } = importClosure(ENTRIES)
    expect([...modules].filter((m) => m.startsWith('library/')).sort()).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 以下是**语义**层面的隔离佐证：两套枚举即便被人接上也对不齐。
// ⚠️ 这些是常量集合运算，**不是** import 图检查——它们证明"两套不同"，
// 证明不了"没被 import"。后者由上面那组负责。此处不再声称它们有隔离效力。
// ═══════════════════════════════════════════════════════════════════════════

/** 新八态的**值**全集（从 EPISODE_STATE_LABEL 的键派生——那张表是穷尽 Record，
 *  少一个键 tsc 就红，所以它的键集合就是类型联合本身）。 */
const NEW_STATES = Object.keys(EPISODE_STATE_LABEL) as EpisodeState[]

describe('新八态 vs 旧七态：值域对不齐（语义佐证，非隔离守卫）', () => {
  it('新八态恰好八个，且就是后端 mediaLibraryApi.ts 的那八个', () => {
    expect([...NEW_STATES].sort()).toEqual(
      ['absent', 'covered', 'embedded', 'origin-skip', 'pending', 'translating', 'unjudged', 'unsolvable'],
    )
  })

  it('旧七态的 "missing" 在新八态里没有对应——它对应两个**语义相反**的态', () => {
    expect(NEW_STATES).not.toContain('missing')
    // 排队等找（还会来结果）与 判定无解（现在没辙）—— 设计文档 §4.3 点名要求两者视觉可分。
    expect(NEW_STATES).toContain('pending')
    expect(NEW_STATES).toContain('unsolvable')
  })

  it('文案键前缀分开（media_state_* vs library_legend_*）——改一个不会误改另一个', () => {
    for (const key of Object.values(EPISODE_STATE_LABEL)) {
      expect(key.startsWith('media_state_'), `${key} 不在 media_state_ 命名空间里`).toBe(true)
    }
    // 旧图例键还活着且不重名（Task ⑪ 才随旧页面删）
    expect(en.library_legend_covered).toBeTruthy()
    expect(en.library_legend_covered).not.toBe(en.media_state_covered)
  })
})

describe('八态文案表（穷尽 Record，漏一态 tsc 红）', () => {
  it('八个态在 en/zh 两侧都有真文案，且同侧内两两不同', () => {
    for (const [name, table] of [['en', en], ['zh', zh]] as const) {
      const values = NEW_STATES.map((s) => (table as Record<string, string>)[EPISODE_STATE_LABEL[s]])
      for (const [i, v] of values.entries()) {
        expect(v, `${name}.${EPISODE_STATE_LABEL[NEW_STATES[i]!]} 缺失`).toBeTruthy()
      }
      // 两个态共用一句文案 = 用户读到的信息里两者不可分（Carbon 双通道在文本通道上的同型失效）
      expect(new Set(values).size, `${name} 有两个态共用同一句文案`).toBe(NEW_STATES.length)
    }
  })

  it('unsolvable 的文案**不说"失败/放弃"**——它不是永久终态（复查闸每周放回一次）', () => {
    expect(en.media_state_unsolvable.toLowerCase()).not.toMatch(/fail|gave up|giving up|error/)
    expect(zh.media_state_unsolvable).not.toMatch(/失败|放弃|错误/)
    // 正面：必须传达"还会再试"
    expect(en.media_state_unsolvable.toLowerCase()).toContain('retry')
    expect(zh.media_state_unsolvable).toContain('再试')
  })

  it('图例列七个染色态，absent 不在其中（它是边框维度，不是颜色维度）', () => {
    expect(LEGEND_STATES).toHaveLength(7)
    expect(LEGEND_STATES as readonly string[]).not.toContain('absent')
    // 图例覆盖了除 absent 外的全部态——漏一个就是有格子的颜色无处可查
    expect([...LEGEND_STATES].sort()).toEqual(NEW_STATES.filter((s) => s !== 'absent').sort())
  })
})
