// web/src/workbench/displayTitle.ts —— 在跑卡/通知英雄用 scout-lang 选片名（spec §10.2）。
// zh → chineseTitle ?? title；en → title。空字符串按 ?? 字面：会显示空，不额外归一。
import type { Lang } from '../i18n/useT.js'

export function displayTitle(
  lang: Lang,
  title: string,
  chineseTitle: string | null,
): string {
  return lang === 'zh' ? (chineseTitle ?? title) : title
}
