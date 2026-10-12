import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreMethod, NavigationSnapshot, ProjectRegistrySnapshot } from '@contracts'
import { createProjectRegistry, captureLegacyProjectInitialization, navigationWithRegisteredProjects, PROJECT_REGISTRY_WAIT_MS, type ProjectRegistryView } from './project-registry'

const registry = (revision: number, removed = false): ProjectRegistrySnapshot => ({ initialized: true, revision,
  projects: [{ projectPath: '/a', version: revision, removed }, { projectPath: '/b', version: 1, removed: false }] })
const empty: NavigationSnapshot = { schemaVersion: 3, throughGlobalSequence: 0, projects: [], quickChat: { totalCount: 0, recentThreads: [] } }
const storage = (): Storage => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
}

describe('SQLite project registration client', () => {
  afterEach(() => vi.useRealTimers())
  it('keeps every registered empty directory, hides tombstones even with old groups, and retains entries without a Thread read', () => {
    const all = navigationWithRegisteredProjects(empty, registry(1))!
    expect(all.projects.map(project => [project.projectPath, project.totalCount, project.recentThreads])).toEqual([['/a', 0, []], ['/b', 0, []]])
    const removed = navigationWithRegisteredProjects({ ...all, projects: all.projects.map(project => ({ ...project, totalCount: 1 })) }, registry(2, true))!
    expect(removed.projects.map(project => project.projectPath)).toEqual(['/b'])
    expect(navigationWithRegisteredProjects(null, registry(1))?.projects).toHaveLength(2)
    expect(navigationWithRegisteredProjects(all, null)?.projects).toEqual(all.projects)
    expect(navigationWithRegisteredProjects(removed, registry(3))?.projects.map(project => project.projectPath)).toEqual(['/a', '/b'])
  })

  it('captures the old empty selection before delayed initialization and startup restoration can overwrite it', async () => {
    const local = storage()
    local.setItem('rovai.current-project.v1', JSON.stringify({ kind: 'directory', projectPath: '/selected' }))
    let finish!: (value: { projectPaths: string[]; removedPaths: string[] }) => void
    const read = captureLegacyProjectInitialization(() => new Promise(resolve => { finish = resolve }), local)
    local.setItem('rovai.current-project.v1', JSON.stringify({ kind: 'directory', projectPath: '/restored-thread' }))
    const input = read()
    finish({ projectPaths: ['/a'], removedPaths: ['/a'] })
    await expect(input).resolves.toEqual({ projectPaths: ['/a', '/selected'], removedPaths: ['/a'] })
  })

  it('ignores a damaged or inaccessible optional selection without blocking known legacy directories', async () => {
    const local = storage()
    const previous = { projectPaths: ['/known'], removedPaths: ['/removed'] }
    local.setItem('rovai.current-project.v1', '{broken')
    await expect(captureLegacyProjectInitialization(async () => previous, local)()).resolves.toEqual(previous)
    await expect(captureLegacyProjectInitialization(async () => previous, { getItem() { throw new Error('unavailable') } })()).resolves.toEqual(previous)
  })

  it('does not complete initialization after legacy read failure and does not reimport after success', async () => {
    let initialized = false
    const legacy = vi.fn().mockRejectedValueOnce(new Error('old preferences unreadable')).mockResolvedValue({ projectPaths: [], removedPaths: [] })
    const request = vi.fn(async (method: CoreMethod) => {
      if (method === 'projects.initialize') initialized = true
      return { initialized, revision: initialized ? 1 : 0, projects: [] }
    })
    const client = createProjectRegistry(request as Parameters<typeof createProjectRegistry>[0], legacy)
    await expect(client.get()).rejects.toThrow('unreadable')
    expect(request.mock.calls.map(call => call[0])).toEqual(['projects.get'])
    await expect(client.get()).resolves.toMatchObject({ initialized: true })
    await client.get()
    expect(legacy).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.filter(call => call[0] === 'projects.initialize')).toHaveLength(1)
  })

  it('retries a lost acknowledgement with the same command and ignores an older snapshot arriving after removal', async () => {
    let readCount = 0
    let finishRead!: (snapshot: ProjectRegistrySnapshot) => void
    const writes: unknown[] = []
    const request = async (method: CoreMethod, params?: unknown): Promise<unknown> => {
      if (method === 'projects.get') return ++readCount === 1 ? registry(1) : new Promise<ProjectRegistrySnapshot>(resolve => { finishRead = resolve })
      writes.push(params)
      if (writes.length === 1) throw new Error('reply lost after commit')
      return { status: 'applied', payload: registry(2, true) }
    }
    const client = createProjectRegistry(request as Parameters<typeof createProjectRegistry>[0], async () => ({ projectPaths: [], removedPaths: [] }))
    const values: ProjectRegistryView[] = []
    client.subscribe(value => values.push(value))
    await client.get()
    const lateRead = client.get()
    await client.change('/a', true)
    finishRead(registry(1))
    expect((await lateRead).projects[0].removed).toBe(true)
    expect(writes[0]).toEqual(writes[1])
    expect(values.at(-1)?.snapshot?.revision).toBe(2)
  })

  it('reports failed saves and reads without publishing success or replacing known records', async () => {
    let failRead = false
    const request = async (method: CoreMethod): Promise<unknown> => {
      if (method === 'projects.get' && !failRead) return registry(1)
      throw new Error('database unavailable')
    }
    const client = createProjectRegistry(request as Parameters<typeof createProjectRegistry>[0], async () => ({ projectPaths: [], removedPaths: [] }))
    const listener = vi.fn()
    client.subscribe(listener)
    await client.get()
    await expect(client.change('/a', true)).rejects.toThrow('database unavailable')
    failRead = true
    await expect(client.get()).rejects.toThrow('database unavailable')
    expect(client.current()).toMatchObject({ unavailable: true, snapshot: registry(1) })
  })
  it('uses first-load legacy groups and reliable partial removals without completing initialization or restoring records', async () => {
    const request = vi.fn().mockRejectedValue(new Error('registry read failed'))
    const client = createProjectRegistry(request, async () => ({ projectPaths: ['/empty'], removedPaths: ['/a'], complete: false }))
    await client.refresh()
    const old = navigationWithRegisteredProjects(empty, registry(1))!
    client.observe(old)
    expect(navigationWithRegisteredProjects(old, client.current().snapshot, client.current())?.projects.map(p => p.projectPath)).toEqual(['/b', '/empty'])
    await client.prepare('/new')
    expect(client.current()).toMatchObject({ unavailable: true, visibilityIncomplete: true, temporaryPaths: expect.arrayContaining(['/new']) })
    expect(request.mock.calls.every(([method]) => method === 'projects.get')).toBe(true)
    await expect(client.prepare('/a')).rejects.toThrow('已移除')
  })

  it('bounds first-load waits and never waits for a slow refresh when a snapshot is available', async () => {
    vi.useFakeTimers()
    let finish!: (value: ProjectRegistrySnapshot) => void
    const request = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const client = createProjectRegistry(request, async () => ({ projectPaths: [], removedPaths: [] }))
    const initial = client.refresh()
    await vi.advanceTimersByTimeAsync(PROJECT_REGISTRY_WAIT_MS)
    await initial
    expect(client.current().unavailable).toBe(true)
    finish(registry(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(client.current().unavailable).toBe(false)
    await client.refresh()
    expect(request).toHaveBeenCalledTimes(2)
    expect(client.current().snapshot?.revision).toBe(1)
  })

  it('skips registration for an existing project and permits temporary use after an isolated save failure, while rejecting path/permission failures', async () => {
    const unavailable = Object.assign(new Error('registration failed'), { code: 'project_registry_unavailable' })
    const request = vi.fn().mockImplementation(async method => {
      if (method === 'projects.get') return registry(1)
      throw unavailable
    })
    const client = createProjectRegistry(request, async () => ({ projectPaths: [], removedPaths: [] }))
    await client.get()
    await client.prepare('/a')
    expect(request.mock.calls.map(([method]) => method)).toEqual(['projects.get'])
    await client.prepare('/temporary')
    expect(client.current().temporaryPaths).toContain('/temporary')
    request.mockRejectedValue(Object.assign(new Error('Permission denied'), { kind: 'domain_rejection' }))
    await expect(client.prepare('/denied')).rejects.toThrow('Permission denied')
    await expect(client.prepare('relative/path')).rejects.toThrow('路径无效')
    expect(client.current().temporaryPaths).not.toContain('/denied')
  })

  it('reconciles only missing temporary paths and gives newer removals precedence without replaying business requests', async () => {
    let available = false
    const writes: { command: { projectPath: string; expectedVersion: number } }[] = []
    let saved: ProjectRegistrySnapshot = { initialized: true, revision: 3, projects: [{ projectPath: '/removed', removed: true, version: 2 }] }
    const request = vi.fn(async (method: CoreMethod, params?: unknown) => {
      if (!available) throw Object.assign(new Error('unavailable'), { code: 'project_registry_unavailable' })
      if (method === 'projects.get') return saved
      const input = params as typeof writes[number]
      writes.push(input)
      saved = { ...saved, revision: 4, projects: [...saved.projects, { projectPath: input.command.projectPath, removed: false, version: 1 }] }
      return { status: 'applied', payload: saved }
    })
    const client = createProjectRegistry(request as Parameters<typeof createProjectRegistry>[0], async () => ({ projectPaths: [], removedPaths: [] }))
    await client.prepare('/removed'); await client.prepare('/kept')
    available = true
    await client.get()
    await vi.waitFor(() => expect(client.current().temporaryPaths).toEqual([]))
    expect(writes.map(p => p.command)).toEqual([{ projectPath: '/kept', removed: false, expectedVersion: 0 }])
    expect(client.current().removedPaths).toEqual(['/removed'])
    expect(request.mock.calls.every(([method]) => ['projects.get', 'projects.set'].includes(method))).toBe(true)
  })

  it('accepts an already satisfied target after a conflict reread but never restores a newer removal', async () => {
    let latest = registry(1)
    const request = vi.fn(async (method: CoreMethod) => method === 'projects.get' ? latest : { status: 'rejected', payload: { message: 'changed' } })
    const client = createProjectRegistry(request as Parameters<typeof createProjectRegistry>[0], async () => ({ projectPaths: [], removedPaths: [] }))
    await client.get()
    latest = registry(2)
    await expect(client.change('/a', false)).resolves.toMatchObject({ revision: 2 })
    latest = registry(3, true)
    await expect(client.change('/a', false)).rejects.toThrow('changed')
    expect(client.current().removedPaths).toEqual(['/a'])
    expect(request.mock.calls.filter(([method]) => method === 'projects.set')).toHaveLength(2)
  })

  it('does not replay a timed-out add or let its late acknowledgement override a newer removal', async () => {
    vi.useFakeTimers()
    let value: ProjectRegistrySnapshot = { initialized: true, revision: 1, projects: [] }
    let finish!: (value: unknown) => void
    const writes: unknown[] = []
    const request = async (method: CoreMethod, params?: unknown): Promise<unknown> => {
      if (method === 'projects.get') return value
      writes.push(params)
      return new Promise(resolve => { finish = resolve })
    }
    const client = createProjectRegistry(request as Parameters<typeof createProjectRegistry>[0], async () => ({ projectPaths: [], removedPaths: [] }))
    await client.get()
    const add = client.prepare('/a')
    await vi.advanceTimersByTimeAsync(PROJECT_REGISTRY_WAIT_MS)
    await add
    expect(client.current().temporaryPaths).toEqual(['/a'])
    value = { initialized: true, revision: 3, projects: [{ projectPath: '/a', removed: true, version: 2 }] }
    await client.get()
    finish({ status: 'applied', payload: { initialized: true, revision: 2, projects: [{ projectPath: '/a', removed: false, version: 1 }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.current()).toMatchObject({ temporaryPaths: [], removedPaths: ['/a'], snapshot: { revision: 3 } })
    expect(writes).toHaveLength(1)
  })

})
