// web/src/activity/stage.ts：活动页阶段进度条的纯函数层——零 DOM、零 React、零依赖。
//
// 这条进度条表示的不是"装了几集/共几集"，而是 **agent 这轮工作走到哪个阶段**。
// 这个语义选择把「多季/单季/几集」的麻烦整个从 UI 层消掉了：找 1 季还是 10 季，
// 条的含义完全一样，因为条读的是工具序列的深度，不是工作量的分母。
//
// 铁律②（界面不显示百分比数字）在本模块的落地方式：这里返回的数字只有一个消费者——
// CSS 的条宽。本模块因此**刻意不导出任何格式化函数**（没有 formatPercent 之类）。
// 谁想把数字打到界面上，得先自己写格式化，那一刻违规是显式的、能在 review 里看见的。

/** 工具名 → 该阶段的条宽（百分比数值，仅供 CSS width 用）。
 *
 *  工具名取自真实注册表，不是凭空拟的：
 *   - findSubtitleWorker.ts 的 tools 对象（read_doc / search_source / list_candidates /
 *     get_candidate / download_candidate / install_subtitle / check_episode_code_safety）
 *   - tmdbTools.ts 的 search_tmdb / get_tmdb_details（经 makeTmdbEvidenceTools 挂上）
 *   - identityTools.ts 的 write_identified_media
 *   - reasoningAgent.ts 的 FINALIZE_TOOL_NAME = 'finalize'（由 agent 循环注入，不在 worker
 *     的 tools 里，但模型确实会调它，且它就是终止条件——所以它是 100）
 *
 *  在此表中但值为 null 的工具 = **不推进阶段但仍进传送带**：read_doc 是查文档，
 *  check_episode_code_safety 是一次校验，两者都可能在任何阶段发生，让它们推进阶段
 *  会让条的位置失去意义。 */
const STAGE_BY_TOOL: Readonly<Record<string, number | null>> = {
  // 在认片子
  search_tmdb: 14,
  get_tmdb_details: 14,
  write_identified_media: 14,
  // 在搜来源
  search_source: 22,
  // 在核对候选
  list_candidates: 44,
  get_candidate: 44,
  // 在下载
  download_candidate: 66,
  // 在装到位
  install_subtitle: 88,
  // 收尾
  finalize: 100,
  // 不推进阶段，但仍然是"在干活"的证据，照样进传送带
  read_doc: null,
  check_episode_code_safety: null,
}

/** 起手值：run 已经开始但还没有任何工具事件到达。不是 0——0 看起来像"卡住了/没启动"，
 *  而此时 agent 确实已经在跑（在读 prompt、在想第一步）。 */
export const STAGE_START = 6

/** 工具名 → 条宽百分比。未推进阶段返回 null。
 *
 *  **兜底分支是本函数的核心契约**：未登记的工具名返回 null（= 不推进），而不是 undefined、
 *  也不抛错。理由：工具表会随后端演进——本 spec 的初稿就漏了 search_tmdb /
 *  get_tmdb_details / write_identified_media 这三个识别工具，而它们早已在跑。未来新增的
 *  工具必然**先于 UI 更新到达**前端。此时正确的行为是诚实降级：进度条停在原处（不假装
 *  推进，也不倒退），传送带照常显示该行（用户看得见 agent 在干一件 UI 还不认识的活）。
 *  抛错会让整条 hero 白屏，返回 undefined 会让下游 `?? 0` 之外的算术静默变成 NaN。 */
export function stageOf(tool: string): number | null {
  // Object.prototype 上的名字（'toString'、'constructor' …）不算登记项——用 hasOwn 而不是
  // `in`/直接取值，否则 stageOf('toString') 会拿到一个函数。
  if (!Object.prototype.hasOwnProperty.call(STAGE_BY_TOOL, tool)) return null
  return STAGE_BY_TOOL[tool]
}

/** 单调不倒退的 reducer：只取「到达过的最远阶段」。
 *
 *  为什么必须单调：agent 反复搜多个来源时会回到 search_source（22），如果条跟着回退，
 *  用户会以为出了问题。多来源搜索因此表现为 **条停在 22% 但传送带在动** —— 这个组合
 *  恰好准确描述了真实情况：阶段进度没变，但确实在干活。
 *
 *  未登记工具与 read_doc 之类走 `?? 0`，即"不参与 max"——current 原样返回。 */
export function advanceStage(current: number, tool: string): number {
  return Math.max(current, stageOf(tool) ?? 0)
}

/** 从一串工具事件算出最终条宽。空列表 = run 刚起手，返回 STAGE_START。
 *  入参只要求有 tool 字段，本层因此不依赖 TraceEvent 的完整形状。 */
export function stageFromTrail(events: readonly { tool: string }[]): number {
  return events.reduce((acc, e) => advanceStage(acc, e.tool), STAGE_START)
}

/** 进度条的三种表现形态。 */
export type StageMode = 'staged' | 'indeterminate' | 'hidden'

/** taskType → 进度条形态。
 *
 *  四种真实取值已核实：orchestratorAgent.tools.ts（'find_subtitle' ×2、'orchestrate'、
 *  'realign'）、realignWorkerTask.ts:6（'realign'）、translateWorkerTask.ts:98（'translate'）。
 *
 *  - find_subtitle → staged：上面那张阶段表就是为它调研的
 *  - realign / translate → indeterminate：这两族的工具序列本 spec **未调研**。凭空给权重
 *    就是编造，违反「阶段是观测到的」这个前提。不定态细条 + 传送带照常，表达"在干活"
 *    而不谎报"走到哪了"
 *  - orchestrate → hidden：编排层属铁律③要隐藏的机械，不进 hero
 *  - 其他 / null → indeterminate：保守兜底。新 taskType 同样会先于 UI 到达 */
export function stageModeOf(taskType: string | null): StageMode {
  switch (taskType) {
    case 'find_subtitle': return 'staged'
    case 'orchestrate': return 'hidden'
    case 'realign':
    case 'translate': return 'indeterminate'
    default: return 'indeterminate'
  }
}
