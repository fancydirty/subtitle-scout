// web/src/api/contract.ts：API 边界的**运行时形状校验**——一个约 90 行的检查器 + 每个 DTO 约
// 6 行的声明。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么需要这一层（病根，不是那一处）
// ══════════════════════════════════════════════════════════════════════════════
// `client.ts` 的 `get<T>()` 是**纯 `as T` 断言**：44 个出口、69 个 DTO，零运行时校验。
// TypeScript 在这里帮不上忙——`res.json()` 的静态类型是 `any`/`unknown`，`as T` 只是
// 把编译器的嘴堵上，浏览器里那个对象是什么形状**没有任何人检查过**。
//
// 后端违约（少个字段、类型变了、返回了别的 JSON）的两种后果：
//  · **崩页**——被解引用两层的嵌套对象缺席时 `Cannot read properties of undefined`，
//    React 19 卸载整棵树。上一轮 `SettingsTabsPage` 读 `data?.providers.subhd.enabled`
//    就是这个形态：可选链只挡到 `data`。
//  · **静默撒谎**——这个更坏。`workPermitted` 缺席 → `undefined` 是 falsy → 横幅说
//    「引擎没开」，而引擎其实在跑；`subtitledEpisodeCount` 缺席 → 卡片上显示 `NaN`
//    或算出错误的缺集数。界面看上去完全正常，用户据此做出错误的判断。
//
// 上一轮的修法是在**那一个消费点**加契约判定（`SettingsTabsPage.readProviders`）。
// 它挡住了那一处，其余几十个 DTO 一个都没挡——因为那不是根本解。根本解是让"后端违约"
// 在**一个地方**被发现：数据进入前端的那个门。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么是手写而不是 zod（实测数字，不是感觉）
// ══════════════════════════════════════════════════════════════════════════════
// 实测（本机 `vite build`，同一份源码，唯一变量是 zod）：
//   基线（无 zod）        484.83 kB │ gzip: 148.65 kB
//   加 zod + 一个 4 键 schema  546.08 kB │ gzip: 165.13 kB
//   代价                  +61.25 kB raw │ **+16.48 kB gzip（+11.1%）**
//
// 那 16.5 KB 买到的是**前端一条都用不上的能力**：transform / refine / coerce /
// discriminated union / 错误 i18n / infer 出类型。我们这一层要做的事只有一件——
// 「这几个路径上的键必须存在且类型对」。为一件事付 11% 的包体，换不回来。
//
// 还有一条不在体积上的代价：给 `web/package.json` 加依赖要过 `docker build` 的
// `web` 阶段（`npm ci` + `vite build`），且 `zod` 在前后端会变成**两份可能不同版本**
// 的同名库——后端已有 `zod@^4.4.3`，前端再装一份，将来"schema 从后端 import 过来复用"
// 这个看起来很美的念头会被 `web/` 是独立 tsconfig 工程这件事挡回去（`api/types.ts`
// 全文件都在手抄后端 interface，正是同一个约束的既有结论）。
//
// ══════════════════════════════════════════════════════════════════════════════
// 为什么这个形态不会退化成"每个 DTO 一个 200 行 guard"
// ══════════════════════════════════════════════════════════════════════════════
// 手写 guard 的通常败法是**逐字段写 if**：`if (typeof x.a !== 'string') throw …`，
// 69 个 DTO 就是几千行。这里换成**声明式**：检查器只写一次（下面这 ~90 行），
// 每个 DTO 是一段 6 行的数据声明：
//
//   const HEALTH = obj({ workPermitted: bool(), roots: arr(obj({ path: str() })) })
//
// 声明是**数据**不是代码，读起来就是那个 DTO 的形状本身，加一个字段是加一行。
//
// 🔴 **只声明致命路径上的键，不复刻整个 DTO**（见 contracts.ts 的短名单与判据）。
// 复刻整个 DTO 就是把 `types.ts` 的 709 行再抄一遍——那才是真正的样板灾难，
// 而且会让"后端加了个可选字段"这种无害变更把整页打成错误态。

/** 声明出来的形状。**内部表示，调用方只用下面五个构造器**（不手写这个联合）。 */
export type Shape =
  | { t: 'prim'; k: 'string' | 'number' | 'boolean'; nullable: boolean }
  | { t: 'obj'; fields: Record<string, Shape>; nullable: boolean }
  | { t: 'arr'; item: Shape; nullable: boolean }

export const str = (): Shape => ({ t: 'prim', k: 'string', nullable: false })
export const num = (): Shape => ({ t: 'prim', k: 'number', nullable: false })
export const bool = (): Shape => ({ t: 'prim', k: 'boolean', nullable: false })
export const obj = (fields: Record<string, Shape>): Shape => ({ t: 'obj', fields, nullable: false })
export const arr = (item: Shape): Shape => ({ t: 'arr', item, nullable: false })

/** `T | null`。**只包 null，不包 undefined**——这是刻意的，见下面 `walk` 的注释：
 *  后端契约里的 `x: T | null` 说的是"这个键在，值可能是 null"，不是"这个键可以不在"。
 *  两者在 JSON 里是不同的事实（`{"ok":null}` vs `{}`），把它们折成一个就等于宣布
 *  「少个字段没关系」——那正是本文件要防的那类静默。 */
export const nullable = (s: Shape): Shape => ({ ...s, nullable: true })

/** 违约的详情：**路径 + 期望 + 实得**。三样都要有，少一样这条消息就不足以定位。 */
export interface ContractViolation {
  /** 形如 `roots[0].ok` / `work.title`。根用 `''`（整个响应体本身就不对时）。 */
  path: string
  expected: string
  got: string
}

/** 人话化 `got`：`typeof` 分不出 null 与 object、也分不出数组与对象，而这三者
 *  恰恰是后端违约最常见的三种形态（返回了 `null`、返回了 `{error:…}`、返回了 `[]`）。 */
function describe(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function expectedOf(s: Shape): string {
  const base = s.t === 'prim' ? s.k : s.t === 'arr' ? 'array' : 'object'
  return s.nullable ? `${base}|null` : base
}

/**
 * 深度优先走一遍，**第一个违约就返回**（不收集全部）。
 *
 * 只收第一条的理由：这条消息是给人看的，而违约几乎总是**同一个原因**的批量表现
 * （后端换了个字段名 → 数组里 300 行全少这个键）。列 300 条相同的违约不会让人更快
 * 定位，只会把真正有用的那一条埋掉。
 *
 * 🔴 `undefined` 与 `null` **不合流**（即使 `nullable`）：`undefined` 永远是"键不在"，
 * 而 `nullable` 说的是"键在、值是 null"。放行 `undefined` 会让 `{}` 通过一个
 * 全字段 nullable 的声明——那个声明就等于没写。
 */
function walk(value: unknown, shape: Shape, path: string): ContractViolation | null {
  if (value === null) {
    return shape.nullable ? null : { path, expected: expectedOf(shape), got: 'null' }
  }
  if (value === undefined) {
    return { path, expected: expectedOf(shape), got: 'undefined' }
  }

  if (shape.t === 'prim') {
    return typeof value === shape.k ? null : { path, expected: expectedOf(shape), got: describe(value) }
  }

  if (shape.t === 'arr') {
    if (!Array.isArray(value)) return { path, expected: expectedOf(shape), got: describe(value) }
    for (let i = 0; i < value.length; i++) {
      const bad = walk(value[i], shape.item, `${path}[${i}]`)
      if (bad) return bad
    }
    return null
  }

  // obj。⚠️ **只检查声明了的键，不拒绝多余的键**：后端加一个前端还没用上的字段是
  // 完全正常的演进（且它天天发生），把那判成违约会让每次后端加字段都打崩前端一页。
  // 这一层回答的是"我要用的那些还在不在"，不是"你有没有多给"。
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { path, expected: expectedOf(shape), got: describe(value) }
  }
  const rec = value as Record<string, unknown>
  for (const key of Object.keys(shape.fields)) {
    const bad = walk(rec[key], shape.fields[key]!, path === '' ? key : `${path}.${key}`)
    if (bad) return bad
  }
  return null
}

/** 校验的唯一入口。合约满足 → `null`；违约 → 一条 `ContractViolation`。
 *  **不抛**——抛不抛是调用方（client.ts）的决定，见那边的论证。 */
export function checkShape(value: unknown, shape: Shape): ContractViolation | null {
  return walk(value, shape, '')
}

/**
 * 违约消息。**指名道姓**：谁违约（哪个端点）、哪个路径、期望什么、实得什么。
 *
 * 对比上一轮那条裸的 `Cannot read properties of undefined (reading 'subhd')`：
 * 那句话里没有端点、没有字段全名，看到它的人得先反查是哪个请求。这条消息一眼就够。
 *
 * 前缀 `[contract]` 是给日志检索用的固定串（这类失败在生产里靠用户截图回传，
 * 一个可搜索的前缀比什么都实用）。
 */
export function violationMessage(endpoint: string, v: ContractViolation): string {
  const where = v.path === '' ? 'response body' : v.path
  return `[contract] ${endpoint} 返回的数据不符合前端依赖的契约：${where} 期望 ${v.expected}，实得 ${v.got}。这是后端违约，不是你的操作问题。`
}

/**
 * 契约违例的**专用错误类型**。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 为什么必须与普通失败可区分（这条是实测撞出来的，不是设计洁癖）
 * ══════════════════════════════════════════════════════════════════════════════
 * 把校验搬到 API 边界有一个**不显眼的副作用**：它把「后端违约」塞进了与
 * 「请求失败 / 还没加载完」同一条管道。所有"`data` 为 null 就当还没加载、先降级显示"
 * 的消费点，会**默默把契约违例一起吞掉**。
 *
 * 实测（本轮变异，`AppShell.boundary.test.tsx` 当场变红）：
 *  · 改之前：`setup/status` 少 `providers` → hook 存下 data → `readProviders` 判违例
 *    → 抛 → `PageBoundary` 接住 → 设置页**诚实降级**。
 *  · 改之后（只抛不分型）：`get()` 在边界就抛 → hook 的 `.catch` 转成 error 字符串 →
 *    `data` 保持 **null** → `readProviders(null)` 走"合法缺席"分支 → badge 渲染 **0/8**。
 *
 * 也就是说：**一次诚实的降级被我换成了一句静默的谎话**（0/8 = "一个源都没配"，
 * 而真相是"不知道"）。这正是本层要消灭的病 B，且是我自己引入的。
 *
 * 所以违例必须**带着身份**传下去，让那类消费点能把它与"还没加载"分开。
 *
 * ⚠️ 谓词同时吃 `unknown` 与 `string`：本仓所有数据 hook 的 catch 都写
 * `setError(String(e))`——错误到消费点时**已经是字符串**，`instanceof` 在那里必然失效。
 * `[contract]` 前缀因此不是装饰，是这条链路上唯一还活着的身份标记。
 */
export class ContractViolationError extends Error {
  readonly violation: ContractViolation
  constructor(endpoint: string, violation: ContractViolation) {
    super(violationMessage(endpoint, violation))
    this.name = 'ContractViolationError'
    this.violation = violation
  }
}

/** 这个错误（或它被 `String()` 压扁后的字符串）是不是契约违例。
 *  消费点据此把「后端违约」与「网络失败 / 还没加载完」分开处置。 */
export function isContractViolation(e: unknown): boolean {
  if (e instanceof ContractViolationError) return true
  return typeof e === 'string' && e.includes('[contract]')
}
