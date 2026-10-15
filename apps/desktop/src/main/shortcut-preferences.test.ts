import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ShortcutPreferencesStore } from './shortcut-preferences'
import { shortcutDefaults } from '../shared/shortcuts'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'rovai-shortcuts-')); directories.push(directory)
  const path = join(directory, 'shortcuts.json')
  return { path, store: new ShortcutPreferencesStore(path, 'darwin') }
}
it('preserves corrupt input until an explicit successful save', async () => {
  const { path, store } = await fixture()
  await writeFile(path, '{broken'); await store.load()
  expect(store.get()).toEqual({ revision: 0, preferences: shortcutDefaults(), degraded: true })
  expect(await readFile(path, 'utf8')).toBe('{broken')
  await store.save({ expectedRevision: 0, preferences: shortcutDefaults() })
  expect(store.get().degraded).toBe(false)
})
it('persists keyboard and mouse together, survives reload, and does not expose mutable state', async () => {
  const { path, store } = await fixture(); await store.load()
  const preferences = shortcutDefaults(); preferences.bindings.latest = 'Ctrl+Shift+K'; preferences.mouse.side1 = 'latest'; preferences.sendMode = 'primary-enter'
  await store.save({ expectedRevision: 0, preferences })
  preferences.bindings.latest = null
  const loaded = new ShortcutPreferencesStore(path, 'darwin'); await loaded.load()
  expect(loaded.get().preferences.bindings.latest).toBe('Ctrl+Shift+K')
  expect(loaded.get().preferences.mouse.side1).toBe('latest')
  expect(loaded.get().preferences.sendMode).toBe('primary-enter')
  const snapshot = loaded.get(); snapshot.preferences.bindings.latest = null
  expect(loaded.get().preferences.bindings.latest).toBe('Ctrl+Shift+K')
})
it('serializes concurrent saves and rejects stale writers without dropping the first update', async () => {
  const { store } = await fixture(); await store.load()
  const first = shortcutDefaults(); first.bindings.latest = 'Alt+L'
  const second = shortcutDefaults(); second.mouse.side1 = 'back'
  const results = await Promise.allSettled([store.save({ expectedRevision: 0, preferences: first }), store.save({ expectedRevision: 0, preferences: second })])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect(store.get()).toEqual({ revision: 1, preferences: first, degraded: false })
})
it('keeps live state unchanged after a write failure and can retry', async () => {
  const { path, store } = await fixture(); await store.load(); await mkdir(path)
  const next = shortcutDefaults(); next.mouse.side2 = 'preview'
  await expect(store.save({ expectedRevision: 0, preferences: next })).rejects.toThrow()
  expect(store.get()).toEqual({ revision: 0, preferences: shortcutDefaults(), degraded: false })
  await rm(path, { recursive: true }); await store.save({ expectedRevision: 0, preferences: next })
  expect(store.get().revision).toBe(1)
})
it('rejects invalid untrusted IPC input before writing', async () => {
  const { store } = await fixture(); await store.load()
  await expect(store.save(null as never)).rejects.toThrow()
  const preferences = shortcutDefaults(); preferences.bindings.latest = 'K'
  await expect(store.save({ expectedRevision: 0, preferences })).rejects.toThrow()
  expect(store.get().revision).toBe(0)
})
