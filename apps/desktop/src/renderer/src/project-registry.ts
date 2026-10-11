import { newCommandId } from '../../shared/command-id'
import type { CoreMethod, LegacyProjectDirectories, NavigationSnapshot, ProjectRegistrySnapshot, StoredCommandResult } from '@contracts'
import { isLegacyProjectPath } from '../../shared/navigation-preferences-model'
import { CURRENT_PROJECT_STORAGE_KEY, projectTargetKey } from './new-conversation-preferences'

export interface ProjectRegistry {
  get(): Promise<ProjectRegistrySnapshot>
  change(projectPath: string, removed: boolean): Promise<ProjectRegistrySnapshot>
  subscribe(listener: (snapshot: ProjectRegistrySnapshot) => void): () => void
}

type Request = <T>(method: CoreMethod, params?: unknown) => Promise<T>

export function captureLegacyProjectInitialization(read: () => Promise<LegacyProjectDirectories>, storage?: Pick<Storage, 'getItem'>): () => Promise<LegacyProjectDirectories> {
  // Capture before startup restoration can replace the selected directory.
  // This synchronous optional read does not delay the route or any Core request.
  let selectedPath: string | null = null
  try {
    const selected = (storage ?? globalThis.localStorage)?.getItem(CURRENT_PROJECT_STORAGE_KEY)
    const current = selected ? JSON.parse(selected) : null
    if (current?.kind === 'directory' && isLegacyProjectPath(current.projectPath)) selectedPath = current.projectPath
  } catch { /* A missing/invalid optional selection cannot block the authoritative legacy read. */ }
  return async () => {
    const previous = await read()
    return { ...previous, projectPaths: [...new Set([...previous.projectPaths, ...(selectedPath ? [selectedPath] : [])])] }
  }
}

export function createProjectRegistry(request: Request, legacy: () => Promise<{ projectPaths: string[]; removedPaths: string[] }>, browserScopeId?: () => string | Promise<string>): ProjectRegistry {
  let snapshot: ProjectRegistrySnapshot | null = null
  let reading: Promise<ProjectRegistrySnapshot> | null = null
  const listeners = new Set<(value: ProjectRegistrySnapshot) => void>()
  const scope = async (): Promise<{ browserScopeId?: string }> => browserScopeId ? { browserScopeId: await browserScopeId() } : {}
  const accept = (value: ProjectRegistrySnapshot): ProjectRegistrySnapshot => {
    if (!snapshot || value.revision > snapshot.revision) {
      snapshot = value
      for (const listener of listeners) listener(value)
    }
    return snapshot
  }
  const get = (): Promise<ProjectRegistrySnapshot> => {
    if (reading) return reading
    const operation = (async () => {
      let value = await request<ProjectRegistrySnapshot>('projects.get', await scope())
      if (!value.initialized) value = await request<ProjectRegistrySnapshot>('projects.initialize', { ...await scope(), ...await legacy() })
      return accept(value)
    })()
    reading = operation
    void operation.finally(() => { if (reading === operation) reading = null }).catch(() => undefined)
    return operation
  }
  return {
    get,
    subscribe(listener) { listeners.add(listener); if (snapshot) listener(snapshot); return () => { listeners.delete(listener) } },
    async change(projectPath, removed) {
      const before = snapshot ?? await get()
      const expectedVersion = before.projects.find(project => project.projectPath === projectPath)?.version ?? 0
      const params = { ...await scope(), commandId: newCommandId(), command: { projectPath, removed, expectedVersion } }
      // A lost reply is retried with the SAME durable command identity, never a
      // fresh restore based on a newer version. Web also reconciles this receipt.
      let result: StoredCommandResult
      try { result = await request<StoredCommandResult>('projects.set', params) }
      catch { result = await request<StoredCommandResult>('projects.set', params) }
      if (result.status !== 'applied') {
        await get()
        throw new Error(String(result.payload.message ?? '项目状态已变化，请刷新后重新操作。'))
      }
      const next = accept(result.payload as unknown as ProjectRegistrySnapshot)
      const current = next.projects.find(project => project.projectPath === projectPath)
      if (!current || current.removed !== removed) throw new Error('项目状态已变化，请刷新后重新操作。')
      return next
    }
  }
}

/** Registry owns membership; the existing navigation read owns all Thread data. */
export function navigationWithRegisteredProjects(navigation: NavigationSnapshot | null, registry: ProjectRegistrySnapshot | null): NavigationSnapshot | null {
  if (!registry?.initialized) return navigation ? { ...navigation, projects: [] } : null
  const source = navigation ?? { schemaVersion: 3, throughGlobalSequence: 0, quickChat: { totalCount: 0, recentThreads: [] }, projects: [] }
  const groups = new Map(source.projects.map(project => [project.projectPath, project]))
  return { ...source, projects: registry.projects.filter(project => !project.removed).map(({ projectPath }) => groups.get(projectPath) ?? {
    projectKey: projectTargetKey(projectPath), projectPath, name: projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath,
    totalCount: 0, recentThreads: [], lastActivityAt: '', lastActivityGlobalSequence: 0
  }) }
}
