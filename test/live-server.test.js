'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

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

  const page = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(page.status, 200)
  const body = await page.text()
  assert.match(body, /<title>Live test terminal<\/title>/)
  assert.match(body, /id="terminal"/)

  // allowIframe defaults to true so the admin UI can embed the terminal.
  assert.equal(page.headers.get('x-frame-options'), null)

  const handshake = await fetch(
    `http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`
  )
  assert.equal(handshake.status, 200)
  assert.match(await handshake.text(), /"sid"/)

  const status = await call('GET /status')
  assert.equal(status.body.running, true)
  assert.equal(status.body.port, port)
})

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
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/`))

    // Restarting on the same port only works if stop() really closed the
    // listener, and only if WeTTY's Prometheus metrics were reset.
    await plugin.start({ port, host: '127.0.0.1' })
    assert.equal(app.calls.pluginError.length, 0, app.lastError())
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
  }
)

test(
  'a base path moves the terminal off the site root',
  { skip },
  async (t) => {
    const app = createMockApp()
    const plugin = withStubbedSsh(app)
    const port = await freePort()
    t.after(() => plugin.stop())

    await plugin.start({ port, host: '127.0.0.1', basePath: '/terminal/' })
    assert.equal(app.calls.pluginError.length, 0, app.lastError())
    assert.equal((await fetch(`http://127.0.0.1:${port}/terminal`)).status, 200)
  }
)

test('iframe embedding can be locked down', { skip }, async (t) => {
  const app = createMockApp()
  const plugin = withStubbedSsh(app)
  const port = await freePort()
  t.after(() => plugin.stop())

  await plugin.start({ port, host: '127.0.0.1', allowIframe: false })
  const page = await fetch(`http://127.0.0.1:${port}/`)
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN')
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
