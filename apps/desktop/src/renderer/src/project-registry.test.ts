import { describe, expect, it, vi } from 'vitest'
import type { CoreMethod, NavigationSnapshot, ProjectRegistrySnapshot } from '@contracts'
import { EMPTY_SNAPSHOT } from '../../shared/navigation-preferences-model'
import { createProjectRegistry, legacyProjectPaths, navigationWithRegisteredProjects } from './project-registry'

const registry = (revision: number, removed = false): ProjectRegistrySnapshot => ({ initialized: true, revision,
  projects: [{ projectPath: '/a', version: revision, removed }, { projectPath: '/b', version: 1, removed: false }] })
const empty: NavigationSnapshot = { schemaVersion: 3, throughGlobalSequence: 0, projects: [], quickChat: { totalCount: 0, recentThreads: [] } }
const storage = (): Storage => {
  const values = new Map<string, string>()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) }, clear: () => values.clear(), key: index => [...values.keys()][index] ?? null, get length() { return values.size } }
}

describe('SQLite project registration client', () => {
  it('keeps every registered empty directory, hides tombstones even with old groups, and retains entries without a Thread read', () => {
    const all = navigationWithRegisteredProjects(empty, registry(1))!
    expect(all.projects.map(project => [project.projectPath, project.totalCount, project.recentThreads])).toEqual([['/a', 0, []], ['/b', 0, []]])
    const removed = navigationWithRegisteredProjects({ ...all, projects: all.projects.map(project => ({ ...project, totalCount: 1 })) }, registry(2, true))!
    expect(removed.projects.map(project => project.projectPath)).toEqual(['/b'])
    expect(navigationWithRegisteredProjects(null, registry(1))?.projects).toHaveLength(2)
    expect(navigationWithRegisteredProjects(all, null)?.projects).toEqual([])
    expect(navigationWithRegisteredProjects(removed, registry(3))?.projects.map(project => project.projectPath)).toEqual(['/a', '/b'])
  })

  it('imports identifiable selected empty directories and legacy removal, and refuses unreadable storage', () => {
    const local = storage()
    local.setItem('rovai.current-project.v1', JSON.stringify({ kind: 'directory', projectPath: '/selected' }))
    expect(legacyProjectPaths({ ...EMPTY_SNAPSHOT, projectOrder: ['directory:/a'], removedProjects: [{ targetKey: 'directory:/a', removedAt: '2026-10-11' }] }, local))
      .toEqual({ projectPaths: ['/a', '/selected'], removedPaths: ['/a'] })
    local.setItem('rovai.current-project.v1', '{broken')
    expect(() => legacyProjectPaths(EMPTY_SNAPSHOT, local)).toThrow()
    expect(() => legacyProjectPaths(EMPTY_SNAPSHOT, { getItem() { throw new Error('unavailable') } } as unknown as Storage)).toThrow('unavailable')
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
    const values: ProjectRegistrySnapshot[] = []
    client.subscribe(value => values.push(value))
    await client.get()
    const lateRead = client.get()
    await client.change('/a', true)
    finishRead(registry(1))
    expect((await lateRead).projects[0].removed).toBe(true)
    expect(writes[0]).toEqual(writes[1])
    expect(values.map(value => value.revision)).toEqual([1, 2])
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
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].projects).toHaveLength(2)
  })
})
