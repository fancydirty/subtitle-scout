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

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readStoredLang() ?? detectDefaultLang())

  const setLang = useCallback((next: Lang) => {
    setLangState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
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
