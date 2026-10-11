import type { ProjectRegistrySnapshot } from '@contracts'
import type { ProjectRegistry } from '../../../apps/desktop/src/renderer/src/project-registry'

/** UI fixture only; persistence and conflict acceptance belong to Core tests. */
export function projectRegistryFixture(paths: string[]): ProjectRegistry {
  let snapshot: ProjectRegistrySnapshot = { initialized: true, revision: 1,
    projects: paths.map(projectPath => ({ projectPath, removed: false, version: 1 })) }
  const listeners = new Set<(snapshot: ProjectRegistrySnapshot) => void>()
  return {
    get: async () => { listeners.forEach(listener => listener(snapshot)); return snapshot },
    subscribe: listener => { listeners.add(listener); listener(snapshot); return () => { listeners.delete(listener) } },
    change: async (projectPath, removed) => {
      const prior = snapshot.projects.find(project => project.projectPath === projectPath)
      snapshot = { ...snapshot, revision: snapshot.revision + 1, projects: [
        ...snapshot.projects.filter(project => project.projectPath !== projectPath),
        { projectPath, removed, version: (prior?.version ?? 0) + 1 }
      ] }
      listeners.forEach(listener => listener(snapshot))
      return snapshot
    }
  }
}
