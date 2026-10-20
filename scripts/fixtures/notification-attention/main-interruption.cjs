const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
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
  const run = code => window.webContents.executeJavaScript(code, true)
  const state = () => run('window.interruptionTest.state()')
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
    console.log(JSON.stringify({ ok: true, cases: ['ACK-before-poll pulse', '600ms independent lifetime',
      'hidden sidebar ACK/no replay', 'exact result read', 'frozen Thread retry/new interruption/manual reminder',
      'stale projection rejection', 'source/route/focus/reset invalidation', 'accessible interruption label'] }))
    window.destroy(); app.quit()
  } catch (error) { console.error(error); window.destroy(); app.exit(1) }
}).catch(error => { console.error(error); app.exit(1) })
app.on('window-all-closed', () => app.quit())
