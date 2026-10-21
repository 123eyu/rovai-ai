import assert from 'node:assert/strict'
import test from 'node:test'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { launchAcceptanceBrowser, pause } from './host-web-browser.mjs'

test('reply detail navigation reveals and retains the original after layout and history loading', { timeout: 120_000 }, async t => {
  const chrome = process.env.ROVAI_TEST_CHROME ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : process.platform === 'win32'
      ? join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : '/usr/bin/google-chrome')
  if (!await access(chrome).then(() => true, () => false)) return t.skip('Chrome is not installed')
  const root = await mkdtemp(join(tmpdir(), 'rovai-reply-details-'))
  const out = process.env.ROVAI_REPLY_UI_OUTPUT ?? join(root, 'screenshots')
  await mkdir(out, { recursive: true })
  let b
  const results = []
  try {
    await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../fixtures/run-presence/build.mjs'), root])
    b = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new',
      `--user-data-dir=${join(root, 'profile')}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--remote-debugging-port=0', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'] })
    await b.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const click = selector => b.click(`document.querySelector(${JSON.stringify(selector)})`)
    const open = async ({ width = 1440, loaded = false, full = false, reduced = false }) => {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 920, deviceScaleFactor: 1, mobile: false })
      await b.send('Page.navigate', { url: pathToFileURL(join(root, 'rovai-teammate-presence.html')).href + '?pure=1' })
      await b.wait('!!window.__presence && !!document.querySelector("[contenteditable=true]")')
      await b.evaluate(`__presence.showReplyCase(true, ${loaded}); document.documentElement.dataset.motionPreference = '${reduced ? 'reduce' : 'full'}'`)
      await b.wait('!!document.querySelector("[data-message-id=long-120]")')
      await click('[contenteditable=true]')
      await b.send('Input.insertText', { text: '跳转时保留草稿。' })
      const draft = await b.evaluate('document.querySelector("[contenteditable=true]").textContent')
      await click('[data-message-id=long-120] .reply-parent-quote')
      await b.wait('!!document.querySelector("[data-reply-message-id=reply-a]")')
      if (full) await click('.reply-detail-expand')
      await pause(300)
      return draft
    }
    const geometry = messageId => b.evaluate(`(() => {
      const viewport = document.querySelector('.timeline-scroll'), target = viewport.querySelector('[data-message-id="${messageId}"]');
      const v = viewport.getBoundingClientRect(), r = target?.getBoundingClientRect();
      return { visible: v.height > 0 && !!r && r.top >= v.top - 1 && r.bottom <= v.bottom + 1,
        top: r?.top, bottom: r?.bottom, viewportTop: v.top, viewportBottom: v.bottom, scrollTop: viewport.scrollTop,
        focused: document.activeElement === target, detailClosed: !document.querySelector('.reply-detail-panel'),
        draft: document.querySelector('[contenteditable=true]').textContent };
    })()`)
    for (const scenario of [
      { name: 'loaded-split', loaded: true, target: 'long-30' }, { name: 'history-split', target: 'long-30' },
      { name: 'loaded-full', loaded: true, full: true }, { name: 'history-full', full: true },
      { name: 'loaded-compact', loaded: true, width: 1040 }, { name: 'history-compact', width: 1040 },
      { name: 'reduced-motion', loaded: true, reduced: true }
    ]) {
      const expectedDraft = await open(scenario)
      const messageId = scenario.target ?? 'reply-a'
      await click(`[data-reply-message-id="${messageId}"] [aria-label="回到原文"]`)
      // Inspect settled geometry, not just focus: a focused offscreen row was the regression.
      await b.wait(`(() => {
        const v = document.querySelector('.timeline-scroll').getBoundingClientRect();
        const r = document.querySelector('.timeline-scroll [data-message-id="${messageId}"]')?.getBoundingClientRect();
        return v.height > 0 && r && r.top >= v.top - 1 && r.bottom <= v.bottom + 1;
      })()`)
      await pause(250)
      const afterReveal = await geometry(messageId)
      await b.capture(join(out, `${scenario.name}.png`))
      await b.send('Emulation.setDeviceMetricsOverride', { width: (scenario.width ?? 1440) + 40, height: 920, deviceScaleFactor: 1, mobile: false })
      await pause(400)
      const afterResize = await geometry(messageId)
      results.push({ name: scenario.name, messageId, expectedDraft, afterReveal, afterResize })
    }
    await writeFile(join(out, 'verification.json'), JSON.stringify(results, null, 2))
    for (const { name, expectedDraft, afterReveal, afterResize } of results) {
      assert.equal(afterReveal.visible, true, `${name}: original must remain in the viewport: ${JSON.stringify(afterReveal)}`)
      assert.equal(afterReveal.focused, true, `${name}: original takes keyboard focus`)
      assert.equal(afterReveal.detailClosed, true)
      assert.equal(afterReveal.draft, expectedDraft)
      assert.equal(afterResize.visible, true, `${name}: subsequent resize must preserve the destination`)
    }
    await open({})
    await b.evaluate('__presence.controls.holdSourceRead = true')
    await click('[data-reply-message-id=reply-a] [aria-label="回到原文"]')
    await b.wait('__presence.controls.executionReads.some(r => r.method === "thread.messages.around" && r.messageId === "reply-a")')
    await click('[data-thread-id="demo-thread-0"] .camp-nav-open')
    await b.evaluate('__presence.controls.holdSourceRead = false')
    await pause(500)
    assert.equal(await b.evaluate('!!document.querySelector("[data-message-id=reply-a]")'), false, 'Late history cannot enter another Thread')
    assert.deepEqual(b.errors, [])
    console.log(JSON.stringify({ result: 'passed', scenarios: results.map(r => r.name), lateHistory: 'ignored' }))
  } finally {
    await b?.close()
    await rm(root, { recursive: true, force: true })
  }
})
