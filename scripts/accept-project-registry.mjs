// macOS packaged upgrade acceptance. No Runtime, daily data or installed App mutation.
// node scripts/accept-project-registry.mjs <old.app> <candidate.app> <new-isolated-root>
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, realpath, access, mkdtemp } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { assertUserDataIsIsolated, seedCompletedOnboardingForAcceptance } from './lib/dev-desktop.mjs'
import { requestNormalApplicationQuit } from './lib/planned-shutdown-app-quit.mjs'

const [oldApp, newApp, requestedRoot] = process.argv.slice(2)
assert(oldApp && newApp && requestedRoot && [oldApp, newApp, requestedRoot].every(isAbsolute),
  'Pass absolute old App, candidate App, and a new isolated acceptance root')
let root = resolve(requestedRoot)
await mkdir(root, { recursive: false }) // Refuse reuse of another run's data.
root = await realpath(root)
const data = assertUserDataIsIsolated(join(root, 'user-data'))
const sockets = await mkdtemp('/tmp/rvreg-')
seedCompletedOnboardingForAcceptance(data)
await mkdir(join(data, 'managed-skill-library'))
const paths = Object.fromEntries(['legacy-empty', 'restored', 'removed', 'empty-a', 'empty-b', 'optional'].map(name => [name, join(root, name)]))
for (const path of Object.values(paths)) await mkdir(path)
const report = { oldApp, newApp, userData: data, skillLibrary: join(data, 'managed-skill-library'), sockets,
  startedAt: new Date().toISOString(), cases: [], binaries: {} }
const stamp = '2026-10-11T00:00:00Z'
const runProcess = promisify(execFile)
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))
const q = JSON.stringify
let app

try {
  for (const [name, path] of [['old', oldApp], ['candidate', newApp]]) {
    report.binaries[name] = {}
    for (const file of ['bin/rovai-host', 'app.asar']) {
      report.binaries[name][file] = createHash('sha256').update(await readFile(join(path, 'Contents/Resources', file))).digest('hex')
    }
  }
  console.log(`Isolated packaged acceptance: userData=${data}; Skill Library=${report.skillLibrary}; sockets=${sockets}`)
  app = await launch(oldApp, 'old')
  const member = await request('members.create', { commandId: randomUUID(), command: {
    displayName: '目录验收队员', teamRole: '测试', professionalResponsibilities: '隔离验收，不执行 Runtime',
    personalityTraits: ['可验证'], workingPrinciples: '只使用隔离数据', growthTopic: '项目登记' } })
  assert.equal(member.status, 'applied', q(member))
  const preflight = await request('threads.creationPreflight')
  assert(preflight.presentMembers.length > 0)
  const create = async (name, projectPath) => {
    const result = await request('threads.create', { commandId: randomUUID(), name, workspace: { projectPath },
      memberAgentIds: preflight.presentMembers.map(value => value.agentId), defaultLeadAgentId: preflight.initialLeadAgentId,
      collaborationMode: 'peer', activationState: 'active' })
    assert.equal(result.status, 'applied', q(result))
    return result.payload.threadId
  }
  const restoredId = await create('升级恢复会话', paths.restored)
  const removedId = await create('移除后仍存在的会话', paths.removed)
  await evaluate(`window.rovai.desktopSession.commitRestorableLocation({kind:'camp',threadId:${q(restoredId)}})`)
  // The old App's restorable Camp and selected empty project can legitimately differ.
  await evaluate(`localStorage.setItem('rovai.current-project.v1', ${q(q({ kind: 'directory', projectPath: paths['legacy-empty'] }))})`)
  await close()
  assert.equal(await sql("SELECT count(*) FROM sqlite_master WHERE name='project_directory_registry'"), '0', 'Old fixture must genuinely predate registry schema')
  report.oldSchema = await sql('SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1')
  const legacy = { schemaVersion: 5, pins: [], projectOrder: [null, `directory:${paths.restored}`],
    projectNames: { [`directory:${paths.optional}`]: 42 }, threadReadStates: {},
    removedProjects: [{ targetKey: `directory:${paths.removed}`, removedAt: stamp }] }
  const navigationFile = join(data, 'navigation.json')
  const damagedBytes = `${q(legacy)}\n`
  await writeFile(navigationFile, damagedBytes)

  app = await launch(newApp, 'upgrade')
  await until(`document.querySelector('.camp-topbar h1')?.textContent === '升级恢复会话'`)
  await until(`window.rovai.request('projects.get').then(value => value.initialized)`)
  let registry = await request('projects.get')
  for (const key of ['legacy-empty', 'restored', 'optional']) assert.equal(entry(registry, paths[key]).removed, false)
  assert.equal(entry(registry, paths.removed).removed, true)
  assert.equal(await readFile(navigationFile, 'utf8'), damagedBytes, 'Startup must not auto-rewrite optional damaged preferences')
  await visible('legacy-empty')
  assert(!await sidebarHas('移除后仍存在的会话'))
  assert.equal(await request('threads.exists', { threadId: removedId }), true)
  await screenshot('01-upgrade')
  record('Old packaged data upgrades: selected-only empty project survives session restore; optional damaged names/order do not block import; removed project stays hidden')

  // Add/switch/delete/remove uses production UI actions where possible; Core probes assert persistence.
  await change(paths['empty-a'], false)
  await change(paths['empty-b'], false)
  await reload()
  for (const key of ['empty-a', 'empty-b', 'legacy-empty']) await visible(key)
  for (const key of ['empty-a', 'empty-b', 'empty-a']) await openProject(paths[key])
  assert(await sidebarHas('empty-b'))
  await screenshot('02-empty-projects')
  record('Two added empty projects survive switching and Renderer reload')

  // Repair only our intentionally damaged fixture to verify a real retry rereads its source.
  // Production never changes this file automatically or requires user repair for project usage.
  const validPreferences = { ...legacy, projectOrder: [], projectNames: {} }
  await writeFile(navigationFile, `${q(validPreferences)}\n`)
  await evaluate(`window.rovai.navigationPreferences.replacePins([{kind:'project',targetKey:${q(`directory:${paths['empty-a']}`)},pinnedAt:${q(stamp)}}])`)
  await close()
  app = await launch(newApp, 'restart-1')
  registry = await request('projects.get')
  for (const key of ['empty-a', 'empty-b', 'legacy-empty']) assert.equal(entry(registry, paths[key]).removed, false)
  assert((await evaluate('window.rovai.navigationPreferences.get()')).pins.some(pin => pin.targetKey === `directory:${paths['empty-a']}`))
  record('Normal application quit/restart preserves empty projects and project pins; preference retries reread the file')

  // Reopen the selected Thread, then delete its last row through the normal command boundary.
  await evaluate(`window.rovai.desktopSession.commitRestorableLocation({kind:'camp',threadId:${q(restoredId)}})`)
  await reload()
  await until(`document.querySelector('.camp-topbar h1')?.textContent === '升级恢复会话'`)
  const projection = await request('threads.open', { threadId: restoredId, traceId: randomUUID() })
  const deleted = await request('threads.delete', { commandId: randomUUID(), command: {
    threadId: restoredId, expectedVersion: projection.thread.version, workspaceDisposition: 'retain' } })
  assert.equal(deleted.status, 'accepted', q(deleted))
  await until(`window.rovai.request('threads.exists',{threadId:${q(restoredId)}}).then(exists => !exists)`)
  await visible('restored')
  await openProject(paths.restored)
  await until(`(() => { const group=[...document.querySelectorAll('.camp-nav-group')].find(el=>el.dataset.group===${q(`directory:${paths.restored}`)}); return group?.textContent.includes('还没有对话') })()`)
  await screenshot('03-last-thread-deleted')
  record('Deleting the selected project’s last Thread retains the project and renders the empty state')

  const emptyVersion = entry(await request('projects.get'), paths['empty-b']).version
  await change(paths['empty-b'], true)
  const stale = await request('projects.set', { commandId: randomUUID(), command: {
    projectPath: paths['empty-b'], removed: false, expectedVersion: emptyVersion } })
  assert.notEqual(stale.status, 'applied', 'Old restore must not undo a newer removal')
  await change(paths.removed, false)
  await reload()
  await visible('removed')
  await openProject(paths.removed)
  await until(`document.querySelector('.unified-sidebar')?.textContent.includes('移除后仍存在的会话')`)
  assert.equal((await request('projects.get')).projects.filter(value => value.projectPath === paths.removed).length, 1)
  await change(paths.removed, true)
  await close()
  app = await launch(newApp, 'restart-2')
  await visible('restored')
  registry = await request('projects.get')
  assert.equal(entry(registry, paths.restored).removed, false)
  assert.equal(entry(registry, paths.removed).removed, true)
  assert.equal(entry(registry, paths['empty-b']).removed, true)
  assert.equal(await request('threads.exists', { threadId: removedId }), true)
  assert(!await sidebarHas('移除后仍存在的会话'))
  await access(paths.removed)
  await access(paths['empty-b'])
  await screenshot('04-second-restart')
  record('Removal survives restart without deleting directories or Threads; explicit re-add restores one entry; stale restore is rejected')
  report.registry = registry
  await close()
  report.newSchema = await sql('SELECT projection_schema_version FROM rovai_data_contract WHERE singleton=1')
  report.registryRows = JSON.parse(await sql('SELECT scope,project_path,removed,revision FROM project_directory_registry ORDER BY scope,project_path', true))
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = String(error.stack ?? error)
  if (app) {
    try { report.failureDom = await evaluate('document.body.innerText'); await screenshot('failure') } catch { /* Process failure may prevent capture. */ }
  }
  process.exitCode = 1
} finally {
  if (app) await close().catch(error => { report.shutdownError = String(error); process.exitCode = 1 })
  report.finishedAt = new Date().toISOString()
  await writeFile(join(root, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
}

function record(name) { report.cases.push(name); console.log(`PASS ${name}`) }
function entry(registry, path) {
  const found = registry.projects.find(value => value.projectPath === path)
  assert(found, `Missing registered project ${path}: ${q(registry)}`)
  return found
}
async function sql(query, json = false) {
  assert(!app, 'Inspect the closed, checkpointed fixture only')
  return (await runProcess('/usr/bin/sqlite3', ['-readonly', ...(json ? ['-json'] : []), `file:${join(data, 'rovai.sqlite')}?immutable=1`, query])).stdout.trim()
}
async function request(method, params = {}) {
  return evaluate(`window.rovai.request(${q(method)},${q(params)}).catch(error=>{throw new Error(JSON.stringify(error))})`)
}
async function change(projectPath, removed) {
  const registry = await request('projects.get')
  const expectedVersion = registry.projects.find(value => value.projectPath === projectPath)?.version ?? 0
  const result = await request('projects.set', { commandId: randomUUID(), command: { projectPath, removed, expectedVersion } })
  assert.equal(result.status, 'applied', q(result))
  return result.payload
}
async function sidebarHas(text) { return evaluate(`document.querySelector('.unified-sidebar')?.textContent.includes(${q(text)}) ?? false`) }
async function visible(text) { await until(`document.querySelector('.unified-sidebar')?.textContent.includes(${q(text)})`) }
async function openProject(path) {
  await until(`Boolean([...document.querySelectorAll('[data-sidebar-menu-target]')].find(el=>el.dataset.sidebarMenuTarget===${q(`project:directory:${path}`)}))`)
  const selector = `document.querySelector(${q(`[data-sidebar-focus-target="project-row:directory:${path}"]`)})`
  await evaluate(`${selector}.click()`)
  await wait(100)
  if (await evaluate(`${selector}.getAttribute('aria-expanded') === 'false'`)) {
    await evaluate(`${selector}.click()`)
  }
}
async function reload() {
  await app.cdp.send('Page.reload')
  await wait(300)
  await until(`Boolean(window.rovai && document.querySelector('.unified-sidebar'))`)
  await until(`window.rovai.request('projects.get').then(value=>value.initialized)`)
}
async function screenshot(name) {
  const response = await app.cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(root, `${name}.png`), Buffer.from(response.result.data, 'base64'))
}
async function evaluate(expression) {
  const response = await app.cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text)
  return response.result?.result?.value
}
async function until(expression, timeout = 45_000) {
  const end = Date.now() + timeout
  do { if (await evaluate(expression)) return; await wait(100) } while (Date.now() < end)
  throw new Error(`Timed out: ${expression}`)
}
async function launch(bundle, name) {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolveClose => server.close(resolveClose))
  const env = { ...process.env, TMPDIR: sockets, ROVAI_ALLOW_ISOLATED_INSTANCE: '1', ROVAI_DISABLE_AUTO_UPDATE_CHECKS: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(bundle, 'Contents/MacOS/Rovai AI'), [`--user-data-dir=${data}`, `--remote-debugging-port=${port}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let log = ''
  child.stdout.on('data', chunk => { log += chunk })
  child.stderr.on('data', chunk => { log += chunk })
  const instance = { child, closed, name, get log() { return log } }
  app = instance
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    assert(child.exitCode === null && child.signalCode === null, `App exited during launch: ${log}`)
    let target
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(value => value.type === 'page') } catch { /* Starting */ }
    if (target) { instance.cdp = await connect(target.webSocketDebuggerUrl); break }
    await wait(100)
  }
  assert(instance.cdp, `Missing debug target: ${log}`)
  await instance.cdp.send('Page.enable')
  await instance.cdp.send('Page.bringToFront')
  await until(`Boolean(window.rovai)`)
  await until(`window.rovai.supervisor.getSnapshot().then(value=>value.fullCoreState==='ready')`)
  const health = await request('health.check')
  assert.equal(await realpath(health.database.path), await realpath(join(data, 'rovai.sqlite')))
  const processes = (await runProcess('/bin/ps', ['-axo', 'pid,ppid,command'])).stdout.split('\n')
  const core = processes.find(line => Number(line.trim().split(/\s+/)[1]) === child.pid && (line.includes('/rovai-core') || line.includes('/rovai-host')))
  assert(core?.includes(`--skill-library-root ${report.skillLibrary}`), `Core must use the isolated Skill Library: ${core}; processes=${processes.filter(line=>line.includes(data)).join('\n')}`)
  report[name] = { coreProcess: core.trim() }
  await access(report.skillLibrary)
  return instance
}
async function close() {
  const current = app
  app = null
  if (!current) return
  let timer
  try {
    await requestNormalApplicationQuit({ app: current, runProcess })
    const [code, signal] = await Promise.race([current.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Normal application quit timed out')), 20_000)
    })])
    assert.equal(code, 0, `App quit failed (${signal})`)
  } finally {
    clearTimeout(timer)
    current.cdp?.close()
    if (current.child.exitCode === null && current.child.signalCode === null) {
      current.child.kill('SIGKILL') // Only this script's isolated process, after a failed normal quit.
      await current.closed
    }
    await writeFile(join(root, `${current.name}.log`), current.log)
  }
}
async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((accept, reject) => { socket.addEventListener('open', accept, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let id = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)), call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id); clearTimeout(call.timer)
    if (message.error) call.reject(new Error(message.error.message)); else call.accept(message)
  })
  socket.addEventListener('close', () => { for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('CDP closed')) } pending.clear() })
  return {
    send(method, params = {}) { return new Promise((accept, reject) => {
      const key = ++id
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timeout: ${method}`)) }, 45_000)
      pending.set(key, { accept, reject, timer }); socket.send(q({ id: key, method, params }))
    }) },
    close() { socket.close() }
  }
}
