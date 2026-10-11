import { isThreadId } from '@contracts'
import { EMPTY_SNAPSHOT, sanitizeSnapshot, sourceMatchesSupportedSnapshot, isProjectTargetKey, isStableId, isTimestamp, isRecord, isNavigationThreadReadState } from '../shared/navigation-preferences-model'
import { readFile } from 'node:fs/promises'
import type {
  NavigationPin,
  NavigationPreferencesSnapshot,
  NavigationThreadReadState,
  StructuredError
} from '@contracts'
import { writePrivateJson } from './general-preferences'
import { normalizeProjectDisplayName, projectDisplayNameError } from '../shared/project-display-name'

export async function readNavigationPreferences(
  filePath: string
): Promise<NavigationPreferencesSnapshot> {
  return (await readNavigationPreferencesResult(filePath)).snapshot
}

async function readNavigationPreferencesResult(filePath: string): Promise<{
  snapshot: NavigationPreferencesSnapshot
  degradation: StructuredError | null
}> {
  let source: unknown
  try {
    source = JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch (error) {
    return {
      snapshot: structuredClone(EMPTY_SNAPSHOT),
      degradation: isMissingPathError(error)
        ? null
        : navigationDegradation(
            'navigation_preferences_unreadable',
            'Navigation preferences could not be read; in-memory defaults are active and the original file was not changed.'
          )
    }
  }

  const snapshot = sanitizeSnapshot(source)
  const changed = !sourceMatchesSupportedSnapshot(source, snapshot)
  return {
    snapshot,
    degradation: changed
      ? navigationDegradation(
          'navigation_preferences_invalid',
          'Navigation preferences required in-memory normalization; the original file was not changed.'
        )
      : null
  }
}

export class NavigationPreferencesStore {
  readonly #filePath: string
  #snapshot: NavigationPreferencesSnapshot
  readonly loadDegradation: StructuredError | null
  #writeTail: Promise<void> = Promise.resolve()

  private constructor(
    filePath: string,
    snapshot: NavigationPreferencesSnapshot,
    loadDegradation: StructuredError | null = null
  ) {
    this.#filePath = filePath
    this.#snapshot = snapshot
    this.loadDegradation = loadDegradation
  }

  static async load(
    filePath: string
  ): Promise<NavigationPreferencesStore> {
    const result = await readNavigationPreferencesResult(filePath)
    return new NavigationPreferencesStore(
      filePath,
      result.snapshot,
      result.degradation
    )
  }

  static defaults(
    filePath: string
  ): NavigationPreferencesStore {
    return new NavigationPreferencesStore(filePath, structuredClone(EMPTY_SNAPSHOT))
  }

  get(): NavigationPreferencesSnapshot {
    if (this.loadDegradation) throw new Error(this.loadDegradation.message)
    return structuredClone(this.#snapshot)
  }

  replacePins(pins: NavigationPin[]): Promise<NavigationPreferencesSnapshot> {
    return this.#enqueue(async () => {
      const next = sanitizeSnapshot({
        ...this.#snapshot,
        pins
      })
      await this.#commit(next)
      return this.get()
    })
  }

  setThreadReadState(threadId: string, state: NavigationThreadReadState | null): Promise<NavigationPreferencesSnapshot> {
    if (!isThreadId(threadId) || (state !== null && !isNavigationThreadReadState(state))) {
      return Promise.reject(new Error('Invalid Thread read state'))
    }
    return this.#enqueue(async () => {
      const threadReadStates = { ...this.#snapshot.threadReadStates }
      if (state === null) delete threadReadStates[threadId]
      else threadReadStates[threadId] = {
        manualUnread: state.manualUnread,
        readThroughGlobalSequence: Math.max(state.readThroughGlobalSequence,
          threadReadStates[threadId]?.readThroughGlobalSequence ?? 0)
      }
      await this.#commit({ ...this.#snapshot, threadReadStates })
      return this.get()
    })
  }

  setProjectName(targetKey: string, name: string | null): Promise<NavigationPreferencesSnapshot> {
    if (!isProjectTargetKey(targetKey)) {
      return Promise.reject(new Error('Unsupported Project navigation key'))
    }
    if (name !== null && (typeof name !== 'string' || projectDisplayNameError(name))) {
      return Promise.reject(new Error(typeof name === 'string'
        ? projectDisplayNameError(name)!
        : 'Invalid Project display name'))
    }
    return this.#enqueue(async () => {
      const projectNames = { ...this.#snapshot.projectNames }
      if (name === null) delete projectNames[targetKey]
      else projectNames[targetKey] = normalizeProjectDisplayName(name)
      await this.#commit({ ...this.#snapshot, projectNames })
      return this.get()
    })
  }

  synchronizeProjectOrder(projectKeys: string[]): Promise<NavigationPreferencesSnapshot> {
    if (
      !Array.isArray(projectKeys)
      || !projectKeys.every(isProjectTargetKey)
      || new Set(projectKeys).size !== projectKeys.length
    ) {
      return Promise.reject(new Error('Project navigation keys are invalid'))
    }
    return this.#enqueue(async () => {
      const currentProjectKeys = new Set(projectKeys)
      const retainedProjectKeys = this.#snapshot.projectOrder === null
        ? []
        : this.#snapshot.projectOrder.filter((projectKey) => currentProjectKeys.has(projectKey))
      const retainedProjectKeySet = new Set(retainedProjectKeys)
      const projectOrder = [
        ...retainedProjectKeys,
        ...projectKeys.filter((projectKey) => !retainedProjectKeySet.has(projectKey))
      ]
      const next = sanitizeSnapshot({
        ...this.#snapshot,
        projectOrder
      })
      await this.#commit(next)
      return this.get()
    })
  }

  async #commit(next: NavigationPreferencesSnapshot): Promise<void> {
    if (this.loadDegradation) throw new Error(this.loadDegradation.message)
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return
    await writePrivateJson(this.#filePath, next)
    this.#snapshot = next
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#writeTail.then(operation, operation)
    this.#writeTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function navigationDegradation(code: string, message: string): StructuredError {
  return { code, message, retryable: true, details: {} }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
