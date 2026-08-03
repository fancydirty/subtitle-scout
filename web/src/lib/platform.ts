// 苹果平台探测。两个消费方：Kbd（mod → ⌘ 还是 Ctrl 的字形）与 Task 9 的 useHotkeys
// （mod → metaKey 还是 ctrlKey）。抽出来是为了两处判定永远一致——一处判成 Mac、
// 另一处判成 Windows 会让"界面上写 ⌘K，按 ⌘K 没反应"这种最难查的 bug 成为可能。
//
// Astryx 的 Kbd 用 useSyncExternalStore 订阅平台变化（src/Kbd/Kbd.tsx）。这里不订阅：
// 运行中的浏览器不会换操作系统，那层订阅在本仓是纯开销。
//
// navigator.platform 已被标记为 deprecated 但所有浏览器仍实现；userAgentData.platform
// 是替代品（Chromium 系有，Safari/Firefox 没有），所以两个都读，优先新的。
// jsdom 里 navigator.platform 是空串 → 返回 false → 测试里 mod 显示为 Ctrl，这是预期的。
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  // 用 || 不用 ??：缩减 UA 的 Chromium 会把 userAgentData.platform 报成空串，
  // ?? 只在 null/undefined 时穿透，空串会挡住向 navigator.platform 的回退。
  const platform = nav.userAgentData?.platform || nav.platform || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}
