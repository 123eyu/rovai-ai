import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentProfile, ThreadSnapshot, ThreadComposerDraftView, ThreadMessageView } from '@contracts'
import { optimisticThreadMessage } from '../../../apps/desktop/src/renderer/src/BusinessApp'
import { ThreadWorkspace, type ThreadLeaveGuard } from '../../../apps/desktop/src/renderer/src/ThreadWorkspace'
import { ThreadClientProvider, type ThreadClient } from '../../../apps/desktop/src/renderer/src/camp-client'
import { loadLocalThreadComposerDraft } from '../../../apps/desktop/src/renderer/src/camp-composer-local-store'
import '../../../apps/desktop/src/renderer/src/styles.css'

// Only the real Renderer and local draft store run here. Core transactions have
// their own SQLite regression owner; this closed transport never starts a Runtime.
const now = '2026-10-08T10:00:00Z'
const threadId = 'rvcamp_01m3rs4y3gfjssw5nstbzbdx7g'
const agent: AgentProfile = { agentId: 'lead', displayName: '负责人', avatarRef: null, accent: null,
  teamRole: '架构师', professionalResponsibilities: '', personalityTraits: [], workingPrinciples: '',
  growthTopic: '', defaultCapabilities: [], presence: 'present', runtimeConfiguration: null,
  runtimeReadiness: { status: 'ready', blockers: [] }, memberOrder: 0, version: 1,
  createdAt: now, updatedAt: now, removedAt: null }
const outside: AgentProfile = { ...agent, agentId: 'outside', displayName: '爱丽丝', teamRole: '实现者', memberOrder: 1,
  runtimeConfiguration: { adapterKind: 'codex-cli', model: { mode: 'explicit', modelId: 'configured-test-model', options: {} },
    permissions: { adapterKind: 'codex-cli', schemaVersion: 1, values: {} } } }
const member = (profile: AgentProfile) => ({ agentId: profile.agentId, displayName: profile.displayName, avatarRef: null,
  teamRole: profile.teamRole, accent: '', membershipStatus: 'active' as const, leaveRequestedAt: null,
  profilePresence: 'present' as const, memberOrder: profile.memberOrder, isDefaultLead: profile === agent, version: 1 })
const initial: ThreadSnapshot = { schemaVersion: 35, throughGlobalSequence: 1,
  thread: { id: threadId, title: '草稿邀请', activationState: 'pending', projectBindingKind: 'directory',
    projectPath: '/fixture/workspace', defaultLeadAgentId: agent.agentId, membershipGeneration: 1,
    version: 1, createdAt: now, updatedAt: now },
  members: [member(agent)], membershipReconciliations: [], tasks: [], messages: [], messageDeliveries: [], turns: [], agentRuns: [],
  executionEvidence: [], agentRunFileChanges: [], agentRunImages: [], contextManifests: [], approvals: [], actions: [], timeline: [] }
const calls: string[] = []
const submissions: ThreadComposerDraftView[] = []
const clipboardWrites: Array<{ text: string; html: string | null }> = []
Object.assign(window, { rovai: { clipboard: { write: async (data: { text: string; html: string | null }) => { clipboardWrites.push(data) } } } })
let rejectSend = true
let coreActivated = false
let acceptedSends = 0
let failNextInvite = false
let conflictNextRemoval = false
let prepareLeave: ThreadLeaveGuard | null = null
let visibleSnapshot = initial
let visibleProfiles = [agent, outside]
let setProfiles: React.Dispatch<React.SetStateAction<AgentProfile[]>>
let setFixture: React.Dispatch<React.SetStateAction<ThreadSnapshot>>
let setVisible: React.Dispatch<React.SetStateAction<boolean>>
const client = {
  platform: 'darwin', onEvent: () => () => {},
  request: async (method: string) => {
    calls.push(method)
    if (method === 'skills.candidates') return { skills: [], errors: [] }
    if (method === 'thread.messages.anchors') return { schemaVersion: 1, threadId, throughGlobalSequence: 0, totalCount: 0, items: [] }
    if (method === 'threads.pendingDraft.setPresence') {
      if (coreActivated) throw new Error('camp.pending_draft_unavailable')
      return { changed: true }
    }
    throw new Error(`Unexpected invitation fixture request: ${method}`)
  },
  composerAttachments: { discard: async () => {} }
} as unknown as ThreadClient
function Fixture() {
  const [snapshot, setSnapshot] = useState(initial)
  const [profiles, updateProfiles] = useState([agent, outside])
  const [acceptedMessages, setAcceptedMessages] = useState<ThreadMessageView[]>([])
  const [visible, show] = useState(true)
  const [entryHost, setEntryHost] = useState<HTMLElement | null>(null)
  const [inspectorVisible, setInspectorVisible] = useState(false)
  const [inspectorTab, setInspectorTab] = useState<'members' | 'tasks'>('members')
  visibleSnapshot = snapshot; visibleProfiles = profiles; setProfiles = updateProfiles; setFixture = setSnapshot; setVisible = show
  return <ThreadClientProvider client={client}><div>
    <header ref={setEntryHost} style={{ height: 40, display: 'flex', justifyContent: 'flex-end' }} />
    <main className="content task-content" style={{ height: 'calc(100vh - 40px)', width: '100vw' }}>
    {visible && <ThreadWorkspace snapshot={snapshot} optimisticMessages={acceptedMessages} agents={profiles} busy={false} stopping={false}
      detailEntryHost={entryHost}
      inspectorVisible={inspectorVisible} inspectorTab={inspectorTab}
      onOpenInspector={tab => { setInspectorTab(tab); setInspectorVisible(true) }}
      onCloseInspector={() => setInspectorVisible(false)} onInspectorTabChange={setInspectorTab}
      onOpenMembers={() => { calls.push('manage-members') }}
      worldMapEnabled={false} onChangeLead={async () => {}} onTasksChanged={async () => {}} onResolveApproval={() => {}}
      onThreadLeaveGuardChange={(_id, guard) => { prepareLeave = guard }}
      onPendingThreadLeave={async () => { calls.push('discard-pending') }}
      onAddMembers={async ids => {
        calls.push('add:' + ids.join(','))
        if (failNextInvite) { failNextInvite = false; return { addedAgentIds: [], unchangedAgentIds: [], failures: ids.map(agentId => ({ agentId, message: '邀请暂时失败' })) } }
        setSnapshot(current => {
          const additions = ids.map(id => ({ ...member(profiles.find(profile => profile.agentId === id)!), isDefaultLead: false }))
          const members = [...current.members, ...additions]
          if (!members.some(item => item.isDefaultLead)) additions[0].isDefaultLead = true
          return { ...current, members, thread: { ...current.thread,
            defaultLeadAgentId: members.find(item => item.isDefaultLead)?.agentId ?? null,
            membershipGeneration: current.thread.membershipGeneration + ids.length } }
        })
        return { addedAgentIds: ids, unchangedAgentIds: [], failures: [] }
      }}
      onPreviewMemberRemoval={async agentId => {
        calls.push('preview:' + agentId)
        const target = snapshot.members.find(item => item.agentId === agentId)!
        return { threadId, agentId, displayName: target.displayName,
          membershipGeneration: snapshot.thread.membershipGeneration, membershipVersion: target.version,
          isDefaultLead: target.isDefaultLead, remainingMemberCount: snapshot.members.length - 1,
          nextDefaultLeadAgentId: snapshot.members.find(item => item.agentId !== agentId)?.agentId ?? null,
          nonTerminalAgentRunCount: 0, openAssignedTaskCount: 0, pendingDeliveryCount: 0,
          runningDeliveryCount: 0, removable: true, blockerCode: null }
      }}
      onRemoveMember={async preview => {
        calls.push('remove:' + preview.agentId + ':' + preview.membershipGeneration)
        if (conflictNextRemoval) {
          conflictNextRemoval = false
          setSnapshot(current => ({ ...current, thread: { ...current.thread, membershipGeneration: current.thread.membershipGeneration + 1 } }))
          return { status: 'conflict', message: '名册已发生变化，请重新读取影响。' }
        }
        setSnapshot(current => ({ ...current, members: current.members.filter(item => item.agentId !== preview.agentId),
          thread: { ...current.thread, defaultLeadAgentId: preview.nextDefaultLeadAgentId,
            membershipGeneration: current.thread.membershipGeneration + 1 } }))
        return { status: 'removed', message: '已移出' }
      }}
      onSend={async draft => {
        calls.push('send'); submissions.push(structuredClone(draft))
        if (rejectSend) throw new Error('Fixture rejects this send')
        coreActivated = true
        acceptedSends += 1
        const message = optimisticThreadMessage(snapshot, `send-${acceptedSends}`, draft, now)
        setAcceptedMessages(current => [...current, { ...message, id: `published-${acceptedSends}`, sequence: acceptedSends }])
        const mentionedIds = draft.content.segments.flatMap(segment => segment.kind === 'atom' && segment.atom.type === 'member' ? [segment.atom.agentId] : [])
        const addressedAgentIds = mentionedIds.length ? mentionedIds : [draft.continuationIntent?.recipient.agentId ?? snapshot.thread.defaultLeadAgentId!]
        return { threadMessageId: 'published-' + acceptedSends, publishedMessageSequence: acceptedSends, deliveryIds: ['delivery'], agentRunIds: [], addressedAgentIds }
      }} />}
    </main></div></ThreadClientProvider>
}
const errors: string[] = []
window.addEventListener('error', e => errors.push(String(e.error?.stack ?? e.message)))
window.addEventListener('unhandledrejection', e => errors.push(String(e.reason)))
createRoot(document.getElementById('root')!).render(<Fixture />)
Object.assign(window, { invitationTest: {
  state: () => ({ calls, submissions, errors, clipboardWrites, memberIds: visibleSnapshot.members.map(member => member.agentId), outsidePresence: visibleProfiles.find(profile => profile.agentId === 'outside')?.presence, text: document.getElementById('camp-message')?.textContent,
    atoms: document.querySelectorAll('[data-composer-atom="member"]').length,
    publishedMentions: [...document.querySelectorAll<HTMLElement>('.message-bubble [data-agent-id="outside"]')].map(token => ({ label: token.textContent, unavailable: token.classList.contains('is-unavailable'), interactive: token.classList.contains('is-interactive') })),
    invite: !!document.querySelector('[aria-label="发送时邀请 爱丽丝"]'),
    continuation: !!document.querySelector('[aria-label="继续发给 爱丽丝"]'),
    draft: loadLocalThreadComposerDraft(threadId),
    button: document.querySelector<HTMLButtonElement>('form.composer:has(#camp-message) button[type="submit"]')?.disabled,
    stored: Object.values(localStorage).join(' ') }),
  presence: (presence: AgentProfile['presence']) => setProfiles(current => current.map(profile => profile.agentId === 'outside' ? { ...profile, presence } : profile)),
  accept: () => { rejectSend = false },
  projectActivation: () => setFixture(current => ({ ...current, thread: { ...current.thread, activationState: 'active' }, members: [member(agent), member(outside)] })),
  hide: () => setVisible(false), show: () => setVisible(true),
  leave: async () => { if (!prepareLeave) throw new Error('Leave guard missing'); (await prepareLeave()).complete(true); setVisible(false) },
  active: () => { localStorage.clear(); setFixture({ ...initial, thread: { ...initial.thread, activationState: 'active' } }); rejectSend = false; calls.length = 0 },
  empty: () => { localStorage.clear(); setFixture({ ...initial, members: [], thread: { ...initial.thread, activationState: 'active', defaultLeadAgentId: null } }); rejectSend = false; calls.length = 0 },
  removeAll: () => setFixture(current => ({ ...current, members: [], thread: { ...current.thread, defaultLeadAgentId: null } })),
  away: () => setFixture(current => ({ ...current, members: current.members.map(item => ({ ...item, profilePresence: 'away', isDefaultLead: false })), thread: { ...current.thread, defaultLeadAgentId: null } })),
  failInvite: () => { failNextInvite = true },
  conflictRemoval: () => { conflictNextRemoval = true },
  submit: () => document.querySelector<HTMLButtonElement>('form.composer:has(#camp-message) button[type="submit"]')!.click(),
  focus: () => document.querySelector<HTMLElement>('#camp-message[contenteditable="true"]')!.focus(),
  text: () => document.querySelector<HTMLElement>('#camp-message[contenteditable="true"]')!.textContent,
} })
