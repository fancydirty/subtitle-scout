// web/src/lib/duration.ts：紧凑时长格式（30s / 1m / 2h / 3d）——**跨区共用的技术层读数**。
//
// ── 为什么它从 library/text.ts 搬到这里（Task ⑪）────────────────────────────
// 它原本长在 `library/text.ts` 里，而 `settings/text.ts:5` 一直在 import 它。Task ⑪ 把旧
// library 页面整体移入 `_legacy/`，于是那条边会变成 **live → _legacy 的编译期依赖**：
// 设置页（新导航四项之一，活着）依赖一个已下架目录里的模块。那样 `_legacy` 就永远删不掉——
// 删它会让设置页编译失败，而"跑稳后删 legacy"是设计文档 §2.2 明写的下一步。
//
// 依赖方向的铁律：**`_legacy/` 可以 import `lib/`（活的公共件），`lib/` 与任何活页面绝不
// import `_legacy/`**。把这个函数提到 lib/ 是让方向合法的唯一改法（另两个选项都更差：
// 在 settings/ 里复制一份 = 两处漂移；让 settings 继续指向 _legacy = 把下架卡死）。
//
// 语义原样搬运，一个字节没改（阶梯 s→m→h→d、单单位、负数钳到 0s）：
// 时长是技术层读数，两种语言下都用同一套单位字母，**不翻译**（DESIGN.md §3：mono 是
// 技术层专属声音）。需要本地化前后缀的调用方自己拼（settings/text.ts 的 addedAgoLabel 就是
// 那么做的），本函数只产出时长本身。

/** 紧凑时长：<60s → `30s`，<60m → `1m`，<24h → `2h`，其余 → `3d`。负数钳制到 `0s`。 */
export function formatDuration(deltaMs: number): string {
  const s = Math.max(0, Math.floor(deltaMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}
