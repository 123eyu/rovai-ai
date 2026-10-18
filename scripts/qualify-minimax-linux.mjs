// Opt-in target-host qualification with a real mcode and the operator's native BYOK provider.
// Core, native sessions, Skills, MCP, workspaces and diagnostics are private fixtures.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { startQualificationCore, processTable, descendantsOf } from './lib/qualification-core.mjs'
import { composerDocumentForAddress } from './lib/create-configured-camp.mjs'

const [fixtureArgument, coreExecutable, phase = 'basics'] = process.argv.slice(2)
assert.equal(process.platform, 'linux', 'Run this qualification on its Linux target host')
assert.ok(isAbsolute(fixtureArgument) && isAbsolute(coreExecutable))
assert.ok(['basics', 'capabilities', 'cli', 'compaction', 'failures'].includes(phase))
const fixture = await realpath(fixtureArgument)
assert.deepEqual(await readdir(fixture), [], 'Use a new, empty private fixture')
const data = join(fixture, 'core'), native = join(fixture, 'native'), project = join(fixture, 'project')
for (const path of [data, native, project]) await mkdir(path, { mode: 0o700 })
const sourceConfig = parseYaml(await readFile(join(process.env.MINIMAX_DATA_DIR ?? join(homedir(), '.minimax'), 'config.yaml'), 'utf8'))
const connection = Object.entries(sourceConfig.custom_provider ?? {}).find(([, value]) => value.models?.['gpt-6.1-sol'])
assert.ok(connection, 'Configure gpt-6.1-sol through the official mcode custom provider first')
const [providerId, provider] = connection
const upstreamKey = provider.options?.apiKey
assert.ok(typeof upstreamKey === 'string' && upstreamKey.length > 12)
const upstreamBase = provider.options.baseURL.replace(/\/$/, '')
assert.equal(provider.api, 'openai-responses')
const syntheticKeyA = 'qualification-a-' + randomUUID(), syntheticKeyB = 'qualification-b-' + randomUUID()
const markerA = 'LINUX_A_' + randomUUID(), markerB = 'LINUX_B_' + randomUUID()
const nativeExecutable = process.env.ROVAI_MINIMAX_CODE_BIN ?? '/home/rovai-test/.local/bin/mcode'
const nativeVersion = execFileSync(nativeExecutable, ['--version'], { encoding: 'utf8' }).trim()
const events = [], requests = []
const report = { schemaVersion: 1, evidenceKind: 'real-linux-mcode-real-provider-production-core', phase,
  fixture, coreExecutable, coreSha256: createHash('sha256').update(await readFile(coreExecutable)).digest('hex'),
  nativeVersion, nativeExecutable, nativeSha256: digestNative(await readFile(nativeExecutable)),
  provider: 'native mcode custom_provider', model: 'gpt-6.1-sol',
  dataDirectory: data, skillLibraryRoot: join(data, 'managed-skill-library'), mcpConfigPath: join(data, 'mcp.json'),
  cases: [], requests, status: 'running', fullQualification: false }
let core, db, stage = 'setup'
function digestNative(value) { return createHash('sha256').update(value).digest('hex') }
const digest = value => createHash('sha256').update(value).digest('hex')
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
const broker = createServer(async (request, response) => {
  let controller
  try {
    assert.equal(request.method, 'POST')
    const chunks = []; let bytes = 0
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 16 * 1024 * 1024); chunks.push(chunk) }
    const raw = Buffer.concat(chunks), body = JSON.parse(raw)
    const route = request.url.startsWith('/b/') ? 'b' : 'a'
    assert.equal(request.headers.authorization, 'Bearer ' + (route === 'b' ? syntheticKeyB : syntheticKeyA))
    const system = [body.instructions, ...(body.input ?? []).filter(value => ['system', 'developer'].includes(value.role)).map(value => JSON.stringify(value.content))].filter(Boolean).join('\n')
    const record = { index: requests.length, stage, route, model: body.model, bodyBytes: raw.length,
      highPriorityDigest: digest(system), charterCount: system.split('[SESSION_CHARTER]').length - 1,
      aPresent: raw.includes(Buffer.from(markerA)), bPresent: raw.includes(Buffer.from(markerB)), usage: [] }
    requests.push(record)
    controller = new AbortController()
    response.once('close', () => { if (!response.writableEnded) { record.clientDisconnected = true; controller.abort() } })
    const suffix = request.url.replace(/^\/[ab]\/v1/, '')
    assert.equal(suffix, '/responses')
    const upstream = await fetch(upstreamBase + suffix, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + upstreamKey }, body: raw,
      signal: controller.signal })
    record.status = upstream.status
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
    let pending = ''
    for await (const part of upstream.body) {
      response.write(part)
      pending += Buffer.from(part).toString('utf8')
      if (pending.length > 2 * 1024 * 1024) pending = ''
      const entries = pending.split('\n\n'); pending = entries.pop()
      for (const entry of entries) {
        for (const line of entry.split('\n').filter(value => value.startsWith('data: '))) {
          try {
            const value = JSON.parse(line.slice(6)), usage = value.response?.usage ?? value.usage
            if (usage) record.usage.push(usage)
          } catch { /* Partial or non-JSON SSE carries no numeric evidence. */ }
        }
      }
    }
    response.end()
  } catch (error) {
    if (controller?.signal.aborted) return
    report.brokerFailure = String(error).replaceAll(upstreamKey, '[REDACTED]')
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Qualification relay failed' } }))
  }
})
await new Promise(resolveListen => broker.listen(0, '127.0.0.1', resolveListen))
async function saveNative(route = 'a') {
  const config = structuredClone(sourceConfig)
  config.custom_provider[providerId].options.baseURL = `http://127.0.0.1:${broker.address().port}/${route}/v1`
  config.custom_provider[providerId].options.apiKey = route === 'a' ? syntheticKeyA : syntheticKeyB
  await writeFile(join(native, 'config.yaml'), stringifyYaml(config), { mode: 0o600 })
}
async function persist() {
  await writeFile(join(fixture, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
async function passed(name, facts = {}) {
  report.cases.push({ name, status: 'passed', ...facts }); await persist()
  console.error(JSON.stringify({ phase, case: name, status: 'passed' }))
}
async function startCore() {
  core = startQualificationCore({ coreExecutable, dataDirectory: data, workingDirectory: project,
    runtimeCacheDirectory: join(fixture, 'cache'), mcpConfigPath: join(data, 'mcp.json'),
    environmentOverrides: { MINIMAX_DATA_DIR: native, MAVIS_DATA_DIR: native },
    onNotification: event => { events.push(event) } })
  await core.request('health.check')
}
const request = (method, params = {}, timeout) => core.request(method, params, timeout)
function binding(threadId, agentId = 'agent_2') {
  return db.prepare('SELECT id,native_session_id,native_binding_id,native_binding_generation FROM conversation WHERE camp_id=? AND agent_id=?').get(threadId, agentId)
}
function threadRuns(threadId) {
  return db.prepare('SELECT id,status,execution_epoch,last_error_code FROM agent_run WHERE camp_id=? ORDER BY created_at,id').all(threadId)
}
async function createThread(name, agentIds = ['agent_2']) {
  const result = await request('threads.create', { commandId: randomUUID(), name,
    workspace: { projectPath: project }, memberAgentIds: agentIds, defaultLeadAgentId: agentIds[0], collaborationMode: 'peer' })
  assert.equal(result.status, 'applied', JSON.stringify(result)); return result.payload.threadId
}
async function turn(threadId, text, options = {}) {
  const before = new Set(threadRuns(threadId).map(run => run.id)), firstEvent = events.length
  const sent = await request('thread.messages.send', { commandId: randomUUID(), threadId,
    content: composerDocumentForAddress({ mode: 'explicit', agentIds: [options.agentId ?? 'agent_2'] }, text),
    sourceAttachments: [], quotes: [], replyToThreadMessageId: null,
    execution: { taskId: null, purpose: 'Linux MiniMax Code runtime qualification', completionRole: 'required' } })
  assert.equal(sent.commandResult?.status, 'accepted', JSON.stringify(sent))
  const deadline = Date.now() + (options.timeout ?? 240_000)
  while (Date.now() < deadline) {
    const run = threadRuns(threadId).find(value => !before.has(value.id))
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      if (!options.allowFailure) assert.equal(run.status, 'succeeded', JSON.stringify(run))
      const snapshot = await request('camps.snapshot', { threadId })
      return { run, snapshot, binding: binding(threadId, options.agentId ?? 'agent_2'),
        events: events.slice(firstEvent).filter(event => event.params?.agentRunId === run.id),
        publicMessages: snapshot.messages.filter(message => message.sourceAgentRunId === run.id) }
    }
    await pause(200)
  }
  throw new Error('AgentRun terminal timeout in ' + stage)
}
const nativeChildren = async () => (await processTable()).filter(process => process.ppid === core.pid).map(process => process.pid)
const publicText = result => result.publicMessages.map(message => message.body).join('\n')
const hostId = result => result.events.find(event => event.method === 'agent_run.started')?.params.hostInstanceId
try {
  console.error(JSON.stringify({ channel: 'automatic_acceptance', phase, fixture, data, skills: report.skillLibraryRoot, mcp: report.mcpConfigPath, native }))
  await saveNative()
  await writeFile(join(project, 'existing.txt'), 'before\nkeep\n')
  await startCore()
  db = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
  const startup = await request('runtime.startup.get', { runtimeKind: 'minimax-code-cli' })
  await request('runtime.startup.save', { runtimeKind: 'minimax-code-cli', expectedRevision: startup.revision,
    configuration: { programPath: nativeExecutable, environment: [] } })
  report.catalog = await request('runtime.modelCatalog.open', { runtimeKind: 'minimax-code-cli', waitForRefresh: true }, 90_000)
  const installation = (await request('runtime.installations.list')).find(value => value.adapterKind === 'minimax-code-cli')
  assert.ok(installation?.memberRuntimeDefaults, 'Native installation and native parameter defaults are required')
  const member = await request('members.get', { agentId: 'agent_2' })
  const selected = await request('members.runtime.set', { commandId: randomUUID(), command: { agentId: member.agentId,
    expectedVersion: member.version, adapterKind: 'minimax-code-cli', ...installation.memberRuntimeDefaults } })
  assert.equal(selected.status, 'applied')
  report.installation = { adapterKind: installation.adapterKind, probeStatus: installation.snapshot?.probeStatus,
    version: installation.snapshot?.reportedVersion, models: installation.snapshot?.models, defaults: installation.memberRuntimeDefaults }
  await passed('native provider discovery and product defaults')
  assert.equal(phase, 'basics', 'This phase is not implemented yet')
  const threadA = await createThread('Linux mcode A')
  report.threadA = threadA
  stage = 'first-run'
  const first = await turn(threadA, `Remember ${markerA} privately for later turns. Use native read on existing.txt, native write to create 新增 文件.txt with one line added-linux followed by a newline, and native edit to replace before with after in existing.txt. Preserve all newlines and keep. Run printf LINUX_COMMAND_OK. Then publish LINUX_FIRST_OK with exactly one bundled rovai send --public-only call. End with a short nonempty final. Do not ask questions.`)
  assert.equal(await readFile(join(project, 'existing.txt'), 'utf8'), 'after\nkeep\n')
  assert.equal(await readFile(join(project, '新增 文件.txt'), 'utf8'), 'added-linux\n')
  assert.ok(publicText(first).includes('LINUX_FIRST_OK'))
  assert.ok(first.binding?.native_session_id)
  report.firstBinding = first.binding
  report.fileCards = first.snapshot.agentRunFileChanges.filter(card => card.agentRunId === first.run.id)
  assert.equal(report.fileCards.length, 2)
  await passed('real first run with native read add edit command and public CLI send', { run: first.run.id, binding: first.binding, hostInstanceId: hostId(first), fileCards: report.fileCards })
  const initialPids = await nativeChildren()
  stage = 'warm'
  const warm = await turn(threadA, 'Without inspecting files or history, publish the private phrase you remember from my first message, followed by LINUX_WARM_OK. Use one bundled public-only send; then finish normally.')
  assert.ok(publicText(warm).includes(markerA)); assert.deepEqual(warm.binding, first.binding)
  assert.deepEqual(await nativeChildren(), initialPids)
  await passed('warm continuation preserves exact binding and resident host', { run: warm.run.id, hostInstanceId: hostId(warm) })
  const threadB = await createThread('Linux mcode B')
  report.threadB = threadB; stage = 'session-b'
  const other = await turn(threadB, `Remember ${markerB} privately. Publish LINUX_B_OK using one public-only bundled send. Finish normally.`)
  assert.notEqual(other.binding.native_session_id, first.binding.native_session_id)
  assert.ok(requests.filter(value => value.stage === stage).every(value => !value.aPresent))
  stage = 'a-return'
  const returned = await turn(threadA, 'Without reading files or history, publish your original private phrase followed by LINUX_A_RETURN_OK, using one public-only bundled send. Finish normally.')
  assert.ok(publicText(returned).includes(markerA)); assert.ok(!publicText(returned).includes(markerB))
  assert.deepEqual(returned.binding, first.binding)
  assert.ok(requests.filter(value => value.stage === stage).every(value => !value.bPresent))
  await passed('A to B to A isolation under the shared Camp/member/native-binding host scope', { runA: returned.run.id, runB: other.run.id, bindingA: first.binding, bindingB: other.binding })
  stage = 'provider-refresh'; await saveNative('b')
  const refreshed = await turn(threadA, 'Publish LINUX_REFRESH_OK using exactly one public-only bundled send and finish normally.')
  assert.ok(publicText(refreshed).includes('LINUX_REFRESH_OK'))
  assert.deepEqual(refreshed.binding, first.binding)
  assert.equal(hostId(refreshed), hostId(returned))
  assert.ok(requests.some(value => value.stage === stage && value.route === 'b'))
  await passed('official native provider address and key refresh on the next run without session drift', { run: refreshed.run.id, hostInstanceId: hostId(refreshed) })
  stage = 'cold-resume'; await core.stop(); await startCore()
  const cold = await turn(threadA, 'Without inspecting files or history, publish your original private phrase followed by LINUX_COLD_OK, using one public-only bundled send. Finish normally.')
  assert.ok(publicText(cold).includes(markerA)); assert.deepEqual(cold.binding, first.binding)
  assert.ok(publicText(cold).includes('LINUX_COLD_OK'))
  await passed('Core restart resumes the exact original native session and memory', { run: cold.run.id, binding: cold.binding })
  assert.ok(requests.filter(value => value.stage !== 'setup').every(value => value.charterCount === 1))
  await passed('every observed real model request keeps exactly one Charter in the high priority layer')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error).replaceAll(upstreamKey, '[REDACTED]')
  console.error(report.error)
} finally {
  if (core) {
    const table = await processTable(); const descendants = descendantsOf(table, core.pid)
    report.shutdown = await core.stop()
    const live = new Set((await processTable()).map(process => process.pid))
    report.descendantsRemaining = descendants.filter(pid => live.has(pid))
    if (report.descendantsRemaining.length) { report.status = 'failed'; report.error = 'Qualification child survived Core shutdown' }
    delete report.shutdown.stderrTail
  }
  db?.close(); broker.closeAllConnections(); await new Promise(resolveClose => broker.close(resolveClose))
  await persist()
  console.log(JSON.stringify({ fixture, phase, status: report.status, cases: report.cases.map(value => ({ name: value.name, status: value.status })), error: report.error }))
}
if (report.status !== 'passed') process.exitCode = 1
