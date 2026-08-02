'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load } = require('./helpers/harness')

const { probeSshClient, sshClientHelpText } = load('ssh-client-probe.js')

test('probeSshClient reports availability using the real ssh binary', () => {
  // This dev/CI environment has openssh-client installed.
  const probe = probeSshClient()
  assert.equal(probe.available, true)
  assert.equal(probe.error, null)
})

test('probeSshClient reports unavailable when the binary is missing', () => {
  const enoent = Object.assign(new Error('spawn ssh ENOENT'), {
    code: 'ENOENT'
  })
  const probe = probeSshClient(() => {
    throw enoent
  })
  assert.equal(probe.available, false)
  assert.match(probe.error, /not found/)
})

test('probeSshClient treats a non-ENOENT failure as available', () => {
  // Some OpenSSH builds exit non-zero on `-V` despite working fine.
  const probe = probeSshClient(() => {
    throw new Error('exit 1')
  })
  assert.equal(probe.available, true)
  assert.equal(probe.error, null)
})

test('sshClientHelpText is empty when available', () => {
  assert.equal(sshClientHelpText({ available: true, error: null }), '')
})

test('sshClientHelpText explains how to install one when missing', () => {
  const help = sshClientHelpText({
    available: false,
    error: 'ssh: command not found'
  })
  assert.match(help, /openssh-client/)
  assert.match(help, /sudo apt update && sudo apt install -y openssh-client/)
  assert.match(help, /container/)
  // Minimal images are exactly where ssh is missing, and they routinely run as
  // root with no sudo installed, so the sudo command alone is not actionable.
  assert.match(help, /(?<!sudo )apt update && apt install -y openssh-client/)
})
