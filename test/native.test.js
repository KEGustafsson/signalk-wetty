'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { load } = require('./helpers/harness')

const { nativeHelpText, probeNodePty, rebuildNodePty } = load('native.js')

test('probeNodePty returns a structured result and never throws', () => {
  const probe = probeNodePty()
  assert.equal(typeof probe.available, 'boolean')
  if (probe.available) {
    assert.equal(probe.error, undefined)
    assert.equal(path.basename(probe.packageDir), 'node-pty')
    assert.equal(path.basename(path.dirname(probe.packageDir)), 'node_modules')
    assert.equal(probe.projectDir, path.dirname(path.dirname(probe.packageDir)))
  } else {
    assert.equal(typeof probe.error, 'string')
  }
})

test('the probe result is stable across calls', () => {
  assert.equal(probeNodePty().available, probeNodePty().available)
})

test('nativeHelpText is empty when there is nothing to fix', () => {
  assert.equal(nativeHelpText({ available: true }), '')
})

test('nativeHelpText explains the app store limitation and the fix', () => {
  const help = nativeHelpText({
    available: false,
    projectDir: '/srv/signalk',
    error: 'missing'
  })
  assert.match(help, /--ignore-scripts/)
  assert.match(help, /npm rebuild node-pty --build-from-source/)
  assert.match(help, /\/srv\/signalk/)
  assert.match(help, /build-essential/)
})

test('rebuilding without a located install fails cleanly rather than spawning npm', async () => {
  const result = await rebuildNodePty({ available: false })
  assert.equal(result.ok, false)
  assert.match(result.output, /nothing to rebuild/)
})

test('a rebuild that cannot be started resolves instead of rejecting', async () => {
  // A non-existent cwd makes the spawn fail immediately, which stands in for
  // any environment where npm is not on PATH.
  // An explicit short timeout keeps the test bounded even on a platform where
  // the spawn unexpectedly succeeds; the default is ten minutes.
  const result = await rebuildNodePty(
    {
      available: false,
      projectDir: path.join(__dirname, 'no-such-directory-9f3a')
    },
    2000
  )
  assert.equal(result.ok, false)
  assert.equal(typeof result.output, 'string')
})

test('a rebuild always settles, timeout or not', async () => {
  // Runs in an empty temp directory so npm cannot touch this repo's
  // node_modules. Whether npm finishes first or the timeout kills it, the
  // promise must settle: if it did not, the request that started the rebuild
  // would hang until the client gave up.
  const fs = require('node:fs')
  const os = require('node:os')
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wetty-rebuild-'))
  try {
    const result = await rebuildNodePty({ available: false, projectDir }, 250)
    assert.equal(typeof result.ok, 'boolean')
    assert.equal(typeof result.output, 'string')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
