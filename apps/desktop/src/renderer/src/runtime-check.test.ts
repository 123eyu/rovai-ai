import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeRefresh, openRuntimeModelCatalog, requestProductRuntimeCheck } from './runtime-check'

describe('explicit Runtime check targeting', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('checks only the Qwen Runtime selected by the user', async () => {
    const request = vi.fn().mockResolvedValue({
      scheduled: true,
      completed: true,
      ready: true,
      runtimeKind: 'qwen-code'
    })
    vi.stubGlobal('window', { rovai: { request } })

    await requestProductRuntimeCheck('qwen-code')

    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('runtime.product.check', {
      runtimeKind: 'qwen-code'
    })
  })

  it('opens only the selected Runtime model catalog', async () => {
    const request = vi.fn().mockResolvedValue({
      runtimeKind: 'copilot-cli',
      cache: {
        status: 'fresh',
        observedAt: '2026-08-18T00:00:00Z',
        revalidateAfter: '2026-08-18T00:01:00Z',
        expiresAt: '2026-08-19T00:00:00Z'
      },
      models: [],
      refreshStatus: 'not_required',
      diagnosticCode: null
    })
    vi.stubGlobal('window', { rovai: { request } })

    await openRuntimeModelCatalog('copilot-cli')

    expect(request).toHaveBeenCalledWith('runtime.modelCatalog.open', {
      runtimeKind: 'copilot-cli'
    })
  })

  it('waits for the backend-owned diagnostic and preserves its failure outcome without a separate rescan', async () => {
    let finishCheck!: (result: unknown) => void
    const completion = new Promise(resolve => { finishCheck = resolve })
    const request = vi.fn().mockReturnValueOnce(completion)
    vi.stubGlobal('window', { rovai: { request } })

    const check = requestProductRuntimeCheck('codex-cli')
    expect(request).toHaveBeenCalledExactlyOnceWith('runtime.product.check', { runtimeKind: 'codex-cli' })
    finishCheck({ ready: false, outcome: 'stable_failure' })
    await expect(check).resolves.toEqual({ ready: false, outcome: 'stable_failure' })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('does not hide a backend environment-read failure or retry with cached discovery', async () => {
    const request = vi.fn().mockRejectedValue(new Error('discovery failed'))
    vi.stubGlobal('window', { rovai: { request } })
    await expect(requestProductRuntimeCheck('codex-cli')).rejects.toThrow('discovery failed')
    expect(request).toHaveBeenCalledTimes(1)
  })
})

describe('Runtime snapshot refresh', () => {
  it('coalesces requests and reads the final state after events during both the first and trailing reads', async () => {
    const pending: Array<() => void> = []
    let source = 0
    let displayed = -1
    const read = vi.fn(() => {
      const snapshot = source
      return new Promise<void>(resolve => pending.push(() => { displayed = snapshot; resolve() }))
    })
    const refresh = createRuntimeRefresh(read)
    const completion = refresh()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    source = 1
    expect(refresh()).toBe(completion)
    expect(refresh()).toBe(completion)
    pending.shift()!()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(2)
    source = 2
    expect(refresh()).toBe(completion)
    pending.shift()!()
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(3)
    pending.shift()!()
    await completion
    expect(displayed).toBe(2)
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('keeps invalidations after a failed read and permits retry after a terminal error', async () => {
    let reject!: (error: Error) => void
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail }))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined)
    const refresh = createRuntimeRefresh(read)
    const completion = refresh()
    await Promise.resolve()
    refresh()
    reject(new Error('obsolete read'))
    await expect(completion).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledTimes(2)
    await expect(refresh()).rejects.toThrow('offline')
    await expect(refresh()).resolves.toBeUndefined()
    expect(read).toHaveBeenCalledTimes(4)
  })
})
