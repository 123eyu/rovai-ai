import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { launchHost, within } from './host-test-client.mjs'
import { launchAcceptanceBrowser } from './host-web-browser.mjs'
import { coreDataDirectoryArguments, removeEphemeralRuntimeCampFilesRoot } from './runtime-camp-files-root.mjs'

// Owns production WebEntry + BusinessApp + Rust Host restart. Fault injection
// and exact resend settlement belong to the smaller transport/UI owners.
test('production Web retains its mounted Composer and authentication across a real Host stop/restart', { timeout: 90_000 }, async t => {
  const root = resolve(import.meta.dirname, '../..')
  const binary = process.env.ROVAI_HOST_BIN ?? join(root, 'target/debug/rovai-host')
  const chrome = process.env.ROVAI_REVIEW_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  try { await access(binary); await access(chrome); await access(join(root, 'out/web/index.html')) }
  catch { t.skip('Requires a built Host, WebUI and Chrome'); return }
  const fixture = await realpath(await mkdtemp(join(tmpdir(), 'rovai-web-recovery-live-')))
  const dataDir = join(fixture, 'core')
  const output = process.env.ROVAI_WEB_RECOVERY_OUTPUT ?? join(fixture, 'evidence')
  await mkdir(output, { recursive: true })
  const args = [...coreDataDirectoryArguments(dataDir), '--skill-library-root', join(dataDir, 'skills'), '--mcp-config-path', join(dataDir, 'mcp.json')]
  console.log(JSON.stringify({ channel: 'automatic_acceptance', dataDir, skillLibraryRoot: join(dataDir, 'skills'), browserProfile: join(fixture, 'chrome'), runtime: false }))
  let host, browser
  try {
    host = launchHost(binary, args, { cwd: root })
    await within(host.ready)
    const profiles = await host.request('members.list')
    const created = await host.request('camps.create', { commandId: crypto.randomUUID(), name: '停服恢复验收', workspace: null,
      memberAgentIds: [profiles[0].agentId], defaultLeadAgentId: profiles[0].agentId, collaborationMode: 'peer' })
    assert.equal(created.status, 'applied')
    const service = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: join(root, 'out/web') })
    browser = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', `--user-data-dir=${join(fixture, 'chrome')}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'] })
    await browser.send('Page.navigate', { url: service.origin })
    await browser.wait(`document.querySelector('#administrator-token') !== null`)
    await browser.click(`document.querySelector('#administrator-token')`)
    await browser.send('Input.insertText', { text: service.administratorToken })
    await browser.click(`document.querySelector('.web-login button[type=submit]')`)
    await browser.wait(`document.querySelector('.web-login-overlay') === null`)
    await browser.click(`[...document.querySelectorAll('button')].find(e => e.textContent.includes('停服恢复验收'))`)
    const editor = `.camp-workspace form.composer:not(.single-chat-composer) [contenteditable="true"]`
    await browser.wait(`document.querySelector(${JSON.stringify(editor)}) !== null`)
    await browser.click(`document.querySelector(${JSON.stringify(editor)})`)
    await browser.send('Input.insertText', { text: '服务恢复后仍然保留的未提交草稿' })
    await browser.wait(`document.querySelector(${JSON.stringify(editor)}).textContent.includes('未提交草稿')`)
    await browser.evaluate(`void(window.recoveryComposerBeforeStop = document.querySelector(${JSON.stringify(editor)}))`)
    await host.close(); host = null
    await browser.wait(`document.querySelector('.web-offline-dialog') !== null`)
    await browser.click(`document.querySelector('.web-offline-retry')`)
    await browser.wait(`document.querySelector('.web-offline-title').textContent === '仍无法连接服务'`)
    await browser.capture(join(output, 'live-host-stopped.png'))
    await browser.key('Escape')
    assert.equal(await browser.evaluate(`document.querySelector('.web-offline-dialog') !== null`), true)
    host = launchHost(binary, args, { cwd: root })
    await within(host.ready)
    const resumed = await host.request('host.web.start', { listen: new URL(service.origin).host, uiDirectory: join(root, 'out/web') })
    assert.equal(resumed.origin, service.origin)
    if (await browser.evaluate(`document.querySelector('.web-offline-retry') !== null`)) await browser.click(`document.querySelector('.web-offline-retry')`)
    await browser.wait(`document.querySelector('.web-offline-dialog') === null && document.querySelector('.web-login-overlay') === null`)
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(editor)}) === window.recoveryComposerBeforeStop`), true)
    assert.equal(await browser.evaluate(`document.querySelector(${JSON.stringify(editor)}).textContent`), '服务恢复后仍然保留的未提交草稿')
    await browser.capture(join(output, 'live-host-recovered.png'))
    await browser.send('Page.reload')
    await browser.wait(`document.querySelector(${JSON.stringify(editor)})?.textContent.includes('未提交草稿') && document.querySelector('.web-login-overlay') === null`)
    assert.equal(await browser.evaluate(`document.querySelector('.web-offline-dialog') === null`), true)
    // Reproduce a persisted, never-admitted command without a Runtime. Recovery
    // must also unblock the real initial navigation reads after a page reload.
    const snapshot = await host.request('camps.open', { threadId: created.payload.threadId, traceId: crypto.randomUUID() })
    const pending = { operation: 'threads.rename', params: { commandId: crypto.randomUUID(), command: {
      threadId: created.payload.threadId, title: '原提交恢复完成', expectedVersion: snapshot.thread.version } } }
    await browser.evaluate(`(() => { const saved = JSON.parse(sessionStorage.getItem('rovai.web.session.v1')); saved.pending = [${JSON.stringify(pending)}]; sessionStorage.setItem('rovai.web.session.v1', JSON.stringify(saved)) })()`)
    await browser.send('Page.reload')
    await browser.wait(`document.querySelector('.web-offline-retry') !== null`)
    await browser.click(`document.querySelector('.web-offline-retry')`)
    await browser.wait(`document.querySelector('.web-offline-dialog') === null && document.body.textContent.includes('原提交恢复完成') && document.querySelector(${JSON.stringify(editor)})?.textContent.includes('未提交草稿')`)
    assert.deepEqual(await browser.evaluate(`JSON.parse(sessionStorage.getItem('rovai.web.session.v1')).pending`), [])
    assert.equal((await host.request('camps.open', { threadId: created.payload.threadId, traceId: crypto.randomUUID() })).thread.title, '原提交恢复完成')
    assert.deepEqual(browser.errors, [])
    await writeFile(join(output, 'live-verification.json'), JSON.stringify({ hostBinarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
      hostRestartVerified: true, productionWebEntry: true, runtimeExecuted: false, checks: ['real Host stopped', 'retry while stopped', 'original Composer DOM retained', 'draft retained', 'same Session resumes', 'reload retains draft and authentication', 'persisted unknown command recovered through Core', 'initial navigation unblocked after recovery'] }, null, 2))
    console.log(`Live recovery evidence: ${output}`)
  } finally {
    await browser?.close(); await host?.close()
    await removeEphemeralRuntimeCampFilesRoot(dataDir)
    await rm(fixture, { recursive: true, force: true })
  }
})
