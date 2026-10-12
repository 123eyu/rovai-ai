import type { ProjectRegistrySnapshot } from '@contracts'
import type { ProjectRegistry, ProjectRegistryView } from '../../../apps/desktop/src/renderer/src/project-registry'

/** UI fixture only; persistence and conflict acceptance belong to Core tests. */
export function projectRegistryFixture(paths: string[]): ProjectRegistry {
  let snapshot: ProjectRegistrySnapshot = { initialized: true, revision: 1,
    projects: paths.map(projectPath => ({ projectPath, removed: false, version: 1 })) }
  const listeners = new Set<(view: ProjectRegistryView) => void>()
  const current = (): ProjectRegistryView => ({ snapshot, temporaryPaths: [], removedPaths: snapshot.projects.filter(p => p.removed).map(p => p.projectPath), unavailable: false, visibilityIncomplete: false })
  return {
    current, refresh: async () => {}, observe: () => {}, prepare: async () => {},
    get: async () => { listeners.forEach(listener => listener(current())); return snapshot },
    subscribe: listener => { listeners.add(listener); listener(current()); return () => { listeners.delete(listener) } },
    change: async (projectPath, removed) => {
      const prior = snapshot.projects.find(project => project.projectPath === projectPath)
      snapshot = { ...snapshot, revision: snapshot.revision + 1, projects: [
        ...snapshot.projects.filter(project => project.projectPath !== projectPath),
        { projectPath, removed, version: (prior?.version ?? 0) + 1 }
      ] }
      listeners.forEach(listener => listener(current()))
      return snapshot
    }
  }
}
