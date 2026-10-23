import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoredCommandResult, ThreadMessageView } from '@contracts'
import { composerDocumentFromText } from './composer-document'
import { MessageReeditStore, messageReeditDocument, REEDIT_LIMITS, REEDIT_TTL_MS, type WithdrawalRequest } from './message-reedit-store'
import { MessageWithdrawal } from './message-withdrawal'

class MemoryStorage {
  data = new Map<string, string>()
  failWrites = false
  get length(): number { return this.data.size }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null }
  getItem(key: string): string | null { return this.data.get(key) ?? null }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded')
    this.data.set(key, value)
  }
  removeItem(key: string): void { this.data.delete(key) }
}
const command = (id = 'message'): WithdrawalRequest => ({ commandId: `command-${id}`,
  command: { threadId: 'thread', messageId: id, expectedVersion: 1 } })
const text = composerDocumentFromText('原文\n保留换行')
const source = { id: 'message', version: 1, canWithdraw: true, withdrawn: false, body: '原文\n保留换行',
  content: [{ kind: 'text', text: '原文\n保留换行' }] } as ThreadMessageView
const applied = { status: 'applied' } as StoredCommandResult
function fixture() {
  let now = 1_000_000
  const storage = new MemoryStorage()
  const store = new MessageReeditStore('profile/owner', storage, () => now)
  return { storage, store, now: () => now, advance: (ms: number) => { now += ms } }
}
afterEach(() => vi.useRealTimers())

describe('withdrawn message local recovery', () => {
  it('starts the ready window once; refresh, restart and duplicate receipts never extend it', () => {
    const f = fixture(), request = command()
    expect(f.store.stage(request, text)).toBe(true)
    expect(f.store.readReady('thread', 'message')).toBeNull()
    f.advance(5_000)
    expect(f.store.confirm(request)).toBe(true)
    f.advance(115_000)
    const restarted = new MessageReeditStore('profile/owner', f.storage, f.now)
    expect(restarted.readReady('thread', 'message')).toEqual(text)
    expect(restarted.confirm(request)).toBe(true)
    f.advance(5_000)
    // The read gate works even when no timer has run (closed/background application).
    expect(restarted.readReady('thread', 'message')).toBeNull()
    expect(restarted.confirm(request)).toBe(false)
    restarted.sweep()
    expect(f.storage.length).toBe(0)
  })
  it('reconciles pending within its original deadline and never recreates expired/deleted copies', () => {
    const f = fixture(), request = command()
    f.store.stage(request, text)
    f.advance(90_000)
    expect(f.store.confirm(request, true)).toBe(true)
    f.advance(30_000)
    expect(f.store.readReady('thread', 'message')).toBeNull()
    expect(f.store.confirm(request, true)).toBe(false)
    f.store.sweep()
    f.store.stage(command('other'), text)
    f.store.deleteThread('thread')
    expect(f.store.confirm(command('other'))).toBe(false)
    expect(f.storage.length).toBe(0)
  })
  it('separates scopes, validates records and ignores mismatched receipts', () => {
    const f = fixture(), request = command()
    f.store.stage(request, text)
    expect(f.store.confirm({ ...request, commandId: 'different' })).toBe(false)
    expect(new MessageReeditStore('another-owner', f.storage, f.now).requestFor('thread', 'message')).toBeNull()
    expect(f.store.readReady('another-thread', 'message')).toBeNull()
    f.storage.setItem(f.storage.key(0)!, '{broken json')
    expect(f.store.readReady('thread', 'message')).toBeNull()
    f.store.sweep()
    expect(f.storage.length).toBe(0)
  })
  it('bounds size, count and aggregate occupancy without evicting live copies or touching drafts', () => {
    const f = fixture()
    f.storage.setItem('rovai.camp-composer-draft.v1:thread', 'ordinary draft')
    expect(f.store.stage(command('large'), composerDocumentFromText('x'.repeat(REEDIT_LIMITS.recordBytes)))).toBe(false)
    for (let i = 0; i < REEDIT_LIMITS.records; ++i) expect(f.store.stage(command(String(i)), text)).toBe(true)
    expect(f.store.stage(command('overflow'), text)).toBe(false)
    expect(f.store.requestFor('thread', '0')).toEqual(command('0'))
    f.advance(REEDIT_TTL_MS)
    expect(f.store.stage(command('after-expiry'), text)).toBe(true)
    expect(f.storage.getItem('rovai.camp-composer-draft.v1:thread')).toBe('ordinary draft')
    const g = fixture(), large = composerDocumentFromText('x'.repeat(25_000))
    let saved = 0
    while (g.store.stage(command(String(saved)), large)) ++saved
    expect(saved).toBeGreaterThan(0)
    expect(saved).toBeLessThan(REEDIT_LIMITS.records)
    expect(g.store.requestFor('thread', '0')).not.toBeNull()
  })
  it('reclaims expired copies across owners while keeping live recovery and replay isolated', () => {
    const f = fixture(), other = new MessageReeditStore('another-owner', f.storage, f.now)
    f.store.stage(command(), text)
    f.store.confirm(command())
    f.advance(60_000)
    other.stage(command('other'), text)
    other.confirm(command('other'))
    expect(other.readReady('thread', 'message')).toBeNull()
    expect(f.store.readReady('thread', 'other')).toBeNull()
    expect(other.pending()).toEqual([])
    f.advance(60_000)
    other.sweep()
    expect(f.storage.length).toBe(1)
    expect(other.readReady('thread', 'other')).toEqual(text)
    f.store.deleteThread('thread')
    expect(other.readReady('thread', 'other')).toEqual(text)
  })
  it('fails closed for pending and ready storage failures', () => {
    const f = fixture(), request = command()
    f.storage.failWrites = true
    expect(f.store.stage(request, text)).toBe(false)
    f.storage.failWrites = false
    expect(f.store.stage(request, text)).toBe(true)
    f.storage.failWrites = true
    expect(f.store.confirm(request)).toBe(false)
    expect(f.store.readReady('thread', 'message')).toBeNull()
    expect(f.store.pending()).toEqual([])
  })
  it('uses one timer per instance and reacts to other-window deletion and foreground expiry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const storage = new MemoryStorage(), store = new MessageReeditStore('scope', storage)
    const target = Object.assign(new EventTarget(), { document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) }) as unknown as Window
    const changed = vi.fn(), unsubscribe = store.subscribe(changed)
    const stop = store.start(target)
    store.stage(command(), text)
    store.confirm(command())
    store.stage(command('second'), text)
    expect(vi.getTimerCount()).toBe(1)
    const second = new MessageReeditStore('scope', storage)
    second.reject(command())
    const before = changed.mock.calls.length
    target.dispatchEvent(Object.assign(new Event('storage'), { key: null }))
    expect(changed.mock.calls.length).toBeGreaterThan(before)
    expect(store.readReady('thread', 'message')).toBeNull()
    vi.setSystemTime(1_000_000 + REEDIT_TTL_MS)
    target.dispatchEvent(new Event('focus'))
    expect(storage.length).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    stop(); unsubscribe()
  })
  it('recovers authored text and explicit mentions only, without falling back to filtered reference text', () => {
    expect(messageReeditDocument(source)).toEqual(text)
    const explicit = messageReeditDocument({ body: '@队员 正文', content: [
      { kind: 'member_mention', agentId: 'member' }, { kind: 'text', text: ' 正文' }
    ] })!
    expect(explicit.segments[0]).toEqual({ kind: 'atom', atom: { type: 'member', agentId: 'member' } })
    expect(messageReeditDocument({ body: '引用内容', content: [{ kind: 'current_user_mention', userId: 'local_user' }] })).toBeNull()
  })
})

describe('withdrawal request integration', () => {
  function adapter(f = fixture()) {
    const request = vi.fn(async (_request: WithdrawalRequest) => applied)
    const refresh = vi.fn(async (_threadId: string) => undefined), accepted = vi.fn(), notify = vi.fn()
    const withdrawal = new MessageWithdrawal({ store: f.store, request, refresh, accepted, notify, rejectionMessage: () => '业务拒绝' })
    return { ...f, withdrawal, request, refresh, accepted, notify }
  }
  it('keeps accepted withdrawal and a ready copy when the follow-up projection fails', async () => {
    const f = adapter()
    f.refresh.mockRejectedValueOnce(new Error('refresh failed'))
    await expect(f.withdrawal.withdraw('thread', source)).resolves.toBeUndefined()
    expect(f.accepted).toHaveBeenCalledWith('thread', 'message')
    expect(f.store.readReady('thread', 'message')).toEqual(text)
    expect(f.notify).toHaveBeenCalledWith('消息已撤回，会话暂未刷新，请稍后重试。')
  })
  it('continues withdrawal when storage fails before or after the command', async () => {
    for (const phase of ['pending', 'ready']) {
      const f = adapter()
      if (phase === 'pending') f.storage.failWrites = true
      else f.request.mockImplementationOnce(async () => { f.storage.failWrites = true; return applied })
      await expect(f.withdrawal.withdraw('thread', source)).resolves.toBeUndefined()
      expect(f.request).toHaveBeenCalledTimes(1)
      expect(f.accepted).toHaveBeenCalledOnce()
      expect(f.store.readReady('thread', 'message')).toBeNull()
      expect(f.notify).toHaveBeenCalledWith('已撤回，本次无法重新编辑。')
    }
  })
  it('keeps unknown results pending, retries the exact request and uses only the remaining pending window', async () => {
    const f = adapter()
    f.request.mockRejectedValueOnce(new Error('network disconnected'))
    await expect(f.withdrawal.withdraw('thread', source)).rejects.toThrow('尚未确认')
    const original = f.request.mock.calls[0][0]
    expect(f.store.pending()).toEqual([original])
    f.advance(90_000)
    await f.withdrawal.withdraw('thread', { ...source, version: 99 })
    expect(f.request.mock.calls[1][0]).toEqual(original)
    expect(f.store.readReady('thread', 'message')).toEqual(text)
    f.advance(30_000)
    expect(f.store.readReady('thread', 'message')).toBeNull()
  })
  it('replays persisted pending requests after restart without a fresh command identity', async () => {
    const f = fixture(), request = command()
    f.store.stage(request, text)
    const restarted = adapter({ ...f, store: new MessageReeditStore('profile/owner', f.storage, f.now) })
    restarted.withdrawal.recoverPending()
    await vi.waitFor(() => expect(restarted.accepted).toHaveBeenCalledOnce())
    expect(restarted.request).toHaveBeenCalledWith(request)
    f.advance(REEDIT_TTL_MS)
    expect(restarted.store.readReady('thread', 'message')).toBeNull()
  })
  it('removes rejected copies and never restores text from a late callback after deletion', async () => {
    const f = adapter()
    f.request.mockResolvedValueOnce({ status: 'rejected' } as StoredCommandResult)
    await expect(f.withdrawal.withdraw('thread', source)).rejects.toThrow('业务拒绝')
    expect(f.store.pending()).toEqual([])
    let complete!: (value: StoredCommandResult) => void
    f.request.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const pending = f.withdrawal.withdraw('thread', source)
    f.store.deleteThread('thread')
    complete(applied)
    await pending
    expect(f.storage.length).toBe(0)
    expect(f.store.readReady('thread', 'message')).toBeNull()
  })
})
