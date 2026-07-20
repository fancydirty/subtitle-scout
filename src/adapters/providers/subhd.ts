import { findNextTag } from './htmlAttrs.js'

// subhd 字幕源客户端。真实链路（curl 实测 2026-07-20，见 __fixtures__/subhd/STRUCTURE.md）：
//   search: GET /search/<q> → 搜索页 HTML（cards）
//   resolve: POST /api/sub/prepare-download → tk cookie → GET /down/<id>(激活) →
//            POST /api/sub/down → CDN 文件 url（credentials omit，下载层 undici 直取）
// 无验证码、无云锁挑战、无 session store——比 zimuku 简单一半。

export interface SubhdSearchResult {
  /** /a/<base62> 的 id 段——同时是 prepare-download/api-sub-down 的 sid */
  id: string
  /** 发布名（view-text 里的长文件名）；缺 → null */
  videoName: string | null
  /** 语言徽章文本，多语用 '/' 连接（简体/繁体/繁中/双语/英语…）；缺 → null */
  language: string | null
  /** 格式徽章：SRT/ASS/SUP…；缺 → null */
  subtype: string | null
  /** 来源徽章：转载精修/官方字幕…；缺 → null */
  releaseSite: string | null
}

const A_HREF_ID_RE = /^\/a\/([A-Za-z0-9]+)$/

/** 轻量 HTML 数字/命名实体解码——发布名里出现 `I&#39;ll` 之类（htmlAttrs 本身不解码实体）。
 *  只覆盖字幕站发布名里实际见过的几种，够用就好。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

interface Anchor { id: string; start: number; textStart: number; textEnd: number }

/** 收集页面里所有 `<a href="/a/<id>">` 锚点（href 恰为 /a/<base62>，海报的 /d/<num> 不匹配）。
 *  用 htmlAttrs.findNextTag 两步解析（先定位标签边界再按属性名读 href），对属性顺序/单双引号免疫。 */
function collectAnchors(html: string): Anchor[] {
  const anchors: Anchor[] = []
  let idx = 0
  for (;;) {
    const tag = findNextTag(html, 'a', idx)
    if (!tag) break
    const m = tag.attrs.href ? A_HREF_ID_RE.exec(tag.attrs.href) : null
    if (m) {
      const close = html.indexOf('</a>', tag.end)
      if (close !== -1) anchors.push({ id: m[1], start: tag.start, textStart: tag.end, textEnd: close })
    }
    idx = tag.end
  }
  return anchors
}

/** 在卡片切片内按 span 的 class 抽字段——语言(fw-bold)/格式(p-1+text-secondary)/来源(text-white)。
 *  同样走 findNextTag，只依赖 class 里的稳定 token，不绑属性顺序。 */
function spansByClass(slice: string, ...classTokens: string[]): string[] {
  const out: string[] = []
  let idx = 0
  for (;;) {
    const tag = findNextTag(slice, 'span', idx)
    if (!tag) break
    const cls = tag.attrs.class ?? ''
    if (classTokens.every(t => cls.split(/\s+/).includes(t))) {
      const close = slice.indexOf('</span>', tag.end)
      if (close !== -1) {
        const text = stripTags(slice.slice(tag.end, close))
        if (text) out.push(text)
      }
    }
    idx = tag.end
  }
  return out
}

/**
 * 解析 subhd 搜索页 → 候选列表。每张结果卡片承载一个 /a/<id>（在标题链接 + view-text 链接里各出现
 * 一次），卡片切片 = 本卡首锚 → 下一张不同 id 的首锚（徽章行在两锚之后、下一卡之前，故切片含之）。
 * 畸形/缺字段的条目 fail-soft（字段为 null，不整卡丢弃、不整体抛）——同 assrt/zimuku 的纪律。
 * 对着 __fixtures__/subhd/search-the-rig.html 的真实 DOM 写（见 STRUCTURE.md）。
 */
export function parseSearchResults(html: string): SubhdSearchResult[] {
  const anchors = collectAnchors(html)
  if (anchors.length === 0) return []

  // 按连续同 id 分组为卡片；卡片起点 = 该组首锚 start，终点 = 下一组首锚 start（或页尾）。
  const cardStarts: { id: string; anchorIdxs: number[]; start: number }[] = []
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]
    const last = cardStarts[cardStarts.length - 1]
    if (last && last.id === a.id) last.anchorIdxs.push(i)
    else cardStarts.push({ id: a.id, anchorIdxs: [i], start: a.start })
  }

  const results: SubhdSearchResult[] = []
  for (let c = 0; c < cardStarts.length; c++) {
    const card = cardStarts[c]
    const sliceEnd = c + 1 < cardStarts.length ? cardStarts[c + 1].start : html.length
    const slice = html.slice(card.start, sliceEnd)

    // videoName：本卡锚点里最长的文本（view-text 发布名 > 短中文标题）
    let videoName: string | null = null
    for (const ai of card.anchorIdxs) {
      const t = stripTags(html.slice(anchors[ai].textStart, anchors[ai].textEnd))
      if (t && (!videoName || t.length > videoName.length)) videoName = t
    }

    const langs = spansByClass(slice, 'p-1', 'fw-bold')
    const fmts = spansByClass(slice, 'p-1', 'text-secondary')
    const sites = spansByClass(slice, 'text-white')

    results.push({
      id: card.id,
      videoName,
      language: langs.length ? langs.join('/') : null,
      subtype: fmts.length ? fmts[0] : null,
      releaseSite: sites.length ? sites[0] : null,
    })
  }
  return results
}
