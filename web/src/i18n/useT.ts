// web/src/i18n/useT.ts：薄 i18n hook——Context 存当前语言，localStorage 持久化，默认按
// navigator.language 猜（zh 开头→zh，否则 en）。故意不做插值/复数等重活：dashboard 文案都是
// 整句平铺 key，复杂度留给真正需要时再加。
import {
  createContext, createElement, useCallback, useContext, useMemo, useState, type ReactNode,
} from 'react'
import { en } from './en.js'
import { zh } from './zh.js'

export type Lang = 'en' | 'zh'
export type TKey = keyof typeof en

const STORAGE_KEY = 'scout-lang'
const TABLES: Record<Lang, Record<TKey, string>> = { en, zh }

function detectDefaultLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  return nav?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function readStoredLang(): Lang | null {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null
    return v === 'en' || v === 'zh' ? v : null
  } catch {
    // localStorage 不可用（隐私模式/SSR）时静默降级到探测值，不炸整个 app。
    return null
  }
}

interface I18nContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: TKey) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children, initialLang }: { children: ReactNode; initialLang?: Lang }) {
  // initialLang 是显式注入的初始语言，优先级高于 localStorage 与 navigator 探测——供测试锁定
  // 语言用（jsdom 下 window.localStorage 拿不到，靠环境 navigator.language 的话语言会变成隐式
  // 环境依赖）。生产不传这个参数，行为与此前逐字节一致：localStorage ?? navigator 探测。
  const [lang, setLangState] = useState<Lang>(() => initialLang ?? readStoredLang() ?? detectDefaultLang())

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
      // 同步写 cookie 供 demo worker 读取（demo 顶条语言需与 UI 同步，2026-09-01）
      document.cookie = `lang=${next}; path=/; max-age=31536000; SameSite=Lax`
      // demo 顶条在浏览器里解析语言（banner.ts 客户端脚本监听此事件实时跟随切换，无需刷新）。
      // 真实 dashboard 无监听者，派发无副作用；window 事件是跨（SPA / worker 注入脚本）边界
      // 的干净同标签页信号——localStorage 的 'storage' 事件同标签页不触发，故需自派发。
      window.dispatchEvent(new CustomEvent('scout:lang', { detail: next }))
    } catch {
      // 同上：存不了就算了，内存态仍然生效。
    }
  }, [])

  const t = useCallback((key: TKey) => TABLES[lang][key], [lang])

  const value = useMemo<I18nContextValue>(() => ({ lang, setLang, t }), [lang, setLang, t])

  // 纯 .ts 文件（非 .tsx）——用 createElement 而不是 JSX 语法，避免为这一个 Provider 组件
  // 单独开一个 .tsx 文件。
  return createElement(I18nContext.Provider, { value }, children)
}

export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useT() 必须包在 <I18nProvider> 内使用')
  return ctx
}
