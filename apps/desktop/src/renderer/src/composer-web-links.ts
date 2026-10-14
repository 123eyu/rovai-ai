import {
  $getNodeByKey, $getRoot, $isElementNode, $isLineBreakNode, $isTextNode,
  type LexicalEditor, type NodeKey, type ElementNode
} from 'lexical'
import { projectWebLinkRanges, projectWebLinkSource } from './safe-markdown-model'
import type { WebLinkRange } from './web-link-ranges'

type Slice = { start: number; end: number; before: boolean; after: boolean }
type Group = { keys: NodeKey[]; text: string; code: Slice[]; links: WebLinkRange[]; rendered: ComposerWebLink[]; context?: Group[] }
export type ComposerWebLink = { range: Range; target: string; literal: string }

function textChange(before: string, after: string): { start: number; end: number; delta: number } {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = before.length
  let nextEnd = after.length
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd-- }
  return { start, end, delta: after.length - before.length }
}

const HIGHLIGHT = 'rovai-composer-web-link'

/**
 * Read-only cache keyed by existing text leaves. Ordinary edits reparse just the
 * affected line/run. Structural edits (new lines, atoms, Markdown delimiters)
 * rebuild the source projection because code/link boundaries can affect later text.
 * Neither indexing nor CSS ranges ever call editor.update().
 */
export function registerComposerWebLinks(editor: LexicalEditor, changed: () => void): {
  current(): readonly ComposerWebLink[]
  destroy(): void
} {
  let groups: Group[] = []
  let byKey = new Map<NodeKey, Group>()
  const links = new Set<ComposerWebLink>()
  const clearPaint = (): void => {
    if (typeof CSS === 'undefined' || !CSS.highlights) return
    const highlight = CSS.highlights.get(HIGHLIGHT)
    for (const link of links) highlight?.delete(link.range)
    if (highlight?.size === 0) CSS.highlights.delete(HIGHLIGHT)
  }
  const paint = (affected: Iterable<Group> = groups): void => {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    const highlight = registry && typeof Highlight !== 'undefined' ? registry.get(HIGHLIGHT) ?? new Highlight() : null
    for (const group of affected) {
      for (const link of group.rendered) { highlight?.delete(link.range); links.delete(link) }
      group.rendered = []
      const texts = group.keys.flatMap(key => {
        const element = editor.getElementByKey(key)
        if (!element) return []
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const nodes: Text[] = []
        let text = walker.nextNode()
        while (text) { nodes.push(text as Text); text = walker.nextNode() }
        return nodes
      })
      const point = (offset: number): [Text, number] | null => {
        for (const text of texts) {
          if (offset <= text.length) return [text, offset]
          offset -= text.length
        }
        return null
      }
      for (const link of group.links) {
        const start = point(link.start), end = point(link.end)
        if (!start || !end) continue
        const range = document.createRange()
        range.setStart(...start); range.setEnd(...end)
        const rendered = { range, target: link.target, literal: group.text.slice(link.start, link.end) }
        group.rendered.push(rendered); links.add(rendered); highlight?.add(range)
      }
    }
    if (highlight) registry?.set(HIGHLIGHT, highlight)
  }
  const rebuild = (): void => {
    clearPaint(); links.clear()
    groups = []
    byKey = new Map()
    let source = ''
    const positions: Array<{ group: Group; start: number }> = []
    let group: Group | null = null
    const visit = (node: ElementNode): void => {
      for (const child of node.getChildren()) {
        if ($isElementNode(child)) { visit(child); group = null; source += '\n' }
        else if ($isTextNode(child)) {
          if (!group) {
            group = { keys: [], text: '', links: [], code: [], rendered: [] }
            groups.push(group); positions.push({ group, start: source.length })
          }
          group.keys.push(child.getKey()); byKey.set(child.getKey(), group)
          const text = child.getTextContent()
          group.text += text; source += text
        } else {
          // Atoms are boundaries; their labels never enter the scanner.
          group = null
          source += $isLineBreakNode(child) ? '\n' : '\ufffc'
        }
      }
    }
    visit($getRoot())
    const projection = projectWebLinkSource(source)
    for (const { group, start } of positions) {
      const end = start + group.text.length
      group.links = projection.links.filter(link => link.start >= start && link.end <= end)
        .map(link => ({ ...link, start: link.start - start, end: link.end - start }))
      group.code = projection.code.filter(code => code.start < end && code.end > start
        && (code.start < start || code.end > end))
        .map(code => ({ start: Math.max(0, code.start - start), end: Math.min(group.text.length, code.end - start),
          before: code.start < start, after: code.end > end }))
    }
    for (const context of projection.contexts) {
      const members = positions.filter(({ group, start }) => start < context.end && start + group.text.length > context.start).map(({ group }) => group)
      for (const group of members) group.context = members
    }
  }
  const unregister = editor.registerUpdateListener(({ editorState, prevEditorState, dirtyLeaves, dirtyElements }) => {
    if (!dirtyLeaves.size && !dirtyElements.size) return
    changed()
    const affected = new Set<Group>()
    let structural = false
    editorState.read(() => {
      for (const [key, intentional] of dirtyElements) {
        if (!intentional) continue
        const node = $getNodeByKey(key)
        const current = $isElementNode(node) ? node.getChildrenKeys().join(',') : null
        const previous = prevEditorState.read(() => {
          const node = $getNodeByKey(key)
          return $isElementNode(node) ? node.getChildrenKeys().join(',') : null
        })
        if (current !== previous) { structural = true; break }
      }
      for (const key of dirtyLeaves) {
        const group = byKey.get(key)
        if (!group || !$isTextNode($getNodeByKey(key))) { structural = true; break }
        affected.add(group)
        group.context?.forEach(member => affected.add(member))
      }
      if (!structural) for (const group of affected) {
        const text = group.keys.map(key => $getNodeByKey(key)?.getTextContent() ?? '').join('')
        if (text === group.text) continue
        const change = textChange(group.text, text)
        const edited = group.text.slice(change.start, change.end) + text.slice(change.start, change.end + change.delta)
        const fence = (value: string): string | undefined => /^ {0,3}(?:\u0060{3,}|~{3,})/u.exec(value)?.[0]
        // These delimiters can open/close a block or a multiline inline span.
        if (/[\u0060~\r\n\\<>\[\]()]/u.test(edited)
          || /^\s*/u.exec(group.text)?.[0] !== /^\s*/u.exec(text)?.[0]
          || fence(group.text) !== fence(text)
          || fence(text) && group.code.some(range => range.before)) { structural = true; break }
        const move = (offset: number): number => offset < change.start ? offset
          : offset >= change.end ? offset + change.delta : change.start
        group.code = group.code.map(range => ({ ...range,
          start: range.before ? 0 : move(range.start),
          end: range.after ? text.length : range.end === change.start ? range.end : move(range.end) }))
        group.text = text
        let masked = text
        for (const range of group.code) masked = masked.slice(0, range.start) + ' '.repeat(range.end - range.start) + masked.slice(range.end)
        group.links = projectWebLinkRanges(masked)
      }
      if (!structural) for (const context of new Set([...affected].flatMap(group => group.context ? [group.context] : []))) {
        const projection = projectWebLinkRanges(context.map(group => group.text).join('\n'))
        let offset = 0
        for (const group of context) {
          group.links = projection.filter(link => link.start >= offset && link.end <= offset + group.text.length)
            .map(link => ({ ...link, start: link.start - offset, end: link.end - offset }))
          offset += group.text.length + 1
        }
      }
      if (structural) rebuild()
    })
    paint(structural ? groups : affected)
  })
  const unregisterRoot = editor.registerRootListener(root => {
    clearPaint()
    if (root) { editor.getEditorState().read(rebuild); paint() }
    else links.clear()
  })
  return {
    current: () => [...links],
    destroy: () => { unregister(); unregisterRoot(); clearPaint(); links.clear(); groups = []; byKey.clear() }
  }
}
