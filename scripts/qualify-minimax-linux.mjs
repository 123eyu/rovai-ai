// Opt-in target-host qualification with a real mcode and the operator's native BYOK provider.
// Core, native sessions, Skills, MCP, workspaces and diagnostics are private fixtures.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, realpath, writeFile, cp, lstat, unlink } from 'node:fs/promises'
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
const ownedServers = [], forbiddenPromptSecrets = [upstreamKey]
const report = { schemaVersion: 1, evidenceKind: 'real-linux-mcode-real-provider-production-core', phase,
  fixture, coreExecutable, coreSha256: createHash('sha256').update(await readFile(coreExecutable)).digest('hex'),
  nativeVersion, nativeExecutable, nativeSha256: digestNative(await readFile(nativeExecutable)),
  provider: 'native mcode custom_provider', model: 'gpt-6.1-sol',
  dataDirectory: data, skillLibraryRoot: join(data, 'managed-skill-library'), mcpConfigPath: join(data, 'mcp.json'),
  cases: [], turns: [], requests, status: 'running', fullQualification: false }
let core, db, stage = 'setup', fault = null
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
    assert.ok(forbiddenPromptSecrets.every(secret => !raw.includes(Buffer.from(secret))), 'A provider/MCP credential entered a model request')
    const route = request.url.startsWith('/b/') ? 'b' : 'a'
    assert.equal(request.headers.authorization, 'Bearer ' + (route === 'b' ? syntheticKeyB : syntheticKeyA))
    const system = [body.instructions, ...(body.input ?? []).filter(value => ['system', 'developer'].includes(value.role)).map(value => JSON.stringify(value.content))].filter(Boolean).join('\n')
    const record = { index: requests.length, stage, route, model: body.model, bodyBytes: raw.length,
      highPriorityDigest: digest(system), charterCount: system.split('[SESSION_CHARTER]').length - 1,
      aPresent: raw.includes(Buffer.from(markerA)), bPresent: raw.includes(Buffer.from(markerB)),
      checkpoint: system.includes('loss-aware checkpoint'),
      sessionTitle: body.tools?.length === 1 && (body.tools[0].name ?? body.tools[0].function?.name) === 'submit_session_title',
      tools: (body.tools ?? []).map(tool => tool.name ?? tool.function?.name).filter(Boolean), usage: [] }
    requests.push(record)
    if (fault && (!fault.checkpointOnly || record.checkpoint)) {
      const activeFault = fault
      if (activeFault.remaining !== Infinity && --activeFault.remaining <= 0) fault = null
      record.injectedFault = activeFault.kind
      if (activeFault.kind === 'hold') {
        await new Promise(resolveClose => response.once('close', resolveClose)); record.clientDisconnected = true; return
      }
      const status = activeFault.kind === 'overflow' ? 400 : activeFault.kind === 'transient' ? 503 : 401
      record.status = status
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { type: activeFault.kind === 'overflow' ? 'invalid_request_error' : 'qualification_fault',
        code: activeFault.kind === 'overflow' ? 'context_length_exceeded' : 'qualification_fault',
        message: activeFault.kind === 'overflow' ? "This model's maximum context length has been exceeded. Reduce the conversation." : 'Controlled qualification rejection' } }))
      return
    }
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
  if (phase === 'compaction') config.custom_provider[providerId].models['gpt-6.1-sol'].limit = { context: 65536, output: 4096 }
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
  let nativeBefore = []
  const previousBinding = binding(threadId, options.agentId ?? 'agent_2')
  if (previousBinding?.native_session_id) nativeBefore = (await nativeHistory(previousBinding.native_session_id)).usage
  const sent = await request('thread.messages.send', { commandId: randomUUID(), threadId,
    content: composerDocumentForAddress({ mode: 'explicit', agentIds: [options.agentId ?? 'agent_2'] }, text),
    sourceAttachments: [], quotes: [], replyToThreadMessageId: null,
    execution: { taskId: null, purpose: 'Linux MiniMax Code runtime qualification', completionRole: 'required' } })
  assert.equal(sent.commandResult?.status, 'accepted', JSON.stringify(sent))
  const deadline = Date.now() + (options.timeout ?? 240_000)
  while (Date.now() < deadline) {
    const run = threadRuns(threadId).find(value => !before.has(value.id))
    if (run && options.onTick) await options.onTick(run)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      if (!options.allowFailure) assert.equal(run.status, 'succeeded', JSON.stringify(run))
      const snapshot = await request('camps.snapshot', { threadId })
      const currentBinding = binding(threadId, options.agentId ?? 'agent_2')
      let usage = []
      if (currentBinding?.native_session_id) {
        const old = new Set(nativeBefore.map(value => value.messageId))
        usage = (await nativeHistory(currentBinding.native_session_id)).usage.filter(value => !old.has(value.messageId))
      }
      report.turns.push({ stage, runId: run.id, status: run.status, binding: currentBinding, nativeUsage: usage })
      return { run, snapshot, binding: currentBinding,
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
async function command(method, value) {
  const result = await request(method, { commandId: randomUUID(), command: value })
  assert.notEqual(result.status, 'rejected', JSON.stringify(result)); return result
}
async function qualifyCli() {
  await request('preferences.tasks.set', { enabled: true })
  const mission = await command('missions.create', { title: 'Linux CLI qualification', description: 'Isolated qualification only.',
    projectPath: project, projectBindingKind: 'directory', memberAgentIds: ['agent_2'], defaultLeadAgentId: 'agent_2', tags: [] })
  const { threadId, missionId } = mission.payload
  const script = join(project, 'verify-cli.mjs'), resultFile = join(project, 'cli-results.json')
  const contextCopy = join(project, 'expired-lease.json')
  await writeFile(script, `
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const results=[];
const call=(args,input={})=>{
  const child=spawnSync(process.env.ROVAI_AGENT_CLI,args,{input:JSON.stringify(input),encoding:'utf8',timeout:30000});
  const value=JSON.parse(child.stdout); results.push({args,status:child.status,value});
  writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(results,null,2));
  assert.equal(child.status,0,JSON.stringify({args,value,stderr:child.stderr}));assert.ok(!value.error,JSON.stringify(value));return value;
};
assert.ok(process.env.ROVAI_CLI_CONTEXT);copyFileSync(process.env.ROVAI_CLI_CONTEXT,${JSON.stringify(contextCopy)});
call(['member','list']);
const self=call(['member','get'],{agentId:'agent_2'});
call(['member','update'],{agentId:'agent_2',expectedVersion:self.version,requestId:randomUUID(),growthTopic:'Linux qualification fixture'});
const created=call(['member','create'],{creationKey:randomUUID(),displayName:'CLI Fixture Member',teamRole:'Verifier',professionalResponsibilities:'Only isolated acceptance.',personalityTraits:['Precise'],workingPrinciples:'Report the requested marker, then stop.',growthTopic:''});
const task=call(['task','create'],{title:'Linux CLI task',description:'Fixture task.',assigneeAgentId:'agent_2'});
call(['task','get'],{taskId:task.taskId});call(['task','list'],{limit:10});call(['task','update'],{taskId:task.taskId,status:'in_progress'});
call(['thread','list']);
const found=call(['thread','search'],{query:'CLI_QUALIFICATION_USER',limit:10});
assert.ok(found.results.length);call(['thread','read'],{messageId:found.results[0].messageId});call(['thread','runs']);
call(['history','search'],{query:'CLI_QUALIFICATION_USER',limit:10});
const memory=call(['memory','write'],{action:'add',scope:'companion',kind:'preference',body:'Linux CLI memory fixture.',retrievalKeys:['linux-cli-qualification']});
call(['memory','view'],{scope:'companion'});call(['memory','search'],{query:'linux-cli-qualification',limit:6});call(['memory','read'],{memoryIds:[memory.memoryId]});
call(['mission','list']);const current=call(['mission','get']);assert.equal(current.missionId,${JSON.stringify(missionId)});
call(['mission','update'],{description:'Updated by the authorized Linux CLI fixture.'});call(['mission','status'],{status:'in_progress'});
const automation=call(['automation','create'],{name:'Linux CLI manual fixture',prompt:'Publish LINUX_AUTOMATION_OK with one public-only send, then stop.',member:'agent_2',project:'quick-chat',repeat:'manual'});
call(['automation','list'],{status:'enabled'});call(['automation','get'],{automationId:automation.automationId});
const updated=call(['automation','update'],{automationId:automation.automationId,expectedVersion:automation.version,name:'Linux CLI updated fixture'});
call(['automation','run'],{automationId:automation.automationId});
const closed=call(['automation','close'],{automationId:automation.automationId,expectedVersion:updated.version});
call(['automation','delete'],{automationId:automation.automationId,expectedVersion:closed.version});
call(['send'],{body:'LINUX_CLI_29_OK',publicOnly:true});
console.log('LINUX_CLI_SCRIPT_OK');
`, { mode: 0o600 })
  stage = 'cli-public'
  const publicRun = await turn(threadId, `CLI_QUALIFICATION_USER: I explicitly authorize creating one test member and manual automation, running and deleting that automation, updating agent_2 growthTopic to Linux qualification fixture, creating/updating one task, writing fixture memory, and updating the current Mission. Execute exactly: node ${JSON.stringify(script)}. Do not modify the script. Its bundled CLI publishes the result; then finish with a short nonempty final.`, { timeout: 600_000 })
  const results = JSON.parse(await readFile(resultFile, 'utf8'))
  assert.ok(results.length >= 29 && results.every(value => value.status === 0))
  assert.ok(publicText(publicRun).includes('LINUX_CLI_29_OK'))
  const evidence = await request('agentRunEvidence.list', { threadId, agentRunId: publicRun.run.id, afterSequence: 0, limit: 1000 })
  report.cliEvidence = evidence
  const expired = spawnSync(dirname(coreExecutable) + '/rovai', ['thread', 'list'], {
    env: { ...process.env, ROVAI_CLI_CONTEXT: contextCopy }, encoding: 'utf8', timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  assert.notEqual(expired.status, 0, 'The completed Run lease must reject')
  assert.ok(JSON.parse(expired.stdout).error)
  await passed('29 public-context CLI operations and expired Run lease rejection', { run: publicRun.run.id, invocations: results.length })
  const privateScript = join(project, 'verify-private-cli.mjs'), privateResult = join(project, 'private-cli-result.json')
  await writeFile(privateScript, `import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';import assert from 'node:assert/strict';const r=spawnSync(process.env.ROVAI_AGENT_CLI,['single-chat','history'],{input:'{}',encoding:'utf8',timeout:10000});const value=JSON.parse(r.stdout);writeFileSync(${JSON.stringify(privateResult)},JSON.stringify({status:r.status,value}));assert.equal(r.status,0);assert.ok(!value.error);console.log('PRIVATE_CLI_OK');`, { mode: 0o600 })
  const opened = await command('singleChat.open', { threadId, agentId: 'agent_2' })
  const conversationId = opened.payload.conversationId
  const before = await request('singleChat.get', { conversationId })
  const ids = new Set(threadRuns(threadId).map(run => run.id))
  stage = 'cli-single-chat'
  const sent = await command('singleChat.send', { threadId, conversationId,
    body: `Execute exactly node ${JSON.stringify(privateScript)}. Do not publish to the public Thread. Finish with PRIVATE_CLI_OK.`, draftRevision: before.draft.revision })
  assert.ok(['applied', 'accepted'].includes(sent.status))
  let privateRun
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    privateRun = threadRuns(threadId).find(run => !ids.has(run.id))
    if (privateRun && ['succeeded', 'failed', 'cancelled'].includes(privateRun.status)) break
    await pause(200)
  }
  assert.equal(privateRun?.status, 'succeeded', JSON.stringify(privateRun))
  assert.equal(JSON.parse(await readFile(privateResult, 'utf8')).status, 0)
  const privateEvidence = await request('agentRunEvidence.list', { threadId, agentRunId: privateRun.id, afterSequence: 0, limit: 1000 })
  const catalogSource = await readFile(resolve(import.meta.dirname, '../crates/rovai-core/src/builtin_tool_transport.rs'), 'utf8')
  const identities = catalogSource.match(/pub const BUILTIN_TOOL_CLI_IDENTITIES:[\s\S]*?= \[([\s\S]*?)\n\];/)[1]
  const expected = [...identities.matchAll(/operation: "([^"]+)"/g)].map(value => value[1]).sort()
  const completed = [...evidence.evidence, ...privateEvidence.evidence].filter(entry => entry.payload?.kind === 'builtin_tool_invocation' && entry.payload?.status === 'completed')
  const observed = [...new Set(completed.map(entry => entry.payload.canonicalTool))].sort()
  assert.deepEqual(observed, expected, 'Every operation in the current Core catalog needs committed real-Run evidence')
  report.cliOperationEvidence = { expected, observed, completedEvidenceRows: completed.length }
  await passed('all 30 current operations have committed Core evidence, including actual private Single Chat history', { run: privateRun.id, conversationId, operations: observed })
  const followup = await turn(threadId, 'Use one bundled public-only send to publish LINUX_CLI_NEW_LEASE_OK. Finish normally.')
  assert.ok(publicText(followup).includes('LINUX_CLI_NEW_LEASE_OK'))
  assert.deepEqual(followup.binding, publicRun.binding)
  await passed('successor public Run receives a working new lease and preserves its native binding', { run: followup.run.id })
  report.cliOperations = results.map(value => value.args.join(' ')).concat('single-chat history')
}
async function qualifyCapabilities() {
  const fixtureServer = resolve(import.meta.dirname, '../crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')
  const callMarker = join(project, 'mcp-calls.txt')
  const definition = source => ({ command: process.execPath, args: [fixtureServer],
    env: { ROVAI_MCP_SMOKE_SOURCE: source, ROVAI_MCP_SMOKE_CALL_MARKER: callMarker } })
  await writeFile(join(native, 'mcp.json'), JSON.stringify({ mcpServers: {
    linux_qualification: definition('NATIVE_CONFLICT'), native_unique: definition('NATIVE_UNIQUE')
  } }), { mode: 0o600 })
  const mutateMcp = async (method, value) => {
    const config = await request('mcp.config.get')
    const result = await request(method, { expectedConfigDigest: config.configDigest, ...value })
    assert.equal(result.status, 'ok', JSON.stringify(result)); return result
  }
  const createdMcp = await mutateMcp('mcp.servers.create', { definitionJson: JSON.stringify({ mcpServers: { linux_qualification: definition('ROVAI_ASSIGNED_V1') } }) })
  const serverId = createdMcp.config.servers.find(server => server.name === 'linux_qualification').serverId
  assert.ok(serverId)
  await mutateMcp('mcp.servers.setEnabled', { serverId, enabled: true })
  await mutateMcp('mcp.assignments.set', { serverId, agentId: 'agent_2', assigned: true })
  const httpSecret = 'synthetic-mcp-' + randomUUID(), httpCalls = []
  forbiddenPromptSecrets.push(httpSecret)
  const httpMcp = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.headers.authorization, 'Bearer ' + httpSecret)
      if (incoming.method !== 'POST') { outgoing.writeHead(405).end(); return }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks))
      if (message.id == null) { outgoing.writeHead(202).end(); return }
      let result
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'linux-http-fixture', version: '1' } }
      else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a qualification marker.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      else if (message.method === 'tools/call') {
        httpCalls.push({ stage, text: message.params.arguments.text })
        result = { content: [{ type: 'text', text: 'HTTP_ACTUAL:' + message.params.arguments.text }] }
      } else { outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } })); return }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } catch { outgoing.writeHead(400).end() }
  })
  await new Promise(resolveListen => httpMcp.listen(0, '127.0.0.1', resolveListen)); ownedServers.push(httpMcp)
  const createdHttp = await mutateMcp('mcp.servers.create', { definitionJson: JSON.stringify({ mcpServers: {
    linux_http: { url: `http://127.0.0.1:${httpMcp.address().port}/mcp`, headers: { Authorization: 'Bearer ' + httpSecret } }
  } }) })
  const httpServerId = createdHttp.config.servers.find(server => server.name === 'linux_http').serverId
  await mutateMcp('mcp.servers.setEnabled', { serverId: httpServerId, enabled: true })
  await mutateMcp('mcp.assignments.set', { serverId: httpServerId, agentId: 'agent_2', assigned: true })
  const skillSource = join(fixture, 'linux-managed-qualification'), nativeSkill = join(project, '.agents/skills/linux-native-qualification')
  await mkdir(skillSource); await mkdir(nativeSkill, { recursive: true })
  const nativeMarker = 'NATIVE_SKILL_' + randomUUID(), skillV1 = 'MANAGED_V1_' + randomUUID(), skillV2 = 'MANAGED_V2_' + randomUUID()
  await writeFile(join(nativeSkill, 'SKILL.md'), `---\nname: linux-native-qualification\ndescription: Native project qualification skill.\n---\nWhen invoked, report ${nativeMarker}.\n`)
  let skill
  const importSkill = async marker => {
    await writeFile(join(skillSource, 'SKILL.md'), `---\nname: linux-managed-qualification\ndescription: Managed Linux qualification skill.\n---\nWhen invoked, report ${marker}.\n`)
    const inspection = await request('skills.import.inspect', { path: skillSource })
    assert.equal(inspection.candidates.length, 1)
    const candidate = inspection.candidates[0]
    await command('skills.import.commit', { stagingToken: inspection.stagingToken, candidateName: candidate.name,
      expectedDigest: candidate.contentDigest, expectedSkillVersion: candidate.existingSkillVersion, confirmUpdate: !!skill })
    skill = (await request('skills.list')).find(value => value.name === 'linux-managed-qualification')
    assert.ok(skill)
    await command('skills.setGroupAssignments', { skillId: skill.id, expectedVersion: skill.version, groupKeys: ['minimax'] })
    skill = await request('skills.get', { skillId: skill.id })
  }
  await importSkill(skillV1)
  const thread = await createThread('Linux capability lifecycle')
  const probe = async (name, text) => { stage = name; return turn(thread, text + ' Publish actual results through exactly one bundled public-only send and finish with a nonempty final. Never fabricate tool results.') }
  const first = await probe('capabilities-first', 'Use native skill discovery to invoke linux-managed-qualification and linux-native-qualification. Actually call the echo tool from linux_qualification, native_unique, and linux_http once each with text fresh_first. Do not substitute shell/file access for MCP.')
  const firstText = publicText(first)
  for (const marker of [skillV1, nativeMarker, 'ROVAI_ASSIGNED_V1:fresh_first', 'NATIVE_UNIQUE:fresh_first', 'HTTP_ACTUAL:fresh_first']) assert.ok(firstText.includes(marker), firstText)
  assert.ok(!firstText.includes('NATIVE_CONFLICT:'))
  const exposure = first.snapshot.contextManifests.find(value => value.agentRunId === first.run.id)?.skillExposure
  assert.ok(exposure?.skills.some(value => value.skillId === skill.id && value.status === 'ready'))
  await passed('native Skill invocation and assigned/native MCP append with whole-definition RovaiWins', { run: first.run.id, binding: first.binding, skillExposure: exposure })
  await importSkill(skillV2)
  await mutateMcp('mcp.servers.update', { serverId, definitionJson: JSON.stringify({ mcpServers: { linux_qualification: definition('ROVAI_ASSIGNED_V2') } }) })
  const updated = await probe('capabilities-update', 'Invoke linux-managed-qualification afresh and call linux_qualification echo with text fresh_updated. Return current actual results, not earlier memory.')
  assert.ok(publicText(updated).includes(skillV2)); assert.ok(!publicText(updated).includes(skillV1))
  assert.ok(publicText(updated).includes('ROVAI_ASSIGNED_V2:fresh_updated'))
  assert.deepEqual(updated.binding, first.binding)
  await passed('managed Skill revision and MCP definition update take effect while exact native Session continues', { run: updated.run.id, binding: updated.binding })
  skill = await request('skills.get', { skillId: skill.id })
  await command('skills.setEnabled', { skillId: skill.id, expectedVersion: skill.version, enabled: false })
  await mutateMcp('mcp.assignments.set', { serverId, agentId: 'agent_2', assigned: false })
  const absent = await probe('capabilities-disabled', 'Call linux_qualification echo with text fresh_unassigned. Use native skill discovery to check which qualification Skills are currently available; invoke only linux-native-qualification. Do not read previously saved skill paths or claim a disabled Skill was invoked.')
  assert.ok(publicText(absent).includes('NATIVE_CONFLICT:fresh_unassigned'))
  const disabledExposure = absent.snapshot.contextManifests.find(value => value.agentRunId === absent.run.id)?.skillExposure
  assert.ok(!disabledExposure.skills.some(value => value.skillId === skill.id && value.status === 'ready'))
  assert.ok(!publicText(absent).includes(skillV1) && !publicText(absent).includes(skillV2))
  await passed('disabled Skill is absent and unassigned MCP restores its native same-name definition', { run: absent.run.id })
  const profile = await request('members.get', { agentId: 'agent_1' })
  const memberTwo = await command('members.runtime.set', { agentId: 'agent_1', expectedVersion: profile.version,
    adapterKind: 'minimax-code-cli', ...report.installation.defaults })
  assert.equal(memberTwo.status, 'applied')
  const adjacent = await createThread('Linux capability adjacent', ['agent_1'])
  stage = 'capabilities-adjacent'
  const neighbor = await turn(adjacent, 'Actually call linux_qualification echo with text adjacent. Return its result through one public-only send, then finish normally.', { agentId: 'agent_1' })
  assert.ok(publicText(neighbor).includes('NATIVE_CONFLICT:adjacent'))
  assert.ok(!publicText(neighbor).includes('ROVAI_ASSIGNED'))
  await passed('unassigned adjacent member has only its native MCP definition and no projected tool leak', { run: neighbor.run.id })
  await mutateMcp('mcp.assignments.set', { serverId, agentId: 'agent_2', assigned: true })
  const reassigned = await probe('capabilities-reassigned', 'Actually call linux_qualification echo with text reassigned and return its current result.')
  assert.ok(publicText(reassigned).includes('ROVAI_ASSIGNED_V2:reassigned'))
  skill = await request('skills.get', { skillId: skill.id })
  await command('skills.delete', { skillId: skill.id, expectedVersion: skill.version })
  await mutateMcp('mcp.servers.delete', { serverId })
  const deleted = await probe('capabilities-deleted', 'Actually call linux_qualification echo with text deleted and return its current result. List current qualification Skills without reading old paths.')
  assert.ok(publicText(deleted).includes('NATIVE_CONFLICT:deleted'))
  assert.ok(!(await request('skills.list')).some(value => value.id === skill.id))
  await passed('MCP reassignment and deletion restore the current native capability without session drift', { run: deleted.run.id })
  await importSkill(skillV2)
  const eligible = await probe('skill-collision-baseline', 'Invoke linux-managed-qualification afresh and return its current verification value.')
  const projected = eligible.snapshot.contextManifests.find(value => value.agentRunId === eligible.run.id).skillExposure.skills.find(value => value.skillId === skill.id && value.status === 'ready')
  assert.ok(projected?.entryPath && projected.entryPath.startsWith(project + '/'))
  assert.ok((await lstat(projected.entryPath)).isSymbolicLink())
  assert.ok((await realpath(projected.entryPath)).startsWith(report.skillLibraryRoot + '/'))
  await unlink(projected.entryPath); await mkdir(projected.entryPath)
  const conflictMarker = 'PROJECT_CONFLICT_' + randomUUID()
  await writeFile(join(projected.entryPath, 'SKILL.md'), `---\nname: linux-managed-qualification\ndescription: Project-owned conflict fixture.\n---\nReport ${conflictMarker}.\n`)
  await command('skills.reconcile', {})
  const issues = await request('skills.projections.listIssues')
  assert.ok(issues.some(issue => issue.skillId === skill.id && issue.entryPath === projected.entryPath && issue.state === 'shadowed'))
  const conflict = await probe('skill-native-name-conflict', 'Invoke linux-managed-qualification afresh using native discovery. Return its actual current result, never the old cached marker.')
  assert.ok(publicText(conflict).includes(conflictMarker) && !publicText(conflict).includes(skillV2))
  skill = await request('skills.get', { skillId: skill.id })
  await command('skills.setGroupAssignments', { skillId: skill.id, expectedVersion: skill.version, groupKeys: [] })
  await command('skills.reconcile', {})
  assert.ok((await readFile(join(projected.entryPath, 'SKILL.md'), 'utf8')).includes(conflictMarker))
  await passed('same-name project Skill wins, is reported shadowed, and survives managed group removal', { run: conflict.run.id })
  await core.stop(); core = null; await startCore()
  const cold = await probe('capabilities-cold', 'Invoke linux-native-qualification and call linux_http echo with text after_cold. Return both actual results.')
  assert.ok(publicText(cold).includes(nativeMarker) && publicText(cold).includes('HTTP_ACTUAL:after_cold'))
  assert.deepEqual(cold.binding, first.binding)
  assert.ok(!(await readFile(join(native, 'mcp.json'), 'utf8')).includes(httpSecret))
  assert.equal(httpCalls.filter(call => call.text === 'fresh_first').length, 1)
  assert.equal(httpCalls.filter(call => call.text === 'after_cold').length, 1)
  report.httpMcp = { actualCalls: httpCalls, secretInNativeGlobalConfig: false, secretInModelRequests: false }
  await passed('authenticated HTTP MCP and native project Skill survive exact cold resume without global secret writes', { run: cold.run.id })
  report.mcpCalls = (await readFile(callMarker, 'utf8')).trim().split('\n').length
}
async function nativeHistory(sessionId) {
  const nativeDb = new DatabaseSync(join(native, 'v2/sqlite/runtime-state.sqlite'), { readOnly: true })
  const relative = nativeDb.prepare('SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id=?').get(sessionId)?.history_relative_dir
  nativeDb.close(); assert.ok(relative && !relative.includes('..'))
  const directory = resolve(native, 'v2/sessions', relative)
  assert.ok(directory.startsWith(join(native, 'v2/sessions') + '/'))
  const rows = (await readFile(join(directory, 'messages.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  const summaries = rows.filter(row => row.message?.role === 'compactionSummary').map(row => ({ messageId: row.message_id,
    tokensBefore: row.message.tokensBefore, generation: row.history_artifact?.generation }))
  const usage = rows.filter(row => row.message?.role === 'assistant' && ['stop', 'toolUse', 'length'].includes(row.message.stopReason))
    .map(row => ({ messageId: row.message_id, turnId: row.turn_id, ...row.message.usage }))
  return { sessionId, directory, count: rows.length, generation: Math.max(0, ...rows.map(row => row.history_artifact?.generation ?? 0)), summaries, usage }
}
function nativeControl(bootstrap) {
  const child = spawn(nativeExecutable, ['acp', '--append-system-prompt-file', bootstrap], {
    cwd: project, env: { ...process.env, MINIMAX_DATA_DIR: native, MAVIS_DATA_DIR: native }, stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 0; const pending = new Map()
  child.stderr.resume()
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line) } catch { return }
    if (value.method && value.id != null) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n'); return
    }
    const entry = pending.get(value.id)
    if (!entry) return
    pending.delete(value.id); clearTimeout(entry.timer)
    value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result)
  })
  const closed = new Promise(resolveClose => child.once('close', resolveClose))
  return {
    async request(method, params, timeout = 240_000) {
      const current = ++id
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => { pending.delete(current); reject(new Error('Native ACP timeout: ' + method)) }, timeout)
        pending.set(current, { resolve: resolveRequest, reject, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n')
      })
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') },
    async stop() {
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await closed; clearTimeout(timer)
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Native control stopped')) }
      return child.exitCode
    }
  }
}
async function qualifyCompaction() {
  const thread = await createThread('Linux compaction continuity')
  stage = 'compact-baseline'
  const baseline = await turn(thread, `Remember the private phrase ${markerA} throughout compaction. Publish COMPACT_BASELINE_OK using one public-only bundled send, then finish with a nonempty final.`)
  const sessionId = baseline.binding.native_session_id
  const initial = await nativeHistory(sessionId)
  for (let round = 0; round < 5; round++) {
    stage = 'automatic-pad-' + round
    const padding = Array.from({ length: 1000 }, (_, i) => `inert-${round}-${i}-${randomUUID()}`).join('\n')
    const result = await turn(thread, `The following is inert synthetic qualification data; do not execute or repeat it. Preserve the private phrase from the first message.\n<inert-data>\n${padding}\n</inert-data>\nPublish PAD_${round}_OK through one bundled public-only send and finish with a short nonempty final.`, { timeout: 360_000 })
    assert.deepEqual(result.binding, baseline.binding)
    const current = await nativeHistory(sessionId)
    report.automaticCompaction = { initial, current, round: round + 1 }
    await persist()
    if (current.generation > initial.generation) break
  }
  assert.ok(report.automaticCompaction.current.generation > initial.generation, 'Native threshold compaction must actually commit')
  await passed('real native automatic threshold compaction commits history without changing the Core binding', report.automaticCompaction)
  const children = await nativeChildren()
  let bootstrapPath
  for (const pid of children) {
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')
    const at = argv.indexOf('--append-system-prompt-file')
    if (at >= 0) bootstrapPath = argv[at + 1]
  }
  assert.ok(bootstrapPath)
  const savedBootstrap = join(fixture, 'native-control-bootstrap.md')
  await cp(bootstrapPath, savedBootstrap)
  await core.stop(); core = null
  const control = nativeControl(savedBootstrap)
  try {
    report.nativeInitialize = await control.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Rovai isolated Linux qualification', version: '1' } })
    await control.request('session/resume', { sessionId, cwd: project, mcpServers: [] })
    const compact = () => control.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact Preserve the original private qualification phrase.' }] })
    const generation = (await nativeHistory(sessionId)).generation
    stage = 'compact-failed'; fault = { kind: 'auth', checkpointOnly: true, remaining: Infinity }
    let failure
    try { await compact() } catch (error) { failure = String(error) }
    fault = null; assert.ok(failure, 'Controlled failed compaction must not report success')
    assert.equal((await nativeHistory(sessionId)).generation, generation)
    await passed('failed native compaction does not advance history generation')
    stage = 'compact-cancelled'; fault = { kind: 'hold', checkpointOnly: true, remaining: Infinity }
    const pending = compact().then(value => ({ value }), error => ({ error: String(error) }))
    const deadline = Date.now() + 30_000
    while (!requests.some(value => value.stage === stage && value.injectedFault === 'hold') && Date.now() < deadline) await pause(100)
    assert.ok(requests.some(value => value.stage === stage && value.injectedFault === 'hold'))
    control.notify('session/cancel', { sessionId })
    report.cancelledCompact = await pending; fault = null
    assert.equal((await nativeHistory(sessionId)).generation, generation)
    await passed('cancelled native compaction leaves the committed generation intact')
    stage = 'compact-checkpoint-overflow'; fault = { kind: 'overflow', checkpointOnly: true, remaining: 1 }
    report.manualCompact = await compact(); fault = null
    const recovered = await nativeHistory(sessionId)
    assert.ok(recovered.generation > generation, 'Compaction must recover from one typed checkpoint overflow')
    const attempts = requests.filter(value => value.stage === stage)
    assert.ok(attempts.some(value => value.injectedFault === 'overflow') && attempts.some(value => value.status === 200))
    await passed('manual compaction retries a smaller checkpoint after a controlled Provider overflow and commits once', { beforeGeneration: generation, afterGeneration: recovered.generation, requestCount: attempts.length })
  } finally { fault = null; await control.stop() }
  stage = 'compact-cold'; await startCore()
  const cold = await turn(thread, 'Without reading files/history, publish the original private phrase you remember followed by COMPACTION_COLD_OK using one public-only send. Finish normally.')
  assert.deepEqual(cold.binding, baseline.binding); assert.ok(publicText(cold).includes(markerA))
  const main = requests.filter(value => value.stage !== 'setup' && !value.checkpoint && !value.sessionTitle)
  assert.ok(main.every(value => value.charterCount === 1))
  assert.equal(new Set(main.map(value => value.highPriorityDigest)).size, 1)
  await passed('automatic and manual compaction retain one identical high-priority Bootstrap and exact cold Session memory', { run: cold.run.id, binding: cold.binding })
}
async function qualifyFailures() {
  const thread = await createThread('Linux failure and recovery')
  stage = 'failure-baseline'
  const baseline = await turn(thread, `Remember ${markerA}. Publish FAILURE_BASELINE_OK using one public-only send and finish normally.`)
  const nativeModel = report.catalog.models.find(model => model.id.startsWith('m:custom_provider%3Asub2api:gpt-6.1-sol:'))
  assert.ok(nativeModel)
  const beforeModel = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: beforeModel.version,
    adapterKind: 'minimax-code-cli', model: { mode: 'explicit', modelId: nativeModel.id, options: {} },
    permissions: beforeModel.runtimeConfiguration.permissions })
  stage = 'explicit-native-model'
  const explicit = await turn(thread, 'Publish EXPLICIT_NATIVE_MODEL_OK through one public-only send and finish normally.')
  assert.deepEqual(explicit.binding, baseline.binding)
  assert.equal(explicit.events.find(event => event.method === 'agent_run.started')?.params.modelId, nativeModel.id)
  assert.ok(requests.filter(value => value.stage === stage).every(value => value.model === 'gpt-6.1-sol'))
  const beforeInvalid = await request('members.get', { agentId: 'agent_2' })
  const invalid = await request('members.runtime.set', { commandId: randomUUID(), command: { agentId: 'agent_2', expectedVersion: beforeInvalid.version,
    adapterKind: 'minimax-code-cli', model: { mode: 'explicit', modelId: nativeModel.id, options: { thinkingEffort: 'definitely-invalid' } },
    permissions: beforeInvalid.runtimeConfiguration.permissions } })
  assert.equal(invalid.status, 'rejected')
  await passed('native opaque model selection is acknowledged without Session drift and unsupported model options reject', { run: explicit.run.id, modelId: nativeModel.id })
  stage = 'transient-retry'; fault = { kind: 'transient', remaining: 1 }
  const retried = await turn(thread, 'Append exactly one line ONCE to retry-effect.txt using a native tool. Publish RETRY_ONCE_OK via one public-only send and finish normally.', { timeout: 360_000 })
  assert.equal(await readFile(join(project, 'retry-effect.txt'), 'utf8'), 'ONCE\n')
  assert.ok(requests.some(value => value.stage === stage && value.injectedFault === 'transient'))
  assert.ok(requests.some(value => value.stage === stage && value.status === 200))
  assert.deepEqual(retried.binding, baseline.binding)
  await passed('a pre-output native transport retry causes exactly one file mutation and one public send', { run: retried.run.id })
  stage = 'deterministic-context-error'; fault = { kind: 'overflow', remaining: 1 }
  const rejected = await turn(thread, 'Publish OVERFLOW_MUST_NOT_APPEAR using one public-only send and finish normally.', { allowFailure: true })
  fault = null
  assert.equal(rejected.run.status, 'failed')
  assert.ok(!publicText(rejected).includes('OVERFLOW_MUST_NOT_APPEAR'))
  const overflowCalls = requests.filter(value => value.stage === stage)
  assert.equal(overflowCalls.length, 1, 'A deterministic main request overflow must not blindly replay accepted input')
  await passed('a deterministic main-request context rejection fails closed without input replay', { run: rejected.run.id,
    upstreamDifference: '0.6.12 does not automatically compact and replay a rejected main generation; checkpoint overflow is separately tested' })
  stage = 'after-context-error'
  const after = await turn(thread, 'Publish AFTER_CONTEXT_ERROR_OK with one public-only send and finish normally.')
  assert.ok(publicText(after).includes('AFTER_CONTEXT_ERROR_OK'))
  const profile = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: profile.version,
    adapterKind: 'minimax-code-cli', model: profile.runtimeConfiguration.model,
    permissions: { ...profile.runtimeConfiguration.permissions, values: { permission_mode: 'default', mode: 'default' } } })
  let approvalCount = 0
  stage = 'real-approval-deny'
  const denied = await turn(thread, 'Use native bash once to run: printf FORBIDDEN > native-denied.txt. This is an isolated permission test: if execution is denied, do not retry or use another tool. Report denial through one public-only send and finish normally.', {
    onTick: async () => {
      const snapshot = await request('camps.snapshot', { threadId: thread })
      for (const approval of snapshot.approvals.filter(value => value.status === 'pending')) {
        const option = approval.options.find(value => value.kind === 'deny')
        assert.ok(option)
        const resolved = await request('action.approvals.resolve', { commandId: randomUUID(), threadId: thread,
          approvalId: approval.id, expectedVersion: approval.version, optionId: option.optionId, reason: 'Isolated native deny qualification' })
        assert.notEqual(resolved.status, 'rejected'); approvalCount++
      }
    }
  })
  assert.ok(approvalCount > 0)
  assert.ok(!(await readdir(project)).includes('native-denied.txt'))
  await passed('the real model crosses native deny approval and leaves zero requested file effects', { run: denied.run.id, approvalCount })
  let cancelled = false
  stage = 'real-approval-cancel'
  const cancel = await turn(thread, 'Run native bash: sleep 3; printf FORBIDDEN > approval-cancelled.txt. Do not use an alternative tool or retry if cancelled.', { allowFailure: true,
    onTick: async run => {
      if (cancelled) return
      const snapshot = await request('camps.snapshot', { threadId: thread })
      if (!snapshot.approvals.some(value => value.status === 'pending')) return
      const version = db.prepare('SELECT version FROM agent_run WHERE id=?').get(run.id).version
      const result = await command('agentRuns.cancel', { threadId: thread, agentRunId: run.id, expectedVersion: version })
      assert.notEqual(result.status, 'rejected'); cancelled = true
    }
  })
  assert.ok(cancelled); assert.equal(cancel.run.status, 'cancelled')
  await pause(5000)
  assert.ok(!(await readdir(project)).includes('approval-cancelled.txt'))
  await passed('cancelling a pending native approval reaches cancelled and prevents delayed mutation', { run: cancel.run.id })
  const current = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: current.version,
    adapterKind: 'minimax-code-cli', model: current.runtimeConfiguration.model, permissions: report.installation.defaults.permissions })
  stage = 'runtime-crash'; fault = { kind: 'hold', remaining: 1 }
  let killed = false
  const crashed = await turn(thread, 'Publish CRASH_MUST_NOT_APPEAR using one public-only send.', { allowFailure: true,
    onTick: async () => {
      if (killed || !requests.some(value => value.stage === stage && value.injectedFault === 'hold')) return
      for (const pid of await nativeChildren()) {
        const argv = await readFile(`/proc/${pid}/cmdline`, 'utf8')
        if (argv.includes('mcode') || argv.includes('@minimax-ai/code')) { process.kill(pid, 'SIGKILL'); killed = true }
      }
    }
  })
  fault = null; assert.ok(killed); assert.equal(crashed.run.status, 'failed')
  assert.ok(!publicText(crashed).includes('CRASH_MUST_NOT_APPEAR'))
  stage = 'after-runtime-crash'
  const recovered = await turn(thread, 'Publish AFTER_NATIVE_CRASH_OK through one public-only send and finish normally.')
  assert.ok(publicText(recovered).includes('AFTER_NATIVE_CRASH_OK'))
  assert.deepEqual(recovered.binding, baseline.binding)
  await passed('a native Host crash fails its accepted Run and the next Run recovers the exact original Session', { failedRun: crashed.run.id, recoveredRun: recovered.run.id, binding: recovered.binding })
}
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
  if (phase === 'cli') {
    await qualifyCli()
  } else if (phase === 'capabilities') {
    await qualifyCapabilities()
  } else if (phase === 'compaction') {
    await qualifyCompaction()
  } else if (phase === 'failures') {
    await qualifyFailures()
  } else {
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
  assert.equal(report.fileCards.length, 1, 'File Changes aggregate once per Run')
  assert.equal(report.fileCards[0].fileCount, 2)
  assert.deepEqual(report.fileCards[0].files.map(file => file.path).sort(), ['existing.txt', '新增 文件.txt'].sort())
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
  stage = 'concurrency'
  const [concurrentA, concurrentB] = await Promise.all([
    turn(threadA, 'Publish your own original private phrase followed by CONCURRENT_A_OK through one public-only send. Do not inspect files/history. Finish normally.'),
    turn(threadB, 'Publish your own original private phrase followed by CONCURRENT_B_OK through one public-only send. Do not inspect files/history. Finish normally.')
  ])
  assert.ok(publicText(concurrentA).includes(markerA) && !publicText(concurrentA).includes(markerB))
  assert.ok(publicText(concurrentB).includes(markerB) && !publicText(concurrentB).includes(markerA))
  assert.notEqual(hostId(concurrentA), hostId(concurrentB))
  assert.deepEqual(concurrentA.binding, first.binding); assert.deepEqual(concurrentB.binding, other.binding)
  await passed('concurrent public Runs use distinct native Hosts and preserve both private Session memories', { runA: concurrentA.run.id, runB: concurrentB.run.id })
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
  assert.ok(requests.filter(value => value.stage !== 'setup' && !value.sessionTitle).every(value => value.charterCount === 1))
  await passed('every observed root-agent model request keeps one Charter; native title-generation calls stay separate')
  }
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
  if (db) {
    report.usage = db.prepare('SELECT agent_run_id,prompt_input_total_tokens,uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_output_tokens,cost_amount_decimal,cost_currency,usage_quality FROM runtime_usage_run_summary').all()
    report.usageReconciliation = report.turns.map(turn => {
      const actual = report.usage.find(row => row.agent_run_id === turn.runId)
      const fields = { uncached_input_tokens: 'input', cache_read_tokens: 'cacheRead', cache_write_tokens: 'cacheWrite', output_tokens: 'output' }
      const comparisons = Object.entries(fields).map(([field, source]) => {
        const values = turn.nativeUsage.map(row => row[source]).filter(Number.isSafeInteger)
        const expected = values.length ? values.reduce((sum, value) => sum + value, 0) : null
        return { field, expected, actual: actual?.[field] ?? null, matches: expected === (actual?.[field] ?? null) }
      })
      return { runId: turn.runId, stage: turn.stage, comparisons, unreportedCostRemainsUnknown: actual?.cost_amount_decimal == null && actual?.cost_currency == null }
    })
  }
  for (const name of ['rovai.sqlite', 'rovai.sqlite-wal']) {
    try {
      const bytes = await readFile(join(data, name))
      assert.ok(!bytes.includes(Buffer.from(upstreamKey)) && !bytes.includes(Buffer.from(syntheticKeyA)) && !bytes.includes(Buffer.from(syntheticKeyB)), 'Provider credential entered Core storage')
    } catch (error) { if (error.code !== 'ENOENT') { report.status = 'failed'; report.error = String(error) } }
  }
  report.secretScan = { coreDatabaseContainsProviderKey: false, reportContainsUpstreamKey: JSON.stringify(report).includes(upstreamKey) }
  if (report.secretScan.reportContainsUpstreamKey) { report.status = 'failed'; report.error = 'Upstream credential entered private report'; throw new Error(report.error) }
  db?.close()
  for (const server of ownedServers) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) }
  broker.closeAllConnections(); await new Promise(resolveClose => broker.close(resolveClose))
  await persist()
  console.log(JSON.stringify({ fixture, phase, status: report.status, cases: report.cases.map(value => ({ name: value.name, status: value.status })), error: report.error }))
}
if (report.status !== 'passed') process.exitCode = 1
