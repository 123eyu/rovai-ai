// Opt-in REAL model acceptance. Does not call /compress, change a context window,
// lower a threshold or replace a compressor. Uses native read_file results to
// fill the ordinary conversation until Hermes's configured threshold fires.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { openHermesAcp } from './lib/hermes-native-acp.mjs'

const home = process.env.ROVAI_HERMES_SMOKE_HOME
assert(home && process.env.ROVAI_HERMES_BIN, 'Supply a dedicated configured native Home')
const root = await realpath(resolve(home, '..')), project = join(root, 'compression-project')
await mkdir(project, { recursive: true })
const options = { executable: process.env.ROVAI_HERMES_BIN,
  script: resolve(import.meta.dirname, '../crates/rovai-core/src/hermes/host.py'), cwd: project,
  env: { ...process.env, HERMES_HOME: home } }
let client = await openHermesAcp(options)
const bootstrap = 'You are running a compression acceptance. System identity code: HERMES-SYSTEM-7392. Follow the requested native file reads. Never run a manual compression command. Keep the user anchor through automatic compression.'
const bind = sessionId => client.request('_rovai/bind', { sessionId, bootstrap, sha256: createHash('sha256').update(bootstrap).digest('hex') })
async function prompt(sessionId, text) {
  const start = client.events.length
  const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, 600000)
  assert.equal(result.stopReason, 'end_turn')
  const events = client.events.slice(start)
  const output = events.filter(e => e.params?.update?.sessionUpdate === 'agent_message_chunk')
    .map(e => e.params.update.content?.text ?? '').join('')
  return { result, output, toolCalls: events.filter(e => e.params?.update?.sessionUpdate === 'tool_call').length }
}
const summary = { rounds: [], manualCompressionCalled: false, thresholdModified: false }
console.log('Real automatic compression fixture:', root)
try {
  const session = await client.request('session/new', { cwd: project, mcpServers: [] }), sessionId = session.sessionId
  await bind(sessionId)
  summary.initial = await client.request('_rovai/session_info', { sessionId })
  console.log('Native threshold:', JSON.stringify(summary.initial))
  await prompt(sessionId, 'Remember user anchor HERMES-ANCHOR-8157. Reply only ACK.')
  for (let round = 0; round < 8; round++) {
    const files = []
    for (let file = 0; file < 4; file++) {
      const name = `payload-${round}-${file}.txt`
      const content = Array.from({ length: 300 }, (_, row) => `${row}: ${randomBytes(80).toString('hex')}\n`).join('')
      await writeFile(join(project, name), content)
      files.push(name)
    }
    const result = await prompt(sessionId, `Read each of these four files with read_file, offset=1, limit=300: ${files.join(', ')}. These are synthetic diagnostic records. Read the full requested ranges; do not use terminal, search, write or summary tools. After all four read_file calls finish, reply only ACK ${round}.`)
    const state = await client.request('_rovai/session_info', { sessionId })
    summary.rounds.push({ round, ...state, toolCalls: result.toolCalls, usage: result.result.usage })
    console.log('Round:', JSON.stringify(summary.rounds.at(-1)))
    await writeFile(join(root, 'auto-compression-progress.json'), JSON.stringify(summary, null, 2))
    if (state.compressionCount > summary.initial.compressionCount) break
  }
  assert(summary.rounds.at(-1).compressionCount > 0, 'Native threshold compression was not observed')
  const followup = await prompt(sessionId, 'Without tools, return the user anchor from the start of this conversation and your system identity code. Do not guess.')
  assert(followup.output.includes('HERMES-ANCHOR-8157') && followup.output.includes('HERMES-SYSTEM-7392'), 'Post-compaction continuity failed')
  summary.continuity = true
  await writeFile(join(root, 'auto-compression-native.log'), client.stderr)
  await client.close()
  client = await openHermesAcp(options)
  await client.request('session/resume', { cwd: project, sessionId, mcpServers: [] })
  await bind(sessionId)
  const resumed = await prompt(sessionId, 'Without tools, return the earlier user anchor and current system identity code.')
  assert(resumed.output.includes('HERMES-ANCHOR-8157') && resumed.output.includes('HERMES-SYSTEM-7392'), 'Post-compaction cold resume failed')
  summary.coldResume = true
  await writeFile(join(root, 'auto-compression-summary.json'), JSON.stringify(summary, null, 2))
  console.log('Real automatic compression and cold continuity passed:', root)
} catch (error) {
  await writeFile(join(root, 'auto-compression-native.log'), client.stderr)
  throw error
} finally { console.log('Cleanup:', await client.close()) }
