// Official, unpatched Hermes with one native Home and a pre-existing shared Gateway.
// Usage: node scripts/smoke-hermes-native-session.mjs <official-source> <prepared-python>
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn, spawnSync, execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, readFile, cp, realpath, symlink, readdir} from 'node:fs/promises'
import {join, resolve, isAbsolute} from 'node:path'
import {tmpdir} from 'node:os'
import {DatabaseSync} from 'node:sqlite'
import {createHash, randomUUID} from 'node:crypto'
import {startQualificationCore} from './lib/qualification-core.mjs'
import {createConfiguredCampAndSend, composerDocumentForAddress} from './lib/create-configured-camp.mjs'

const [officialSource, python] = process.argv.slice(2)
assert([officialSource, python].every(p => p && isAbsolute(p)))
const repository = resolve(import.meta.dirname, '..')
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-native-session-')))
const userHome = join(root, 'user'), nativeHome = join(userHome, '.hermes')
const project = join(root, 'project'), data = join(root, 'data'), source = join(root, 'hermes-agent')
for (const p of [nativeHome, project, data]) await mkdir(p, {recursive: true, mode: 0o700})
// The test user's normal CLI installation precedes Gateway/Core startup.
// A Run must not create or repair the fixed installation entry.
await mkdir(join(userHome, '.local/bin'), {recursive: true})
await symlink(join(repository, 'target/debug/rovai'), join(userHome, '.local/bin/rovai'))
execFileSync('git', ['clone', '--shared', '--no-hardlinks', officialSource, source], {stdio: 'pipe'})
await cp(join(officialSource, 'install-stamp.json'), join(source, 'install-stamp.json'))
const nativeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim()
const sh = s => "'" + s.replaceAll("'", "'\\''") + "'"
// A test installation entry selecting the existing prepared interpreter; no upstream code changes.
const launcher = join(root, 'hermes')
const bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(source)}); sys._hermes_pin_default_home = True; import hermes_bootstrap; import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)`
await writeFile(launcher, `#!/bin/sh\nexec ${sh(python)} -I -B -c ${sh(bootstrap)} "$@"\n`, {mode: 0o700})
const wire = [], calls = new Map(), runs = [], checks = {}, threads = {}, sessions = {}
let core, gateway, database, wireError, gatewayLog = '', summaries = 0
const text = value => ({id: randomUUID(), type: 'message', role: 'assistant', status: 'completed', content: [{type: 'output_text', text: value, annotations: []}]})
function respond(res, body, item, tokens = 100) {
  const id = 'response-' + randomUUID(), output = {id, object: 'response', status: 'completed', output: [item], usage: {input_tokens: tokens, output_tokens: 10, total_tokens: tokens + 10}}
  if (!body.stream) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(output)); return}
  res.writeHead(200, {'content-type': 'text/event-stream'}); let sequence = 0
  const emit = event => res.write('data: ' + JSON.stringify({...event, sequence_number: sequence++}) + '\n\n')
  emit({type: 'response.created', response: {id, status: 'in_progress', output: []}})
  emit({type: 'response.output_item.added', output_index: 0, item})
  if (item.type === 'message') emit({type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text})
  emit({type: 'response.output_item.done', output_index: 0, item})
  emit({type: 'response.completed', response: output}); res.end()
}
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({data: [{id: 'native-probe', object: 'model'}]})); return}
    const parts = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts)); wire.push(body)
    if (!Array.isArray(body.input)) {res.end('{}'); return}
    const main = Array.isArray(body.tools) && body.tools.length > 0
    if (!main) {if (JSON.stringify(body.input).includes('You are a summarization agent creating a context checkpoint.')) summaries++; respond(res, body, text('Earlier isolated tasks completed. Continue the current task.')); return}
    const label = [...JSON.stringify(body.input).matchAll(/SESSION_PROBE:([AB][0-9]+)/g)].at(-1)?.[1]
    const n = calls.get(label) ?? 0; calls.set(label, n + 1)
    if (label && n === 0) {
      const contexts = join(data, 'runtime', 'builtin-tools')
      const processes = await readdir(contexts)
      assert(processes.length > 0, 'A live native CLI lease must retain its process/run-tmp root')
      for (const process of processes) assert(!await exists(join(contexts, process, 'context.json')), 'Hermes must not project a CLI context file')
      checks.noHermesContextProjection = true
    }

    const mcpRound = ['A0', 'A1', 'A2', 'A6'].includes(label)
    if (mcpRound && n >= 1 && n <= 3) {
      const toolName = JSON.stringify(body.input).match(/mcp__editor_hermes_fixture_[a-z0-9]+__echo/)?.[0]
      const name = n === 1 ? 'tool_search' : n === 2 ? 'tool_describe' : 'tool_call'
      if (n > 1) assert(toolName, 'Assigned MCP tool was not discovered')
      const args = n === 1 ? {queries: ['hermes_fixture']} : n === 2 ? {names: [toolName]} : {calls: [{name: toolName, arguments: {text: 'NATIVE_MCP_' + label}}]}
      respond(res, body, {id: randomUUID(), type: 'function_call', call_id: randomUUID(), name, arguments: JSON.stringify(args), status: 'completed'}); return
    }
    if (!label || n > 0) {respond(res, body, text('Done.')); return}
    const observation = `import os,json,pathlib; pathlib.Path(${JSON.stringify(join(root, label + '.json'))}).write_text(json.dumps({k:os.environ.get(k) for k in ['HERMES_SESSION_CHAT_ID','HERMES_SESSION_ID','HERMES_HOME','ROVAI_CLI_CONTEXT']}))`
    let command = `rovai --version > ${sh(join(root, label + '.version'))}; python3 -c ${sh(observation)}; rovai send --public-only --body NATIVE_OK_${label}`
    if (label === 'A0') command += `; python3 -c ${sh(`import subprocess; subprocess.Popen(['python3',${JSON.stringify(join(root, 'late.py'))}],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)`)}`
    if (label === 'A1') command += `; touch ${sh(join(root, 'release-old'))}; python3 -c ${sh(`import pathlib,time; p=pathlib.Path(${JSON.stringify(join(root, 'late.json'))}); end=time.time()+20\nwhile not p.exists() and time.time()<end: time.sleep(.05)\nassert p.exists()`)}`
    if (label === 'B2') command += `; touch ${sh(join(root, 'crash-started'))}; python3 -c ${sh(`import pathlib,time; p=pathlib.Path(${JSON.stringify(join(root,'crash-release'))}); end=time.time()+30\nwhile not p.exists() and time.time()<end: time.sleep(.05)\nassert p.exists()`)}; touch ${sh(join(root, 'crash-finished'))}`
    if (label === 'A5') command += `; touch ${sh(join(root, 'cancel-started'))}; sleep 15; touch ${sh(join(root, 'cancel-finished'))}`
    respond(res, body, {id: randomUUID(), type: 'function_call', call_id: randomUUID(), name: 'terminal', arguments: JSON.stringify({command}), status: 'completed'}, ['A3', 'A4'].includes(label) ? 60000 : 100)
  } catch (error) {wireError = error; res.writeHead(500); res.end()}
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const config = {model: {provider: 'fixture', default: 'native-probe', context_length: 65536},
  providers: {fixture: {base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'HERMES_NATIVE_PROBE_KEY', transport: 'codex_responses', models: ['native-probe']}},
  updates: {check: false}, platform_toolsets: {acp: ['terminal', 'skills', 'mcp']}, session_title: {enabled: false},
  agent: {max_turns: 8, system_prompt: 'NATIVE_CONFIG_SYSTEM_RETAINED'},
  compression: {enabled: true, threshold: 0.5, protect_first_n: 0, protect_last_n: 2}}
await writeFile(join(nativeHome, 'config.yaml'), JSON.stringify(config), {mode: 0o600})
await writeFile(join(nativeHome, '.env'), 'PROBE_SENTINEL=unchanged\n', {mode: 0o600})
const mcpId = randomUUID(), brokenId = randomUUID()
await writeFile(join(root, 'mcp.json'), JSON.stringify({mcpServers: {
  hermes_fixture: {command: process.execPath, args: [join(repository, 'crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')], env: {ROVAI_MCP_SMOKE_SOURCE: 'HERMES_MCP', ROVAI_MCP_SMOKE_CALL_MARKER: join(root, 'mcp-called')}},
  broken_fixture: {command: join(root, 'missing-mcp'), args: []}},
  _rovai: {schemaVersion: 2, servers: {hermes_fixture: {serverId: mcpId, enabled: true, source: 'user', riskLevel: 'standard'}, broken_fixture: {serverId: brokenId, enabled: true, source: 'user', riskLevel: 'standard'}}, assignments: [{serverId: mcpId, agentId: 'agent_2'}, {serverId: brokenId, agentId: 'agent_2'}]}}), {mode: 0o600})
await writeFile(join(root, 'late.py'), `import pathlib,time,subprocess,json\np=pathlib.Path(${JSON.stringify(root)})\nend=time.time()+180\nwhile not (p/'release-old').exists() and time.time()<end: time.sleep(.05)\nif not (p/'release-old').exists(): raise SystemExit(2)\nr=subprocess.run(['rovai','send','--public-only','--body','LATE_A0_AS_A1'],capture_output=True,text=True)\n(p/'late.json').write_text(json.dumps(dict(code=r.returncode,output=r.stdout)))\n`)
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const original = {config: await hash(join(nativeHome, 'config.yaml')), env: await hash(join(nativeHome, '.env'))}
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ROVAI_') && !k.startsWith('HERMES_')))
Object.assign(env, {HOME: userHome, HERMES_HOME: nativeHome, HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_NATIVE_PROBE_KEY: 'loopback-only', PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'})
const options = {coreExecutable: join(repository, 'target/debug/rovai-core'), dataDirectory: data, workingDirectory: repository,
  runtimeCacheDirectory: join(root, 'runtime-cache'), mcpConfigPath: join(root, 'mcp.json'),
  environmentOverrides: {...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith('ROVAI_') || k.startsWith('HERMES_')).map(k => [k, undefined])), ...env, ROVAI_HERMES_BIN: launcher}}
const exists = async path => {try {await readFile(path); return true} catch {return false}}
const alive = child => child && child.exitCode === null && child.signalCode === null
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {if (wireError) throw wireError; if (core?.stderrTail.includes('panicked at')) throw Error(core.stderrTail); const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 100))}
  throw Error('Native Session acceptance deadline exceeded: ' + (core?.stderrTail ?? ''))
}
const row = (sql, ...args) => database.prepare(sql).get(...args)
async function send(name, round) {
  const agentId = name === 'A' ? 'agent_2' : 'agent_3', label = name + round, body = `SESSION_PROBE:${label} Complete the isolated task.`
  const previousRunRow = threads[name] ? row('SELECT COALESCE(MAX(rowid),0) AS n FROM agent_run WHERE camp_id=?', threads[name]).n : 0
  if (!threads[name]) {
    const sent = await createConfiguredCampAndSend(core.request, {commandId: randomUUID(), name: 'Native Session ' + name, purpose: 'Isolated native session acceptance', body, memberAgentIds: [agentId], defaultLeadAgentId: agentId, workspace: {projectPath: project}})
    threads[name] = sent.payload.threadId
  } else await core.request('thread.messages.send', {commandId: randomUUID(), threadId: threads[name], content: composerDocumentForAddress({mode: 'explicit', agentIds: [agentId]}, body), sourceAttachments: [], quotes: [], replyToThreadMessageId: null, deliveryMode: 'start', execution: {taskId: null, purpose: 'Native session continuation', completionRole: 'required'}})
  console.log("submitted", label, threads[name]);

  return {label, name, agentId, thread: threads[name], previousRunRow}
}
async function waitForToolStart(thread, marker) {
  await until(async () => {
    const snapshot = await core.request('threads.snapshot', {threadId: thread})
    for (const approval of snapshot.approvals.filter(a => a.status === 'pending')) {
      const option = approval.options.find(o => o.kind === 'allow_once'); assert(option)
      await core.request('action.approvals.resolve', {commandId: randomUUID(), threadId: thread, approvalId: approval.id, expectedVersion: approval.version, optionId: option.optionId, reason: 'Isolated controlled native Session probe'})
    }
    return exists(join(root, marker))
  })
}
async function settled(test) {
  const run = await until(async () => {
    const r = row('SELECT id,status,execution_epoch,public_runtime_failure_json AS failure FROM agent_run WHERE camp_id=? AND rowid>? ORDER BY rowid DESC LIMIT 1', test.thread, test.previousRunRow)
    if (r?.status === 'waiting') {
      const snapshot = await core.request('threads.snapshot', {threadId: test.thread})
      for (const approval of snapshot.approvals.filter(a => a.status === 'pending')) {
        const option = approval.options.find(o => o.kind === 'allow_once'); assert(option)
        await core.request('action.approvals.resolve', {commandId: randomUUID(), threadId: test.thread, approvalId: approval.id, expectedVersion: approval.version, optionId: option.optionId, reason: 'Isolated controlled native Session probe'})
      }
    }
    return r && ['succeeded', 'failed', 'cancelled'].includes(r.status) && !runs.some(v => v.run === r.id) && r
  })
  assert.equal(run.status, 'succeeded', JSON.stringify({test, run}))
  const compatibility = row('SELECT runtime_binding_compatibility_digest AS binding, runtime_host_config_digest AS host, runtime_compatibility_digest AS runtime FROM agent_run WHERE id=?', run.id)
  assert.deepEqual({...compatibility}, {binding: null, host: null, runtime: null})

  const message = row("SELECT * FROM camp_message WHERE camp_id=? AND author_type='agent' AND body=?", test.thread, 'NATIVE_OK_' + test.label)
  assert(message, test.label + ' missing public Send'); assert.equal(message.author_id, test.agentId); assert.equal(message.source_agent_run_id, run.id)
  const sid = row('SELECT native_session_id FROM conversation WHERE camp_id=? AND agent_id=?', test.thread, test.agentId).native_session_id
  if (sessions[test.name]) assert.equal(sid, sessions[test.name]); else sessions[test.name] = sid
  const observed = JSON.parse(await readFile(join(root, test.label + '.json')))
  assert.equal(observed.HERMES_SESSION_CHAT_ID, sid); assert.equal(observed.HERMES_HOME, nativeHome); assert.equal(observed.ROVAI_CLI_CONTEXT, null)
  const delivery = row("SELECT hermes_rules_delivery_kind AS kind FROM runtime_input_delivery WHERE agent_run_id=? AND status='accepted' ORDER BY rowid LIMIT 1", run.id)
  assert(delivery); assert.equal(delivery.kind, test.label === 'A0' || test.label === 'B0' ? 'initial' : test.label === 'A2' ? 'update' : 'none')
  console.log("succeeded", test.label, run.id);
  runs.push({...test, run: run.id, epoch: run.execution_epoch, nativeSessionId: sid, physicalSessionId: observed.HERMES_SESSION_ID, rules: delivery.kind, messageId: message.id})
  return run
}
console.log(JSON.stringify({channel: 'isolated automatic acceptance', root, userHome, nativeHome, data, skillLibrary: join(data, 'managed-skill-library'), nativeCommit}))
try {
  gateway = spawn(launcher, ['--profile', 'default', 'gateway', 'run', '--quiet'], {cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
  gateway.stdout.on('data', d => gatewayLog += d); gateway.stderr.on('data', d => gatewayLog += d)
  await until(async () => {if (!alive(gateway)) throw Error(gatewayLog); return exists(join(nativeHome, 'gateway.lock'))})
  core = startQualificationCore(options); await core.request('health.check')
  await until(async () => !(await core.request('runtime.status.get')).runtimeAvailability.some(r => r.runtimeKind === 'hermes-cli' && r.discovery.discoveryStatus === 'detecting'))
  await core.request('runtime.startup.save', {runtimeKind: 'hermes-cli', configuration: {programPath: launcher, environment: []}, expectedRevision: 0})
  const check = await core.request('runtime.product.check', {runtimeKind: 'hermes-cli'}); assert(check.ready, JSON.stringify(check))
  const installation = await until(async () => {const r = (await core.request('runtime.installations.list')).find(v => v.adapterKind === 'hermes-cli' && v.installationClass === 'managed_default'); return r?.snapshot?.probeStatus === 'ready' && r})
  assert(installation.snapshot.capabilities.includes('hermes.native_session_cli')); assert(!installation.snapshot.capabilities.some(c => c.startsWith('context.compaction.')))
  assert(!installation.snapshot.capabilities.some(c => c.startsWith('mcp.same_name_policy.')))
  for (const agentId of ['agent_2', 'agent_3']) {
    const member = await core.request('members.get', {agentId})
    assert.equal((await core.request('members.runtime.set', {commandId: randomUUID(), command: {agentId, expectedVersion: member.version, adapterKind: 'hermes-cli', model: installation.memberRuntimeDefaults.model, permissions: installation.memberRuntimeDefaults.permissions}})).status, 'applied')
  }
  database = new DatabaseSync(join(data, 'rovai.sqlite'), {readOnly: true})
  for (const round of [0, 1]) await Promise.all(['A', 'B'].map(async name => settled(await send(name, round))))
  assert.notEqual(sessions.A, sessions.B)
  const late = JSON.parse(await readFile(join(root, 'late.json'))); assert.equal(late.code, 0)
  assert.equal(row("SELECT source_agent_run_id FROM camp_message WHERE body='LATE_A0_AS_A1'").source_agent_run_id, runs.find(r => r.label === 'A1').run)
  checks.concurrentMembers = true; checks.backgroundUsesRunAtCallTime = true
  for (const id of [sessions.B, 'unknown-session']) {
    const rejected = spawnSync(join(userHome, '.local/bin/rovai'), ['send', '--public-only', '--body', 'MUST_NOT_SEND'], {env: {...env, HERMES_SESSION_PLATFORM: 'local', HERMES_SESSION_CHAT_ID: id}, encoding: 'utf8'})
    assert.notEqual(rejected.status, 0); assert(rejected.stdout.includes('builtin_tool.run_not_bound'), JSON.stringify({status: rejected.status, stdout: rejected.stdout, stderr: rejected.stderr}))
  }
  assert.equal(row("SELECT COUNT(*) AS n FROM camp_message WHERE body='MUST_NOT_SEND'").n, 0)
  checks.noActiveOrUnknownSessionRejected = true
  await core.stop(); core = null; assert(alive(gateway)); checks.gatewaySurvivesCoreShutdown = true
  core = startQualificationCore(options); await core.request('health.check')
  const member = await core.request('members.get', {agentId: 'agent_2'})
  assert.equal((await core.request('members.update', {commandId: randomUUID(), command: {agentId: 'agent_2', expectedVersion: member.version, displayName: 'Native Session updated', teamRole: member.teamRole, professionalResponsibilities: member.professionalResponsibilities, personalityTraits: member.personalityTraits, workingPrinciples: member.workingPrinciples, growthTopic: member.growthTopic}})).status, 'applied')
  for (const round of [2, 3, 4]) await settled(await send('A', round))
  assert.equal(summaries, 2)
  const nativeLog = await readFile(join(nativeHome, 'logs/agent.log'), 'utf8')
  assert(nativeLog.split('\n').some(line => line.includes('broken_fixture') && line.includes('failed')))
  const compressions = nativeLog.split('\n').filter(line => line.includes('context compression attempt telemetry:')).map(line => JSON.parse(line.slice(line.indexOf('{'))))
  assert.equal(compressions.filter(c => c.commit_status === 'committed' && c.session_id === sessions.A).length, 2)
  checks.nativeCompactionNoRulesRedelivery = true
  assert.equal(row("SELECT COUNT(*) AS n FROM bootstrap_redelivery_requirement WHERE adapter_kind='hermes-cli'").n, 0)
  assert(wire.some(body => JSON.stringify(body).includes('NATIVE_CONFIG_SYSTEM_RETAINED')))
  checks.nativeSystemPromptPreserved = true
  assert.equal(original.config, await hash(join(nativeHome, 'config.yaml'))); assert.equal(original.env, await hash(join(nativeHome, '.env')))
  checks.nativeConfigUnchanged = true
  assert(wire.some(body => JSON.stringify(body.input ?? []).includes('HERMES_MCP:NATIVE_MCP_A0')))
  assert(wire.some(body => JSON.stringify(body.input ?? []).includes('HERMES_MCP:NATIVE_MCP_A1')))
  assert(wire.some(body => JSON.stringify(body.input ?? []).includes('HERMES_MCP:NATIVE_MCP_A2')))
  checks.mcpNewAndColdResumeWithPartialFailure = true
  checks.fixedCliWithoutAcpPathInjection = true
  // Cancel one member while the other continues on the shared execution server.
  await send('A', 5)
  const other = settled(await send('B', 3))
  await waitForToolStart(threads.A, 'cancel-started')
  const active = row('SELECT id,version FROM agent_run WHERE camp_id=? ORDER BY rowid DESC LIMIT 1', threads.A)
  assert.notEqual((await core.request('agentRuns.cancel', {commandId: randomUUID(), command: {threadId: threads.A, agentRunId: active.id, expectedVersion: active.version}})).status, 'rejected')
  await until(() => row('SELECT status FROM agent_run WHERE id=?', active.id).status === 'cancelled')
  await other; assert(alive(gateway)); checks.cancelDoesNotStopOtherSession = true
  // Gateway replacement is performed only by this fixture, never by Core.
  await core.stop(); core = null
  gateway.kill('SIGTERM'); await until(() => !alive(gateway), 15000)
  gateway = spawn(launcher, ['--profile', 'default', 'gateway', 'run', '--quiet'], {cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
  gateway.stdout.on('data', d => gatewayLog += d); gateway.stderr.on('data', d => gatewayLog += d)
  await until(() => exists(join(nativeHome, 'gateway.lock')))
  core = startQualificationCore(options); await core.request('health.check')
  await settled(await send('A', 6))
  assert(wire.some(body => JSON.stringify(body.input ?? []).includes('HERMES_MCP:NATIVE_MCP_A6')))
  checks.mcpRebindAfterNativeGatewayRestart = true
  await send('B', 2)
  await waitForToolStart(threads.B, 'crash-started')
  const crashed = row('SELECT id FROM agent_run WHERE camp_id=? ORDER BY rowid DESC LIMIT 1', threads.B)
  process.kill(core.pid, 'SIGKILL'); await core.stop(1000); core = null
  assert(alive(gateway)); await writeFile(join(root, 'crash-release'), 'release')
  await until(() => exists(join(root, 'crash-finished')))
  core = startQualificationCore(options); await core.request('health.check')
  const recovered = row('SELECT status FROM agent_run WHERE id=?', crashed.id)
  assert.notEqual(recovered.status, 'succeeded')
  assert.equal(row("SELECT COUNT(*) AS n FROM camp_message WHERE body='NATIVE_OK_B2'").n, 1)
  await settled(await send('B', 4))
  assert.equal(calls.get('B2'), 2, 'Restart must not replay the interrupted task')
  checks.coreKillDoesNotKillGatewayOrReplay = true

  for (const run of runs) {
    const payload = wire.filter(body => body.tools?.length && Array.isArray(body.input))
      .map(body => body.input.findLast(item => item.role === 'user')?.content)
      .map(content => typeof content === 'string' ? content : JSON.stringify(content))
      .find(content => content?.includes('SESSION_PROBE:' + run.label))
    assert(payload, 'Missing actual model input for ' + run.label)
    assert.equal(payload.includes('[Rovai 协作规则]'), run.rules === 'initial')
    assert.equal(payload.includes('[Rovai 协作规则更新]'), run.rules === 'update')
    assert(!payload.includes('[Rovai 协作规则恢复]'))
  }
  assert.equal(row('SELECT COUNT(*) AS n FROM agent_run').n, 12)
  checks.actualModelInputsMatchRulesDelivery = true
  checks.noHermesCompatibilityDigests = true
  checks.cliEntryInstalledBeforeRuns = true

  await core.stop(); core = null; assert(alive(gateway))
  checks.originalSessionColdResume = true
  assert.equal(original.config, await hash(join(nativeHome, 'config.yaml'))); assert.equal(original.env, await hash(join(nativeHome, '.env')))
  assert.equal(execFileSync('git', ['diff', '--exit-code'], {cwd: source, encoding: 'utf8'}), '')
  console.log(JSON.stringify({checks, runs, summaries, root}, null, 2))
} catch (error) {checks.failure = String(error); throw error}
finally {
  if (core) await core.stop().catch(() => {})
  database?.close()
  if (alive(gateway)) {gateway.kill('SIGTERM'); await until(() => !alive(gateway), 15000).catch(() => gateway.kill('SIGKILL'))}
  server.closeAllConnections(); await new Promise(r => server.close(r))
  await writeFile(join(root, 'report.json'), JSON.stringify({nativeCommit, checks, runs, summaries}, null, 2))
  await writeFile(join(root, 'wire.json'), JSON.stringify(wire)); await writeFile(join(root, 'gateway.log'), gatewayLog)
  console.log('Evidence:', root)
}
