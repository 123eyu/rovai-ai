import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchAcceptanceBrowser, pause } from './host-web-browser.mjs'

test('production composer uses Core per-target eligibility and honest receipt labels', { timeout: 120_000 }, async () => {
  const root = process.env.ROVAI_STEER_UI_OUTPUT ?? await mkdtemp(join(tmpdir(), 'rovai-steer-ui-'))
  await mkdir(root, { recursive: true })
  await promisify(execFile)(process.execPath, [resolve('scripts/fixtures/run-presence/build.mjs'), root])
  const chrome = process.env.ROVAI_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const browser = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', `--user-data-dir=${await mkdtemp(join(root, 'browser-'))}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', 'about:blank'] })
  const click = selector => browser.click(`document.querySelector(${JSON.stringify(selector)})`)
  const closeMenu = () => browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const report = []
  try {
    for (const kind of ['empty', 'attachment', 'idle', 'other-member', 'ready', 'mixed', 'incompatible', 'not-ready', 'unknown', 'accepted', 'queued', 'ended']) {
      // Each case has its own draft-client cache, including the single-recipient cases.
      await browser.evaluate('try { localStorage.clear(); sessionStorage.clear() } catch {} delete window.__presence')
      await browser.send('Page.navigate', { url: pathToFileURL(join(root, 'rovai-teammate-presence.html')).href + `?pure=1&case=${kind}` })
      await browser.wait('!!window.__presence && !!document.querySelector(".composer-box")')
      await browser.evaluate(`__presence.showSteerCase('${kind}')`); await pause(300)
      const eligible = ['attachment', 'ready', 'mixed', 'accepted'].includes(kind)
      assert.equal(await browser.evaluate('!!document.querySelector(".steer-send-choice")'), eligible, kind)
      const actionLabel = await browser.evaluate('document.querySelector(".composer:not(.single-chat-composer) .composer-actions .composer-primary-action").getAttribute("aria-label")')
      assert.equal(actionLabel, eligible ? kind === 'mixed' ? '优先插话' : '插话'
        : ['empty','idle','other-member','ended'].includes(kind) ? '发送消息' : '排队发送', kind)
      let rows = []
      if (eligible) {
        await click('.steer-send-choice'); await pause(100)
        rows = await browser.evaluate('[...document.querySelectorAll(".steer-recipient-plan")].map(e=>e.innerText)')
        if (kind === 'mixed') {
          assert.equal(rows.length, 3)
          assert.match(rows[0], /插话/); assert.match(rows[1], /排队/); assert.match(rows[2], /发送/)
          assert.match(rows[1], /版本.*回执要求/)
        }
        await closeMenu(); await pause(100)
      } else if (kind === 'incompatible') {
        assert.match(await browser.evaluate('document.querySelector(".steer-send-action").title'), /版本.*回执要求/)
      }
      for (const theme of ['day', 'night']) {
        await browser.evaluate(`__presence.setTheme('${theme}')`)
        await browser.send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 760, deviceScaleFactor: 1, mobile: false }); await pause(100)
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth > innerWidth'), false)
        await browser.capture(join(root, `${kind}-${theme}.png`))
      }
      if (kind === 'ready') {
        // The same mounted composer returns to ordinary send without a toast or lost draft.
        await browser.evaluate('__presence.finishSteerRuns()'); await pause(100)
        assert.equal(await browser.evaluate('!!document.querySelector(".steer-send-choice")'), false)
        assert.equal(await browser.evaluate('document.querySelector(".composer:not(.single-chat-composer) .composer-actions .composer-primary-action").getAttribute("aria-label")'), '发送消息')
      }
      if (kind === 'empty') {
        // Typing and clearing use the live editor; the same active Run is unchanged.
        await browser.evaluate('document.querySelector("#camp-message").focus()')
        await browser.send('Input.insertText', { text: '这条更正' })
        await browser.wait('!!document.querySelector(".steer-send-choice")')
        await browser.evaluate(`(() => { const e = document.querySelector('#camp-message'); const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); e.focus() })()`)
        await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
        await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
        await browser.wait('!document.querySelector(".steer-send-choice")')
        assert.equal(await browser.evaluate('document.querySelector(".composer:not(.single-chat-composer) .composer-actions .composer-primary-action").getAttribute("aria-label")'), '发送消息')
        await click('#camp-message')
        await browser.send('Input.insertText', { text: '@' })
        await browser.send('Input.insertText', { text: '奥黛丽' })
        await browser.wait('[...document.querySelectorAll("button[role=option]")].some(e => e.textContent.includes("奥黛丽"))')
        await browser.click('[...document.querySelectorAll("button[role=option]")].find(e => e.textContent.includes("奥黛丽"))')
        await pause(100)
        assert.equal(await browser.evaluate('document.querySelector(".composer:not(.single-chat-composer) .composer-actions .composer-primary-action").getAttribute("aria-label")'), '发送消息', 'live mention immediately replaces the busy default lead')
        await browser.capture(join(root, 'live-mention.png'))
        await browser.send('Input.insertText', { text: ' @' })
        await browser.wait('[...document.querySelectorAll("button[role=option]")].some(e => e.textContent.includes("所有队员"))')
        await browser.click('[...document.querySelectorAll("button[role=option]")].find(e => e.textContent.includes("所有队员"))')
        await pause(100)
        assert.equal(await browser.evaluate('document.querySelector(".composer:not(.single-chat-composer) .composer-actions .composer-primary-action").getAttribute("aria-label")'), '优先插话', 'all-members overrides the individual mention immediately')
        await browser.evaluate(`(() => { const e = document.querySelector('#camp-message'); const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); e.focus() })()`)
        await browser.send('Input.insertText', { text: '恢复发给队长' })
        await pause(100)
        assert.equal(await browser.evaluate('document.querySelector(".composer:not(.single-chat-composer) .composer-actions .composer-primary-action").getAttribute("aria-label")'), '插话', 'removing all recipient atoms immediately restores the default target')
      }
      if (['empty', 'attachment', 'idle', 'other-member', 'ready', 'not-ready'].includes(kind)) { report.push({ kind, actionLabel }); continue }
      const selector = '[data-message-id="steer-example"] .user-message-receipt'
      const summary = await browser.evaluate(`document.querySelector('${selector}').innerText`)
      assert.match(summary, kind === 'unknown' ? /待核对/ : kind === 'queued' ? /待处理/ : /已插话/)
      if (kind === 'mixed') assert.equal(summary, '已插话 1 · 待处理 1 · 待核对 1')
      assert.equal(await browser.evaluate('!!document.querySelector("[data-message-id=steer-example] .user-message-withdraw")'), kind === 'queued')
      await click(selector); await pause(100)
      const receipt = await browser.evaluate('document.querySelector(".user-message-receipt-menu").innerText')
      if (kind !== 'queued') assert.match(receipt, kind === 'unknown' ? /是否送达待核对/ : /运行时已接收/)
      assert.equal(receipt.includes('撤回消息'), kind === 'queued', 'accepted and unknown input cannot be withdrawn, even with a stale message flag')
      assert.doesNotMatch(receipt, /已消费|已加入当前执行/)
      await browser.capture(join(root, `${kind}-receipt.png`))
      report.push({ kind, actionLabel, rows, summary, receipt })
      await closeMenu()
    }
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`Steer UI evidence: ${root}`)
  } finally { await browser.close() }
})
