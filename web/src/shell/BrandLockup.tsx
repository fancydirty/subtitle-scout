// web/src/shell/BrandLockup.tsx：侧栏品牌 lockup（2026-08-31 B2 品牌落位随行件）。
// 2026-08-31 v2（用户裁决"全部保持可爱鸟本尊，不要两套形象"）：几何重绘小标退役，
// 直接用吉祥物本尊紧裁图（/favicon.png，64²，vite publicDir 静态件，与浏览器 tab 同源同图）。
// - 字标 = mono 大写 + 0.14em 字距：沿用 auth-shell__wordmark 确立的终端 DNA（styles.css:933），
//   与全中文 sans 的 nav 行形成品牌行/导航行的质感分层。**不引 webfont**（styles.css 铁律）。
// - 文案仍取 t('brand_name')（i18n 契约：中文界面沿用英文 wordmark，见 i18n.test.ts）。
import { useT } from '../i18n/useT.js'

/** B2 吉祥物本尊小图（favicon 同源）。rounded 让蓝灰底图在暗侧栏里成为一枚干净的 app 图标。 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <img
      src="/favicon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      className="rounded-[6px]"
    />
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
