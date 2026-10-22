// Opt-in acceptance against the installed native executor and a real model.
// Supply a private, preconfigured Hermes Home. No secret discovery or copying.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { openHermesAcp } from './lib/hermes-native-acp.mjs'

const home = process.env.ROVAI_HERMES_SMOKE_HOME
assert(home && process.env.ROVAI_HERMES_BIN, 'Set the private Home and official executable')
const root = await realpath(resolve(home, '..')), project = join(root, 'project')
await mkdir(project, { recursive: true })
const fixture = join(root, 'mcp-proof.mjs')
await writeFile(fixture, `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'hermes-proof',version:'1'}}:
m.method==='tools/list'?{tools:[{name:'probe',description:'Returns the integration verification code.',inputSchema:{type:'object',properties:{}}}]}:
m.method==='tools/call'?{content:[{type:'text',text:process.env.PROOF_CODE??'MCP-COPPER-6842'}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`)
await mkdir(join(home, 'skills/rovai-hermes-proof'), { recursive: true })
await writeFile(join(home, 'skills/rovai-hermes-proof/SKILL.md'), '---\nname: rovai-hermes-proof\ndescription: Read this skill to retrieve the native integration proof code.\n---\nThe proof code is SKILL-INDIGO-3941.\n')
const options = { executable: process.env.ROVAI_HERMES_BIN,
  script: resolve(import.meta.dirname, '../crates/rovai-core/src/hermes/host.py'), cwd: project,
  env: { ...process.env, HERMES_HOME: home } }
const mcpServers = [{ name: 'hermesproof', command: process.execPath, args: [fixture], env: [] }]
const bootstrap = 'For the integration check, remember system code SYSTEM-CERULEAN-7832. Keep it across turns and compression.'
const sha256 = createHash('sha256').update(bootstrap).digest('hex')
const results = {}
let client = await openHermesAcp(options)
async function bind(sessionId) {
  const ack = await client.request('_rovai/bind', { sessionId, bootstrap, sha256 })
  assert.equal(ack.sha256, sha256)
}
async function prompt(sessionId, text) {
  const start = client.events.length
  const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  assert.equal(result.stopReason, 'end_turn')
  const events = client.events.slice(start)
  const output = events.filter(m => m.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map(m => m.params.update.content?.text ?? '').join('')
  return { result, output, events }
}
try {
  const session = await client.request('session/new', { cwd: project, mcpServers })
  const id = session.sessionId
  await client.request('session/set_mode', { sessionId: id, modeId: 'dont_ask' })
  const model = await client.request('session/set_config_option', { sessionId: id, configId: 'model', value: session.models.currentModelId })
  assert.equal(model.configOptions[0].currentValue, session.models.currentModelId)
  await bind(id)
  const first = await prompt(id, 'Call the hermesproof MCP probe tool, then use skill_view to read rovai-hermes-proof. Reply with the MCP proof code, skill proof code, and the system code from your instructions.')
  for (const marker of ['MCP-COPPER-6842','SKILL-INDIGO-3941','SYSTEM-CERULEAN-7832']) assert(first.output.includes(marker), `Missing ${marker}`)
  assert(first.events.some(m => m.params?.update?.rawInput?.tool === 'skill_view'))
  assert(first.events.some(m => m.params?.update?.rawInput?.tool?.includes('hermesproof')))
  console.log('Native MCP, Skill and system binding passed')
  results.nativeTools = { mcp: true, skill: true, modelAcknowledged: true, firstUsage: first.result.usage }
  const warm = await prompt(id, 'Return only the system code again.')
  assert(warm.output.includes('SYSTEM-CERULEAN-7832'))
  results.warmUsage = warm.result.usage
  results.compaction = await client.request('_rovai/compact', { sessionId: id })
  assert.equal(results.compaction.sessionId, id)
  assert.equal(results.compaction.status, 'compressed')
  const compressed = await prompt(id, 'Return only the system code after compression.')
  assert(compressed.output.includes('SYSTEM-CERULEAN-7832'))
  assert.equal((await client.close()).code, 0)
  client = await openHermesAcp(options)
  await assert.rejects(client.request('session/resume', { sessionId: 'missing-hermes-target', cwd: project, mcpServers }),
    error => error.rpcError?.data?.code === 'HERMES_SESSION_NOT_FOUND')
  await client.request('session/resume', { sessionId: id, cwd: project, mcpServers })
  await bind(id)
  const resumed = await prompt(id, 'Return the MCP code from the earlier conversation and the current system code, without calling tools.')
  assert(resumed.output.includes('MCP-COPPER-6842') && resumed.output.includes('SYSTEM-CERULEAN-7832'))
  results.coldResume = true
  await assert.rejects(client.request('session/new', { cwd: project, mcpServers: [] }),
    error => error.rpcError?.code === -32004)
  results.changedAssignmentRejected = true
  console.log(JSON.stringify(results, null, 2))
  await writeFile(join(root, 'native-summary.json'), JSON.stringify(results, null, 2))
} finally { console.log('Cleanup:', await client.close()) }
