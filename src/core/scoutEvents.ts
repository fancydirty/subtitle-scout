// src/core/scoutEvents.ts —— R-F10 的事件总线：daemon 产、dashboard SSE 端点消费。
//
// ── 为什么存在（R-F10 用户裁决）────────────────────────────────────────────────
// 用户原话：「对用户而言有必要推的事件才推，而非事无巨细」。据此从现有 30 条 daemon 日志里
// 筛出 4 类进 SSE：activity / found / health / progress（清单与逐条判据见
// docs/design/2026-08-11-FRONTEND-SPEC.md §六·六）。
//
// **把系统的辛苦展示给用户看是反效果**——用户要的是"找到了什么"，不是"我跑了多少次
// ffprobe"。故 probe wrote=N 统计、`回填: xxx ok=N`、`judge: 判定 N 个文件`、trace 修剪、
// 清理写探针、各种"（隔离，下轮重试）"的单文件错误**一律不进这条通道**，它们的去处是
// doctor 按钮 + 日志文件。这条纪律的执行点不在这个文件里，而在**发布方**（daemonV2 只在
// 4 类事件对应的位置调 emit）——总线本身只认类型，不做内容审查。反例锁在
// daemonV2.events.test.ts（拿真实日志形态做反证）。
//
// ── 为什么是显式 emit 而不是解析 log 字符串（设计选择 A）─────────────────────────
// 备选方案是在 cli/index.ts 那个共享 log 函数里做模式匹配。否掉的理由：那是在解析自己刚
// 打印出来的字符串，日志文案一改事件就**静默**失效——而本仓已经栽过多次"日志文案与实际
// 口径不符"。显式 emit 的漏接同样静默，但它至少能被 watchWiring.test.ts 的接线断言与
// daemonV2 走 run() 的端到端用例钉住（本仓栽过 6 次"有表有函数但没人触发"，见 C12→C35→
// C43→C21→audio_langs→tmdb_seasons）。
//
// ── 为什么放 src/core/（设计选择 B）──────────────────────────────────────────
// daemon（src/v2）产、dashboard（src/dashboard）消费，两者都在 cmdWatch 一个进程里。放任一
// 侧都会造成反向依赖；src/core 是既有的中立层，而且**同型先例就在隔壁**——traceBus.ts
// （痕迹通道 C）是同一个形状的进程内总线。刻意照它的形状写（订阅集合 + 环形缓冲 + 订阅者
// 回调抛错必须吞），但**不复用它**：traceBus 的载荷是 agent 工具调用（runKey/tool/args），
// 语义、粒度、消费者全都不同，塞在一起会让"该不该推给用户"这条判据无处安放。

/** R-F10 的四类事件。类型集合是**封闭**的——新增一类必须回到 FRONTEND-SPEC §六·六 走
 *  同一条判据（"站在用户视角问：我需要知道吗"），而不是就地加个字符串。 */
export type ScoutEventType =
  /** 工作台状态变化：开始处理某作品 / 队列变化 / 巡检开始与结束。 */
  | 'activity'
  /** 找到并装上了字幕（通知页的数据源）。 */
  | 'found'
  /** 异常：守备目录读取失败、R8/C47 拦截、provider 全挂。**只收"我的库可能有问题"这一档**，
   *  单文件抖动（会自愈）不算。 */
  | 'health'
  /** 正在处理的那个作品的进度（第 3/8 集）——唯一的高频事件，故唯一被节流。 */
  | 'progress'

/** 三个工作台。**封闭三态**，与 §3.5 的 `current.kind` 同集合——它描述的就是"哪个工作台"，
 *  而不是"事件从哪一行代码发出来的"。想给巡检级/扫描级事件找个位置的冲动请忍住：
 *  加 `'inspect'|'scan'` 会把它变成五态，`current.kind` 那侧就再也对不上了。 */
export type ScoutWorkbench = 'identify' | 'subtitle' | 'translate'

/** 发布方给的部分（id/at 由总线补齐——发布方自己编 id 就会与续传的单调性打架）。 */
export interface ScoutEventInput {
  type: ScoutEventType
  /** 给人看的一句话（前端直接渲染，不在浏览器里二次拼装）。 */
  message: string
  /** 作品标题（有则给，通知页/活动页按它分组）。 */
  title?: string
  /**
   * 这条事件属于哪个工作台。**可选，而且必须可选**（不是偷懒）：
   * daemonV2 的 13 个 emit 点里有 6 个**不属于任何工作台**——巡检开始/完成/失败是巡检级，
   * 阶段 1 扫描的三条 health 是扫描级。给它们编一个 `'identify'` 是在事件流里撒谎，
   * 而为它们扩类型又会把三态撑成五态（见 ScoutWorkbench 的注释）。
   *
   * 故判别口径是 **`workbench !== undefined`**，不是"哪个值"：
   * 有值 → 工作台级，前端按值分三路（subtitle/translate 进两 tab，identify 进顶部状态条）；
   * 无值 → 巡检/扫描级，前端走全局横幅那条，**不进任何 tab**。
   * 前端千万不要写 `?? 'identify'` 之类的兜底——那会把巡检级事件混进识别状态条。
   */
  workbench?: ScoutWorkbench
  /** 结构化补充（进度的 done/total 之类）。前端可选消费，缺席不影响 message 的可读性。 */
  data?: Record<string, unknown>
}

/**
 * 「当前在处理什么」的**快照**（不是变化）。
 *
 * ── 为什么需要它（设计文档审计 F-6）──
 * SSE 的 activity 事件是**变化**：断线期间巡检跑完、50 槽缓冲又被 progress 冲掉，重连后
 * replay 里既没有"正在处理 X"也没有"巡检完成"，前端于是永远停在上一次看到的那句
 * "正在处理 X"。变化流无法自证当前态，必须有一个可随时查询的快照与它并列。
 *
 * ── 为什么挂在总线上而不是落 meta 表 / 注入 daemon holder ──
 * · holder 注入否掉：cli/index.ts 里 dashboard（:662 拿到 events）比 daemon（:745 才 new）
 *   先构造，dashboard 手上根本没有 daemon 引用可注入。
 * · meta 表否掉：meta 至今**没有任何读写封装**，全是散落裸 SQL；为一个每秒可能变几次的
 *   内存态开一条落盘通道，是拿磁盘换一个进程重启就该归零的值。
 * · 挂总线**零新增连线**：写入点 = 已有的 13 个 emit，触发点 = publish 本身，
 *   读取点 = /api/v2/health。没有任何一方需要多认识一个对象。
 *
 * 字段一律 `| null` 而不是可选：这东西会被 JSON.stringify 送给前端，undefined 会让字段
 * **整个消失**，前端就分不清"没在处理"和"这版后端还没这个字段"。
 */
export interface ScoutCurrent {
  /** 哪个工作台在忙。取自事件的 `workbench`——**不是**从 message 里猜的。 */
  kind: ScoutWorkbench
  /** 正在处理的作品标题。事件没带 title 时是 null（不编一个）。 */
  title: string | null
  /** 队列里的第几个（progress 的 `data.done`）。只有 progress 带得出，故 activity 之后、
   *  配对的 progress 之前会是 null——**这是诚实的 null，不是缺陷**。 */
  index: number | null
  /** 队列总长（progress 的 `data.total`）。 */
  total: number | null
}

export interface ScoutEvent extends ScoutEventInput {
  /** 单调递增，从 1 起。SSE 的 `id:` 字段与浏览器 `Last-Event-ID` 续传就靠它。
   *  **被节流折叠掉的事件不占号**：占号的话重连补发会看到 id 空洞，客户端无从判断那是
   *  "被丢了"还是"根本没发生过"。 */
  id: number
  at: number
}

/** progress 的节流窗口（R-F10 约束 2：每秒最多 1 条）。
 *  为什么只节流 progress：一部剧 24 集逐集完成会在几分钟内连发 24 条，而其余三类天然低频
 *  （巡检一天一次、found 一集一条、health 是异常）。对低频事件加节流只会制造"事件丢了"
 *  的排障疑云，没有任何收益。
 *
 *  **窗口是 per-workbench 的，不是全局的**（见 ScoutEventBus.lastProgressAt 的注释）。 */
export const PROGRESS_THROTTLE_MS = 1000

/** 续传环形缓冲的容量。
 *  为什么 50 够：这条缓冲**只服务"手机锁屏 30 秒再打开"这一档断线重连**，不是账目
 *  （账目在 runs 表与日志文件里）。50 条约等于一次巡检里十几个作品的活动量；再大只是让
 *  重连瞬间往前端灌一屏它并不需要的陈年事件，还把常驻内存抬上去。 */
export const REPLAY_BUFFER_CAP = 50

export interface ScoutEventBusOpts {
  /** 测试注入时钟。**必须可注入**：节流测试真睡 1 秒会把用例时长押在 wall clock 上
   *  （同 DaemonV2Deps.sleep 的既有论证——真等还会诱使后来人调小窗口来"救测试"）。 */
  now?: () => number
}

/**
 * 进程内事件总线。**不是单例**（与 traceBus 的模块级单例刻意不同）：单例会让并行跑的测试
 * 互相串事件，而这条通道的每一条用例都在数"收到几条"。cmdWatch 里 new 一个，
 * 同时喂给 daemon（emit）与 dashboard（startDashboard 的 events 参数）。
 */
export class ScoutEventBus {
  private readonly nowFn: () => number
  private readonly subscribers = new Set<(e: ScoutEvent) => void>()
  private readonly buffer: ScoutEvent[] = []
  private nextId = 1
  /**
   * 上一条**放行**的 progress 的时刻（不是上一次尝试的时刻——否则连续尝试会把窗口
   * 无限往后顶，一条都发不出去），**按工作台各记一个**。
   *
   * ── 为什么不是全局单标量（原实现）──
   * 三个工作台共用一个 1 秒窗口，则阶段切换的那一秒里，谁先发谁把对方挤掉：字幕台刚
   * 发完 `3/47`，翻译台紧接着的 `1/12` 就被静默折叠。前端于是只看得见其中一路在动，
   * 另一路"卡住不动"——而它其实正在跑。节流的本意是"同一个高频源别刷屏"，不是
   * "三条互不相干的进度条互相抢名额"。
   *
   * ── key 为什么是 `ScoutWorkbench | undefined`，undefined 不与任何工作台合并 ──
   * 无 workbench 的 progress 是巡检/扫描级（当前生产没有这样的点，但类型允许），
   * 它与工作台进度不是同一路条，合并进任何一个工作台的窗口都会重演上面那笔账。
   * 故它自成一路（Map 的 key 直接用 undefined，不做归一化）。
   *
   * 用 Map 而不是三个字段：三态是封闭的，但写成三个字段会让"新增一个工作台"变成
   * 改三处；而且 undefined 这一路根本没法当字段名。
   */
  private readonly lastProgressAt = new Map<ScoutWorkbench | undefined, number>()

  /**
   * 「现在在处理什么」的快照。见 ScoutCurrent 的头注释（为什么它必须与事件流并列存在）。
   *
   * ── 谁写它：本类的 updateCurrent，唯一入口是 publish（= 已有的 13 个 emit 点）。
   * ── 谁读它：getCurrent()（Task ⑤ 的 /api/v2/health）。
   * ── 何时清空：见 updateCurrent 里 `workbench === undefined` 那一支的论证。
   */
  private current: ScoutCurrent | null = null

  constructor(opts: ScoutEventBusOpts = {}) {
    this.nowFn = opts.now ?? (() => Date.now())
  }

  /**
   * 依据一条事件推进 / 清空 current。**自带 try/catch**（不是靠 publish 那层兜）：
   * 快照是增益，它算错了顶多 /health 显示不准，绝不许因此让这条事件推不出去——外层那个
   * catch 是在 broadcast **之前**兜住的，一旦被它接住订阅者就一条都收不到了。
   *
   * ── 判别口径复用既有的那条：`workbench !== undefined` ──
   * 有 workbench = 工作台级 → 它描述"某个台在处理某个作品"，推进快照。
   * 无 workbench = 巡检级/扫描级（生产里正好 6 个点：巡检开始 / 巡检完成 / 巡检失败 +
   *   阶段 1 扫描的三条 health）→ **清空**。
   *
   * ── 为什么"清空"这件事恰好能被这条口径覆盖（本 task 的核心判断）──
   * 要解决的缺陷是"巡检跑完了前端还停在正在处理 X"。巡检的三种结局各发一条无 workbench
   * 的事件：完成（activity）、失败（health）、以及下一轮的开始（activity）。三条都清空，
   * 于是 current 在"没有任何工作台在跑"的全部时段里都是 null。
   * **这不需要 daemon 配合、不新增任何连线**——这 6 个 emit 点在 Task ⓪ 之前就存在，
   * 本改动一行 daemonV2 都没碰。
   *
   * 阶段 1 那三条扫描级 health 也会清空：它们发生在巡检开头，此刻 current 已被"巡检开始"
   * 清成 null，再清一次是幂等的 no-op，不是误伤。
   *
   * ── found 为什么不动 current ──
   * found 是**成果**（"装上了 3 条"），不是**状态**（"正在处理谁"）。拿它推进快照会让
   * /health 把一条已经结束的活报成"正在处理"；拿它清空则会在同一个作品还要继续的中途
   * 把状态条打空。成果的去处是通知页，不是状态快照。
   */
  private updateCurrent(input: ScoutEventInput): void {
    try {
      if (input.workbench === undefined) {
        this.current = null
        return
      }
      if (input.type === 'activity') {
        // 新作品开工：index/total 归 null 而不是留着上一条的——留着就是拿甲剧的
        // "第 3/47 个"去描述乙剧，正是本仓的病 B（把中间量说成结论量）。
        this.current = { kind: input.workbench, title: input.title ?? null, index: null, total: null }
        return
      }
      if (input.type === 'progress') {
        // done/total 走 `data`（daemonV2 的两个 progress 点都填 `{ done, total }`）。
        // data 的类型是 Record<string, unknown>，故必须逐个验型：非有限数一律记 null，
        // **不做 Number() 强转**——把 undefined 转成 NaN 再报出去比报 null 更难排查。
        const d = input.data
        const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        this.current = {
          kind: input.workbench,
          title: input.title ?? null,
          index: num(d?.done),
          total: num(d?.total),
        }
      }
      // health（带 workbench，当前生产无此点）不动 current：它是异常播报，不是"在处理谁"。
    } catch {
      // 见方法头注释。宁可快照停在旧值，也不许连累这条事件的推送。
    }
  }

  /**
   * 「现在在处理什么」的当前快照，没有任何工作台在跑时为 null。
   *
   * **返回的是副本**：直接把内部对象交出去，调用方（/health 的 JSON 序列化路径）一改就
   * 改到了总线的内部状态，而这种串味在测试里几乎照不出来。
   */
  getCurrent(): ScoutCurrent | null {
    return this.current === null ? null : { ...this.current }
  }

  /**
   * 发布一条事件：节流门 → 编号 → 进缓冲 → 广播。
   *
   * **整体 try/catch，绝不向调用方抛错**：调用方是巡检主循环（daemonV2），口径与本仓
   * gcStaging / dbMaintenance / 各回填 pass 一致——推送是增益，SSE 挂了绝不能影响巡检。
   * 发布方那侧还会再包一层 `emit?.()` 的 try/catch（两道，与 daemonV2 既有的运维器官
   * 逐个包 catch 同理：一处失灵不许连坐）。
   */
  publish(input: ScoutEventInput): void {
    try {
      // 快照先于节流门推进：节流管的是**推送带宽**（别把 SSE 刷屏），而 current 是
      // 按需查询的，一次巡检里被读几次由前端决定，与事件频率无关。放在门后的话，被折叠
      // 的那 3/4 条 progress 也会把快照一起折叠掉——而这个快照的存在意义恰恰是
      // "断线/丢事件时仍能问出真实当前态"，让它跟着丢是自废武功。
      this.updateCurrent(input)
      const at = this.nowFn()
      if (input.type === 'progress') {
        // 未记录过 → 视为 -Infinity（第一条无条件放行）。注意 Map 里可能存着 0
        // （注入时钟从 0 起的测试），故必须用 `?? -Infinity` 而不是 `|| -Infinity`。
        const last = this.lastProgressAt.get(input.workbench) ?? -Infinity
        if (at - last < PROGRESS_THROTTLE_MS) return
        this.lastProgressAt.set(input.workbench, at)
      }
      const ev: ScoutEvent = { ...input, id: this.nextId++, at }
      this.buffer.push(ev)
      if (this.buffer.length > REPLAY_BUFFER_CAP) this.buffer.shift()
      for (const fn of this.subscribers) {
        try {
          fn(ev)
        } catch {
          // 吞掉——一个订阅者（= 一条快断的 SSE 连接）的异常不许打断 publish 本身，
          // 也不许波及其它订阅者。照 traceBus.publish 的既有口径。
        }
      }
    } catch {
      // 时钟/序列化之类的意外一律吞：见方法头注释（推送是增益，不许反噬巡检）。
    }
  }

  /** 订阅全部事件（按 type 过滤是订阅方自己的事）。返回退订函数。
   *  **调用方必须在连接关闭时调它**——不调就是长跑 daemon 上的真实内存泄漏
   *  （每次浏览器重连留一个死回调 + 它闭包里攥着的 ServerResponse）。 */
  subscribe(fn: (e: ScoutEvent) => void): () => void {
    this.subscribers.add(fn)
    return () => { this.subscribers.delete(fn) }
  }

  /** 当前订阅者数量——**为测试而导出**：只断言"退订后收不到"证明不了内部集合已经放手
   *  （一个恒 return 的回调同样收不到），而泄漏正是长跑 daemon 上会真出事的那一半。 */
  subscriberCount(): number {
    return this.subscribers.size
  }

  /** 续传：给出缓冲里 id 严格大于 lastEventId 的事件（升序）。
   *  lastEventId=0 → 给全部缓冲。离线太久（lastEventId 早于窗口）→ 同样只能给出缓冲里
   *  现存的这些，**不假装没漏**（这条通道从来不是账目，账目在 runs 表与日志文件里）。 */
  replay(lastEventId: number): ScoutEvent[] {
    return this.buffer.filter((e) => e.id > lastEventId)
  }
}
