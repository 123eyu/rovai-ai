// Real Core and Hermes. Caller supplies a dedicated, already configured native
// Hermes Home; never copy daily Rovai data or resolve another runtime's secrets.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startQualificationCore, descendantsOf, processTable, waitForProcessesToExit } from './lib/qualification-core.mjs'
import { createConfiguredCampAndSend, composerDocumentForAddress } from './lib/create-configured-camp.mjs'

assert(process.env.ROVAI_HERMES_SMOKE_HOME, 'Set ROVAI_HERMES_SMOKE_HOME to a private acceptance Home')
assert(process.env.ROVAI_HERMES_BIN, 'Select the official Hermes 0.22.4 launcher')
const repository = resolve(import.meta.dirname, '..')
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-core-')))
const data = join(root, 'data'), project = join(root, 'project')
await mkdir(project)
await writeFile(join(root, 'mcp.json'), '{}')
const core = startQualificationCore({ coreExecutable: join(repository, 'target/debug/rovai-core'),
  dataDirectory: data, workingDirectory: repository, runtimeCacheDirectory: join(root, 'cache'),
  mcpConfigPath: join(root, 'mcp.json'), environmentOverrides: { HERMES_HOME: process.env.ROVAI_HERMES_SMOKE_HOME } })
console.log('Isolated fixture:', root)
let descendants = []
try {
  await core.request('health.check')
  const discoveryDeadline = Date.now() + 45000
  while (Date.now() < discoveryDeadline) {
    const status = await core.request('runtime.status.get')
    if (status.runtimeAvailability.some(row => row.runtimeKind === 'hermes-cli' && row.discovery.discoveryStatus !== 'detecting')) break
    await new Promise(done => setTimeout(done, 100))
  }
  console.log('Discovery complete')
  await core.request('runtime.product.check', { runtimeKind: 'hermes-cli' })
  let installation
  const until = Date.now() + 120000
  while (Date.now() < until) {
    installation = (await core.request('runtime.installations.list')).find(row => row.adapterKind === 'hermes-cli' && row.installationClass === 'managed_default')
    if (installation?.snapshot?.probeStatus === 'ready') break
    if (['probe_failed','missing_capabilities'].includes(installation?.snapshot?.probeStatus)) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  console.log('Hermes probe:', installation?.snapshot?.probeStatus, installation?.snapshot?.lastError)
  assert.equal(installation?.snapshot?.probeStatus, 'ready')
  const member = await core.request('members.get', { agentId: 'agent_2' })
  const selected = await core.request('members.runtime.set', { commandId: crypto.randomUUID(), command: {
    agentId: 'agent_2', expectedVersion: member.version, adapterKind: 'hermes-cli',
    model: installation.memberRuntimeDefaults.model, permissions: installation.memberRuntimeDefaults.permissions } })
  assert.equal(selected.status, 'applied')
  const sent = await createConfiguredCampAndSend(core.request, { commandId: crypto.randomUUID(), name: 'Hermes acceptance', purpose:'Hermes real Core acceptance',
    body: 'This is an isolated integration acceptance. Use terminal to run `rovai --help` and confirm the built-in CLI works. Use write_file to create hermes-proof.txt containing alpha followed by a newline. Read it, then use patch to change alpha to beta. Finally use `rovai send --public-only` to publish HERMES_CORE_ACCEPTED, the verification summary and your member name. Do not send to any other agent.',
    memberAgentIds: ['agent_2'], defaultLeadAgentId: 'agent_2', workspace: { projectPath: project } })
  const thread = sent.payload.threadId ?? sent.payload.campId
  let run
  const runUntil = Date.now() + 240000
  while (Date.now() < runUntil) {
    const snapshot = await core.request('camps.snapshot', { threadId: thread })
    run = snapshot.agentRuns.find(item => item.inputMessageIds?.includes(sent.payload.threadMessageId) || item.anchorMessageId === sent.payload.threadMessageId)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  console.log('Run:', run?.id, run?.status)
  assert.equal(run?.status, 'succeeded')
  assert.equal(await readFile(join(project, 'hermes-proof.txt'), 'utf8'), 'beta\n')
  const db = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
  try {
    const evidence = db.prepare('SELECT kind, result_preview_json FROM agent_run_execution_evidence WHERE agent_run_id = ?').all(run.id ?? run.agentRunId)
    assert(evidence.some(row => row.result_preview_json?.includes('reported_mutation')), 'Applied native patch evidence missing')
    assert(db.prepare("SELECT COUNT(*) AS n FROM camp_message WHERE author_type='agent' AND body LIKE '%HERMES_CORE_ACCEPTED%'").get().n > 0, 'Built-in CLI public Send missing')
    await writeFile(join(root, 'summary.json'), JSON.stringify({ runtime: 'hermes-cli', version: installation.snapshot.reportedVersion,
      thread, run: run.id ?? run.agentRunId, evidenceCount: evidence.length, patch: true }, null, 2))
  } finally { db.close() }
  // A second real Run exercises the current Built-in lease on a warm Session,
  // followed by cancellation while its actual native terminal is still running.
  const sentCancel = await core.request('thread.messages.send', { commandId: crypto.randomUUID(), threadId: thread,
    content: composerDocumentForAddress({ mode:'explicit', agentIds:['agent_2'] },
      'Cancellation acceptance: call terminal exactly once, in the foreground, with command `echo $$ > cancel.pid; sleep 120`. The harness will cancel you. Do not call any other tool or send a message.'),
    sourceAttachments: [], quotes: [], replyToThreadMessageId: null,
    execution: { taskId: null, purpose:'Hermes cancellation acceptance', completionRole:'required' } })
  const cancelledMessage = (sentCancel.commandResult ?? sentCancel).payload.threadMessageId
  let cancelRun, terminalPid
  const cancelDeadline = Date.now() + 90000
  while (Date.now() < cancelDeadline) {
    const snapshot = await core.request('camps.snapshot', { threadId:thread })
    cancelRun = snapshot.agentRuns.find(item => item.inputMessageIds?.includes(cancelledMessage) || item.anchorMessageId === cancelledMessage)
    terminalPid = await readFile(join(project, 'cancel.pid'), 'utf8').then(Number).catch(() => null)
    if (terminalPid && cancelRun) break
    await new Promise(done => setTimeout(done, 100))
  }
  assert(terminalPid && cancelRun, 'Native foreground terminal did not start')
  descendants = descendantsOf(await processTable(), core.pid)
  const cancelled = await core.request('agentRuns.cancel', { commandId:crypto.randomUUID(),
    command:{ threadId:thread, agentRunId:cancelRun.id, expectedVersion:cancelRun.version } })
  assert.notEqual(cancelled.status, 'rejected', JSON.stringify(cancelled))
  const settleDeadline = Date.now() + 30000
  while (Date.now() < settleDeadline) {
    cancelRun = (await core.request('camps.snapshot',{threadId:thread})).agentRuns.find(row=>row.id===cancelRun.id)
    if(cancelRun.status==='cancelled') break
    await new Promise(done=>setTimeout(done,100))
  }
  assert.equal(cancelRun.status,'cancelled')
  assert.deepEqual(await waitForProcessesToExit([terminalPid], 10000), [], 'Cancelled native terminal survived')
  console.log('Warm cancellation passed:', cancelRun.id)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  const stopped = await core.stop()
  if (process.exitCode) console.error(stopped.stderrTail)
  assert.deepEqual(await waitForProcessesToExit(descendants, 10000), [], 'Hermes descendants survived Core cleanup')
}
