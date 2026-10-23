// Installed Hermes + deterministic model endpoint. Real native file operations,
// reasoning config, active redirect, questionnaire exclusion and provider errors.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openHermesAcp } from './lib/hermes-native-acp.mjs'

const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-experience-')))
const home = join(root, 'home'), project = join(root, 'project')
await mkdir(home, { mode: 0o700 }); await mkdir(project)
const wire = [], queue = []
let fail = false, hold = false, release, count = 0, wireError
const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'fixture-model', object: 'model' }] })); return
    }
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (!Array.isArray(body.input)) { response.end('{}'); return }
    wire.push(body)
    if (hold) { hold = false; await new Promise(done => { release = done }) }
    if (fail) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Model invalid-hermes-model does not exist', type: 'invalid_request_error', code: 'model_not_found' } })); return
    }
    const next = queue.shift(), index = ++count, id = `response-${index}`
    const items = next ? next.map((call, n) => ({ type: 'function_call', id: `fc-${index}-${n}`, call_id: `call-${index}-${n}`,
      name: call.name, arguments: JSON.stringify(call.args), status: 'completed' })) : [{ type: 'message', id: `message-${index}`,
      role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'EXPERIENCE_OK', annotations: [] }] }]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    let sequence = 0
    const emit = event => response.write('data: ' + JSON.stringify({ ...event, sequence_number: sequence++ }) + '\n\n')
    emit({ type: 'response.created', response: { id, status: 'in_progress', output: [] } })
    for (const [output_index, item] of items.entries()) {
      emit({ type: 'response.output_item.added', output_index, item })
      emit({ type: 'response.output_item.done', output_index, item })
    }
    emit({ type: 'response.completed', response: { id, status: 'completed', output: items,
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } })
    response.end()
  } catch (error) { wireError = error; response.writeHead(500); response.end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
await writeFile(join(home, 'config.yaml'), JSON.stringify({ model: { provider: 'fixture', default: 'fixture-model' },
  providers: { fixture: { base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key_env: 'ROVAI_HERMES_FIXTURE_KEY',
    transport: 'codex_responses', models: ['fixture-model'] } },
  platform_toolsets: { acp: ['file', 'terminal', 'clarify', 'no_mcp'] },
  agent: { max_turns: 20, disabled_toolsets: ['clarify'], reasoning_effort: 'low' },
  session_title: { enabled: false }, compression: { enabled: false } }), { mode: 0o600 })
let client
console.log('Isolated fixture:', root)
try {
  client = await openHermesAcp({ executable: process.env.ROVAI_HERMES_BIN,
    script: resolve(import.meta.dirname, '../crates/rovai-core/src/hermes/host.py'), cwd: project,
    env: { ...process.env, HERMES_HOME: home, ROVAI_HERMES_FIXTURE_KEY: 'controlled-fixture' } })
  const session = await client.request('session/new', { cwd: project, mcpServers: [] }), sessionId = session.sessionId
  await client.request('session/set_mode', { sessionId, modeId: 'dont_ask' })
  const bootstrap = 'Run the requested integration fixture. Never ask a questionnaire.'
  await client.request('_rovai/bind', { sessionId, bootstrap, sha256: createHash('sha256').update(bootstrap).digest('hex') })
  const prompt = id => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Execute the fixture.' }], _meta: { rovai: { promptId: id } } })
  const selected = await client.request('session/set_config_option', { sessionId, configId: 'model', value: 'custom:fixture:fixture-model' })
  assert.equal(selected.configOptions.find(o => o.id === 'model').currentValue, 'custom:fixture:fixture-model', 'Named custom endpoint identity did not round-trip')
  const effort = await client.request('session/set_config_option', { sessionId, configId: 'reasoning_effort', value: 'high' })
  assert.equal(effort.configOptions.find(o => o.id === 'reasoning_effort').currentValue, 'high')
  const path = join(project, '中文 space.txt'), second = join(project, 'second.txt')
  queue.push([{ name: 'write_file', args: { path, content: 'alpha\n' } }],
    [{ name: 'write_file', args: { path, content: 'beta\n' } }],
    [{ name: 'patch', args: { path, old_string: 'beta', new_string: 'gamma' } }],
    [{ name: 'patch', args: { mode: 'patch', patch: `*** Begin Patch\n*** Add File: ${second}\n+two\n*** Delete File: ${path}\n*** End Patch` } }])
  assert.equal((await prompt('file-turn')).stopReason, 'end_turn')
  const states = client.events.flatMap(m => m.params?.update?._meta?.rovaiHermesFileStates ?? [])
  assert(states.some(s => s.path === path && s.changeKind === 'add' && s.oldText === null && s.newText === 'alpha\n'), 'New-file states missing')
  assert(states.some(s => s.oldText === 'alpha\n' && s.newText === 'beta\n'), 'Overwrite states missing')
  assert(states.some(s => s.oldText === 'beta\n' && s.newText === 'gamma\n'), 'Patch states missing')
  assert(states.some(s => s.path === path && s.changeKind === 'delete'), 'Delete states missing')
  assert(states.some(s => s.path === second && s.changeKind === 'add'), 'Multi-file add missing')
  assert(wire.every(body => body.tools.every(tool => !/ask_user|clarify/.test(tool.name ?? ''))), 'Disabled questionnaire advertised')
  assert(wire.some(body => body.reasoning?.effort === 'high'), 'Native reasoning effort absent from wire')
  assert(!JSON.stringify(wire).includes('rovaiHermesFileStates'), 'Evidence leaked into model history')
  const empty = join(project, 'empty.txt'), crlf = join(project, 'crlf.txt'), moved = join(project, 'moved.txt')
  const binary = join(project, 'binary.dat'), large = join(project, 'large.txt')
  await writeFile(crlf, 'old\r\n'); await writeFile(binary, Buffer.from([0, 1, 2])); await writeFile(large, 'x'.repeat(1024 * 1024 + 1))
  const edgeStart = client.events.length
  queue.push([{ name: 'read_file', args: { path: crlf } }], [{ name: 'write_file', args: { path: empty, content: '' } },
    { name: 'write_file', args: { path: crlf, content: 'new\n' } }],
    [{ name: 'write_file', args: { path: empty, content: '' } }],
    [{ name: 'patch', args: { path: crlf, old_string: 'not-present', new_string: 'NEVER' } }],
    [{ name: 'patch', args: { mode: 'patch', patch: `*** Begin Patch\n*** Move File: ${second} -> ${moved}\n*** End Patch` } }],
    [{ name: 'write_file', args: { path: binary, content: 'text' } }, { name: 'write_file', args: { path: large, content: 'small' } }])
  assert.equal((await prompt('file-edges')).stopReason, 'end_turn')
  const edgeEvents = client.events.slice(edgeStart), edges = edgeEvents.flatMap(m => m.params?.update?._meta?.rovaiHermesFileStates ?? [])
  assert.equal(edges.filter(s => s.path === empty).length, 1, 'No-change generated duplicate file evidence')
  assert(edges.some(s => s.path === empty && s.oldText === null && s.newText === '' && s.changeKind === 'add'), 'Empty creation lost missing-state semantics')
  assert(edges.some(s => s.path === crlf && s.oldText === 'old\r\n' && s.newText === 'new\r\n'), 'Native CRLF normalization lost')
  assert.equal(await readFile(crlf, 'utf8'), 'new\r\n')
  assert(!edges.some(s => [binary, large].includes(s.path)), 'Unbounded or binary old state guessed as empty')
  assert(!edgeEvents.some(m => m.params?.update?.status === 'failed' && m.params.update._meta?.rovaiHermesFileStates), 'Failed patch produced successful evidence')
  assert(edges.some(s => s.path === second && s.changeKind === 'delete'), 'Move source deletion missing')
  assert(edges.some(s => s.path === moved && s.changeKind === 'add'), 'Move destination creation missing')
  console.log('Native file states, reasoning and questionnaire exclusion passed')
  hold = true
  const active = prompt('steer-turn')
  active.catch(() => {}) // Preserve the original assertion if cleanup closes a pending prompt.
  const deadline = Date.now() + 15000
  while (!release && Date.now() < deadline) await new Promise(done => setTimeout(done, 20))
  assert(release, 'Model request did not start')
  assert.equal((await client.request('_rovai/steer', { sessionId, inputId: 'wrong', expectedPromptId: 'other', text: 'NEVER' })).accepted, false)
  const steer = await client.request('_rovai/steer', { sessionId, inputId: 'input-1', expectedPromptId: 'steer-turn', text: 'STEER-MARKER-8302' })
  assert.equal(steer.accepted, true, JSON.stringify(steer))
  release(); release = null
  assert.equal((await active).stopReason, 'end_turn')
  assert(JSON.stringify(wire.at(-1)).includes('STEER-MARKER-8302'), 'Native redirect never reached model')
  assert.equal((await client.request('_rovai/steer', { sessionId, inputId: 'late', expectedPromptId: 'steer-turn', text: 'NEVER' })).accepted, false)
  fail = true
  await assert.rejects(prompt('error-turn'), error => error.rpcError?.code === -32003 && /invalid-hermes-model/.test(error.rpcError?.data?.error))
  if (wireError) throw wireError
  const summary = { fileStates: states, edgeStates: edges, reasoning: true, questionnaireDisabled: true, steer: true, nativeErrorDetail: true }
  await writeFile(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log('Experience acceptance passed:', root)
} catch (error) {
  await writeFile(join(root, 'events.json'), JSON.stringify(client?.events ?? [], null, 2))
  await writeFile(join(root, 'stderr.log'), client?.stderr ?? '')
  throw error
} finally {
  release?.(); if (client) console.log('Cleanup:', await client.close())
  server.closeAllConnections(); await new Promise(done => server.close(done))
}
