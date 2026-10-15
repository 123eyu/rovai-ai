import { readFile } from 'node:fs/promises'
import type { ShortcutPreferencesApi, ShortcutPreferencesSnapshot } from '@contracts'
import { parseShortcutPreferences, shortcutDefaults } from '../shared/shortcuts'
import { writePrivateJson } from './general-preferences'

export class ShortcutPreferencesStore {
  #snapshot: ShortcutPreferencesSnapshot = { revision: 0, preferences: shortcutDefaults(), degraded: false }
  #tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly path: string, private readonly platform: NodeJS.Platform) {}
  async load(): Promise<void> {
    try {
      const preferences = parseShortcutPreferences(JSON.parse(await readFile(this.path, 'utf8')), this.platform)
      if (!preferences) throw new Error('Invalid shortcuts')
      this.#snapshot = { revision: 0, preferences, degraded: false }
    } catch (error) {
      this.#snapshot.degraded = !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    }
  }
  get(): ShortcutPreferencesSnapshot { return structuredClone(this.#snapshot) }
  save(input: Parameters<ShortcutPreferencesApi['save']>[0]): Promise<ShortcutPreferencesSnapshot> {
    const preferences = parseShortcutPreferences(input?.preferences, this.platform)
    if (!preferences || !Number.isSafeInteger(input?.expectedRevision)) return Promise.reject(new Error('快捷键设置无效，请重新录制。'))
    const expectedRevision = input.expectedRevision
    const operation = this.#tail.then(async () => {
      if (expectedRevision !== this.#snapshot.revision) throw new Error('快捷键设置已在其他窗口更新，请确认后重试保存。')
      await writePrivateJson(this.path, preferences)
      this.#snapshot = { revision: this.#snapshot.revision + 1, preferences, degraded: false }
      return this.get()
    })
    this.#tail = operation.catch(() => undefined)
    return operation
  }
}
