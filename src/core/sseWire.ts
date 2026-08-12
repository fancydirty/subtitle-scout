// src/core/sseWire.ts —— SSE 线格式 + 续传断点的**纯逻辑**，前后端共用的那道缝。
//
// ── 为什么单独一个文件（而不是留在 server.ts 里当闭包）────────────────────────────
// 这条链的缺陷史全部长在**缝上**：前端拼 URL → 后端读 query → replay 起点 → 前端去重，
// 四段各有各的测试，中间三道缝没人守。缝没人守的直接原因是**没有任何一段代码是两侧共有的**
// ——后端的 frame() 是 server.ts 里的一个闭包，前端的解析是 eventsBus.ts 里的一段 if，
// 想写一条端到端用例就只能在测试里把两边各手抄一遍，而手抄的那份永远只会证明"我抄对了"。
//
// 把线格式与断点解析**提成纯函数**之后，web/ 的用例可以直接 import 这个文件（它零依赖：
// 不碰 node:*、不碰 DOM、不碰时钟），于是"后端怎么发"与"前端怎么收"在同一条用例里用的是
// **同一份真实实现**。这就是 sseWireContract.e2e.test.ts 能站住的全部理由。
//
// ── boot epoch 在线上的两个落点（本文件的核心决定）─────────────────────────────
// 缺陷：ScoutEventBus 的 nextId 是进程内变量，daemon 重启后从 1 重数；前端 lastSeenId 只
// 单调上升，于是把重启后的**全部**新事件当旧的丢掉。页面不报错、连接是通的、状态显示
// "已连接"，但永远不再更新——最坏的那种失败。
//
// 修法是给事件编号配一个 **boot epoch**（ScoutEventBus.bootId，进程启动即生成）。它必须
// 出现在两个地方，缺一不可：
//
//  ① **SSE 的 `id:` 行**写成 `<bootId>:<seq>`（W3C 说 last event ID 是**不透明字符串**，
//     不要求是数字——见 html.spec.whatwg.org 的 "last event ID string"）。
//     为什么非这样不可：浏览器**原生**重连会自动把它上次见过的 `id:` 原样放进
//     `Last-Event-ID` 请求头，而**前端代码碰不到这个头**（W3C 不暴露）。如果 id 只是个
//     裸数字，重启后的新进程收到 `Last-Event-ID: 42` 就会 replay(>42)，把自己刚发的 1..42
//     全部跳过——**服务端这一半的静默失聪，光靠改前端是修不掉的**。
//     把 epoch 编进 id 里，这个头就自带 epoch，零额外帧、零额外请求。
//
//  ② **连接建立时的一条 `hello` 帧**（helloFrame）。为什么还需要它：①解决的是服务端
//     replay 起点，而前端那侧的 `lastSeenId` 去重门**看不到 `id:` 行**（EventSource 只把
//     `data` 交出来）。前端必须从别处知道"对面换了一个进程，你攒的 42 作废了"。
//     hello 是**每条连接一次**，不是每条事件一次——后者会给每秒一条的 progress 热路径加
//     一份纯冗余载荷（bootId 在一条连接的生命周期里恒定，重复发 N 次不多给一个比特的信息）。
//
// ── 为什么不是"后端 id 持久化到 meta 表"（方案 B，否掉）────────────────────────
// 那给每条事件加一次写库，而 SSE 事件是**瞬时**的（ScoutCurrent 的头注释已经为同一件事
// 否过一次 meta 表：「拿磁盘换一个进程重启就该归零的值」）。而且它只让 id 不重号，
// 并不能让前端知道"缓冲已经空了"——重启后 replay 缓冲是空的，客户端拿着 id=99999 连上来，
// 服务端诚实地给它 0 条，页面照样一片死寂，只是不再"丢事件"而已。epoch 才是那个能让
// 双方对齐"我们说的是不是同一段历史"的东西。

/** 连接建立时那条一次性帧的事件名。**前端 eventsBus.ts 里有一份同名常量**（web/ 是独立
 *  tsconfig 工程，跨工程 import 会把 node 侧类型面拖进浏览器工程，同 web/src/events/types.ts
 *  手抄后端类型的既有处置）。两份是否一致由 sseWireContract.e2e.test.ts 用**本常量**造帧、
 *  喂给**真实前端**来证明——不是靠注释里互相承诺。 */
export const HELLO_EVENT = 'hello'

/** hello 帧的载荷。字段非可选（`| null` 而不是 `?`）：要 JSON.stringify 给前端，
 *  undefined 会让字段整个消失，前端就分不清"这次没有 bootId"和"这版后端还没这个字段"
 *  （同 ScoutCurrent / HealthRootDTO 的既有论证）。 */
export interface SseHello {
  bootId: string
}

/** 客户端报上来的续传断点（请求头 `Last-Event-ID` 或 query `?lastEventId=`）。 */
export interface ResumeToken {
  /** 这个断点属于**哪一次进程启动**。`null` = 客户端没报（裸数字形式）。 */
  bootId: string | null
  /** 序号。非法/缺席 → 0（= 补发缓冲里全部，最多 REPLAY_BUFFER_CAP 条，不会失控）。 */
  seq: number
}

/**
 * 生成一次启动的 epoch。
 *
 * 判据只有一条：**同一进程内恒定，跨进程重启必不同**。不需要全局唯一、不需要密码学强度、
 * 不落库（落库就等于回到方案 B 的那笔账）。故时间戳 + 随机后缀足矣——时间戳让它在日志里
 * 可读（能一眼看出是哪次启动），随机后缀盖住"同一毫秒内重启两次"这个理论缺口。
 *
 * ⚠️ **不用 `crypto.randomUUID()`**：那会给本文件引入一个运行时依赖，而本文件必须保持
 * 零依赖才能被 web/ 的端到端用例直接 import（见文件头「为什么单独一个文件」）。
 *
 * 时钟与随机源都从参数进（同本仓各处 `now: () => number` 的既有惯例）：不注入就没法在用例里
 * 造出"两次启动"这个前提，而那正是本次修复要锁的全部内容。
 */
export function makeBootId(
  now: () => number = () => Date.now(),
  rand: () => number = Math.random,
): string {
  const t = now().toString(36)
  // 取小数部分的 36 进制若干位。**不含 `:`**——`:` 是 formatEventId 的分隔符，
  // bootId 里混进它会让 parseResumeToken 切错位（parseResumeToken 用 lastIndexOf 兜住了
  // 这种情况，但源头不产生它更省心）。
  const r = Math.floor(rand() * 0x7fffffff).toString(36)
  return `${t}-${r}`
}

/**
 * SSE `id:` 行的值：`<bootId>:<seq>`。
 *
 * 见文件头①。注意**只有 `id:` 行是复合的**——`data` 里那个 JSON 的 `id` 字段仍然是
 * 纯数字（前端的去重门读的是它，而"事件的序号"本来就该是个数）。两者不是重复：
 * 一个是**传输层**的续传游标（要跨进程自证身份），一个是**载荷**里的业务序号。
 */
export function formatEventId(bootId: string, seq: number): string {
  return `${bootId}:${seq}`
}

/**
 * 解析客户端报上来的断点。接受两种形式：
 *  · `"<bootId>:<seq>"` —— 本版前端与本版后端发出的 `id:` 行（浏览器原样回传）。
 *  · `"<seq>"` —— 裸数字。**必须继续接受**：`?lastEventId=3` 是本端点既有的公开形状
 *    （eventStream.test.ts 里有用例锁着），而且旧版前端的 tab 不会因为后端升级就自己关掉。
 *    此时 bootId 报 `null`（= 不知道属于哪次启动），由 resolveReplayFrom 决定怎么处置。
 *
 * 非法输入（空、NaN、负数）→ `{ bootId: null, seq: 0 }`，即"从缓冲头补发"。
 * 这条兜底是有意的：断点读不懂时**多补几条**（前端会按 id 去重）远好过**少补几条**
 * （少补 = 静默丢事件，正是本次要修的病）。
 */
export function parseResumeToken(raw: string | null | undefined): ResumeToken {
  if (raw == null || raw === '') return { bootId: null, seq: 0 }
  // lastIndexOf 而不是 split(':')[0]：bootId 理论上可以含 `:`（不是我们生成的，但客户端
  // 什么都可能报上来），从右边切才不会把它拦腰截断。
  const cut = raw.lastIndexOf(':')
  const bootId = cut >= 0 ? raw.slice(0, cut) : null
  const seqRaw = cut >= 0 ? raw.slice(cut + 1) : raw
  const seq = Number(seqRaw)
  if (!Number.isFinite(seq) || seq <= 0) return { bootId: bootId === '' ? null : bootId, seq: 0 }
  return { bootId: bootId === '' ? null : bootId, seq }
}

/**
 * **本次修复的服务端落点**：这条连接该从哪个 id 之后开始补发。
 *
 * 三支：
 *  ① `token.bootId === currentBootId` → 信它的 seq。同一次启动内的正常续传。
 *  ② `token.bootId !== null && token.bootId !== currentBootId` → **0**（补发全部缓冲）。
 *     这就是修复：客户端攥着的是**上一个进程**的号段，拿它当起点会把新进程刚发的
 *     1..seq 全部跳过——服务端这一半的静默失聪。
 *  ③ `token.bootId === null`（裸数字）→ 信它的 seq。
 *     **为什么不一并归 0**：那会把 eventStream.test.ts 既有的 `?lastEventId=1` 语义改掉
 *     （"只补 id>1 的"变成"全补"），而那条语义是这个端点的公开契约。裸数字来自
 *     "没有 epoch 概念"的客户端，我们没有依据判它跨没跨进程——**按它说的办**是诚实的，
 *     猜一个"大概重启了"不是。本版前端一旦收到过 hello 就必定报复合形式（见
 *     eventsBus.ts 的 eventsUrl），所以③在本版前后端之间不会走到。
 */
export function resolveReplayFrom(token: ResumeToken, currentBootId: string): number {
  if (token.bootId !== null && token.bootId !== currentBootId) return 0
  return token.seq
}

/** 连接建立时的一次性 hello 帧。**不带 `id:` 行**——它不是事件、不占号，带 id 会污染
 *  浏览器维护的 Last-Event-ID（下次原生重连就会拿一个不存在的号去续传）。 */
export function helloFrame(bootId: string): string {
  const payload: SseHello = { bootId }
  return `event: ${HELLO_EVENT}\ndata: ${JSON.stringify(payload)}\n\n`
}

/** 一条事件的完整 SSE 帧。`id:` 走复合形式（见 formatEventId），`data` 是事件原文。 */
export function eventFrame(bootId: string, e: { id: number; type: string }): string {
  return `id: ${formatEventId(bootId, e.id)}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
}
