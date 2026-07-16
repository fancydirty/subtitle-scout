// web/src/i18n/zh.ts：扁平 key 表，中文。workflow_* 键直接引用 en 的值——这是代码层面强制的
// "Workflow 区永不本地化"裁决（DESIGN.md §7，用户裁决），不是漏翻译，不许在这里手写中文替换掉它。
import { en } from './en.js'

export const zh = {
  // Triage 的中文=甄别（用户钦定，DESIGN.md §7）。Workflow 沿用视觉基准
  // full-design-v2.html 里的"工作流"（外壳导航标签，不属于"Workflow 区"内容本身）。
  nav_library: '媒体库',
  nav_workflow: '工作流',
  nav_triage: '甄别',
  nav_settings: '设置',

  cmdk_trigger: '搜索',
  cmdk_label: '命令面板',
  cmdk_placeholder: '跳转到页面…',
  cmdk_empty: '无匹配',

  library_empty_title: '媒体库暂无内容',
  library_empty_desc: '扫描媒体根目录后，剧集与电影会出现在这里。',

  library_filter_all: '全部',
  library_filter_gap: '有缺口',
  library_filter_throttled: '停牌中',
  library_filter_full: '全覆盖',

  library_section_series: '剧集',
  library_section_anime: '动漫',
  library_section_movie: '电影',
  library_section_other: '其他',

  library_kind_series: '剧集',
  library_kind_movie: '电影',

  library_filtered_empty_title: '这个筛选下暂时没有条目',
  library_filtered_empty_desc: '换一个筛选条件看看库里的其它内容。',

  library_error_prefix: '无法加载媒体库：',
  library_retry: '重试',

  library_detail_error_prefix: '无法加载这部剧：',
  library_detail_not_found_title: '未找到该剧集',
  library_detail_not_found_desc: '这部剧可能已从库中移除。',
  library_detail_layout_nonstandard: '目录结构与 TMDB 标准顺序不同',
  library_detail_canonical_pending: '应有集目录尚未缓存',
  library_detail_not_on_disk: '磁盘无此文件',
  library_detail_no_subtitles: '这一集暂无字幕。',
  library_detail_next_recheck_prefix: '预计复查',
  library_detail_close_label: '关闭单集详情',
  library_detail_file_heading: '文件',
  library_detail_subtitles_heading: '字幕',

  library_legend_covered: '已覆盖',
  library_legend_missing: '缺字幕',
  library_legend_throttled: '停牌中',
  library_legend_dashed: '磁盘无此文件',

  // Workflow 区永不本地化（用户裁决）：直接引用 en 值，禁止改成中文。
  workflow_empty_title: en.workflow_empty_title,
  workflow_empty_desc: en.workflow_empty_desc,

  triage_empty_title: '暂无待甄别项',
  triage_empty_desc: '识别器无法确信归位的文件会停在这里，等待人工认领。',

  settings_empty_title: '设置页即将上线',
  settings_empty_desc: '媒体根目录、目标语言与部署信息将会集中呈现在这里。',
} as const
