import { newCommandId } from '../../shared/command-id'
import type { CoreMethod, LegacyProjectDirectories, NavigationSnapshot, ProjectRegistrySnapshot, StoredCommandResult } from '@contracts'
import { isLegacyProjectPath } from '../../shared/navigation-preferences-model'
import { CURRENT_PROJECT_STORAGE_KEY, projectTargetKey } from './new-conversation-preferences'

export interface ProjectRegistryView {
  snapshot: ProjectRegistrySnapshot | null
  temporaryPaths: string[]
  removedPaths: string[]
  unavailable: boolean
  visibilityIncomplete: boolean
}
export interface ProjectRegistry {
  get(): Promise<ProjectRegistrySnapshot>
  current(): ProjectRegistryView
  refresh(): Promise<void>
  observe(navigation: NavigationSnapshot): void
  prepare(projectPath: string, explicitRestore?: boolean): Promise<void>
  change(projectPath: string, removed: boolean): Promise<ProjectRegistrySnapshot>
  subscribe(listener: (view: ProjectRegistryView) => void): () => void
}

type Request = <T>(method: CoreMethod, params?: unknown) => Promise<T>
// Bounds only presentation/optional registration. The transport retains its own
// timeout and command receipt; business requests are neither cancelled nor replayed.
export const PROJECT_REGISTRY_WAIT_MS = 500
class RegistryWaitExpired extends Error {}
function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RegistryWaitExpired()), PROJECT_REGISTRY_WAIT_MS)
    operation.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
function optionalSaveFailure(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return error instanceof RegistryWaitExpired || code === 'project_registry_unavailable' || code === 'core_request_timeout'
}

export function captureLegacyProjectInitialization(read: () => Promise<LegacyProjectDirectories>, storage?: Pick<Storage, 'getItem'>): () => Promise<LegacyProjectDirectories> {
  let selectedPath: string | null = null
  try {
    const selected = (storage ?? globalThis.localStorage)?.getItem(CURRENT_PROJECT_STORAGE_KEY)
    const current = selected ? JSON.parse(selected) : null
    if (current?.kind === 'directory' && isLegacyProjectPath(current.projectPath)) selectedPath = current.projectPath
  } catch { /* Optional selection cannot block the authoritative legacy read. */ }
  return async () => {
    const previous = await read()
    return { ...previous, projectPaths: [...new Set([...previous.projectPaths, ...(selectedPath ? [selectedPath] : [])])] }
  }
}

export function createProjectRegistry(request: Request, legacy: () => Promise<LegacyProjectDirectories>, browserScopeId?: () => string | Promise<string>): ProjectRegistry {
  let snapshot: ProjectRegistrySnapshot | null = null
  let reading: Promise<ProjectRegistrySnapshot> | null = null
  let reconciling: Promise<void> | null = null
  let failed = false
  let legacyComplete = false
  const temporary = new Set<string>()
  const legacyRemoved = new Set<string>()
  const listeners = new Set<(value: ProjectRegistryView) => void>()
  const scope = async (): Promise<{ browserScopeId?: string }> => browserScopeId ? { browserScopeId: await browserScopeId() } : {}
  const current = (): ProjectRegistryView => ({ snapshot, temporaryPaths: [...temporary],
    removedPaths: snapshot?.initialized ? snapshot.projects.filter(p => p.removed).map(p => p.projectPath) : [...legacyRemoved],
    unavailable: failed || (snapshot?.initialized === true && temporary.size > 0),
    visibilityIncomplete: !snapshot?.initialized && !legacyComplete })
  const publish = (): void => { const value = current(); for (const listener of listeners) listener(value) }
  const accept = (value: ProjectRegistrySnapshot): ProjectRegistrySnapshot => {
    if (!snapshot || value.revision > snapshot.revision) snapshot = value
    for (const project of snapshot.projects) temporary.delete(project.projectPath)
    publish()
    return snapshot
  }
  const changeAtVersion = async (projectPath: string, removed: boolean, expectedVersion: number): Promise<ProjectRegistrySnapshot> => {
    const params = { ...await scope(), commandId: newCommandId(), command: { projectPath, removed, expectedVersion } }
    let result: StoredCommandResult
    try { result = await request<StoredCommandResult>('projects.set', params) }
    catch (error) {
      // Retry an uncertain acknowledgement with exactly the same durable identity.
      if ((error as { kind?: string })?.kind === 'domain_rejection') throw error
      result = await request<StoredCommandResult>('projects.set', params)
    }
    if (result.status !== 'applied') {
      // A read already in flight may predate this conflict. Confirm with a new read.
      if (reading) await reading.catch(() => undefined)
      const latest = await get()
      if (latest.projects.some(p => p.projectPath === projectPath && p.removed === removed)) return latest
      throw new Error(String(result.payload.message ?? '项目状态已变化，请重新操作。'))
    }
    const next = accept(result.payload as unknown as ProjectRegistrySnapshot)
    if (!next.projects.some(p => p.projectPath === projectPath && p.removed === removed)) throw new Error('项目状态已变化，请重新操作。')
    return next
  }
  const reconcile = (): void => {
    if (reconciling || !snapshot?.initialized || temporary.size === 0) return
    const operation = (async () => {
      for (const path of [...temporary]) {
        if (snapshot?.projects.some(p => p.projectPath === path)) { temporary.delete(path); continue }
        // Recovery can ONLY fill an absent record. It never rebases a restore onto
        // a newer tombstone, and never repeats Thread creation or message sending.
        try { await changeAtVersion(path, false, 0) } catch { failed = true }
      }
      publish()
    })()
    reconciling = operation
    void operation.finally(() => { if (reconciling === operation) reconciling = null }).catch(() => undefined)
  }
  const get = (): Promise<ProjectRegistrySnapshot> => {
    if (reading) return reading
    const operation = (async () => {
      // Read independently so even an unavailable registry can use reliable legacy
      // removals. An incomplete read is presentation-only, never an initialization.
      const previous = !snapshot?.initialized ? legacy().then(value => {
        if (snapshot?.initialized) return value
        legacyComplete = value.complete !== false
        for (const path of value.removedPaths) { legacyRemoved.add(path); temporary.delete(path) }
        for (const path of value.projectPaths) if (!legacyRemoved.has(path)) temporary.add(path)
        publish()
        return value
      }) : null
      void previous?.catch(() => undefined)
      let value = await request<ProjectRegistrySnapshot>('projects.get', await scope())
      accept(value)
      if (!value.initialized) {
        const input = await previous!
        if (input.complete === false) throw new Error('Project display preferences are incomplete')
        value = await request<ProjectRegistrySnapshot>('projects.initialize', { ...await scope(), projectPaths: input.projectPaths, removedPaths: input.removedPaths })
      }
      failed = false
      return accept(value)
    })()
    reading = operation
    void operation.finally(() => { if (reading === operation) reading = null }).catch(() => undefined)
    void operation.then(() => { reconcile() }, () => { failed = true; publish() })
    return operation
  }
  const refresh = async (): Promise<void> => {
    const operation = get()
    if (snapshot?.initialized) { void operation.catch(() => undefined); return }
    try { await bounded(operation) } catch { failed = true; publish() }
  }
  return {
    get, current, refresh,
    subscribe(listener) { listeners.add(listener); listener(current()); return () => { listeners.delete(listener) } },
    observe(navigation) {
      for (const { projectPath } of navigation.projects) {
        if (!snapshot?.projects.some(p => p.projectPath === projectPath) && !legacyRemoved.has(projectPath)) temporary.add(projectPath)
      }
      publish()
      reconcile()
    },
    async change(projectPath, removed) {
      const before = snapshot?.initialized ? snapshot : await get()
      const version = before.projects.find(p => p.projectPath === projectPath)?.version ?? 0
      return changeAtVersion(projectPath, removed, version)
    },
    async prepare(projectPath, explicitRestore = false) {
      if (!isLegacyProjectPath(projectPath)) throw new Error('项目目录路径无效，请重新选择。')
      if (!snapshot?.initialized) await refresh()
      const known = snapshot?.projects.find(p => p.projectPath === projectPath)
      if (known && !known.removed) return
      if ((known?.removed || (!snapshot?.initialized && legacyRemoved.has(projectPath))) && (!explicitRestore || !snapshot?.initialized)) {
        throw new Error('该项目已移除，请重新添加后使用。')
      }
      if (snapshot?.initialized) {
        try { await bounded(changeAtVersion(projectPath, false, known?.version ?? 0)); return }
        catch (error) { if (!optionalSaveFailure(error) || known?.removed) throw error }
      }
      const latest = snapshot?.projects.find(p => p.projectPath === projectPath)
      if (latest?.removed || (!snapshot?.initialized && legacyRemoved.has(projectPath))) throw new Error('该项目已移除，请重新添加后使用。')
      if (latest && !latest.removed) return
      temporary.add(projectPath)
      failed = true
      publish()
    }
  }
}

/** Runtime fallback never changes registration or grants directory/Skill access. */
export function navigationWithRegisteredProjects(navigation: NavigationSnapshot | null, registry: ProjectRegistrySnapshot | null, view?: ProjectRegistryView): NavigationSnapshot | null {
  if (!navigation && !registry && !view?.temporaryPaths.length) return null
  const source = navigation ?? { schemaVersion: 3, throughGlobalSequence: 0, quickChat: { totalCount: 0, recentThreads: [] }, projects: [] }
  const groups = new Map(source.projects.map(project => [project.projectPath, project]))
  const removed = new Set([...(view?.removedPaths ?? []), ...(registry?.projects.filter(p => p.removed).map(p => p.projectPath) ?? [])])
  const paths = new Set([...(registry?.initialized ? registry.projects.filter(p => !p.removed).map(p => p.projectPath) : groups.keys()), ...(view?.temporaryPaths ?? [])])
  return { ...source, projects: [...paths].filter(path => !removed.has(path)).map(projectPath => groups.get(projectPath) ?? {
    projectKey: projectTargetKey(projectPath), projectPath, name: projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? projectPath,
    totalCount: 0, recentThreads: [], lastActivityAt: '', lastActivityGlobalSequence: 0
  }) }
}
