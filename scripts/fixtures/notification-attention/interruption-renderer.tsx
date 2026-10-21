import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { NavigationThreadItem, NotificationEpisodeChange, NotificationThreadInterruptions, StoredCommandResult, ThreadSnapshot } from '@contracts'
import { ThreadClientProvider } from '../../../apps/desktop/src/renderer/src/camp-client'
import { desktopThreadClient } from '../../../apps/desktop/src/renderer/src/desktop-camp-client'
import { ThreadNavigation } from '../../../apps/desktop/src/renderer/src/ThreadNavigation'
import { NotificationAttentionController } from '../../../apps/desktop/src/renderer/src/NotificationAttentionController'
import { ThreadInterruptionAttentionContext, useThreadInterruptionAttention } from '../../../apps/desktop/src/renderer/src/thread-interruption-attention'
import { ThreadWorkspace, type VisibleNotificationSources } from '../../../apps/desktop/src/renderer/src/ThreadWorkspace'
import { createReviewModel } from '../host-web-parity/model'
import { agents, initial, initialDraft, installations, message, run as templateRun } from '../host-web-parity/data'
import '../../../apps/desktop/src/renderer/src/styles.css'

const id = 'rvcamp_01h47kvsy5fk1shh6w1g60eec0'
const batchIds = [id, ...Array.from({ length: 200 }, (_, index) => `rvcamp_extra_${String(index).padStart(3, '0')}`)]
const secondaryId = batchIds[200]
const thread: NavigationThreadItem = { id, title: '中断提醒验收', activationState: 'active', projectPath: '/fixture',
  projectBindingKind: 'quick_chat', defaultLead: null, marker: 'none', lastActivityAt: '2026-10-21',
  lastActivityGlobalSequence: 0, latestCompletionGlobalSequence: 0, version: 1 }
const noop = () => undefined
let attentive = true
Object.defineProperty(document, 'hasFocus', { value: () => attentive })
let sequence = 0
const journal: NotificationEpisodeChange[] = []
const facts = new Map<string, { sequence: number; read: boolean }>()
const events = new Set<(event: { method: string }) => void>()
const requests: { method: string; request: any }[] = []
const emit = () => events.forEach(listener => listener({ method: 'notification_episode.changed' }))
let holdProjection = false
let failAck = false
const held: (() => void)[] = []
let secondaryUnread = false
let secondaryMode: 'success' | 'fail' | 'hold' = 'success'
let batchFailures = 0
const heldBatches: (() => void)[] = []
const receipts = new Map<string, StoredCommandResult>()
const task = () => ({ enabled: false, headsUpAfterSequence: 0, observedThroughChangeSequence: sequence })
let attention: ReturnType<typeof useThreadInterruptionAttention>
let showSources: (runs: string[]) => void
let manual: (value: boolean) => void
let showSidebar: (value: boolean) => void
let changeSurface: (value: string | null) => void
let changeThreadIds: (value: string[]) => void
let localWrites = 0
const workspaceModel = createReviewModel('desktop', 'camp')
const workspaceRunId = 'workspace-stop'
let showWorkspace: (status: 'running' | 'cancelled', offscreen: boolean, ready: boolean) => void
let confirmWorkspace: () => void
let currentWorkspace: ThreadSnapshot | null = null
const client = { ...workspaceModel.client, platform: 'darwin', onEvent: (listener: (event: { method: string }) => void) => {
  events.add(listener); return () => events.delete(listener)
}, request: async (method: string, request: any) => {
  requests.push({ method, request })
  if (method === 'thread.messages.anchors') {
    const messages = currentWorkspace?.messages ?? []
    return { schemaVersion: 1, threadId: id, throughGlobalSequence: currentWorkspace?.throughGlobalSequence ?? 0, totalCount: messages.length,
      items: messages.map(message => ({ messageId: message.id, sequence: message.sequence,
        messageVersion: message.version, title: message.body })) }
  }
  if (method === 'preferences.tasks.get') return task()
  if (method === 'notifications.preference.get') return { headsUpEnabled: false }
  if (method === 'notifications.inbox') return { schemaVersion: 10, throughChangeSequence: sequence,
    unreadCount: [...facts.values()].filter(fact => !fact.read).length, items: [], nextCursor: null }
  if (method === 'notifications.changesSince') return { schemaVersion: 10, requestedAfterChangeSequence: request.afterChangeSequence,
    throughChangeSequence: sequence, nextChangeSequence: sequence, retainedFloorChangeSequence: 0,
    resetRequired: false, hasMore: false, taskCapability: task(), changes: journal.filter(change => change.changeSequence > request.afterChangeSequence) }
  if (method === 'notifications.threadInterruptions') {
    const snapshot: NotificationThreadInterruptions = { throughChangeSequence: sequence, threads: request.threadIds.map((threadId: string) => ({
      threadId, hasUnreadInterruption: threadId === id ? [...facts.values()].some(fact => !fact.read) : threadId === secondaryId && secondaryUnread
    })) }
    if (request.threadIds.includes(secondaryId)) {
      if (secondaryMode === 'fail') { batchFailures++; throw new Error('second batch unavailable') }
      if (secondaryMode === 'hold') await new Promise<void>(resolve => heldBatches.push(resolve))
    }
    if (holdProjection) await new Promise<void>(resolve => held.push(resolve))
    return snapshot
  }
  if (method === 'notifications.acknowledgeThreadInterruptions' || method === 'notifications.acknowledgeVisibleSources') {
    if (failAck) { failAck = false; throw new Error('lost response') }
    const receipt = receipts.get(request.commandId)
    if (receipt) return receipt
    for (const [runId, fact] of facts) {
      if (fact.sequence <= request.command.observedThroughChangeSequence
        && (method === 'notifications.acknowledgeThreadInterruptions' || request.command.visibleAgentRunIds.includes(runId))) fact.read = true
    }
    const result = { commandId: request.commandId, status: 'applied', code: 'ok', payload: { resultingChangeSequence: ++sequence } } as StoredCommandResult
    receipts.set(request.commandId, result)
    emit()
    return result
  }
  return workspaceModel.client.request(method as Parameters<typeof workspaceModel.client.request>[0], request)
} } as unknown as typeof desktopThreadClient

function workspaceSnapshot(status: 'running' | 'cancelled', offscreen: boolean): ThreadSnapshot {
  const startedAt = new Date(Date.now() - 2000).toISOString(), endedAt = new Date().toISOString()
  return { ...initial, throughGlobalSequence: 100, thread: { ...initial.thread, id },
    messages: [{ ...message(1, '检查没有公开输出就停止的执行。', 'user'), createdAt: startedAt },
      ...Array.from({ length: offscreen ? 25 : 0 }, (_, i) => ({
        ...message(i + 2, `后续消息 ${i + 1}，不代替旧执行的已读。`, 'user'), createdAt: new Date(Date.now() + 60_000).toISOString()
      }))],
    agentRuns: [{ ...templateRun, id: workspaceRunId, invocationKind: 'batch', threadTurnId: null,
      status, inputMessageIds: ['review-message-1'], anchorMessageId: 'review-message-1', publicTailSequenceAtStart: 1,
      executionEvidenceCount: 0, executionEvidenceChangeSequence: 0, createdAt: startedAt, startedAt,
      updatedAt: status === 'running' ? startedAt : endedAt, endedAt: status === 'running' ? null : endedAt,
      cancelReasonCode: status === 'running' ? null : 'user_requested_agent_run_stop' }]
  }
}

function admit(runId: string, read = false, conversationId: string | null = null) {
  const n = ++sequence
  facts.set(runId, { sequence: n, read })
  const action = { actionId: runId, kind: 'open_agent_run' as const, available: true, threadId: id,
    threadTurnId: null, agentRunId: runId, messageId: null, approvalId: null, acknowledgementId: runId, observedEpisodeVersion: 1 }
  journal.push({ changeSequence: n, episodeId: runId, episodeVersion: 1, attentionRevision: 1, operation: 'upsert',
    changeCause: 'occurrence_admitted', changedAt: '2026-10-21', headsUpSignal: null, headsUpInvalidation: null,
    interruptionAdmission: { acknowledgementId: runId, threadId: id, agentRunId: runId,
      conversationId, kind: 'user_stop', admittedChangeSequence: n },
    episode: { id: runId, kind: 'collaboration', episodeVersion: 1, attentionRevision: 1, changeSequence: n,
      thread: { id, title: thread.title }, threadTurnId: null, agentRunId: runId, primarySemantic: 'run_stopped', unread: !read,
      resolved: false, satisfied: false, pendingApprovalCount: 0, mentionCount: 0, unacknowledgedMentionCount: 0,
      mention: null, reasons: [], primaryAction: action, secondaryActions: [], createdAt: '2026-10-21', updatedAt: '2026-10-21' }
  })
  emit()
}

function Fixture() {
  const [runs, setRuns] = useState<string[]>([])
  const [conversationId, setConversation] = useState<string | null>(null)
  const [manualUnread, setManual] = useState(false)
  const [sidebar, setSidebar] = useState(true)
  const [threadIds, setThreadIds] = useState([id])
  const [workspace, setWorkspace] = useState<ThreadSnapshot | null>(null)
  const [workspaceReady, setWorkspaceReady] = useState(true)
  const [workspaceSources, setWorkspaceSources] = useState<VisibleNotificationSources | null>(null)
  currentWorkspace = workspace
  const sources: VisibleNotificationSources = { threadId: id, conversationId, surfaceVisible: true,
    snapshotSequence: 0, agentRunIds: runs, campTurnIds: [], messageIds: [], approvalIds: [] }
  attention = useThreadInterruptionAttention(true, threadIds, { threadId: id, conversationId, visible: true })
  showSources = setRuns; manual = setManual; showSidebar = setSidebar; changeSurface = setConversation
  changeThreadIds = setThreadIds
  showWorkspace = (status, offscreen, ready) => {
    setWorkspaceSources(null); setWorkspaceReady(ready); setWorkspace(workspaceSnapshot(status, offscreen))
  }
  confirmWorkspace = () => setWorkspaceReady(true)
  return <ThreadInterruptionAttentionContext.Provider value={attention}>
    <div className="app-shell" style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gridTemplateRows: 'minmax(0, 1fr)', height: '100vh' }}>
      <div id="sidebar" style={{ visibility: sidebar ? 'visible' : 'hidden' }}>
        <ThreadNavigation view="camp" state="ready" navigation={{ schemaVersion: 3, throughGlobalSequence: 0,
          quickChat: { totalCount: 1, recentThreads: [thread] }, projects: [] }}
          activeThreadId={id} pendingMemoryCount={0}
          threadReadStates={{ [id]: { manualUnread, readThroughGlobalSequence: 0 } }}
          onNewConversation={noop} onMembers={noop} onMemory={noop} onSettings={noop} onOpenProject={noop}
          onThread={noop} onRemoveProject={async () => {}} onRename={async () => {}} onDelete={async () => {}}
          onError={error => { throw error }} />
      </div>
      <main style={{ minWidth: 0, height: '100vh' }}>{workspace
        ? <ThreadWorkspace snapshot={workspace} agents={agents} installations={installations}
            initialComposerDraft={{ ...initialDraft, threadId: id }} busy={false} stopping={false}
            onSend={async () => {}} onResolveApproval={noop} onChangeLead={async () => {}}
            worldMapEnabled={false} suppressExecutionAutoOpen workspaceEntrySnapshotReady={workspaceReady}
            onVisibleNotificationSources={setWorkspaceSources}
            onCancelAgentRun={async stopped => {
              attention.beginStop(stopped.id, { commandId: stopped.id, threadId: id, conversationId: null })
              setWorkspace(workspaceSnapshot('cancelled', false))
              admit(stopped.id)
            }} />
        : <input id="focus" defaultValue="保留的草稿" />}</main>
      <NotificationAttentionController enabled activeThreadId={id} activeThreadVisible={workspaceReady} navigationActive={false}
        visibleSources={conversationId ? null : workspace ? workspaceSources : sources} singleChatSources={conversationId ? sources : null}
        onNavigate={async () => ({ status: 'navigated' })} onPresentNavigation={async () => true}
        onCancelNavigation={noop} onRefreshVisibleThread={async () => false} onError={noop} />
    </div>
  </ThreadInterruptionAttentionContext.Provider>
}
Object.assign(window, { interruptionTest: {
  admit, begin: (runId: string, conversationId: string | null = null) => attention.beginStop(runId, { commandId: runId, threadId: id, conversationId }),
  workspace: (status: 'running' | 'cancelled', offscreen = false, ready = true) => showWorkspace(status, offscreen, ready),
  confirmWorkspace: () => confirmWorkspace(),
  visible: (runs: string[]) => showSources(runs), sidebar: (value: boolean) => showSidebar(value),
  manual: (value: boolean) => manual(value), surface: (value: string | null) => changeSurface(value),
  attentive: (value: boolean) => { attentive = value; window.dispatchEvent(new Event(value ? 'focus' : 'blur')) },
  reset: () => attention.reset(), poll: emit,
  hold: () => { holdProjection = true; void attention.refresh() },
  release: () => { holdProjection = false; held.splice(0).forEach(resolve => resolve()) },
  capture: () => attention.captureRead(id),
  markRead: async (intent: Parameters<typeof attention.acknowledge>[0]) => { localWrites++; manual(false); try { await attention.acknowledge(intent) } catch {} },
  failAck: () => { failAck = true },
  batches: () => { secondaryUnread = true; sequence++; changeThreadIds(batchIds) },
  batchMode: (mode: typeof secondaryMode) => { secondaryMode = mode },
  batchUnread: (unread: boolean) => { secondaryUnread = unread; sequence++ },
  confirmBatch: () => {
    secondaryUnread = false
    attention.committed(secondaryId, ++sequence)
    return sequence
  },
  releaseBatch: () => { secondaryMode = 'fail'; heldBatches.splice(0).forEach(resolve => resolve()) },
  refresh: () => attention.refresh(),
  invalidate: (runId: string) => {
    facts.delete(runId)
    const old = journal.find(change => change.episodeId === runId)!
    journal.push({ ...old, changeSequence: ++sequence, interruptionAdmission: null, changeCause: 'resolved',
      headsUpInvalidation: { kind: 'source_state_changed', acknowledgementId: runId, throughAttentionRevision: null } })
    emit()
  },
  state: () => ({ ready: !!attention.snapshots[id], unread: attention.snapshots[id]?.unread,
    flashing: attention.flashing.has(id), dot: !!document.querySelector('.camp-unread-dot'),
    label: document.querySelector('.camp-nav-row button')?.getAttribute('aria-label'),
    headsUp: document.querySelectorAll('.notification-heads-up').length,
    workspaceMarkers: [...document.querySelectorAll<HTMLElement>('[data-interrupted-run-id]')].map(node => node.dataset.interruptedRunId),
    workspaceStop: !!document.querySelector('.run-presence-stop'),
    stopConfirmation: !!document.querySelector('.run-presence-stop-confirmation .danger-button'),
    executionOpen: !!document.querySelector('.execution-drawer'),
    outputGroups: document.querySelectorAll('.agent-message-output').length,
    projectionCount: Object.keys(attention.snapshots).length, secondary: attention.snapshots[secondaryId],
    batchFailures, heldBatches: heldBatches.length,
    localWrites, requests, held: held.length, facts: [...facts].map(([runId, fact]) => ({ runId, ...fact })) })
} })
createRoot(document.getElementById('root')!).render(<ThreadClientProvider client={client}><Fixture /></ThreadClientProvider>)
