import type { ComposerDocument, InputHistoryItem, InputHistoryPage } from '@contracts'
import type { ThreadClient } from './camp-client'
import { cloneComposerDocument } from './composer-document'

export type InputHistoryTarget =
  | { kind: 'thread'; threadId: string }
  | { kind: 'single'; threadId: string; conversationId: string }

export function inputHistoryKey(target: InputHistoryTarget): string {
  return target.kind === 'thread' ? `thread:${target.threadId}` : `single:${target.conversationId}`
}

export function hasRecallableInput(content: ComposerDocument): boolean {
  return content.segments.some(segment => segment.kind === 'atom' || segment.text.trim().length > 0)
}

interface Cache {
  items: InputHistoryItem[]
  initialized: boolean
  nextCursor: string | null
  hasMore: boolean
  inFlight: Promise<void> | null
  users: number
}

/** One memory-only LRU per stable Host/Owner/editor client. Drafts never enter it. */
export class InputHistoryStore {
  private readonly caches = new Map<string, Cache>()
  private readonly active = new Map<string, number>()
  constructor(private readonly read: (target: InputHistoryTarget, cursor: string | null) => Promise<InputHistoryPage>) {}

  private touch(target: InputHistoryTarget): Cache {
    const key = inputHistoryKey(target)
    const cache = this.caches.get(key) ?? {
      items: [], initialized: false, nextCursor: null, hasMore: true, inFlight: null,
      users: this.active.get(key) ?? 0
    }
    this.caches.delete(key)
    this.caches.set(key, cache)
    while (this.caches.size > 8) this.caches.delete(this.caches.keys().next().value!)
    return cache
  }

  peek(target: InputHistoryTarget): Readonly<Cache> | undefined {
    return this.caches.get(inputHistoryKey(target))
  }

  activate(target: InputHistoryTarget): () => void {
    const key = inputHistoryKey(target)
    const cache = this.touch(target)
    cache.users += 1
    this.active.set(key, cache.users)
    if (!cache.initialized) void this.load(target).catch(() => undefined)
    return () => {
      const users = Math.max(0, (this.active.get(key) ?? 1) - 1)
      if (users) this.active.set(key, users)
      else this.active.delete(key)
      const retained = this.caches.get(key)
      if (retained) {
        retained.users = users
        if (!users) this.trim(retained)
      }
    }
  }

  use(target: InputHistoryTarget): void { this.touch(target) }

  record(target: InputHistoryTarget, historyId: string, content: ComposerDocument): void {
    if (!historyId || !hasRecallableInput(content)) return
    const cache = this.touch(target)
    const existing = cache.items.find(item => item.historyId === historyId)
    // Replayed responses and overlapping reads never create or move a second entry.
    if (!existing) cache.items.unshift({ historyId, content: cloneComposerDocument(content), cursor: null })
    if (!cache.users) this.trim(cache)
  }

  load(target: InputHistoryTarget): Promise<void> {
    const cache = this.touch(target)
    if (cache.inFlight) return cache.inFlight
    if (cache.initialized && !cache.hasMore) return Promise.resolve()
    const first = !cache.initialized
    const cursor = first ? null : cache.nextCursor
    const key = inputHistoryKey(target)
    const operation = Promise.resolve().then(() => this.read(target, cursor)).then(page => {
      // A late response must not resurrect a cache evicted from the LRU.
      if (this.caches.get(key) !== cache) return
      // Leaving may trim the tail while its next page is in flight. That page
      // cannot replace the retained cursor or mark the omitted range exhausted.
      if (!first && cache.nextCursor !== cursor) return
      const byId = new Map(page.items.map(item => [item.historyId, item]))
      if (first) {
        const overlap = cache.items.findIndex(item => byId.has(item.historyId))
        // A reset can retain >20 accepted entries without database cursors.
        // Only entries before the overlap are newer than this page; putting
        // every cursorless entry first would move the older ones to the head.
        const boundary = overlap < 0
          ? cache.items.findIndex(item => item.cursor !== null)
          : overlap
        const split = boundary < 0 ? cache.items.length : boundary
        cache.items = [
          ...cache.items.slice(0, split),
          ...page.items,
          ...cache.items.slice(split).filter(item => !byId.has(item.historyId))
        ]
      } else {
        const existingIds = new Set(cache.items.map(item => item.historyId))
        cache.items = [
          ...cache.items.map(item => byId.get(item.historyId) ?? item),
          ...page.items.filter(item => !existingIds.has(item.historyId))
        ]
      }
      cache.initialized = true
      cache.nextCursor = page.nextCursor
      cache.hasMore = page.hasMore
      if (!cache.users) this.trim(cache)
    }).finally(() => {
      if (cache.inFlight === operation) cache.inFlight = null
    })
    cache.inFlight = operation
    return operation
  }

  private trim(cache: Cache): void {
    if (cache.items.length <= 100) return
    cache.items.length = 100
    cache.nextCursor = cache.items.at(-1)!.cursor
    cache.hasMore = true
    if (!cache.nextCursor) cache.initialized = false
  }
}

const stores = new WeakMap<ThreadClient, InputHistoryStore>()

export function inputHistoryFor(client: ThreadClient): InputHistoryStore {
  let store = stores.get(client)
  if (!store) {
    store = new InputHistoryStore((target, cursor) => target.kind === 'thread'
      ? client.request<InputHistoryPage>('thread.messages.inputHistory', { threadId: target.threadId, cursor })
      : client.request<InputHistoryPage>('singleChat.inputHistory', {
        threadId: target.threadId, conversationId: target.conversationId, cursor
      }))
    stores.set(client, store)
  }
  return store
}

export interface InputHistoryAdapter<Snapshot> {
  capture(): Snapshot
  preview(content: ComposerDocument, boundary: 'start' | 'end'): void
  restore(snapshot: Snapshot): void
}

/** Transient navigation stores only the selected identity and the original draft. */
export class InputHistoryNavigation<Snapshot> {
  private original: { snapshot: Snapshot } | null = null
  private selectedId: string | null = null
  private generation = 0
  private loading = false

  constructor(
    private readonly store: InputHistoryStore,
    private readonly target: InputHistoryTarget,
    private readonly adapter: InputHistoryAdapter<Snapshot>
  ) {}

  get browsing(): boolean { return this.original !== null }

  canMove(direction: 'older' | 'newer'): boolean {
    if (direction === 'newer') return this.browsing
    const cache = this.store.peek(this.target)
    if (!cache?.initialized || cache.hasMore) return true
    const index = cache.items.findIndex(item => item.historyId === this.selectedId)
    return index + 1 < cache.items.length
  }

  older(): void {
    if (this.loading || !this.canMove('older')) return
    this.store.use(this.target)
    this.original ??= { snapshot: this.adapter.capture() }
    const generation = ++this.generation
    const select = (): boolean => {
      if (generation !== this.generation) return false
      const items = this.store.peek(this.target)?.items ?? []
      const index = items.findIndex(item => item.historyId === this.selectedId)
      const next = items[index + 1]
      if (!next) return false
      this.selectedId = next.historyId
      this.adapter.preview(next.content, 'start')
      return true
    }
    if (select()) return
    this.loading = true
    void this.store.load(this.target).then(() => {
      if (!select() && generation === this.generation && !this.selectedId) this.adopt()
    }, () => {
      if (generation === this.generation && !this.selectedId) this.adopt()
    }).finally(() => { if (generation === this.generation) this.loading = false })
  }

  newer(): void {
    if (!this.browsing) return
    this.generation += 1
    this.loading = false
    this.store.use(this.target)
    const items = this.store.peek(this.target)?.items ?? []
    const index = items.findIndex(item => item.historyId === this.selectedId)
    const next = index > 0 ? items[index - 1] : null
    if (!next) { this.cancel(); return }
    this.selectedId = next.historyId
    this.adapter.preview(next.content, 'end')
  }

  cancel(): boolean {
    const original = this.original
    this.adopt()
    if (original) this.adapter.restore(original.snapshot)
    return original !== null
  }

  /** Losing focus cancels a pending move, but keeps an already visible preview sendable. */
  cancelPending(): void {
    if (!this.loading) return
    this.generation += 1
    this.loading = false
    if (!this.selectedId) this.original = null
  }

  /** User edits/sends, or the editor unmounts. Invalidate any outstanding refill. */
  adopt(): void {
    this.generation += 1
    this.loading = false
    this.selectedId = null
    this.original = null
  }
}

export function isInputHistoryKey(event: {
  key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean
  isComposing?: boolean; keyCode?: number; defaultPrevented: boolean
}): boolean {
  return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && ['ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)
}
