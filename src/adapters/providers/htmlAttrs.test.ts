import { describe, it, expect } from 'vitest'
import { findNextTag } from './htmlAttrs.js'

describe('findNextTag', () => {
  it('returns null when the tag is not present', () => {
    expect(findNextTag('<div>no anchors here</div>', 'a')).toBeNull()
  })

  it('parses a simple double-quoted attribute', () => {
    const r = findNextTag('<a href="/x.html">text</a>', 'a')
    expect(r?.attrs).toEqual({ href: '/x.html' })
  })

  it('parses a single-quoted attribute', () => {
    const r = findNextTag("<a href='/x.html'>text</a>", 'a')
    expect(r?.attrs).toEqual({ href: '/x.html' })
  })

  it('is attribute-order agnostic', () => {
    const first = findNextTag('<a href="/x.html" id="down">t</a>', 'a')
    const second = findNextTag('<a id="down" href="/x.html">t</a>', 'a')
    expect(first?.attrs).toEqual({ href: '/x.html', id: 'down' })
    expect(second?.attrs).toEqual({ href: '/x.html', id: 'down' })
  })

  it('tolerates extra attributes (class/title/data-*) interspersed between the ones we care about', () => {
    const r = findNextTag(
      '<a class="btn btn-danger" href="/x.html" data-track="dl" id="down" title="下载压缩包">t</a>', 'a',
    )
    expect(r?.attrs.href).toBe('/x.html')
    expect(r?.attrs.id).toBe('down')
  })

  it('does not let a bare ">" inside a quoted attribute value prematurely close the tag (title decoy)', () => {
    const html = '<a title="预告: </a> 佯攻收尾" href="/detail/5.html" class="y">Real Title</a>'
    const r = findNextTag(html, 'a')
    expect(r?.attrs.title).toBe('预告: </a> 佯攻收尾')
    expect(r?.attrs.href).toBe('/detail/5.html')
    // end must land after the *real* closing '>', not the one hiding inside the title text
    expect(html.slice(r!.end)).toBe('Real Title</a>')
  })

  it('handles self-closing tags (<img ... />) and stops attribute scanning at the "/>"', () => {
    const html = '<img alt="verify code" src="/img.png" />REST'
    const r = findNextTag(html, 'img')
    expect(r?.attrs).toEqual({ alt: 'verify code', src: '/img.png' })
    expect(html.slice(r!.end)).toBe('REST')
  })

  it('handles a void element without a trailing slash (<input ...>) and continues scanning after it', () => {
    const html = '<input type="hidden" name="a" value="1"><input type="hidden" name="b" value="2">'
    const first = findNextTag(html, 'input', 0)
    expect(first?.attrs).toEqual({ type: 'hidden', name: 'a', value: '1' })
    const second = findNextTag(html, 'input', first!.end)
    expect(second?.attrs).toEqual({ type: 'hidden', name: 'b', value: '2' })
  })

  it('supports unquoted attribute values', () => {
    const r = findNextTag('<a href=/detail/1.html id=down>t</a>', 'a')
    expect(r?.attrs).toEqual({ href: '/detail/1.html', id: 'down' })
  })

  it('treats an attribute with no value as an empty string', () => {
    const r = findNextTag('<input disabled name="x">', 'input')
    expect(r?.attrs).toEqual({ disabled: '', name: 'x' })
  })

  it('does not match a tag name that is only a prefix (e.g. "article" when searching for "a")', () => {
    const r = findNextTag('<article>not an anchor</article>', 'a')
    expect(r).toBeNull()
  })

  it('finds the tag starting from fromIndex, skipping earlier occurrences', () => {
    const html = '<a href="/1.html">one</a><a href="/2.html">two</a>'
    const first = findNextTag(html, 'a', 0)
    const second = findNextTag(html, 'a', first!.end)
    expect(second?.attrs.href).toBe('/2.html')
  })
})
