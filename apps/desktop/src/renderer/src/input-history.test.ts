import { describe, expect, it, vi } from 'vitest'
import type { InputHistoryItem, InputHistoryPage } from '@contracts'
import { composerDocumentFromText } from './composer-document'
import { InputHistoryNavigation, InputHistoryStore, type InputHistoryTarget } from './input-history'

const thread: InputHistoryTarget = { kind: 'thread', threadId: 'a' }
const item = (id: string, cursor: string | null = id): InputHistoryItem => ({
  historyId: id, content: composerDocumentFromText(`  ${id}\n`), cursor
})
const page = (ids: string[], hasMore = false): InputHistoryPage => ({
  items: ids.map(id => item(id)), hasMore, nextCursor: ids.at(-1) ?? null
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

describe('input history cache', () => {
  it('shares first-page reads, preserves accepted submissions during preload, and uses identity rather than text', async () => {
    const pending = deferred<InputHistoryPage>()
    const read = vi.fn(() => pending.promise)
    const store = new InputHistoryStore(read)
    store.record(thread, 'same-1', composerDocumentFromText('same'))
    const leave = store.activate(thread)
    const first = store.load(thread)
    expect(store.load(thread)).toBe(first)
    store.record(thread, 'same-2', composerDocumentFromText('same'))
    store.record(thread, 'empty', composerDocumentFromText('\t\n\u3000'))
    pending.resolve(page(['same-1', 'older'], true))
    await first
    expect(read).toHaveBeenCalledTimes(1)
    expect(store.peek(thread)?.items.map(item => item.historyId)).toEqual(['same-2', 'same-1', 'older'])
    store.record(thread, 'same-1', composerDocumentFromText('same'))
    expect(store.peek(thread)?.items[1].cursor).toBe('same-1')
    expect(store.peek(thread)?.items[2].content).toEqual(composerDocumentFromText('  older\n'))
    leave()
    store.activate(thread)()
    expect(read).toHaveBeenCalledTimes(1) // warm activation does not fetch an old or new page
  })

  it.each([false, true])('trims on leave and resumes at the retained cursor (late old page: %s)', async lateOldPage => {
    const pending = deferred<InputHistoryPage>()
    const read = vi.fn(async (_target: InputHistoryTarget, cursor: string | null) => {
      const start = cursor ? Number(cursor) : 0
      if (start === 160) return pending.promise
      return page(Array.from({ length: 20 }, (_, index) => String(start + index + 1)), start < 140 || lateOldPage)
    })
    const store = new InputHistoryStore(read)
    const leave = store.activate(thread)
    for (let page = 0; page < 8; page++) await store.load(thread)
    expect(store.peek(thread)?.items).toHaveLength(160)
    expect(store.peek(thread)?.hasMore).toBe(lateOldPage)
    const oldRead = lateOldPage ? store.load(thread) : null
    leave()
    pending.resolve(page([]))
    await oldRead
    expect(store.peek(thread)?.items).toHaveLength(100)
    expect(store.peek(thread)?.hasMore).toBe(true)
    expect(store.peek(thread)?.nextCursor).toBe('100')
    const leaveAgain = store.activate(thread)
    expect(read).toHaveBeenCalledTimes(lateOldPage ? 9 : 8)
    await store.load(thread)
    expect(read).toHaveBeenLastCalledWith(thread, '100')
    expect(store.peek(thread)?.items[100].historyId).toBe('101')
    leaveAgain()
  })

  it('shares eight LRU slots across independent conversations and ignores responses to evicted entries', async () => {
    const pending = deferred<InputHistoryPage>()
    const store = new InputHistoryStore(() => pending.promise)
    const old = store.load(thread)
    const singles = Array.from({ length: 8 }, (_, index): InputHistoryTarget => ({
      kind: 'single', threadId: 'a', conversationId: String(index)
    }))
    for (const target of singles) store.record(target, 'entry', composerDocumentFromText('same body'))
    expect(store.peek(thread)).toBeUndefined()
    pending.resolve(page(['late']))
    await old
    expect(store.peek(thread)).toBeUndefined()
    store.use(singles[0])
    store.record(thread, 'new', composerDocumentFromText('submitted'))
    expect(store.peek(singles[1])).toBeUndefined()
    expect(store.peek(singles[0])?.items).toHaveLength(1)
    expect(store.peek(thread)?.initialized).toBe(false)
  })

  it('reinitializes a trimmed local-only tail and retries failed reads without discarding cached input', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page(['accepted-100']))
    const store = new InputHistoryStore(read)
    for (let index = 0; index < 101; index++) store.record(thread, `accepted-${index}`, composerDocumentFromText(String(index)))
    expect(store.peek(thread)?.items).toHaveLength(100)
    expect(store.peek(thread)?.initialized).toBe(false)
    await expect(store.load(thread)).rejects.toThrow('offline')
    expect(store.peek(thread)?.items).toHaveLength(100)
    await store.load(thread)
    expect(read).toHaveBeenLastCalledWith(thread, null)
    expect(store.peek(thread)?.items.slice(0, 3).map(item => item.historyId))
      .toEqual(['accepted-100', 'accepted-99', 'accepted-98'])
    expect(store.peek(thread)?.items.find(item => item.historyId === 'accepted-100')?.cursor).toBe('accepted-100')
  })
})

describe('input history navigation', () => {
  it('tracks selected identity through head inserts, and restores the original draft at the newest slot', async () => {
    const store = new InputHistoryStore(async () => page(['b', 'a']))
    await store.load(thread)
    const preview = vi.fn()
    const restore = vi.fn()
    const original = { document: composerDocumentFromText('unsent\n'), selection: 2 }
    const capture = vi.fn(() => original)
    const nav = new InputHistoryNavigation(store, thread, { capture, preview, restore })
    nav.older()
    expect(preview).toHaveBeenLastCalledWith(item('b').content, 'start')
    store.record(thread, 'c', composerDocumentFromText('new accepted'))
    nav.older()
    expect(preview).toHaveBeenLastCalledWith(item('a').content, 'start')
    nav.newer()
    expect(preview).toHaveBeenLastCalledWith(item('b').content, 'end')
    nav.newer()
    expect(preview).toHaveBeenLastCalledWith(composerDocumentFromText('new accepted'), 'end')
    nav.newer()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(restore).toHaveBeenCalledWith(original)
    expect(nav.browsing).toBe(false)
  })

  it.each(['edit', 'escape', 'leave'] as const)('never refills after %s cancels an in-flight first Up', async mode => {
    const pending = deferred<InputHistoryPage>()
    const read = vi.fn(() => pending.promise)
    const store = new InputHistoryStore(read)
    const preview = vi.fn()
    const restore = vi.fn()
    const nav = new InputHistoryNavigation(store, thread, { capture: () => 'draft', preview, restore })
    nav.older()
    nav.older()
    await settle()
    expect(read).toHaveBeenCalledTimes(1)
    if (mode === 'escape') nav.cancel()
    else nav.adopt()
    pending.resolve(page(['old']))
    await settle()
    expect(preview).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledTimes(mode === 'escape' ? 1 : 0)
    expect(store.peek(thread)?.items).toHaveLength(1)
  })
})
