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
const { EMBEDDED_TERMINAL_PATH } = load('config.js')

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

const sshUp = async (host, port) => ({
  reachable: true,
  host,
  port,
  banner: 'SSH-2.0-OpenSSH_9.6p1',
  error: null,
  code: null
})

const sshDown = async (host, port) => ({
  reachable: false,
  host,
  port,
  banner: null,
  error: `connect ECONNREFUSED ${host}:${port}`,
  code: 'ECONNREFUSED'
})

const sshClientAvailable = () => ({ available: true, error: null })

const withFakeWetty = (overrides = {}) => {
  const app = createMockApp()
  const fake = createFakeWetty(overrides.wetty)
  const plugin = createPlugin(app, {
    loadWetty: async () => fake.module,
    probeNative: overrides.probeNative ?? availableNative,
    rebuildNative: overrides.rebuildNative,
    probeSsh: overrides.probeSsh ?? sshUp,
    probeSshClient: overrides.probeSshClient ?? sshClientAvailable,
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
    // Not user-configurable: always the embedded proxy's own mount path, so
    // WeTTY's self-generated links are correct wherever the proxy sits.
    base: EMBEDDED_TERMINAL_PATH,
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
  const [transport] = fake.state.transports
  assert.equal(transport.level, 'debug')
  assert.equal(transport.silent, false)
  await plugin.stop()
})

test('WeTTYs own logging is reported through the plugins debug log', async () => {
  const { plugin, app, fake } = withFakeWetty()
  await plugin.start({})
  // What WeTTY would have printed to the console it inherits from the Signal K
  // server: it reaches app.debug() instead, which the server gates per plugin.
  fake.emitLog({ level: 'info', message: 'Server started' })
  assert.ok(
    app.calls.debug.includes('WeTTY info: Server started'),
    `expected the WeTTY log line in ${JSON.stringify(app.calls.debug)}`
  )
  await plugin.stop()
})

test('a log record winston has already formatted is reported verbatim', async () => {
  const { plugin, app, fake } = withFakeWetty()
  await plugin.start({})
  const formatted =
    '{"label":"Wetty","level":"info","message":"Server started"}'
  fake.emitLog({
    level: 'info',
    message: 'Server started',
    [Symbol.for('message')]: formatted
  })
  assert.ok(
    app.calls.debug.includes(formatted),
    `expected the formatted line in ${JSON.stringify(app.calls.debug)}`
  )
  await plugin.stop()
})

test('silent drops WeTTYs logging instead of reporting it', async () => {
  const { plugin, app, fake } = withFakeWetty()
  await plugin.start({ logLevel: 'silent' })
  // Silenced rather than levelled down: the level is left untouched so a silent
  // transport cannot fall back to the logger's own default level.
  const [transport] = fake.state.transports
  assert.equal(transport.silent, true)
  assert.equal(transport.level, 'http')

  const before = app.calls.debug.length
  fake.emitLog({ level: 'info', message: 'Server started' })
  assert.equal(
    app.calls.debug.length,
    before,
    'a silenced transport should report nothing'
  )
  await plugin.stop()
})

test('WebSocket upgrade forwarding is installed from the first request', async (t) => {
  // Signal K hands plugins a router, never its HTTP server, and the property
  // some servers carry it on is not part of the plugin API. The server is
  // taken from a request instead — so it is a request that has to install the
  // forwarder, and stop() has to take it back off again.
  const http = require('node:http')
  const { plugin } = withFakeWetty()
  const { router, handlers } = createMockRouter()
  plugin.registerWithRouter(router)

  const frontend = http.createServer((req, res) => {
    void handlers.get('USE /terminal')(req, res, () => {})
  })
  await new Promise((resolve) => frontend.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => frontend.close(resolve)))

  await plugin.start({})
  assert.equal(frontend.listenerCount('upgrade'), 0, 'nothing served yet')

  // WeTTY is a fake here, so the proxy has nothing to reach and answers 502 —
  // the forwarder is installed on the way in, before any of that matters.
  await fetch(`http://127.0.0.1:${frontend.address().port}/`).catch(() => {})
  assert.equal(frontend.listenerCount('upgrade'), 1)

  await plugin.stop()
  assert.equal(frontend.listenerCount('upgrade'), 0, 'removed on stop')
})

test('every listener serving the plugin forwards upgrades, not just the first', async (t) => {
  // A server reachable over both HTTP and HTTPS serves the plugin's routes
  // from more than one listener; a session opened through one of them must not
  // depend on which listener happened to be served first.
  const http = require('node:http')
  const { plugin } = withFakeWetty()
  const { router, handlers } = createMockRouter()
  plugin.registerWithRouter(router)

  const listeners = await Promise.all(
    [0, 0].map(async () => {
      const server = http.createServer((req, res) => {
        void handlers.get('USE /terminal')(req, res, () => {})
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      t.after(() => new Promise((resolve) => server.close(resolve)))
      return server
    })
  )

  await plugin.start({})
  for (const server of listeners) {
    await fetch(`http://127.0.0.1:${server.address().port}/`).catch(() => {})
  }
  for (const server of listeners) {
    assert.equal(server.listenerCount('upgrade'), 1)
  }

  await plugin.stop()
  for (const server of listeners) {
    assert.equal(server.listenerCount('upgrade'), 0, 'removed on stop')
  }
})

test('a failing WeTTY start is reported instead of thrown', async () => {
  const { plugin, app } = withFakeWetty({
    wetty: { failWith: new Error('listen EADDRINUSE') }
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

  await plugin.start({ port: 4444, host: '127.0.0.1' })
  const after = await call('GET /status')
  assert.equal(after.statusCode, 200)
  assert.equal(after.body.running, true)
  assert.equal(after.body.port, 4444)
  assert.equal(after.body.basePath, EMBEDDED_TERMINAL_PATH)
  assert.equal(after.body.scheme, 'http')
  assert.equal(after.body.error, null)
  assert.equal(after.body.native.available, true)
  assert.deepEqual(after.body, JSON.parse(JSON.stringify(after.body)))
  await plugin.stop()
})

/** Minimal stand-in for a Node ServerResponse, for the raw `.use()` route. */
const fakeRawResponse = () => {
  const res = {
    statusCode: 200,
    headersSent: false,
    setHeader: () => {},
    writeHead: (code) => {
      res.statusCode = code
    },
    end: (chunk) => {
      res.body = chunk
    }
  }
  return res
}

test('the embedded terminal route responds 503 before the plugin has started', async () => {
  const { plugin } = withFakeWetty()
  const { router, handlers } = createMockRouter()
  plugin.registerWithRouter(router)

  const useHandler = handlers.get('USE /terminal')
  assert.equal(typeof useHandler, 'function')

  const res = fakeRawResponse()
  await useHandler({ url: '/', headers: {} }, res, () => {})
  assert.equal(res.statusCode, 503)
  assert.match(res.body, /not running/)
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

/** Polls the status route the way the webapp does, until the rebuild settles. */
const awaitRebuild = async (call) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await call('GET /status')
    if (!body.rebuild.running) {
      return body.rebuild
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('rebuild never finished')
}

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
  const { statusCode, body } = await call('POST /rebuild-native')
  assert.equal(statusCode, 200)
  assert.equal(body.started, false)
  assert.equal(body.nativeAvailable, true)
  assert.equal(rebuilds, 0)
})

test('POST /rebuild-native answers immediately instead of holding the request', async () => {
  // Compiling node-pty takes minutes on a Pi; a held response would be cut off
  // by any proxy in front of the admin UI long before the build finishes.
  let release
  const app = createMockApp()
  const plugin = createPlugin(app, {
    loadWetty: async () => createFakeWetty().module,
    probeNative: missingNative,
    rebuildNative: () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: false, output: 'done' })
      })
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  const { statusCode, body } = await call('POST /rebuild-native')
  assert.equal(statusCode, 202)
  assert.equal(body.started, true)

  const during = await call('GET /status')
  assert.equal(during.body.rebuild.running, true)
  assert.equal(during.body.rebuild.ok, null)
  assert.ok(during.body.rebuild.startedAt)

  release()
  const finished = await awaitRebuild(call)
  assert.equal(finished.running, false)
  assert.ok(finished.finishedAt)
})

test('a second rebuild request is refused while one is running', async () => {
  // Two npm rebuilds in one directory means two node-gyp runs writing to the
  // same build/ tree, which can leave node-pty broken rather than fixed.
  let starts = 0
  let release
  const plugin = createPlugin(createMockApp(), {
    loadWetty: async () => createFakeWetty().module,
    probeNative: missingNative,
    rebuildNative: () =>
      new Promise((resolve) => {
        starts += 1
        release = () => resolve({ ok: true, output: 'gyp info ok' })
      })
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await call('POST /rebuild-native')
  const second = await call('POST /rebuild-native')
  assert.equal(second.statusCode, 409)
  assert.equal(second.body.started, false)
  assert.equal(starts, 1)

  release()
  await awaitRebuild(call)
})

test('a successful rebuild is reported through the status route', async () => {
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

  await call('POST /rebuild-native')
  const result = await awaitRebuild(call)
  assert.equal(result.ok, true)
  assert.match(result.output, /gyp info ok/)
  assert.match(app.lastStatus(), /restart the plugin/)

  const { body } = await call('GET /status')
  assert.equal(body.native.available, true)
})

test('a failed rebuild keeps its output and reports a plugin error', async () => {
  const app = createMockApp()
  const plugin = createPlugin(app, {
    loadWetty: async () => createFakeWetty().module,
    probeNative: missingNative,
    rebuildNative: async () => ({ ok: false, output: 'gyp ERR! not ok' })
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await call('POST /rebuild-native')
  const result = await awaitRebuild(call)
  assert.equal(result.ok, false)
  assert.match(result.output, /gyp ERR!/)
  assert.match(app.lastError(), /rebuild failed/)
})

test('a rebuild that throws is reported rather than left unhandled', async () => {
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

  const { statusCode } = await call('POST /rebuild-native')
  assert.equal(statusCode, 202)
  const result = await awaitRebuild(call)
  assert.equal(result.ok, false)
  assert.match(result.output, /ENOENT/)
  assert.match(app.lastError(), /rebuild failed/)
})

test('a rebuild can be started again after one finished', async () => {
  let starts = 0
  const plugin = createPlugin(createMockApp(), {
    loadWetty: async () => createFakeWetty().module,
    probeNative: missingNative,
    rebuildNative: async () => {
      starts += 1
      return { ok: false, output: 'gyp ERR! not ok' }
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await call('POST /rebuild-native')
  await awaitRebuild(call)
  const second = await call('POST /rebuild-native')
  assert.equal(second.statusCode, 202)
  await awaitRebuild(call)
  assert.equal(starts, 2)
})

test('a reachable SSH server leaves the plugin in a plain running state', async () => {
  const { plugin, app } = withFakeWetty()
  await plugin.start({})
  assert.deepEqual(app.calls.pluginError, [])
  assert.match(app.lastStatus(), /Terminal embedded at/)
  await plugin.stop()
})

test('a missing SSH server is reported without withholding the terminal', async () => {
  // The page still has to load: the moment sshd is started, sessions work
  // again without anybody touching the plugin.
  const { plugin, app, fake } = withFakeWetty({ probeSsh: sshDown })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({})
  assert.equal(fake.state.starts.length, 1, 'WeTTY should still be started')

  const { body } = await call('GET /status')
  assert.equal(body.running, true)
  assert.equal(body.ssh.checked, true)
  assert.equal(body.ssh.reachable, false)
  assert.match(body.ssh.error, /ECONNREFUSED/)
  assert.match(body.ssh.help, /openssh-server/)
  assert.ok(body.ssh.checkedAt)
  assert.match(app.lastError(), /ECONNREFUSED/)
  await plugin.stop()
})

test('a missing SSH client is reported without withholding the terminal', async () => {
  // Same shape as a missing SSH server: the page still loads, only sessions
  // fail, because that is all a missing client actually breaks.
  const { plugin, app, fake } = withFakeWetty({
    probeSshClient: () => ({
      available: false,
      error: 'ssh: command not found'
    })
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({})
  assert.equal(fake.state.starts.length, 1, 'WeTTY should still be started')

  const { body } = await call('GET /status')
  assert.equal(body.running, true)
  assert.equal(body.sshClient.available, false)
  assert.equal(body.sshClient.error, 'ssh: command not found')
  assert.match(body.sshClient.help, /openssh-client/)
  assert.match(body.sshClient.help, /container/)
  assert.match(app.lastError(), /command not found/)
  assert.match(app.lastError(), /fix instructions above the terminal/)
  await plugin.stop()
})

test('a missing SSH client and an unreachable SSH server are both reported', async () => {
  const { plugin, app } = withFakeWetty({
    probeSsh: sshDown,
    probeSshClient: () => ({
      available: false,
      error: 'ssh: command not found'
    })
  })
  await plugin.start({})
  assert.match(app.lastError(), /command not found/)
  assert.match(app.lastError(), /ECONNREFUSED/)
  await plugin.stop()
})

test('local mode does not probe for an SSH client', async () => {
  let probes = 0
  const { plugin } = withFakeWetty({
    probeSshClient: () => {
      probes += 1
      return { available: false, error: 'ssh: command not found' }
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({ mode: 'local' })
  const { body } = await call('GET /status')
  if (body.effectiveMode === 'local') {
    assert.equal(probes, 0, 'local mode never shells out to ssh')
    assert.equal(body.sshClient.available, true)
  } else {
    // Not running as root, so the plugin fell back to SSH and must check it.
    assert.equal(probes, 1)
    assert.equal(body.sshClient.available, false)
  }
  await plugin.stop()
})

test('the SSH check reports the host and port actually configured', async () => {
  const seen = []
  const { plugin } = withFakeWetty({
    probeSsh: async (host, port) => {
      seen.push([host, port])
      return sshDown(host, port)
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({ ssh: { host: 'nav.local', port: 2222 } })
  assert.deepEqual(seen, [['nav.local', 2222]])
  const { body } = await call('GET /status')
  assert.equal(body.ssh.host, 'nav.local')
  assert.equal(body.ssh.port, 2222)
  await plugin.stop()
})

test('local mode skips the SSH check entirely', async () => {
  let probes = 0
  const { plugin } = withFakeWetty({
    probeSsh: async (host, port) => {
      probes += 1
      return sshDown(host, port)
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({ mode: 'local' })
  const { body } = await call('GET /status')
  if (body.effectiveMode === 'local') {
    assert.equal(probes, 0, 'local mode never shells out to ssh')
    assert.equal(body.ssh.checked, false)
  } else {
    // Not running as root, so the plugin fell back to SSH and must check it.
    assert.equal(probes, 1)
    assert.equal(body.ssh.checked, true)
  }
  await plugin.stop()
})

test('a throwing SSH probe never takes the plugin down', async () => {
  const { plugin, app } = withFakeWetty({
    probeSsh: async () => {
      throw new Error('socket exploded')
    }
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({})
  const { body } = await call('GET /status')
  assert.equal(body.running, true)
  assert.match(body.ssh.error, /socket exploded/)
  assert.deepEqual(
    app.calls.debug.filter((m) => /SSH check failed/.test(m)).length > 0,
    true
  )
  await plugin.stop()
})

test('GET /ssh-check re-runs the probe and clears the error once sshd is up', async () => {
  // Somebody who has just installed and started sshd should be able to confirm
  // it from the webapp without restarting the plugin.
  let up = false
  const { plugin, app } = withFakeWetty({
    probeSsh: async (host, port) =>
      up ? sshUp(host, port) : sshDown(host, port)
  })
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  await plugin.start({})
  assert.match(app.lastError(), /ECONNREFUSED/)

  const first = await call('GET /ssh-check')
  assert.equal(first.body.reachable, false)

  up = true
  const second = await call('GET /ssh-check')
  assert.equal(second.body.reachable, true)
  assert.equal(second.body.banner, 'SSH-2.0-OpenSSH_9.6p1')
  assert.equal(second.body.help, '')
  assert.match(app.lastStatus(), /Terminal embedded at/)

  const { body } = await call('GET /status')
  assert.equal(body.ssh.reachable, true)
  await plugin.stop()
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
