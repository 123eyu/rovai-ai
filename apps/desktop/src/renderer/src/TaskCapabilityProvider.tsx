import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ThreadClient } from './camp-client'

interface TaskCapability {
  enabled: boolean
  ready: boolean
  saving: boolean
  error: 'read' | 'save' | null
  setEnabled(enabled: boolean): Promise<void>
  retry(): Promise<void>
}
const unavailable: TaskCapability = { enabled: false, ready: false, saving: false, error: null, setEnabled: async () => {}, retry: async () => {} }
const Context = createContext<TaskCapability>(unavailable)
export const useTaskCapability = (): TaskCapability => useContext(Context)

/** This is a Host projection, never a second persisted preference. Changing
 * clients immediately invalidates the old value and every outstanding response. */
export function TaskCapabilityProvider({ client, children }: { client: ThreadClient; children: ReactNode }): React.JSX.Element {
  const [state, setState] = useState({ client, enabled: false, ready: false, saving: false, error: null as TaskCapability['error'] })
  const current = useRef(client)
  // A return to a cached client is still a new Host visit.
  const clientGeneration = useRef(0)
  const version = useRef(0)
  const pendingSave = useRef<boolean | null>(null)
  const saving = useRef(false)
  if (current.current !== client) { current.current = client; clientGeneration.current++; version.current++; pendingSave.current = null; saving.current = false }
  const reload = useCallback(async () => {
    const request = ++version.current
    try {
      const next = await client.request<{ enabled: boolean }>('preferences.tasks.get', {})
      if (typeof next?.enabled !== 'boolean') throw new Error('Invalid Task capability')
      if (current.current === client && request === version.current) setState(old => ({ ...old, client, enabled: next.enabled, ready: true, error: old.error === 'save' ? 'save' : null }))
    } catch {
      if (current.current === client && request === version.current) setState(old => ({ ...old, client, enabled: false, ready: false, error: old.error === 'save' ? 'save' : 'read' }))
    }
  }, [client])
  useEffect(() => {
    setState({ client, enabled: false, ready: false, saving: false, error: null })
    void reload()
    const event = client.onEvent?.(value => { if (value.method === 'preferences.tasks_changed') void reload() })
    const invalidation = client.onInvalidated?.(change => {
      if (!change || change.resync) {
        setState(old => ({ ...old, client, enabled: false, ready: false }))
        void reload()
      } else if (change.tasksChanged) void reload()
    })
    const focus = (): void => { void reload() }
    window.addEventListener('focus', focus)
    return () => { version.current++; event?.(); invalidation?.(); window.removeEventListener('focus', focus) }
  }, [client, reload])
  const setEnabled = useCallback(async (enabled: boolean) => {
    if (saving.current) return
    saving.current = true
    pendingSave.current = enabled
    const generation = clientGeneration.current
    const request = ++version.current
    setState(old => ({ ...old, client, saving: true, error: null }))
    try {
      const next = await client.request<{ enabled: boolean }>('preferences.tasks.set', { enabled })
      if (typeof next?.enabled !== 'boolean') throw new Error('Invalid Task preference receipt')
      if (current.current !== client || generation !== clientGeneration.current) return
      pendingSave.current = null
      if (request === version.current) setState(old => ({ ...old, client, enabled: next.enabled, ready: true, error: null }))
      void reload()
    } catch {
      if (current.current === client && generation === clientGeneration.current) setState(old => ({ ...old, error: 'save' }))
    } finally {
      if (current.current === client && generation === clientGeneration.current) { saving.current = false; setState(old => ({ ...old, saving: false })) }
    }
  }, [client, reload])
  const value = state.client === client ? state : { ...unavailable, client }
  return <Context.Provider value={{ ...value, setEnabled, retry: () => pendingSave.current === null ? reload() : setEnabled(pendingSave.current) }}>{children}</Context.Provider>
}
