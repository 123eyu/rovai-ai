const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { isAbsolute, join } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [renderer, userData] = process.argv.slice(2)
assert.ok(isAbsolute(renderer) && isAbsolute(userData))
mkdirSync(join(userData, 'managed-skill-library'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'session'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1040, height: 700,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  window.webContents.on('console-message', event => console.error(event.message))
  const run = async code => {
    try { return await window.webContents.executeJavaScript(code, true) }
    catch (error) { throw new Error(`Renderer command failed: ${code}`, { cause: error }) }
  }
  const state = () => run('window.interruptionTest.state()')
  const capture = async name => {
    const output = process.env.ROVAI_NOTIFICATION_OUTPUT
    if (!output) return
    assert.ok(isAbsolute(output))
    mkdirSync(output, { recursive: true })
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await wait(50)
    writeFileSync(join(output, name), (await window.webContents.capturePage()).toPNG())
  }
  const until = async (condition, message) => {
    for (let n = 0; n < 100; n++) { const current = await state(); if (condition(current)) return current; await wait(20) }
    throw new Error(`${message}: ${JSON.stringify(await state())}`)
  }
  try {
    await window.loadFile(renderer)
    window.webContents.focus()
    await window.webContents.capturePage() // Ensure the isolated hidden renderer has painted.
    await until(s => s.ready, 'Initial bounded projection')
    await run("document.querySelector('#focus').focus(); window.interruptionTest.begin('race')")
    assert.equal((await state()).dot, false, 'Request intent alone cannot flash')
    await run("window.interruptionTest.admit('race', true)")
    await until(s => s.flashing && s.dot && !s.unread, 'Already-ACKed real admission must still paint')
    assert.equal((await state()).headsUp, 0, 'No stop popup even with real admission')
    await wait(720)
    assert.equal((await state()).dot, false)
    await run("window.interruptionTest.poll()")
    await wait(60)
    assert.equal((await state()).flashing, false, 'No poll replay')

    await run("window.interruptionTest.sidebar(false)")
    await wait(40)
    await run("window.interruptionTest.begin('hidden'); window.interruptionTest.admit('hidden'); window.interruptionTest.visible(['hidden'])")
    await until(s => s.facts.find(f => f.runId === 'hidden')?.read, 'Hidden sidebar cannot block exact visible ACK')
    assert.equal((await state()).flashing, false)
    await run("window.interruptionTest.sidebar(true)")
    await wait(80)
    assert.equal((await state()).dot, false, 'Expanding cannot replay skipped feedback')

    // Use the production menu visibility rule, then an actually offscreen row.
    // Neither hidden slot may gate the independently visible result's ACK.
    for (const [runId, hide, reveal] of [
      ['menu-hidden', "document.querySelector('.camp-nav-row').dataset.menuOpen = 'true'", "delete document.querySelector('.camp-nav-row').dataset.menuOpen"],
      ['offscreen', "document.querySelector('.camp-nav-row').style.transform = 'translateY(-2000px)'", "document.querySelector('.camp-nav-row').style.transform = ''"]
    ]) {
      await run(`${hide}; window.interruptionTest.visible([]); window.interruptionTest.begin('${runId}'); window.interruptionTest.admit('${runId}'); window.interruptionTest.visible(['${runId}'])`)
      await until(s => s.facts.find(f => f.runId === runId)?.read, `${runId} cannot block visible ACK`)
      assert.equal((await state()).flashing, false)
      await run(reveal)
      await wait(60)
      assert.equal((await state()).dot, false, `${runId} cannot replay on reveal`)
    }

    await run("window.interruptionTest.visible([]); window.interruptionTest.begin('unseen'); window.interruptionTest.admit('unseen')")
    await until(s => s.flashing && s.unread, 'Unseen terminal admission')
    await wait(720)
    assert.equal((await state()).dot, true, 'Unseen result retains durable attention after the pulse')
    assert.match((await state()).label, /未查看的执行中断/)
    assert.doesNotMatch((await state()).label, /有新回复/)
    await run("window.interruptionTest.visible(['unseen'])")
    await until(s => !s.dot, 'Real visible result clears durable interruption')

    await run("window.interruptionTest.visible([]); window.interruptionTest.admit('first')")
    await until(s => s.unread, 'Thread boundary ready')
    await run("window.savedRead = window.interruptionTest.capture(); window.interruptionTest.admit('later'); window.interruptionTest.failAck(); window.interruptionTest.markRead(window.savedRead)")
    await wait(60)
    await run("window.interruptionTest.manual(true); window.interruptionTest.poll()")
    let current = await until(s => s.facts.find(f => f.runId === 'first')?.read, 'Frozen Core retry')
    assert.equal(current.facts.find(f => f.runId === 'later').read, false, 'Newer interruption survives')
    assert.equal(current.localWrites, 1, 'Core retry cannot repeat local mark-read')
    assert.match(current.label, /已标记未读/)
    const reads = current.requests.filter(r => r.method === 'notifications.acknowledgeThreadInterruptions')
    assert.ok(reads.length >= 2)
    assert.deepEqual(reads[0].request, reads[1].request, 'Uncertain retry keeps exact UUID and boundary')
    await run("window.interruptionTest.manual(false); window.interruptionTest.visible(['later'])")
    await until(s => !s.unread, 'Finish bounded read')

    // Hold a stale true response across a confirmed ACK.
    await run("window.interruptionTest.visible([]); window.interruptionTest.admit('stale')")
    await until(s => s.unread, 'Prepare stale projection')
    await run("window.interruptionTest.hold()")
    await until(s => s.held > 0, 'Projection really pending')
    await run("window.interruptionTest.visible(['stale'])")
    await until(s => s.facts.find(f => f.runId === 'stale')?.read, 'ACK while projection pending')
    await run("window.interruptionTest.release()")
    await until(s => !s.unread && !s.dot, 'Late projection cannot resurrect ACKed attention')

    await run("window.interruptionTest.visible([]); window.interruptionTest.begin('ended'); window.interruptionTest.admit('ended', true)")
    await until(s => s.flashing, 'Short feedback before exact invalidation')
    await run("window.interruptionTest.invalidate('ended')")
    await until(s => !s.flashing, 'Ending original source cancels feedback')
    await run("window.interruptionTest.begin('route'); window.interruptionTest.admit('route', true)")
    await until(s => s.flashing, 'Feedback before route switch')
    await run("window.interruptionTest.surface('other-private')")
    await until(s => !s.flashing, 'Changing conversation clears feedback')
    await run("window.interruptionTest.surface(null)")
    await wait(50)
    await run("window.interruptionTest.attentive(false); window.interruptionTest.begin('background'); window.interruptionTest.admit('background', true)")
    await wait(80)
    await run("window.interruptionTest.attentive(true)")
    assert.equal((await state()).flashing, false, 'Other/background windows cannot synthesize local feedback')
    await run("window.interruptionTest.begin('reset'); window.interruptionTest.reset(); window.interruptionTest.admit('reset', true)")
    await wait(80)
    assert.equal((await state()).flashing, false, 'Reset discards local intents without replay')

    // 201 requested Threads produce independent 200 + 1 batches. Establish an
    // old true result in the second batch, then fail only that batch.
    await run('window.interruptionTest.batches()')
    await until(s => s.projectionCount === 201 && s.secondary?.unread, 'Both initial batches loaded')
    await run("window.interruptionTest.batchMode('fail'); window.interruptionTest.batchUnread(false); window.interruptionTest.admit('batch-failure')")
    current = await until(s => s.dot && s.unread && s.batchFailures > 0, 'Successful batch must paint despite another batch failing')
    assert.equal(current.secondary.unread, true, 'Failed batch preserves its last proven result')
    const batchRequests = current.requests.filter(r => r.method === 'notifications.threadInterruptions')
    assert.ok(batchRequests.some(r => r.request.threadIds.length === 200))
    assert.ok(batchRequests.some(r => r.request.threadIds.length === 1))
    await run("window.interruptionTest.batchMode('success'); window.interruptionTest.visible(['batch-failure'])")
    current = await until(s => !s.unread && !s.secondary.unread, 'Existing refresh recovers the failed batch')
    const confirmedSnapshotSequence = current.secondary.sequence

    // The slow second response captures true while its previous visible result
    // is false. A later exact ACK raises the production hook's receipt floor.
    await run("window.interruptionTest.visible([]); window.interruptionTest.batchMode('hold'); window.interruptionTest.batchUnread(true); window.interruptionTest.admit('batch-delayed')")
    await until(s => s.dot && s.unread && s.heldBatches > 0, 'Fast batch must paint before the slow batch returns')
    const acknowledgementSequence = await run('window.interruptionTest.confirmBatch()')
    const failuresBeforeRelease = (await state()).batchFailures
    await run('window.interruptionTest.releaseBatch()')
    // Fail the subsequent retry so a fresh false cannot mask application of the
    // stale true response. The older snapshot must remain untouched.
    current = await until(s => s.heldBatches === 0 && s.batchFailures > failuresBeforeRelease, 'Late batch and pending refresh settled')
    assert.equal(current.secondary.unread, false, 'Late batch cannot resurrect attention below the ACK boundary')
    assert.equal(current.secondary.sequence, confirmedSnapshotSequence, 'Rejected late response must not replace the proven snapshot')
    await run("window.interruptionTest.batchMode('success'); window.interruptionTest.visible(['batch-delayed'])")
    await until(s => !s.dot && s.secondary.sequence >= acknowledgementSequence, 'Normal refresh accepts the post-ACK snapshot')

    // Unlike the projection cases above, only the real ThreadWorkspace DOM may
    // provide source IDs here. No public message, artifact or execution drawer.
    await run("window.interruptionTest.workspace('running')")
    await until(s => s.workspaceStop, 'Production running row exposes its stop button')
    await run("document.querySelector('.run-presence-stop').scrollIntoView({ block: 'center' })")
    await wait(80)
    await run("document.querySelector('.run-presence-stop').click()")
    await until(s => s.stopConfirmation, 'Production stop confirmation opens')
    await run("document.querySelector('.run-presence-stop-confirmation .danger-button').click()")
    current = await until(s => s.facts.find(f => f.runId === 'workspace-stop')?.read && s.flashing && s.dot,
      'Silent stop must ACK from its real visible marker while the independent pulse remains')
    assert.deepEqual(current.workspaceMarkers, ['workspace-stop'])
    assert.equal(current.executionOpen, false, 'No execution drawer is needed')
    assert.equal(current.outputGroups, 0, 'No synthetic reply, avatar or empty output group')
    await capture('silent-stop-pulse.png')
    await wait(720)
    assert.equal((await state()).dot, false, 'The dot clears without re-entering the Thread')
    for (const [theme, width, height] of [['day', 1040, 700], ['night', 1440, 920]]) {
      window.setSize(width, height)
      await run(`document.documentElement.dataset.theme = '${theme}'`)
      await wait(80)
      const marker = await run(`(() => {
        const node = document.querySelector('[data-interrupted-run-id] button'), rect = node.getBoundingClientRect();
        return { label: node.getAttribute('aria-label'), height: rect.height, inside: rect.top >= 0 && rect.bottom <= innerHeight
          && rect.left >= 0 && rect.right <= innerWidth, overflow: document.documentElement.scrollWidth > innerWidth };
      })()`)
      assert.match(marker.label, /你已中断/)
      assert.ok(marker.height >= 24 && marker.inside && !marker.overflow)
      await capture(`silent-stop-${theme}-${width}.png`)
    }

    // Re-entry with the same stopped Run beyond the viewport is not a read.
    await run("window.interruptionTest.invalidate('workspace-stop'); window.interruptionTest.workspace('cancelled', true, false)")
    await wait(100)
    await run("window.interruptionTest.admit('workspace-stop'); document.querySelector('.camp-timeline').scrollTop = 100000")
    await wait(100)
    await run('window.interruptionTest.confirmWorkspace()')
    await until(s => s.unread && s.dot, 'An offscreen old stop remains unread on Thread entry')
    await wait(150)
    assert.equal((await state()).facts.find(f => f.runId === 'workspace-stop').read, false)
    await run("document.querySelector('[data-interrupted-run-id]').scrollIntoView({ block: 'center' })")
    await until(s => s.facts.find(f => f.runId === 'workspace-stop')?.read && !s.dot,
      'Scrolling the exact old marker into view clears its interruption')

    // A cached entry preview must not ACK; the same painted marker is eligible
    // after the real entry snapshot is ready, as in BusinessApp's attention gate.
    await run("window.interruptionTest.invalidate('workspace-stop'); window.interruptionTest.workspace('cancelled', false, false)")
    await wait(80)
    await run("window.interruptionTest.admit('workspace-stop')")
    await until(s => s.unread && s.workspaceMarkers.length === 1, 'Cached marker is painted but unread')
    await wait(150)
    assert.equal((await state()).facts.find(f => f.runId === 'workspace-stop').read, false)
    await run('window.interruptionTest.confirmWorkspace()')
    await until(s => s.facts.find(f => f.runId === 'workspace-stop')?.read && !s.dot,
      'Authoritative re-entry clears the visible silent stop without opening execution')
    console.log(JSON.stringify({ ok: true, cases: ['ACK-before-poll pulse', '600ms independent lifetime',
      'hidden sidebar ACK/no replay', 'exact result read', 'frozen Thread retry/new interruption/manual reminder',
      'stale projection rejection', 'source/route/focus/reset invalidation', 'accessible interruption label',
      '201 Threads: partial batch failure preserves old state without blocking a successful batch',
      '201 Threads: slow batch does not block paint and late data cannot override ACK',
      'Production ThreadWorkspace: silent stop ACK, 600ms feedback and closed execution drawer',
      'Production ThreadWorkspace: offscreen and cached stop stay unread until actually observed'] }))
    window.destroy(); app.quit()
  } catch (error) { console.error(error); window.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
