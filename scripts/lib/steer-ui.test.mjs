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
  const browser = await launchAcceptanceBrowser({ executable: chrome, args: ['--headless=new', `--user-data-dir=${join(root, 'browser')}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', 'about:blank'] })
  const click = selector => browser.click(`document.querySelector(${JSON.stringify(selector)})`)
  const closeMenu = () => browser.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  const report = []
  try {
    for (const kind of ['mixed', 'incompatible', 'unknown', 'ended']) {
      // Each case has its own draft-client cache, including the single-recipient cases.
      await browser.evaluate('try { localStorage.clear(); sessionStorage.clear() } catch {} delete window.__presence')
      await browser.send('Page.navigate', { url: pathToFileURL(join(root, 'rovai-teammate-presence.html')).href + `?pure=1&case=${kind}` })
      await browser.wait('!!window.__presence && !!document.querySelector(".composer-box")')
      await browser.evaluate(`__presence.showSteerCase('${kind}')`); await pause(300)
      if (kind === 'ended') {
        assert.equal(await browser.evaluate('!!document.querySelector(".steer-send-choice")'), false)
        continue
      }
      await click('.steer-send-choice'); await pause(150)
      const rows = await browser.evaluate('[...document.querySelectorAll(".steer-recipient-plan")].map(e=>e.innerText)')
      if (kind === 'mixed') {
        assert.equal(rows.length, 3)
        assert.match(rows[0], /插话/); assert.match(rows[1], /排队/); assert.match(rows[2], /发送/)
        assert.match(rows[1], /版本.*回执要求/)
      } else {
        assert.equal(rows.length, 1)
        assert.match(rows[0], kind === 'unknown' ? /送达结果待核对/ : /版本.*回执要求/)
      }
      for (const theme of ['day', 'night']) {
        await browser.evaluate(`__presence.setTheme('${theme}')`)
        await browser.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 720, deviceScaleFactor: 1, mobile: false }); await pause(100)
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth > innerWidth'), false)
        assert.ok(await browser.evaluate('document.querySelector(".steer-send-action > span").getBoundingClientRect().height <= 20'), 'send label stays on one line')
        await browser.capture(join(root, `${kind}-${theme}.png`))
      }
      await closeMenu(); await pause(100)
      const selector = '[data-message-id="steer-example"] .user-message-receipt'
      const summary = await browser.evaluate(`document.querySelector('${selector}').innerText`)
      assert.match(summary, kind === 'unknown' ? /待核对/ : /运行时已接收/)
      await click(selector); await pause(100)
      const receipt = await browser.evaluate('document.querySelector(".user-message-receipt-menu").innerText')
      assert.match(receipt, kind === 'unknown' ? /是否送达待核对/ : /运行时已接收/)
      assert.doesNotMatch(receipt, /已消费|已加入当前执行/)
      report.push({ kind, rows, summary, receipt })
      await closeMenu()
    }
    await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log(`Steer UI evidence: ${root}`)
  } finally { await browser.close() }
})
