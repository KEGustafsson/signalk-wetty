'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { load } = require('./helpers/harness')

const {
  SERVICE_WORKER_PATH,
  createServiceWorkerHandler,
  wettyServiceWorkerFile
} = load('service-worker-asset.js')

/** Collects a response the way a real ServerResponse would receive it. */
const createResponse = () => {
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader: (name, value) => {
      res.headers[name.toLowerCase()] = value
    },
    end: (body) => {
      res.body = body
      res.ended = true
    }
  }
  return res
}

test('the real wetty package’s service worker is locatable', () => {
  // Guards the resolution itself: the whole point of serving this file from
  // the proxy is that it exists, and only WeTTY's own path handling rejects it.
  const file = wettyServiceWorkerFile()
  assert.ok(file, 'wetty’s sw.js should be found next to the installed package')
  assert.ok(fs.existsSync(file))
})

test('a path containing a dot-segment still resolves — the case WeTTY 404s on', () => {
  // Reproduces the Signal K layout (~/.signalk/node_modules/...): the file is
  // found here, where `send`'s dotfile rule would have refused to serve it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dotdir-'))
  const buildDir = path.join(root, '.signalk', 'node_modules', 'wetty', 'build')
  fs.mkdirSync(buildDir, { recursive: true })
  fs.writeFileSync(path.join(buildDir, 'sw.js'), '// sw')

  const file = wettyServiceWorkerFile(() => path.join(buildDir, 'server.js'))
  assert.equal(file, path.join(buildDir, 'sw.js'))

  fs.rmSync(root, { recursive: true, force: true })
})

test('an unresolvable wetty yields no file and a reported reason', () => {
  const errors = []
  const handler = createServiceWorkerHandler(
    (msg) => errors.push(msg),
    () => undefined
  )
  assert.equal(handler.available, false)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /service worker/i)
})

test('a GET for the service worker is answered from the cached file', () => {
  const handler = createServiceWorkerHandler(
    () => {},
    () => '/fake/build/sw.js',
    () => Buffer.from('// service worker')
  )
  assert.equal(handler.available, true)

  const res = createResponse()
  const handled = handler.handle(
    { method: 'GET', url: SERVICE_WORKER_PATH },
    res
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.toString(), '// service worker')
  assert.match(res.headers['content-type'], /javascript/)
  assert.equal(res.headers['content-length'], '17')
  assert.equal(res.headers['cache-control'], 'no-cache')
})

test('a HEAD request gets the headers without the body', () => {
  const handler = createServiceWorkerHandler(
    () => {},
    () => '/fake/build/sw.js',
    () => Buffer.from('// service worker')
  )
  const res = createResponse()

  assert.equal(
    handler.handle({ method: 'HEAD', url: SERVICE_WORKER_PATH }, res),
    true
  )
  assert.equal(res.body, undefined)
  assert.equal(res.headers['content-length'], '17')
})

test('a query string does not stop the service worker from matching', () => {
  const handler = createServiceWorkerHandler(
    () => {},
    () => '/fake/build/sw.js',
    () => Buffer.from('// sw')
  )
  const res = createResponse()
  assert.equal(
    handler.handle({ method: 'GET', url: `${SERVICE_WORKER_PATH}?v=2` }, res),
    true
  )
})

test('every other request is left to the proxy', () => {
  const handler = createServiceWorkerHandler(
    () => {},
    () => '/fake/build/sw.js',
    () => Buffer.from('// sw')
  )

  for (const req of [
    { method: 'GET', url: '/' },
    { method: 'GET', url: '/client/wetty.js' },
    { method: 'GET', url: '/socket.io/?EIO=4' },
    // Only GET/HEAD are ever a service worker fetch; anything else belongs to
    // WeTTY, which should decide for itself how to reject it.
    { method: 'POST', url: SERVICE_WORKER_PATH }
  ]) {
    const res = createResponse()
    assert.equal(
      handler.handle(req, res),
      false,
      `should not handle ${req.url}`
    )
    assert.equal(res.ended, false)
  }
})

test('an unreadable file leaves the request to the proxy instead of failing it', () => {
  const errors = []
  const handler = createServiceWorkerHandler(
    (msg) => errors.push(msg),
    () => '/fake/build/sw.js',
    () => {
      throw new Error('EACCES')
    }
  )
  assert.equal(handler.available, false)
  assert.match(errors[0], /EACCES/)

  const res = createResponse()
  assert.equal(
    handler.handle({ method: 'GET', url: SERVICE_WORKER_PATH }, res),
    false
  )
  assert.equal(res.ended, false)
})
