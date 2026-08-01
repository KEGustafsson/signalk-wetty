'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load, createFakeWetty } = require('./helpers/harness')

const { resolveOptions } = load('config.js')
const { WettyRunner, toWettyConfig } = load('wetty-runner.js')

test('toWettyConfig renames plugin options to WeTTYs vocabulary', () => {
  const config = toWettyConfig(
    resolveOptions({
      ssh: {
        keyPath: '/etc/signalk/ssh/id_ed25519',
        configFile: '/etc/signalk/ssh/config',
        password: 'secret'
      }
    })
  )
  assert.equal(config.ssh.key, '/etc/signalk/ssh/id_ed25519')
  assert.equal(config.ssh.config, '/etc/signalk/ssh/config')
  assert.equal(config.ssh.pass, 'secret')
  // WeTTY treats empty strings as "not set", so unset paths must stay empty
  // rather than becoming the string "undefined".
  const empty = toWettyConfig(resolveOptions({}))
  assert.equal(empty.ssh.key, '')
  assert.equal(empty.ssh.config, '')
  assert.equal(empty.ssh.pass, '')
})

test('forcessh follows the effective connection mode', () => {
  assert.equal(toWettyConfig(resolveOptions({ mode: 'ssh' })).forcessh, true)
  // Without root, local mode is not reachable, so WeTTY is told to use SSH.
  const asNonRoot = toWettyConfig(resolveOptions({ mode: 'local' })).forcessh
  const root = typeof process.getuid === 'function' && process.getuid() === 0
  assert.equal(asNonRoot, !root)
})

test('the runner reports whether a server is up', async () => {
  const fake = createFakeWetty()
  const runner = new WettyRunner(async () => fake.module)
  assert.equal(runner.running, false)
  await runner.start(resolveOptions({}))
  assert.equal(runner.running, true)
  await runner.stop()
  assert.equal(runner.running, false)
})

test('a failed start leaves the runner stopped', async () => {
  const fake = createFakeWetty({ failWith: new Error('boom') })
  const runner = new WettyRunner(async () => fake.module)
  await assert.rejects(() => runner.start(resolveOptions({})), /boom/)
  assert.equal(runner.running, false)
  await runner.stop()
})

test('stop() is bounded when WeTTY never invokes its close callback', async () => {
  const hangingModule = {
    start: async () => ({ close: () => {} }),
    getLogger: () => undefined
  }
  const runner = new WettyRunner(async () => hangingModule)
  await runner.start(resolveOptions({}))
  const started = Date.now()
  await runner.stop(50)
  assert.ok(Date.now() - started < 2000, 'stop() should not wait indefinitely')
  assert.equal(runner.running, false)
})

test('stop() swallows a throwing close so the server can shut down', async () => {
  const throwingModule = {
    start: async () => ({
      close: () => {
        throw new Error('close exploded')
      }
    }),
    getLogger: () => undefined
  }
  const runner = new WettyRunner(async () => throwingModule)
  await runner.start(resolveOptions({}))
  await runner.stop()
  assert.equal(runner.running, false)
})

test('idle keep-alive connections are dropped on stop', async () => {
  let closedAll = 0
  const runner = new WettyRunner(async () => ({
    start: async () => ({
      close: (cb) => cb && cb(),
      httpServer: {
        close: (cb) => cb && cb(),
        closeAllConnections: () => {
          closedAll += 1
        }
      }
    }),
    getLogger: () => undefined
  }))
  await runner.start(resolveOptions({}))
  await runner.stop()
  assert.equal(closedAll, 1)
})

test('a restart retries once when prom-client rejects a duplicate metric', async () => {
  let attempts = 0
  const runner = new WettyRunner(async () => ({
    start: async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error(
          'A metric with the name process_cpu_seconds_total has already been registered.'
        )
      }
      return { close: (cb) => cb && cb() }
    },
    getLogger: () => undefined
  }))
  await runner.start(resolveOptions({}))
  assert.equal(attempts, 2)
  assert.equal(runner.running, true)
  await runner.stop()
})
