'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const { load, freePort } = require('./helpers/harness')

const { createEmbeddedProxy, installUpgradeForwarding, resolveUpgradeUrl } =
  load('embedded-proxy.js')

const MOUNT_PATH = '/plugins/signalk-wetty/terminal'

/** Minimal stand-in for WeTTY: echoes the request path back as JSON. */
const startTarget = async () => {
  const port = await freePort()
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

/** Fronts a proxy's middleware with a real HTTP server, the way Express would. */
const startFrontend = async (middleware, onUpgrade) => {
  const port = await freePort()
  const server = http.createServer((req, res) => {
    void middleware(req, res, () => {})
  })
  if (onUpgrade) {
    server.on('upgrade', onUpgrade)
  }
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return { port, close: () => new Promise((resolve) => server.close(resolve)) }
}

test('the full mount path is always prepended before forwarding to the target', async (t) => {
  // Express has already stripped the mount path by the time this middleware
  // sees a request; it is added back so WeTTY (whose own basePath is set to
  // this same path — see wetty-runner.ts) receives what it expects.
  const target = await startTarget()
  t.after(target.close)

  const proxy = createEmbeddedProxy({ port: target.port }, MOUNT_PATH, () => {})
  const frontend = await startFrontend(proxy.middleware)
  t.after(frontend.close)

  const res = await fetch(`http://127.0.0.1:${frontend.port}/socket.io/?x=1`)
  const body = await res.json()
  assert.equal(body.url, `${MOUNT_PATH}/socket.io/?x=1`)
})

test('the root path is forwarded without a trailing slash', async (t) => {
  // Regression: appending a bare "/" to the mount path produces
  // fullMountPath + "/", which WeTTY's own redirect middleware 301s back
  // down to fullMountPath — and re-stripping/re-adding the mount prefix on
  // that redirected request reproduces the same "/", looping forever.
  const target = await startTarget()
  t.after(target.close)

  const proxy = createEmbeddedProxy({ port: target.port }, MOUNT_PATH, () => {})
  const frontend = await startFrontend(proxy.middleware)
  t.after(frontend.close)

  const res = await fetch(`http://127.0.0.1:${frontend.port}/`)
  const body = await res.json()
  assert.equal(body.url, MOUNT_PATH)
})

test('a proxy error is reported through the callback instead of crashing', async (t) => {
  // A port nothing is listening on, so the proxy genuinely fails to connect.
  const deadPort = await freePort()
  const errors = []

  const proxy = createEmbeddedProxy({ port: deadPort }, MOUNT_PATH, (msg) =>
    errors.push(msg)
  )
  const frontend = await startFrontend(proxy.middleware)
  t.after(frontend.close)

  const res = await fetch(`http://127.0.0.1:${frontend.port}/`)
  assert.ok(res.status >= 500)
  // Filtered rather than counted outright: the same callback also carries the
  // service-worker lookup's own report when wetty is not installed at all.
  const proxyErrors = errors.filter((msg) =>
    /Embedded terminal proxy error/.test(msg)
  )
  assert.equal(proxyErrors.length, 1)
})

test('WeTTY’s service worker is served by the proxy, never forwarded', async (t) => {
  // WeTTY cannot serve this file itself from a Signal K installation: it uses
  // res.sendFile() with an absolute path and no root, so `send` applies its
  // dotfile rule to the whole path and 404s on the ".signalk" segment.
  const target = await startTarget()
  t.after(target.close)

  const proxy = createEmbeddedProxy({ port: target.port }, MOUNT_PATH, () => {})
  const frontend = await startFrontend(proxy.middleware)
  t.after(frontend.close)

  const res = await fetch(`http://127.0.0.1:${frontend.port}/sw.js`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /javascript/)

  const body = await res.text()
  // The stand-in target echoes the request path back as JSON, so anything
  // resembling a URL here means the request reached WeTTY after all.
  assert.doesNotMatch(body, new RegExp(MOUNT_PATH))
  assert.match(body, /addEventListener/)
})

test('resolveUpgradeUrl strips the mount path from a matching URL', () => {
  assert.equal(
    resolveUpgradeUrl(`${MOUNT_PATH}/socket.io/?EIO=4`, MOUNT_PATH),
    '/socket.io/?EIO=4'
  )
})

test('resolveUpgradeUrl normalises a bare mount-path hit to /', () => {
  assert.equal(resolveUpgradeUrl(MOUNT_PATH, MOUNT_PATH), '/')
})

test('resolveUpgradeUrl rejects a URL outside the mount path', () => {
  assert.equal(resolveUpgradeUrl('/some/other/path', MOUNT_PATH), null)
  assert.equal(resolveUpgradeUrl(undefined, MOUNT_PATH), null)
})

test('handleUpgrade ignores a URL outside the mount path, leaving it for other listeners', async (t) => {
  const target = await startTarget()
  t.after(target.close)

  const proxy = createEmbeddedProxy({ port: target.port }, MOUNT_PATH, () => {})

  let sawOtherHandler = false
  const server = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  server.on('upgrade', proxy.handleUpgrade)
  server.on('upgrade', (_req, socket) => {
    sawOtherHandler = true
    socket.destroy()
  })
  const port = await freePort()
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))

  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/some/other/path',
      headers: { Connection: 'Upgrade', Upgrade: 'fake' }
    })
    req.on('upgrade', () => resolve())
    req.on('error', () => resolve())
    req.end()
    setTimeout(resolve, 300)
  })
  assert.equal(
    sawOtherHandler,
    true,
    'a non-matching upgrade must fall through to other listeners'
  )
})

test('installUpgradeForwarding attaches to the server and can be removed', () => {
  const listeners = []
  const fakeServer = {
    on: (event, handler) => {
      if (event === 'upgrade') {
        listeners.push(handler)
      }
    },
    removeListener: (event, handler) => {
      if (event !== 'upgrade') {
        return
      }
      const index = listeners.indexOf(handler)
      if (index !== -1) {
        listeners.splice(index, 1)
      }
    }
  }
  const handler = () => {}
  const remove = installUpgradeForwarding(fakeServer, handler)
  assert.equal(listeners.length, 1)
  remove()
  assert.equal(listeners.length, 0)
})

test('installUpgradeForwarding is a safe no-op when no server is exposed', () => {
  const remove = installUpgradeForwarding(undefined, () => {})
  assert.doesNotThrow(() => remove())
})
