// web/src/library/sectionLabel.ts：海报墙分区标题 i18n 化。后端 sectionOf()（src/dashboard/
// apiV2.ts）零配置按库目录结构派生分区标签，四个已知桶固定吐中文（'剧集'/'动漫'/'电影'/'其他'）
// ——那是数据事实的既有形状，不归这次前端改动碰（"不碰 src/"）。这里只做展示层翻译：
// 认得的桶映射到 i18n key，认不出的目录名（后端已 titleCase 过）原样透传。
import type { TKey } from '../i18n/useT.js'

const KNOWN_SECTION_KEYS: Record<string, TKey> = {
  '剧集': 'library_section_series',
  '动漫': 'library_section_anime',
  '电影': 'library_section_movie',
  '其他': 'library_section_other',
}

export function sectionLabel(section: string, t: (key: TKey) => string): string {
  const key = KNOWN_SECTION_KEYS[section]
  return key ? t(key) : section
}
