import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, type LexicalEditor, type ElementNode } from 'lexical'
import { projectWebLinkRanges } from './safe-markdown-model'

export type ComposerWebLink = { range: Range; target: string; literal: string }
type TextSpan = { node: Text; key: string; start: number; end: number }
const HIGHLIGHT = 'rovai-composer-web-link'
const SETTLE_MS = 150

/** Markdown context belongs to the parser. Coalesce edits before projecting the
 * current source, outside the input/update path; gestures flush pending work.
 * Only DOM ranges change. No editor updates, history entries, or draft writes. */
export function registerComposerWebLinks(editor: LexicalEditor, changed: () => void): {
  current(): readonly ComposerWebLink[]
  destroy(): void
} {
  let links = new Map<string, ComposerWebLink>()
  let pending = true
  let timer: ReturnType<typeof setTimeout> | undefined
  const clearPaint = (): void => {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    const highlight = registry?.get(HIGHLIGHT)
    for (const link of links.values()) highlight?.delete(link.range)
    if (highlight?.size === 0) registry?.delete(HIGHLIGHT)
  }
  const refresh = (): void => {
    clearTimeout(timer)
    if (!pending || !editor.getRootElement()) return
    if (editor.isComposing()) { timer = setTimeout(refresh, SETTLE_MS); return }
    pending = false
    let source = ''
    const spans: TextSpan[] = []
    editor.getEditorState().read(() => {
      const visit = (node: ElementNode): void => {
        for (const child of node.getChildren()) {
          if ($isElementNode(child)) { visit(child); source += '\n' }
          else if ($isTextNode(child)) {
            const element = editor.getElementByKey(child.getKey())
            let offset = source.length
            if (element) {
              const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
              let text = walker.nextNode() as Text | null
              let index = 0
              while (text) {
                spans.push({ node: text, key: `${child.getKey()}:${index++}`, start: offset, end: offset + text.length })
                offset += text.length
                text = walker.nextNode() as Text | null
              }
            }
            source += child.getTextContent()
          } else source += $isLineBreakNode(child) ? '\n' : '\ufffc' // Never scan Atom labels.
        }
      }
      visit($getRoot())
    })
    const next = new Map<string, ComposerWebLink>()
    let cursor = 0
    const point = (offset: number): { span: TextSpan; offset: number } | null => {
      while (cursor < spans.length && spans[cursor].end < offset) cursor++
      const span = spans[cursor]
      return span && offset >= span.start ? { span, offset: offset - span.start } : null
    }
    for (const link of projectWebLinkRanges(source)) {
      const start = point(link.start), end = point(link.end)
      if (!start || !end) continue
      const key = `${start.span.key}:${start.offset}-${end.span.key}:${end.offset}:${link.target}`
      const literal = source.slice(link.start, link.end)
      let rendered = links.get(key)
      if (!rendered || rendered.literal !== literal || rendered.range.startContainer !== start.span.node || rendered.range.startOffset !== start.offset
        || rendered.range.endContainer !== end.span.node || rendered.range.endOffset !== end.offset) {
        const range = document.createRange()
        range.setStart(start.span.node, start.offset); range.setEnd(end.span.node, end.offset)
        rendered = { range, target: link.target, literal }
      }
      next.set(key, rendered)
    }
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (registry && typeof Highlight !== 'undefined') {
      const highlight = registry.get(HIGHLIGHT) ?? new Highlight()
      for (const [key, link] of links) if (next.get(key) !== link) highlight.delete(link.range)
      for (const link of next.values()) highlight.add(link.range)
      if (highlight.size) registry.set(HIGHLIGHT, highlight)
      else registry.delete(HIGHLIGHT)
    }
    links = next
  }
  const unregister = editor.registerUpdateListener(({ dirtyLeaves, dirtyElements }) => {
    if (!dirtyLeaves.size && !dirtyElements.size) return
    changed()
    pending = true
    clearTimeout(timer)
    timer = setTimeout(refresh, SETTLE_MS)
  })
  const unregisterRoot = editor.registerRootListener(root => {
    clearTimeout(timer)
    clearPaint(); links.clear()
    pending = true
    if (root) refresh()
  })
  return {
    current: () => { refresh(); return editor.isComposing() ? [] : [...links.values()] },
    destroy: () => { unregister(); unregisterRoot(); clearTimeout(timer); clearPaint(); links.clear() }
  }
}
