const assert = require('node:assert/strict')
const { mkdirSync, writeFileSync } = require('node:fs')
const { isAbsolute, join, dirname } = require('node:path')
const { app, BrowserWindow } = require('electron')
const [renderer, userData] = process.argv.slice(2)
assert.ok(isAbsolute(renderer) && isAbsolute(userData))
mkdirSync(join(userData, 'managed-skill-library'), { recursive: true })
app.setPath('userData', userData)
app.setPath('sessionData', join(userData, 'session'))

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: process.platform === 'linux', width: 1440, height: 920, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
  const errors = []
  window.webContents.on('console-message', event => { if (event.level >= 2) errors.push(event.message) })
  const run = code => window.webContents.executeJavaScript(code, true)
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await pause(20) }
    throw new Error(`Timed out: ${expression}`)
  }
  const geometry = () => run(`(() => {
    const editor = document.querySelector('.automation-editor'), handle = document.querySelector('.automation-splitter')
    const r = handle.getBoundingClientRect()
    return { width: editor.getBoundingClientRect().width, hidden: editor.hidden,
      list: document.querySelector('.automation-list').getBoundingClientRect().width,
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + 200) }
  })()`)
  const near = (value, expected) => assert.ok(Math.abs(value - expected) < 2, `${value} != ${expected}`)
  let origin, pointer, pressed = false
  const mouse = (type, clickCount = 1) => {
    if (type === 'mouseDown') pressed = true
    if (type === 'mouseUp') pressed = false
    window.webContents.sendInputEvent({ type, ...pointer, button: 'left', clickCount, modifiers: pressed ? ['leftButtonDown'] : [] })
  }
  const begin = async () => {
    origin = await geometry(); pointer = { x: origin.x, y: origin.y }
    mouse('mouseMove'); mouse('mouseDown'); await frame()
    return origin
  }
  const move = async width => {
    pointer.x = Math.round(origin.x + origin.width - width)
    mouse('mouseMove'); await frame()
  }
  const release = async () => { mouse('mouseUp'); await frame() }
  const key = async keyCode => {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode }); await frame()
  }
  const reset = async () => {
    pointer = await geometry(); mouse('mouseMove'); mouse('mouseDown', 2); mouse('mouseUp', 2); await frame()
  }
  const load = async () => {
    await window.loadFile(renderer)
    await wait('document.querySelector(".automation-task-open")')
    await run('document.querySelector(".automation-task-open").click()'); await frame()
    await wait('document.querySelector(".automation-name-input")')
  }
  const edit = async name => {
    await run(`(() => { const input = document.querySelector('.automation-name-input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(name)});
      input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await frame()
  }
  const capture = async name => writeFileSync(join(dirname(userData), name + '.png'), (await window.webContents.capturePage()).toPNG())
  try {
    await load()
    near((await geometry()).list, 248)
    await begin(); await move(300); near((await geometry()).width, 320)
    await pause(400); near((await geometry()).width, 320)
    await release(); near((await geometry()).width, 320)
    await reset()
    const before = await begin(); await move(240); near((await geometry()).width, 320)
    await pause(400); assert.equal((await geometry()).hidden, true)
    await move(480); near((await geometry()).width, 480)
    await key('Escape'); await release(); near((await geometry()).width, before.width)
    await begin(); await move(240); await release(); await pause(400)
    near((await geometry()).width, 320)
    await reset()
    await begin(); await move(240); await pause(220); await release(); await pause(220)
    assert.equal((await geometry()).hidden, true, 'Release during folding finishes the fold')
    await key('Enter'); near((await geometry()).list, 248)

    await run('window.automationSplitterTest.failSave()')
    await edit('保存失败时保留草稿')
    await begin(); await move(240); await pause(400)
    assert.equal((await geometry()).hidden, false)
    near((await geometry()).width, 320)
    assert.equal(await run('document.querySelector(".automation-name-input").value'), '保存失败时保留草稿')
    const failedSaves = await run('window.automationSplitterTest.saveCount()')
    await move(100); await pause(250)
    assert.equal(await run('window.automationSplitterTest.saveCount()'), failedSaves, 'Holding after rejection does not repeatedly retry saving')
    await release(); await capture('automation-save-failure')

    await load()
    await run('window.automationSplitterTest.holdSave()')
    await edit('延迟保存可以取消折叠')
    const original = await begin(); await move(240)
    await wait('window.automationSplitterTest.saveCount() === 1')
    await key('Escape'); await release()
    await run('window.automationSplitterTest.releaseSave()'); await pause(400)
    assert.equal((await geometry()).hidden, false, 'A late save response cannot revive a cancelled fold')
    near((await geometry()).width, original.width)

    await run('document.documentElement.dataset.theme="night"'); await capture('automation-night')
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await begin(); await move(240); near((await geometry()).width, 320)
    await pause(230); await frame(); assert.equal((await geometry()).hidden, true)
    await release()
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ ok: true, checks: ['minimum pause and release', 'fold and same-gesture reversal', 'Escape', 'early release',
      'release during fold', 'keyboard restore', 'save failure preserves draft without retry loop', 'late save fenced after cancellation', 'night', 'reduced motion'] }))
    window.destroy(); app.quit()
  } catch (error) {
    await capture('failure'); console.error(error); console.error(errors); window.destroy(); app.exit(1)
  }
})
