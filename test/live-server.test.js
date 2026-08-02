'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const {
  load,
  createMockApp,
  createMockRouter,
  nativeAvailable,
  freePort
} = require('./helpers/harness')

/**
 * End-to-end coverage against the real `wetty` package: the plugin actually
 * binds a port, serves the terminal page and answers a socket.io handshake.
 *
 * Skipped when node-pty has no compiled binding — that is the expected state
 * of an app store install, and the plugin's own status message covers it.
 */
const skip = !nativeAvailable()
  ? 'wetty/node-pty is not installed with a compiled binding'
  : false

const createPlugin = load('index.js')
const { EMBEDDED_TERMINAL_PATH } = load('config.js')

// WeTTY's basePath is always EMBEDDED_TERMINAL_PATH (see wetty-runner.ts),
// so even a direct fetch against its own port has to use that path.
const directUrl = (port, suffix = '') =>
  `http://127.0.0.1:${port}${EMBEDDED_TERMINAL_PATH}${suffix}`

// These tests are about WeTTY serving real traffic, not about SSH. Stubbing the
// probe keeps them from depending on whether the machine running them happens
// to have an sshd listening; ssh-probe.test.js covers the real thing.
const withStubbedSsh = (app) =>
  createPlugin(app, {
    probeSsh: async (host, port) => ({
      reachable: true,
      host,
      port,
      banner: 'SSH-2.0-OpenSSH_9.6p1',
      error: null,
      code: null
    })
  })

test('the plugin serves a real WeTTY instance', { skip }, async (t) => {
  const app = createMockApp()
  const plugin = withStubbedSsh(app)
  const { router, call } = createMockRouter()
  plugin.registerWithRouter(router)

  const port = await freePort()
  t.after(() => plugin.stop())

  await plugin.start({ port, host: '127.0.0.1', title: 'Live test terminal' })
  assert.equal(app.calls.pluginError.length, 0, app.lastError())

  const page = await fetch(directUrl(port, '/'))
  assert.equal(page.status, 200)
  const body = await page.text()
  assert.match(body, /<title>Live test terminal<\/title>/)
  assert.match(body, /id="terminal"/)

  // allowIframe defaults to true so the admin UI can embed the terminal.
  assert.equal(page.headers.get('x-frame-options'), null)
  const csp = page.headers.get('content-security-policy') || ''
  // WeTTY's own allowIframe only clears X-Frame-Options; helmet's default
  // CSP frame-ancestors 'self' would still block embedding from the admin
  // UI, which normally runs on a different port. See src/csp-patch.ts.
  assert.doesNotMatch(csp, /frame-ancestors/)
  // No SSL is configured for this test server, so upgrading a later request
  // to HTTPS (helmet's other CSP default) would just fail outright.
  assert.doesNotMatch(csp, /upgrade-insecure-requests/)

  const handshake = await fetch(
    directUrl(port, '/socket.io/?EIO=4&transport=polling')
  )
  assert.equal(handshake.status, 200)
  assert.match(await handshake.text(), /"sid"/)

  const status = await call('GET /status')
  assert.equal(status.body.running, true)
  assert.equal(status.body.port, port)
})

test(
  'the terminal is genuinely embedded: reachable through a single origin, no separate port to visit',
  { skip },
  async (t) => {
    const app = createMockApp()
    // Stands in for Signal K's own HTTP server. It is never handed to the
    // plugin — the plugin finds it through the requests it serves, which is
    // how WebSocket upgrades get forwarded alongside regular HTTP requests.
    const frontend = http.createServer()
    const frontendPort = await freePort()
    await new Promise((resolve) =>
      frontend.listen(frontendPort, '127.0.0.1', resolve)
    )
    t.after(() => new Promise((resolve) => frontend.close(resolve)))

    const plugin = createPlugin(app, {
      probeSsh: async (host, port) => ({
        reachable: true,
        host,
        port,
        banner: 'SSH-2.0-OpenSSH_9.6p1',
        error: null,
        code: null
      })
    })
    const { router, handlers } = createMockRouter()
    plugin.registerWithRouter(router)

    // Simulates what Express does once Signal K mounts the plugin's router
    // at /plugins/signalk-wetty and the plugin mounts itself at /terminal
    // underneath: strip both prefixes before the registered handler runs.
    const MOUNT_PREFIX = '/plugins/signalk-wetty/terminal'
    frontend.on('request', (req, res) => {
      if (!req.url.startsWith(MOUNT_PREFIX)) {
        res.writeHead(404)
        res.end()
        return
      }
      req.url = req.url.slice(MOUNT_PREFIX.length) || '/'
      const handler = handlers.get('USE /terminal')
      void handler(req, res, () => {})
    })

    const wettyPort = await freePort()
    t.after(() => plugin.stop())
    await plugin.start({ port: wettyPort, host: '127.0.0.1' })
    assert.equal(app.calls.pluginError.length, 0, app.lastError())

    // Every request in this test targets frontendPort — standing in for
    // Signal K's own port — never WeTTY's own internal port directly.
    const page = await fetch(`http://127.0.0.1:${frontendPort}${MOUNT_PREFIX}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /id="terminal"/)

    // Serving that page is what gave the plugin the server, so upgrades for
    // the session the page is about to open are now forwarded too.
    assert.equal(frontend.listenerCount('upgrade'), 1)

    const handshake = await fetch(
      `http://127.0.0.1:${frontendPort}${MOUNT_PREFIX}/socket.io/?EIO=4&transport=polling`
    )
    assert.equal(handshake.status, 200)
    assert.match(await handshake.text(), /"sid"/)
  }
)

test(
  'the port is released on stop and reusable on restart',
  { skip },
  async (t) => {
    const app = createMockApp()
    const plugin = withStubbedSsh(app)
    const port = await freePort()
    t.after(() => plugin.stop())

    await plugin.start({ port, host: '127.0.0.1' })
    await plugin.stop()
    await assert.rejects(() => fetch(directUrl(port, '/')))

    // Restarting on the same port only works if stop() really closed the
    // listener, and only if WeTTY's Prometheus metrics were reset.
    await plugin.start({ port, host: '127.0.0.1' })
    assert.equal(app.calls.pluginError.length, 0, app.lastError())
    assert.equal((await fetch(directUrl(port, '/'))).status, 200)
  }
)

test('iframe embedding can be locked down', { skip }, async (t) => {
  const app = createMockApp()
  const plugin = withStubbedSsh(app)
  const port = await freePort()
  t.after(() => plugin.stop())

  await plugin.start({ port, host: '127.0.0.1', allowIframe: false })
  const page = await fetch(directUrl(port, '/'))
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN')
  const csp = page.headers.get('content-security-policy') || ''
  assert.match(csp, /frame-ancestors 'self'/)
  // Still no SSL configured here, independent of allowIframe.
  assert.doesNotMatch(csp, /upgrade-insecure-requests/)
})

test(
  'a port that is already taken is reported, not thrown',
  { skip },
  async (t) => {
    const net = require('node:net')
    const blocker = net.createServer()
    const port = await freePort()
    await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve))
    t.after(() => new Promise((resolve) => blocker.close(resolve)))

    const app = createMockApp()
    const plugin = withStubbedSsh(app)
    t.after(() => plugin.stop())

    await plugin.start({ port, host: '127.0.0.1' })
    assert.match(app.lastError() || '', /already in use|EADDRINUSE/)
  }
)
