// web/src/shell/BrandLockup.tsx：侧栏品牌 lockup（2026-08-31 B2 品牌落位随行件）。
// 设计裁决：
// - 小标 = favicon 的去底板变体（头剪影+呆毛+护目镜），24px；眼点比 favicon 压深一档
//   （#1a1d21 vs 头色）——favicon 在 16px 靠 tile 对比，这里 24px 裸放暗底，需要镜内反差。
// - 字标 = mono 大写 + 0.14em 字距：沿用 auth-shell__wordmark 确立的终端 DNA（styles.css:933），
//   与全中文 sans 的 nav 行形成品牌行/导航行的质感分层。**不引 webfont**（styles.css 铁律）。
// - 文案仍取 t('brand_name')（i18n 契约：中文界面沿用英文 wordmark，见 i18n.test.ts）。
import { useT } from '../i18n/useT.js'

/** B2 小标（无底板）：与 web/public/favicon.svg 同源几何，头色提亮一档适配裸暗底。 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="38" r="23" fill="#3b424b" />
      <circle cx="41" cy="13.5" r="4" fill="#3b424b" />
      <rect x="12" y="27" width="40" height="18" rx="9" fill="#a3e635" />
      <circle cx="24" cy="36" r="5.2" fill="#1a1d21" />
      <circle cx="40.5" cy="36" r="6" fill="#1a1d21" />
      <circle cx="26" cy="34.2" r="1.6" fill="#a3e635" />
      <circle cx="42.8" cy="33.6" r="1.9" fill="#a3e635" />
    </svg>
  )
}

export function BrandLockup() {
  const { t } = useT()
  return (
    <div className="flex items-center gap-2.5 px-3 py-1.5">
      <BrandMark />
      <span className="text-[12px] font-semibold uppercase tracking-[0.14em] leading-6 text-foreground [font-family:var(--font-mono)]">
        {t('brand_name')}
      </span>
    </div>
  )
}
