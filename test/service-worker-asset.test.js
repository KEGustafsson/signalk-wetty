'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load } = require('./helpers/harness')

const { SERVICE_WORKER_PATH, createServiceWorkerHandler } = load(
  'service-worker-asset.js'
)

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

const bodyOf = () => {
  const res = createResponse()
  createServiceWorkerHandler().handle(
    { method: 'GET', url: SERVICE_WORKER_PATH },
    res
  )
  return res.body.toString()
}

test('a GET for the service worker is answered with a 200', () => {
  const res = createResponse()
  const handled = createServiceWorkerHandler().handle(
    { method: 'GET', url: SERVICE_WORKER_PATH },
    res
  )

  assert.equal(handled, true)
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /javascript/)
  assert.equal(res.headers['content-length'], String(res.body.length))
})

test('the served worker unregisters itself and clears any cache', () => {
  // The point of serving anything at all: WeTTY's own worker has never run on
  // a Signal K install, so this must switch nothing on — only clean up.
  const body = bodyOf()
  assert.match(body, /self\.registration\.unregister\(\)/)
  assert.match(body, /caches\.delete/)
})

test('the served worker installs no fetch handler', () => {
  // A fetch handler would put a cache in front of the terminal's own
  // socket.io traffic, which is exactly what must not happen here.
  assert.doesNotMatch(bodyOf(), /addEventListener\(\s*['"]fetch['"]/)
})

test('the response is never cached, so the old worker cannot survive', () => {
  const res = createResponse()
  createServiceWorkerHandler().handle(
    { method: 'GET', url: SERVICE_WORKER_PATH },
    res
  )
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('a HEAD request gets the headers without the body', () => {
  const res = createResponse()

  assert.equal(
    createServiceWorkerHandler().handle(
      { method: 'HEAD', url: SERVICE_WORKER_PATH },
      res
    ),
    true
  )
  assert.equal(res.body, undefined)
  assert.ok(Number(res.headers['content-length']) > 0)
})

test('a query string does not stop the service worker from matching', () => {
  const res = createResponse()
  assert.equal(
    createServiceWorkerHandler().handle(
      { method: 'GET', url: `${SERVICE_WORKER_PATH}?v=2` },
      res
    ),
    true
  )
})

test('every other request is left to the proxy', () => {
  const handler = createServiceWorkerHandler()

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
