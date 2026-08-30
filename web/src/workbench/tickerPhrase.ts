// web/src/workbench/tickerPhrase.ts —— 活动卡 ticker 单行文案的纯函数。
// 职责：(tool, object) → {key, obj?}。带对象时用 wb_ticker_* 短语键并把对象随 obj 交出；
// 对象缺失（null/''/纯空白）或该阶段无 ticker 模板时，落回 stepActionKey 的旧 wb_step_* 且不带 obj。
//
// ⚠️ 为什么返回 {key, obj} 而不是拼好的整句：本仓 t() 是纯查表、不支持插值（i18n/useT.ts
// 头注释 + notif_episodes_suffix 的既有先例）。所以 wb_ticker_* 是「Searching for」这类可后接
// 对象的短语，由调用方（ActivityPage/ActivityTicker，Task 8/9）拼 `{t(key)} {obj}`——纯函数
// 不碰 i18n，与 stepActionKey 同一形态（ActivityPage 现在就是 t(stepActionKey(step))）。
import type { TKey } from '../i18n/useT.js'
import { stepActionKey } from './stepPhrase.js'

/** 主工具 → 带对象时的 ticker 短语键。不在表内的工具带对象也照旧走 step 键（不臆造模板）。 */
const TICKER: Record<string, TKey> = {
  search_source: 'wb_ticker_search', search_tmdb: 'wb_ticker_search',
  download_candidate: 'wb_ticker_download',
  get_candidate: 'wb_ticker_review', list_candidates: 'wb_ticker_review',
  install_subtitle: 'wb_ticker_install',
}

export function tickerPhrase(tool: string, object: string | null): { key: TKey; obj?: string } {
  const obj = object?.trim()
  const tickerKey = TICKER[tool]
  // 有对象 + 该工具有 ticker 模板 → 带对象的具体句。
  if (obj && tickerKey) return { key: tickerKey, obj }
  // 其余一律降级回旧 step 句，无 obj——object 缺失、或工具无 ticker 模板、或未知工具。
  // 复用 stepActionKey（内部走 stageOf），"未知工具→wb_step_working"这条兜底与 stepPhrase 同源。
  return { key: stepActionKey(tool) }
}
