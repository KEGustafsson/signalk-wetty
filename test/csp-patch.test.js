'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load } = require('./helpers/harness')

const { stripCspDirectives, installCspPatch } = load('csp-patch.js')

test('stripCspDirectives removes only the named directives', () => {
  const csp =
    "default-src 'self'; frame-ancestors 'self'; upgrade-insecure-requests; object-src 'none'"
  assert.equal(
    stripCspDirectives(csp, ['frame-ancestors', 'upgrade-insecure-requests']),
    "default-src 'self'; object-src 'none'"
  )
})

test('stripCspDirectives is a no-op when none of the directives are present', () => {
  const csp = "default-src 'self'; object-src 'none'"
  assert.equal(stripCspDirectives(csp, ['frame-ancestors']), csp)
})

test('stripCspDirectives matches directive names exactly, not a prefix', () => {
  const csp = "frame-ancestors-extra 'self'; default-src 'self'"
  assert.equal(stripCspDirectives(csp, ['frame-ancestors']), csp)
})

test('stripCspDirectives strips a valueless directive like upgrade-insecure-requests', () => {
  const csp = "default-src 'self'; upgrade-insecure-requests"
  assert.equal(
    stripCspDirectives(csp, ['upgrade-insecure-requests']),
    "default-src 'self'"
  )
})

/** Minimal stand-in for the raw http.Server WeTTY hands back. */
const fakeHttpServer = () => {
  let requestHandler
  return {
    prependListener: (event, handler) => {
      if (event === 'request') {
        requestHandler = handler
      }
    },
    fireRequest: (req, res) => requestHandler(req, res)
  }
}

/** Minimal stand-in for a Node ServerResponse. */
const fakeResponse = () => {
  const headers = {}
  const res = {
    setHeader: (name, value) => {
      headers[name] = value
      return res
    }
  }
  return { res, headers }
}

test('the patched response strips the requested directives from a CSP header', () => {
  const server = fakeHttpServer()
  installCspPatch(server, ['frame-ancestors', 'upgrade-insecure-requests'])

  const { res, headers } = fakeResponse()
  server.fireRequest({}, res)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; frame-ancestors 'self'; upgrade-insecure-requests"
  )

  assert.equal(headers['Content-Security-Policy'], "default-src 'self'")
})

test('the patch leaves unrelated headers untouched', () => {
  const server = fakeHttpServer()
  installCspPatch(server, ['frame-ancestors'])

  const { res, headers } = fakeResponse()
  server.fireRequest({}, res)
  res.setHeader('X-Powered-By', 'Express')

  assert.equal(headers['X-Powered-By'], 'Express')
})

test('an empty directive list installs no patch at all', () => {
  let listenerCalls = 0
  const server = {
    prependListener: () => {
      listenerCalls += 1
    }
  }
  installCspPatch(server, [])
  assert.equal(listenerCalls, 0)
})
