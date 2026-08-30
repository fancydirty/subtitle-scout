// web/src/workbench/ActivityTicker.tsx —— 活动卡 ticker 单行：脉冲点 + 一句「正在做什么」。
//
// props 收 raw (tool, object)，组件内部调 tickerPhrase + useT 拼 `{t(key)}{obj? ' '+obj : ''}`。
// ⚠️ 这**不违反** RunCard「stepLabel 必须已是译文、禁塞 raw tool id」那条纪律：那里说的是
// 不许把 raw tool 字符串画上屏幕，而这里 tickerPhrase 走的是词表翻译（tool → wb_ticker_*/
// wb_step_* 键，未知工具落 wb_step_working），吐出去的永远是译文，不是 raw id。组件内翻译
// 这条形态更自洽——testid 好断言，且降级逻辑（obj 缺失落 step 键）与拼句同处一地。
//
// tool 为 null（无正在进行的动作）→ 返回 null，ticker 不占屏。
import { useT } from '../i18n/useT.js'
import { tickerPhrase } from './tickerPhrase.js'

export function ActivityTicker({ tool, object }: { tool: string | null; object: string | null }) {
  const { t } = useT()
  if (!tool) return null

  const { key, obj } = tickerPhrase(tool, object)
  // obj 在场（tickerPhrase 已 trim 过、只有非空才带出来）→ 短语后接对象；否则只出降级整句。
  const text = obj ? `${t(key)} ${obj}` : t(key)

  return (
    <div className="wb-ticker" data-testid="wb-ticker">
      {/* 脉冲点：纯装饰（文案自己把话说全），aria-hidden 免读屏器空念一个点。 */}
      <span className="wb-ticker-dot" aria-hidden="true" />
      <span className="wb-ticker-text">{text}</span>
    </div>
  )
}
