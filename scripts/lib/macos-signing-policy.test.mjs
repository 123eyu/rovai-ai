import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  MACOS_SIGNING_POLICY,
  assertAdhocMacosSignature,
  assertStableMacosSignature
} from './macos-signing-policy.mjs'
import { MACOS_TICKET_RETRY, runMacosTicket } from './macos-ticket-retry.mjs'

const TEAM_ID = 'ABCDE12345'
const validDetails = [
  'CodeDirectory v=20500 size=433 flags=0x10000(runtime) hashes=3+7 location=embedded',
  'Authority=Developer ID Application: Rovai AI (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'Timestamp=Sep 28, 2026 at 00:00:00',
  `TeamIdentifier=${TEAM_ID}`
].join('\n')
const validRequirement = [
  'designated => identifier "ai.rovai.desktop"',
  'and anchor apple generic',
  'and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */',
  'and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */',
  `and certificate leaf[subject.OU] = "${TEAM_ID}"`
].join(' ')

test('accepts only ad-hoc signatures for local daily installation', () => {
  assert.doesNotThrow(() => assertAdhocMacosSignature('App', {
    details: [
      'Identifier=Electron',
      'Signature=adhoc',
      'TeamIdentifier=not set'
    ].join('\n'),
    designatedRequirement: 'designated => cdhash H"1234"'
  }))

  assert.throws(() => assertAdhocMacosSignature('App', {
    details: validDetails,
    designatedRequirement: validRequirement
  }), /not ad-hoc signed/)

  assert.throws(() => assertAdhocMacosSignature('App', {
    details: [
      'Signature=adhoc',
      `Authority=${MACOS_SIGNING_POLICY.authorityPrefix} Rovai AI (${TEAM_ID})`
    ].join('\n'),
    designatedRequirement: 'designated => cdhash H"1234"'
  }), /certificate authority/)
})

test('accepts an Apple Developer ID signature for the configured Team ID', () => {
  assert.doesNotThrow(() => assertStableMacosSignature('App', {
    details: validDetails,
    designatedRequirement: validRequirement,
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }))
})

test('rejects ad-hoc, wrong-team, weakened, and non-Developer-ID signatures', () => {
  assert.throws(() => assertStableMacosSignature('App', {
    details: 'Signature=adhoc',
    designatedRequirement: 'designated => cdhash H"1234"',
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /ad-hoc/)

  assert.throws(() => assertStableMacosSignature('App', {
    details: validDetails,
    designatedRequirement: 'designated => cdhash H"1234"',
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /CDHash-only/)

  assert.throws(() => assertStableMacosSignature('App', {
    details: validDetails.replace('ABCDE12345', 'ZYXWV98765'),
    designatedRequirement: validRequirement,
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /authority chain/)

  assert.throws(() => assertStableMacosSignature('App', {
    details: validDetails,
    designatedRequirement: validRequirement.replace('ABCDE12345', 'ZYXWV98765'),
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /wrong Apple Developer Team ID/)

  assert.throws(() => assertStableMacosSignature('App', {
    details: validDetails.replace('runtime', 'linker-signed'),
    designatedRequirement: validRequirement,
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /Hardened Runtime/)

  assert.throws(() => assertStableMacosSignature('App', {
    details: validDetails.replace(/^Timestamp=.*\n/m, ''),
    designatedRequirement: validRequirement,
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /timestamp/)

  assert.throws(() => assertStableMacosSignature('App', {
    details: validDetails,
    designatedRequirement: validRequirement.replace('anchor apple generic', 'anchor trusted'),
    expectedIdentifier: MACOS_SIGNING_POLICY.appId,
    expectedTeamId: TEAM_ID
  }), /Developer ID certificate/)
})

test('release workflow requires a pinned Developer ID certificate and notarization', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/macos-signed-build.yml', import.meta.url),
    'utf8'
  )
  const verifier = readFileSync(
    new URL('../verify-macos-release.mjs', import.meta.url),
    'utf8'
  )

  assert.match(workflow, /secrets\.MAC_CSC_LINK/)
  assert.match(workflow, /secrets\.MAC_CSC_KEY_PASSWORD/)
  assert.match(workflow, /vars\.MAC_RELEASE_CERT_SHA256/)
  assert.match(workflow, /vars\.MAC_RELEASE_TEAM_ID/)
  assert.match(workflow, /secrets\.APPLE_API_KEY_BASE64/)
  assert.match(workflow, /xcrun notarytool submit/)
  assert.match(workflow, /node scripts\/retry-macos-ticket\.mjs staple "\$DMG_PATH"/)
  assert.doesNotMatch(workflow, /add-trusted-cert/)
  assert.match(workflow, /node scripts\/verify-macos-release\.mjs \$\{\{ matrix\.arch \}\}/)
  assert.match(verifier, /macos-signing-policy\.mjs/)
  for (const target of ['appPath', 'dmgPath', 'zipAppPath']) {
    assert.ok(verifier.includes(`runMacosTicket('validate', ${target}, { cwd: root })`))
  }
})

const disconnected = {
  status: 68,
  stderr: 'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."'
}

function ticketFixture(results) {
  const calls = [], pauses = [], retries = []
  return {
    calls, pauses, retries,
    options: {
      cwd: '/fixture',
      execute: (...args) => {
        calls.push(args)
        return results[Math.min(calls.length - 1, results.length - 1)]
      },
      pause: delay => pauses.push(delay),
      onRetry: message => retries.push(message)
    }
  }
}

test('ticket retry preserves the exact stapler action and space-containing target', () => {
  for (const action of ['staple', 'validate']) {
    const fixture = ticketFixture([disconnected, disconnected, { status: 0, stdout: 'Result: valid\n' }])
    assert.equal(runMacosTicket(action, '/fixture/Rovai AI.app', fixture.options), 'Result: valid')
    assert.equal(fixture.calls.length, 3)
    for (const call of fixture.calls) {
      assert.deepEqual(call, [
        '/usr/bin/xcrun', ['stapler', action, '/fixture/Rovai AI.app'],
        { cwd: '/fixture', encoding: 'utf8' }
      ])
    }
    assert.deepEqual(fixture.pauses, [20_000, 40_000])
    assert.equal(fixture.retries.length, 2)
  }
})

test('ticket retry stops after six failed network attempts and never treats them as success', () => {
  assert.deepEqual(MACOS_TICKET_RETRY, { attempts: 6, baseDelayMs: 20_000, maxDelayMs: 60_000 })
  const fixture = ticketFixture([disconnected])
  assert.throws(() => runMacosTicket('validate', '/fixture/App.app', fixture.options), /failed \(68\)/)
  assert.equal(fixture.calls.length, 6)
  assert.deepEqual(fixture.pauses, [20_000, 40_000, 60_000, 60_000, 60_000])
})

test('ticket retry does not repeat missing tickets, invalid signatures, or unknown Error 68 failures', () => {
  for (const result of [
    { status: 65, stderr: 'The ticket is not valid.' },
    { status: 68, stderr: 'The staple and validate action failed! Error 68.' },
    { status: 65, stderr: 'Code signature is invalid.' },
    { status: 66, stderr: 'A ticket was not found.' }
  ]) {
    const fixture = ticketFixture([result])
    assert.throws(() => runMacosTicket('validate', '/fixture/App.app', fixture.options), /failed/)
    assert.equal(fixture.calls.length, 1)
    assert.deepEqual(fixture.pauses, [])
  }
})

test('ticket retry returns first-attempt success without sleeping', () => {
  const fixture = ticketFixture([{ status: 0, stdout: 'Valid\n' }])
  assert.equal(runMacosTicket('validate', '/fixture/App.app', fixture.options), 'Valid')
  assert.equal(fixture.calls.length, 1)
  assert.deepEqual(fixture.pauses, [])
})

test('ticket retry recognizes only the selected Apple network error codes', () => {
  for (const domain of ['NSURLErrorDomain', 'kCFErrorDomainCFNetwork']) {
    for (const code of [-1001, -1003, -1004, -1005, -1006, -1009]) {
      const fixture = ticketFixture([
        { status: 68, stderr: `Error Domain=${domain} Code=${code}` },
        { status: 0, stdout: 'Valid' }
      ])
      assert.equal(runMacosTicket('validate', '/fixture/App.app', fixture.options), 'Valid')
      assert.equal(fixture.calls.length, 2)
    }
  }
  for (const code of [-1200, -1202, -1012, -10050]) {
    const fixture = ticketFixture([{ status: 68, stderr: `Error Domain=NSURLErrorDomain Code=${code}` }])
    assert.throws(() => runMacosTicket('validate', '/fixture/App.app', fixture.options), /failed/)
    assert.equal(fixture.calls.length, 1)
  }
})

test('ticket retry does not retry process errors or signals', () => {
  const error = Object.assign(new Error('xcrun missing'), { code: 'ENOENT' })
  for (const result of [
    { error, status: null },
    { status: null, signal: 'SIGTERM', stderr: disconnected.stderr }
  ]) {
    const fixture = ticketFixture([result])
    assert.throws(() => runMacosTicket('validate', '/fixture/App.app', fixture.options))
    assert.equal(fixture.calls.length, 1)
    assert.deepEqual(fixture.pauses, [])
  }
})

test('ticket retry rejects unsupported actions before invoking xcrun', () => {
  const fixture = ticketFixture([{ status: 0 }])
  assert.throws(() => runMacosTicket('submit', '/fixture/App.app', fixture.options), /Expected stapler action/)
  assert.throws(() => runMacosTicket('validate', '', fixture.options), /Expected stapler action/)
  assert.deepEqual(fixture.calls, [])
})
