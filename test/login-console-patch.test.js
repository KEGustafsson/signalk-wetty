'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load } = require('./helpers/harness')

const { installLoginExitPatch } = load('login-console-patch.js')

/** Minimal stand-in for the global `console` object's `error` export. */
const fakeConsole = () => {
  const calls = []
  return {
    calls,
    error: (...args) => {
      calls.push(args)
    }
  }
}

test('WeTTYs login-prompt exit message is redirected to the debug log', () => {
  const target = fakeConsole()
  const logged = []
  installLoginExitPatch((msg) => logged.push(msg), target)

  target.error('Process exited with code: 0')

  assert.equal(target.calls.length, 0, 'must not reach the real console')
  assert.deepEqual(logged, ['WeTTY Process exited with code: 0'])
})

test('a non-zero exit code is matched the same way', () => {
  const target = fakeConsole()
  const logged = []
  installLoginExitPatch((msg) => logged.push(msg), target)

  target.error('Process exited with code: 1')

  assert.equal(target.calls.length, 0)
  assert.deepEqual(logged, ['WeTTY Process exited with code: 1'])
})

test('every other console.error call passes through untouched', () => {
  const target = fakeConsole()
  const logged = []
  installLoginExitPatch((msg) => logged.push(msg), target)

  target.error('some unrelated error', { detail: 'x' })
  target.error(new Error('boom'))

  assert.equal(logged.length, 0)
  assert.equal(target.calls.length, 2)
  assert.deepEqual(target.calls[0], ['some unrelated error', { detail: 'x' }])
})

test('removing the patch restores the original console.error', () => {
  const target = fakeConsole()
  const original = target.error
  const remove = installLoginExitPatch(() => {}, target)
  remove()

  assert.equal(target.error, original)
})
