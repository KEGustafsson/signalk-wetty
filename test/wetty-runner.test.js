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
        password: 'secret'
      }
    })
  )
  assert.equal(config.ssh.key, '/etc/signalk/ssh/id_ed25519')
  assert.equal(config.ssh.pass, 'secret')
  // The built-in SSH client never shells out to `ssh`, so ssh_config has
  // nothing to apply to — WeTTY's own `config` field is always empty now.
  assert.equal(config.ssh.config, '')
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

test('logging is redirected before WeTTY gets a chance to log', async () => {
  // WeTTY logs its own startup, so a transport redirected only after start()
  // still lets those lines reach the Signal K server console.
  const transports = [{ level: 'info', silent: false }]
  const logged = []
  const module = {
    start: async () => {
      transports[0].log?.(
        { level: 'info', message: 'Server started' },
        () => {}
      )
      return { close: (cb) => cb?.() }
    },
    getLogger: () => ({ transports })
  }
  const runner = new WettyRunner(
    async () => module,
    (msg) => logged.push(msg)
  )
  await runner.start(resolveOptions({}))
  assert.deepEqual(logged, ['WeTTY info: Server started'])
  await runner.stop()
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

test('a late listen error rejects the start and closes the server', async () => {
  // WeTTY resolves its promise before listen() has succeeded or failed, so an
  // EADDRINUSE arrives afterwards as an error event. Unhandled, that event
  // takes the whole Signal K server process down.
  let closed = 0
  const runner = new WettyRunner(async () => ({
    start: async () => ({
      close: (cb) => {
        closed += 1
        if (cb) {
          cb()
        }
      },
      httpServer: {
        listening: false,
        close: (cb) => cb && cb(),
        on: () => {},
        once: (event, handler) => {
          if (event === 'error') {
            setImmediate(() => handler(new Error('listen EADDRINUSE :::3001')))
          }
        },
        removeListener: () => {}
      }
    }),
    getLogger: () => undefined
  }))

  await assert.rejects(() => runner.start(resolveOptions({})), /EADDRINUSE/)
  assert.equal(runner.running, false)
  assert.equal(closed, 1, 'the half-open server should have been closed')
})

test('a start resolves once the server reports it is listening', async () => {
  const runner = new WettyRunner(async () => ({
    start: async () => ({
      close: (cb) => cb && cb(),
      httpServer: {
        listening: false,
        close: (cb) => cb && cb(),
        on: () => {},
        once: (event, handler) => {
          if (event === 'listening') {
            setImmediate(handler)
          }
        },
        removeListener: () => {}
      }
    }),
    getLogger: () => undefined
  }))

  await runner.start(resolveOptions({}))
  assert.equal(runner.running, true)
  await runner.stop()
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

test('a start retries once when prom-client rejects a duplicate metric', async () => {
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
