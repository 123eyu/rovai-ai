import type { GeneralPreferencesSnapshot } from '@contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_GENERAL_PREFERENCES } from './general-preferences-model'
import { creationPreferences, withHostConversationPreferences } from './host-general-preferences'

function localPreferences(initial: GeneralPreferencesSnapshot) {
  let snapshot = structuredClone(initial)
  const commit = async (patch: Partial<GeneralPreferencesSnapshot>): Promise<GeneralPreferencesSnapshot> => {
    snapshot = { ...snapshot, ...patch }
    return structuredClone(snapshot)
  }
  return {
    get: async () => structuredClone(snapshot),
    setInterfaceLanguage: (interfaceLanguage: GeneralPreferencesSnapshot['interfaceLanguage']) => commit({ interfaceLanguage }),
    setStartupLocationMode: (startupLocationMode: GeneralPreferencesSnapshot['startupLocationMode']) => commit({ startupLocationMode }),
    setLastSettingsSection: (lastSettingsSection: GeneralPreferencesSnapshot['lastSettingsSection']) => commit({ lastSettingsSection }),
    setExecutionConsolePlacement: (executionConsolePlacement: GeneralPreferencesSnapshot['executionConsolePlacement']) => commit({ executionConsolePlacement }),
    setWorldMapEnabled: (worldMapEnabled: boolean) => commit({ worldMapEnabled }),
    setNewConversationDefaults: async () => structuredClone(snapshot),
    setOneClickNewConversationEnabled: async () => structuredClone(snapshot),
    invalidateNewConversationDefaults: async () => structuredClone(snapshot)
  }
}

describe('Host-backed general preferences', () => {
  it('does not block local presentation changes on a second Host read', async () => {
    const local = localPreferences(DEFAULT_GENERAL_PREFERENCES)
    const shared = creationPreferences(DEFAULT_GENERAL_PREFERENCES)
    let hostReads = 0
    const preferences = withHostConversationPreferences(local, async <T>() => {
      hostReads += 1
      if (hostReads > 1) throw new Error('Host read is unavailable')
      return structuredClone(shared) as T
    })

    await preferences.get()
    const updated = await preferences.setExecutionConsolePlacement('bottom')

    expect(updated.executionConsolePlacement).toBe('bottom')
    expect(hostReads).toBe(1)
  })

  it('loads Host-owned creation preferences before the first local presentation change returns', async () => {
    const local = localPreferences(DEFAULT_GENERAL_PREFERENCES)
    const shared = creationPreferences({
      ...DEFAULT_GENERAL_PREFERENCES,
      newConversationDefaults: { memberAgentIds: ['agent-a'], defaultLeadAgentId: 'agent-a' },
      oneClickNewConversationEnabled: true
    })
    let hostReads = 0
    const preferences = withHostConversationPreferences(local, async <T>() => {
      hostReads += 1
      return structuredClone(shared) as T
    })

    const updated = await preferences.setWorldMapEnabled(false)

    expect(updated).toMatchObject({
      worldMapEnabled: false,
      newConversationDefaults: shared.newConversationDefaults,
      oneClickNewConversationEnabled: true
    })
    expect(hostReads).toBe(1)
  })

  it.each([null, { memberAgentIds: ['agent-a'], defaultLeadAgentId: 'agent-a' }])(
    'keeps confirmed Team B when a stale Team A observation is invalidated (Custom: %j)', async defaults => {
      let shared = creationPreferences({ ...DEFAULT_GENERAL_PREFERENCES,
        newConversationTeamId: 'team-A', newConversationDefaults: defaults, oneClickNewConversationEnabled: true })
      let invalidation: unknown
      const preferences = withHostConversationPreferences(localPreferences(DEFAULT_GENERAL_PREFERENCES), async <T>(method: string, params?: unknown) => {
        if (method === 'preferences.newConversation.setTeam') {
          shared = { ...shared, newConversationTeamId: (params as { teamId: string }).teamId, newConversationDefaultsRequireConfirmation: false }
        } else if (method === 'preferences.newConversation.invalidate') {
          invalidation = params
          const expected = params as { expectedTeamId: string | null; expectedDefaults: unknown }
          // The Host accepts invalidation only when both source fields still match.
          if (expected.expectedTeamId === shared.newConversationTeamId && JSON.stringify(expected.expectedDefaults) === JSON.stringify(shared.newConversationDefaults)) {
            shared = { ...shared, newConversationDefaultsRequireConfirmation: true }
          }
        }
        return structuredClone(shared) as T
      })

      const stale = await preferences.get()
      await preferences.setNewConversationTeam('team-B')
      const expected = { expectedTeamId: stale.newConversationTeamId, expectedDefaults: stale.newConversationDefaults }
      const result = await preferences.invalidateNewConversationDefaults(expected)

      expect(invalidation).toEqual(expected)
      expect(result).toMatchObject({ newConversationTeamId: 'team-B', newConversationDefaultsRequireConfirmation: false, oneClickNewConversationEnabled: true })
      expect(await preferences.get()).toEqual(result)
    }
  )
})
