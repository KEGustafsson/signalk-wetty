'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load } = require('./helpers/harness')

const { installEnvVersionPatch } = load('env-version-patch.js')

/** Minimal stand-in for the `child_process` module's `exec` export. */
const fakeExecTarget = () => {
  const calls = []
  return {
    calls,
    exec: (command, ...rest) => {
      calls.push({ command, rest })
      return 'real-child-process-result'
    }
  }
}

test('the env --version probe is answered without touching the real exec', async () => {
  const target = fakeExecTarget()
  installEnvVersionPatch(target)

  const result = await new Promise((resolve) => {
    target.exec('/usr/bin/env --version', (error, stdout, stderr) => {
      resolve({ error, stdout, stderr })
    })
  })

  assert.equal(result.error, null)
  assert.match(result.stdout, /GNU coreutils/)
  assert.equal(result.stderr, '')
  assert.equal(target.calls.length, 0, 'the real exec must never be called')
})

test('the synthetic output parses the same way WeTTYs own code parses it', async () => {
  const target = fakeExecTarget()
  installEnvVersionPatch(target)

  const stdout = await new Promise((resolve) => {
    target.exec('/usr/bin/env --version', (_error, out) => resolve(out))
  })

  // Mirrors wetty/build/server/spawn/env.js's own parsing exactly.
  const version = parseInt(
    stdout.split(/\r?\n/)[0].split(' (GNU coreutils) ')[1].split('.')[0],
    10
  )
  assert.equal(Number.isNaN(version), false)
  assert.ok(version < 9, 'must stay below WeTTYs -S threshold')
})

test('every other command is passed through to the real exec untouched', () => {
  const target = fakeExecTarget()
  installEnvVersionPatch(target)

  const callback = () => {}
  const result = target.exec('ls -la', callback)

  assert.equal(target.calls.length, 1)
  assert.equal(target.calls[0].command, 'ls -la')
  assert.equal(target.calls[0].rest[0], callback)
  assert.equal(result, 'real-child-process-result')
})

test('a version-probe call with no callback falls through to the real exec', () => {
  const target = fakeExecTarget()
  installEnvVersionPatch(target)

  target.exec('/usr/bin/env --version')

  assert.equal(target.calls.length, 1)
  assert.equal(target.calls[0].command, '/usr/bin/env --version')
})

test('removing the patch restores the original exec', () => {
  const target = fakeExecTarget()
  const original = target.exec
  const remove = installEnvVersionPatch(target)
  remove()

  assert.equal(target.exec, original)
})
