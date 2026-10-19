import React, { act, useEffect, useState, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { AgentProfile, Team } from '@contracts'
import { NewConversationDialog } from '../../../apps/desktop/src/renderer/src/NewConversationDialog'
import { ThreadClientProvider } from '../../../apps/desktop/src/renderer/src/camp-client'
import { TeamWorkspace } from '../../../apps/desktop/src/renderer/src/TeamWorkspace'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const check = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const find = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector)
  if (!node) throw new Error(`Missing ${selector}`)
  return node
}
const click = (selector: string) => act(async () => { find(selector).click() })
const type = (selector: string, value: string) => act(async () => {
  const input = find(selector)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

// Real React effects and production BusinessApp handoff. Promise resolution,
// not elapsed time, determines when save and teams.list reach the UI.
export async function runTeamCreationRegression(root: Root, app: ReactNode, client: any, agents: AgentProfile[]) {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const team: Team = { id: 'team-fixture', name: 'Team v1', memberAgentIds: agents.map(a => a.agentId), defaultLeadAgentId: agents[0].agentId, guidance: '', version: 1 }
  const saved = { ...team, name: 'Team v2', version: 2 }
  const save = deferred<any>(), list = deferred<Team[]>()
  let holdList = false, refreshes = 0
  const creations: any[] = []
  const teamWrites: any[] = []
  const request = client.request
  client.request = async (method: string, params: any) => {
    if (method === 'teams.list') { if (holdList) { refreshes++; return list.promise }; return [team] }
    if (method === 'teams.save') { teamWrites.push(params); return save.promise }
    if (method === 'threads.create') {
      creations.push(params)
      // Retain the dialog so the same draft can be submitted after list refresh.
      return { status: 'rejected', code: 'fixture.retry', payload: { message: 'Fixture retry' } }
    }
    return request(method, params)
  }
  await act(async () => { root.render(app) })
  await type('.team-editor-form input', saved.name)
  await click('.team-start-button')
  await click('[role="dialog"] .primary-button')
  holdList = true
  await act(async () => { save.resolve({ status: 'applied', code: 'team.saved', payload: { team: saved } }) })
  check(refreshes > 0, true, 'teams.list is still pending when dialog opens')
  await click('.new-camp-dialog .compact-primary')
  check(creations.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'saved receipt used before list refresh')
  check(find('.team-picker-trigger').textContent?.includes(saved.name), true, 'saved name displayed')
  await act(async () => { list.resolve([saved]) })
  await click('.new-camp-dialog .compact-primary')
  check(creations.length, 2, 'both create attempts were submitted')
  check(creations.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'retry uses saved version')

  const preflight = { admissible: true, blockers: [], initialLeadAgentId: agents[0].agentId,
    presentMembers: agents.map(a => ({ agentId: a.agentId, displayName: a.displayName, memberOrder: a.memberOrder, runtimeConfigured: true, runtimeReadiness: 'ready' as const })) }
  const submitted: any[] = []
  const common = { open: true, initialTeamId: team.id, initialWorkspace: null, agents, projects: [], preflight, busy: false, projectAccessReady: true,
    initialSelection: { memberAgentIds: [agents[0].agentId], defaultLeadAgentId: agents[0].agentId },
    onOpenChange() {}, onChooseWorkspaceDirectory: async () => null, onWorkspaceSelected: async () => {}, onCreate: async (draft: unknown) => { submitted.push(draft) } }
  function LateLibrary({ response }: { response: Promise<Team[]> }) {
    const [teams, setTeams] = useState<Team[]>([])
    useEffect(() => { void response.then(setTeams) }, [response])
    return <ThreadClientProvider client={client}><NewConversationDialog {...common} teams={teams}/></ThreadClientProvider>
  }
  const late = deferred<Team[]>()
  await act(async () => { root.render(<LateLibrary key="late" response={late.promise}/>) })
  check((find('.compact-primary') as HTMLButtonElement).disabled, true, 'unloaded team blocks creation')
  await click('.compact-text-button[aria-controls="new-camp-optional-panel"]')
  await type('#new-camp-name', 'Keep my name')
  await act(async () => { late.resolve([saved]) })
  await click('.compact-primary')
  check(submitted.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'late team completes initial selection')
  check(submitted.at(-1)?.name, 'Keep my name', 'late library preserves edited name')
  await act(async () => { root.render(<LateLibrary key="late" response={Promise.resolve([{ ...saved, version: 3 }])}/>) })
  await click('.compact-primary')
  check(submitted.length, 2, 'external refresh still allows a submission with the frozen version')
  check(submitted.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'external edits do not silently replace the selected snapshot')

  const switched = deferred<Team[]>()
  await act(async () => { root.render(<LateLibrary key="custom" response={switched.promise}/>) })
  await act(async () => { find('.team-picker-trigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await click('[role="menuitemradio"]') // Custom is first.
  await act(async () => { switched.resolve([saved]) })
  await click('.compact-primary')
  check(submitted.length, 3, 'Custom selection can submit after the late list')
  check(submitted.at(-1)?.team, undefined, 'late team does not replace an explicit Custom selection')
  check(submitted.at(-1)?.memberAgentIds, [agents[0].agentId], 'Custom roster is retained')

  // Discard may change the selected row, but must not retarget a pending action.
  const fallback = { ...team, id: 'team-B', name: 'Team B' }
  for (const action of ['conversation', 'duplicate']) for (const remaining of [[fallback], []]) {
    const opened: Team[] = []
    const writesBefore = teamWrites.length
    const renderWorkspace = (teams: Team[]) => <ThreadClientProvider client={client}><TeamWorkspace
      key={`${action}-${remaining.length}`} teams={teams} agents={agents} loading={false} loadError={null}
      defaultTeamId={null} customDefaults={null} refresh={async () => teams}
      onNewConversation={team => { opened.push(team) }} onLeaveGuardChange={() => {}}/></ThreadClientProvider>
    await act(async () => { root.render(renderWorkspace([team, fallback])) })
    await type('.team-editor-form input', 'Unsaved A')
    await act(async () => { root.render(renderWorkspace(remaining)) })
    if (action === 'conversation') await click('.team-start-button')
    else {
      await act(async () => { find('.team-overflow').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      await click('.team-crud-menu [role="menuitem"]')
    }
    await click('[role="dialog"] .quiet-button:nth-child(2)')
    check(opened.length, 0, 'deleted source does not start a conversation with a fallback team')
    check(teamWrites.length, writesBefore, 'deleted source does not duplicate a fallback team')
    check(find('[role="alert"]').textContent?.includes('重新选择'), true, 'cancelled action explains that the team must be selected again')
    if (remaining.length) check(find('.team-detail-header h1').textContent, fallback.name, 'list selection may still fall back to Team B')
  }
  await act(async () => { root.unmount() })
  return { ok: true, cases: ['save receipt before teams.list', 'retry after list refresh', 'late initial team preserves draft', 'external edits preserve selected version', 'late list preserves Custom', 'deleted source cancels conversation and duplication with a fallback or empty library'] }
}
