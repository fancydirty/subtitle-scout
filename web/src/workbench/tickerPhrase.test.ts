import { describe, it, expect } from 'vitest'
import { tickerPhrase } from './tickerPhrase.js'

// ticker 单行文案：(tool, object) → {key, obj?}。
// object 在场 → wb_ticker_* 短语键 + obj（调用方拼 `{t(key)} {obj}`，因 t() 不支持插值）；
// object 缺失 → 落回 stepActionKey 的旧 wb_step_* 无 obj。

describe('tickerPhrase：带对象时用 wb_ticker_* + obj', () => {
  it('search_source + object → wb_ticker_search + obj', () => {
    expect(tickerPhrase('search_source', 'S01E32')).toEqual({ key: 'wb_ticker_search', obj: 'S01E32' })
  })
  it('search_tmdb + object → wb_ticker_search（同族并进搜索档）', () => {
    expect(tickerPhrase('search_tmdb', 'The Bear')).toEqual({ key: 'wb_ticker_search', obj: 'The Bear' })
  })
  it('download_candidate + object → wb_ticker_download', () => {
    expect(tickerPhrase('download_candidate', 'cand#3')).toEqual({ key: 'wb_ticker_download', obj: 'cand#3' })
  })
  it('get_candidate + object → wb_ticker_review', () => {
    expect(tickerPhrase('get_candidate', 'cand#3')).toEqual({ key: 'wb_ticker_review', obj: 'cand#3' })
  })
  it('list_candidates + object → wb_ticker_review', () => {
    expect(tickerPhrase('list_candidates', 'S01E32')).toEqual({ key: 'wb_ticker_review', obj: 'S01E32' })
  })
  it('install_subtitle + object → wb_ticker_install', () => {
    expect(tickerPhrase('install_subtitle', 'S01E32')).toEqual({ key: 'wb_ticker_install', obj: 'S01E32' })
  })
})

describe('tickerPhrase：object 缺失/空 → 落回旧 wb_step_*，无 obj', () => {
  it('object=null → wb_step_search（stageOf(source) 的旧键），无 obj', () => {
    expect(tickerPhrase('search_source', null)).toEqual({ key: 'wb_step_search' })
  })
  it('object=空串 → 同样落旧键无 obj', () => {
    expect(tickerPhrase('download_candidate', '')).toEqual({ key: 'wb_step_download' })
  })
  it('object=纯空白 → 视为缺失，落旧键无 obj', () => {
    expect(tickerPhrase('install_subtitle', '   ')).toEqual({ key: 'wb_step_install' })
  })
})

describe('tickerPhrase：其余工具走 stageOf → 旧 wb_step_*，永不带 obj', () => {
  it('未知工具 + object → wb_step_working（不臆造 ticker 模板）', () => {
    expect(tickerPhrase('unknown_tool', 'x')).toEqual({ key: 'wb_step_working' })
  })
  it('未知工具 + null → wb_step_working', () => {
    expect(tickerPhrase('unknown_tool', null)).toEqual({ key: 'wb_step_working' })
  })
  it('freeze_glossary + object → wb_step_glossary（无 ticker 模板的阶段照旧走 step 键）', () => {
    expect(tickerPhrase('freeze_glossary', 'term')).toEqual({ key: 'wb_step_glossary' })
  })
})
