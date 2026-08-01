'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  load,
  createMockApp,
  createFakeWetty,
  createMockRouter
} = require('./helpers/harness')

const createPlugin = load('index.js')

const availableNative = () => ({
  available: true,
  packageDir: '/fake/node_modules/node-pty',
  projectDir: '/fake'
})

const missingNative = () => ({
  available: false,
  packageDir: '/fake/node_modules/node-pty',
  projectDir: '/fake',
  error: 'node-pty is installed but the compiled binding is missing'
})

const withFakeWetty = (overrides = {}) => {
  const app = createMockApp()
  const fake = createFakeWetty(overrides.wetty)
  const plugin = createPlugin(app, {
    loadWetty: async () => fake.module,
    probeNative: overrides.probeNative ?? availableNative,
    rebuildNative: overrides.rebuildNative,
    ...overrides.deps
  })
  return { app, fake, plugin }
}

test('exports a factory returning the documented plugin surface', () => {
  assert.equal(typeof createPlugin, 'function')
  const { plugin } = withFakeWetty()
  assert.equal(plugin.id, 'signalk-wetty')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(typeof plugin.description, 'string')
  for (const method of [
    'schema',
    'uiSchema',
    'start',
    'stop',
    'registerWithRouter'
  ]) {
    assert.equal(typeof plugin[method], 'function', `missing ${method}()`)
  }
  assert.equal(typeof plugin.schema(), 'object')
})

test('start/stop/restart is clean, which is what the plugin CI checks', async () => {
  const { plugin, fake, app } = withFakeWetty()
  await plugin.start({})
  await plugin.stop()
  await plugin.start({})
  await plugin.stop()

  assert.equal(fake.state.starts.length, 2)
  assert.equal(fake.state.closes, 2)
  assert.equal(app.lastStatus(), 'Stopped')
  assert.deepEqual(app.calls.pluginError, [])
})

test('a second start without a stop replaces the running server', async () => {
  const { plugin, fake } = withFakeWetty()
  await plugin.start({ port: 4001 })
  await plugin.start({ port: 4002 })
  assert.equal(fake.state.closes, 1, 'the first server should have been closed')
  assert.equal(fake.state.starts[1].server.port, 4002)
  await plugin.stop()
})

test('stop() before any start is a no-op', async () => {
  const { plugin, fake } = withFakeWetty()
  await plugin.stop()
  assert.equal(fake.state.closes, 0)
})

test('plugin options are mapped onto WeTTY configuration', async () => {
  const { plugin, fake } = withFakeWetty()
  await plugin.start({
    port: 4321,
    host: '127.0.0.1',
    basePath: '/term/',
    title: 'Boat shell',
    allowIframe: false,
    command: 'bash',
    ssh: {
      host: 'nav.local',
      port: 2222,
      user: 'pi',
      auth: 'publickey,password',
      knownHosts: '/etc/signalk/ssh/known_hosts',
      allowRemoteHosts: true
    }
  })

  const call = fake.state.starts[0]
  assert.deepEqual(call.server, {
    base: '/term',
    port: 4321,
    host: '127.0.0.1',
    title: 'Boat shell',
    allowIframe: false,
    socket: false
  })
  assert.equal(call.command, 'bash')
  assert.equal(call.forcessh, true)
  assert.equal(call.ssl, undefined)
  assert.equal(call.ssh.host, 'nav.local')
  assert.equal(call.ssh.port, 2222)
  assert.equal(call.ssh.user, 'pi')
  assert.equal(call.ssh.knownHosts, '/etc/signalk/ssh/known_hosts')
  assert.equal(call.ssh.allowRemoteHosts, true)
  await plugin.stop()
})

test('the configured log level is applied to WeTTYs logger', async () => {
  const { plugin, fake } = withFakeWetty()
  await plugin.start({ logLevel: 'debug' })
  assert.deepEqual(fake.state.transports, [{ level: 'debug' }])
  await plugin.stop()
})

test('a failing WeTTY start is reported instead of thrown', async () => {
  const { plugin, app } = withFakeWetty({
    wetty: { failWith: Object.assign(new Error('listen EADDRINUSE'), {}) }
  })
  await plugin.start({ port: 3001 })
  const message = app.lastError()
  assert.match(message, /Failed to start the terminal/)
  assert.match(message, /already in use/)
  assert.deepEqual(app.calls.status, [])
})

test('a missing wetty package produces an actionable message', async () => {
  const app = createMockApp()
  const plugin = createPlugin(app, {
    probeNative: availableNative,
    loadWetty: async () => {
      throw Object.assign(new Error("Cannot find package 'wetty'"), {
        code: 'ERR_MODULE_NOT_FOUND'
      })
    }
  })
  await plugin.start({})
  assert.match(app.lastError(), /npm install wetty/)
})

test('an uncompiled node-pty stops the plugin before WeTTY is started', async () => {
  const { plugin, app, fake } = withFakeWetty({ probeNative: missingNative })
  await plugin.start({})
  assert.equal(fake.state.starts.length, 0)
  assert.match(app.lastError(), /compiled binding is missing/)
  assert.match(app.lastError(), /npm rebuild node-pty/)
  await plugin.stop()
})

test('GET /status describes a running terminal', async () => {
  const { plugin } = withFakeWetty()
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  const before = await call('GET /status')
  assert.equal(before.body.running, false)

  await plugin.start({ port: 4444, host: '127.0.0.1', basePath: '/x' })
  const after = await call('GET /status')
  assert.equal(after.statusCode, 200)
  assert.equal(after.body.running, true)
  assert.equal(after.body.port, 4444)
  assert.equal(after.body.basePath, '/x')
  assert.equal(after.body.scheme, 'http')
  assert.equal(after.body.loopbackOnly, true)
  assert.equal(after.body.error, null)
  assert.equal(after.body.native.available, true)
  assert.deepEqual(after.body, JSON.parse(JSON.stringify(after.body)))
  await plugin.stop()
})

test('GET /status reports https when a key pair is configured', async () => {
  const { plugin } = withFakeWetty()
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)
  await plugin.start({
    ssl: { enabled: true, keyPath: '/k.pem', certPath: '/c.pem' }
  })
  const { body } = await call('GET /status')
  assert.equal(body.scheme, 'https')
  await plugin.stop()
})

test('GET /status surfaces the native build problem to the webapp', async () => {
  const { plugin } = withFakeWetty({ probeNative: missingNative })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)
  await plugin.start({})
  const { body } = await call('GET /status')
  assert.equal(body.running, false)
  assert.equal(body.native.available, false)
  assert.match(body.native.help, /build-essential/)
  assert.match(body.error, /node-pty/)
})

test('POST /rebuild-native short-circuits when node-pty already works', async () => {
  let rebuilds = 0
  const { plugin } = withFakeWetty({
    rebuildNative: async () => {
      rebuilds += 1
      return { ok: true, output: '' }
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)
  const { body } = await call('POST /rebuild-native')
  assert.equal(body.ok, true)
  assert.equal(body.nativeAvailable, true)
  assert.equal(rebuilds, 0)
})

test('POST /rebuild-native reports a successful build', async () => {
  let probes = 0
  const app = createMockApp()
  const plugin = createPlugin(app, {
    loadWetty: async () => createFakeWetty().module,
    // Fails the first time, succeeds once the rebuild has run.
    probeNative: () => (probes++ === 0 ? missingNative() : availableNative()),
    rebuildNative: async () => ({ ok: true, output: 'gyp info ok' })
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  const { statusCode, body } = await call('POST /rebuild-native')
  assert.equal(statusCode, 200)
  assert.equal(body.ok, true)
  assert.equal(body.nativeAvailable, true)
  assert.match(app.lastStatus(), /restart the plugin/)
})

test('POST /rebuild-native reports a failed build with its output', async () => {
  const app = createMockApp()
  const plugin = createPlugin(app, {
    loadWetty: async () => createFakeWetty().module,
    probeNative: missingNative,
    rebuildNative: async () => ({ ok: false, output: 'gyp ERR! not ok' })
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  const { body } = await call('POST /rebuild-native')
  assert.equal(body.ok, false)
  assert.equal(body.nativeAvailable, false)
  assert.match(body.output, /gyp ERR!/)
  assert.match(app.lastError(), /rebuild failed/)
})

test('POST /rebuild-native answers with 500 when the rebuild itself throws', async () => {
  const app = createMockApp()
  const plugin = createPlugin(app, {
    loadWetty: async () => createFakeWetty().module,
    probeNative: missingNative,
    rebuildNative: async () => {
      throw new Error('spawn npm ENOENT')
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  const { statusCode, body } = await call('POST /rebuild-native')
  assert.equal(statusCode, 500)
  assert.equal(body.ok, false)
  assert.match(body.output, /ENOENT/)
})

test('the SSH password is never written to the debug log', async () => {
  const { plugin, app } = withFakeWetty()
  await plugin.start({ ssh: { password: 'hunter2' } })
  const logged = app.calls.debug.join('\n')
  assert.ok(logged.length > 0, 'expected the plugin to log its configuration')
  assert.equal(logged.includes('hunter2'), false)
  assert.match(logged, /\*\*\*/)
  await plugin.stop()
})

test('the plugin survives a server without status helpers', async () => {
  const brokenApp = {
    debug: () => {
      throw new Error('no debug on this server')
    },
    error: () => {},
    setPluginStatus: () => {
      throw new Error('no setPluginStatus on this server')
    },
    setPluginError: () => {
      throw new Error('no setPluginError on this server')
    }
  }
  const plugin = createPlugin(brokenApp, {
    loadWetty: async () => createFakeWetty().module,
    probeNative: availableNative
  })
  await plugin.start({})
  await plugin.stop()
})
