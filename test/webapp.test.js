'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { load } = require('./helpers/harness')

const { PLUGIN_ID } = load('config.js')

const ROOT = path.resolve(__dirname, '..')
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')

test('the webapp talks to this plugins routes', () => {
  assert.match(html, new RegExp(`/plugins/${PLUGIN_ID}`))
  assert.match(html, /\$\{API\}\/status/)
  assert.match(html, /\$\{API\}\/rebuild-native/)
})

test('the webapp sends the admin session along with its requests', () => {
  const fetches = html.match(/fetch\([\s\S]*?\)/g) || []
  assert.ok(fetches.length >= 2)
  for (const call of fetches) {
    assert.match(
      call,
      /credentials: 'same-origin'/,
      `missing credentials: ${call}`
    )
  }
})

test('the terminal URL is built from the browsers own hostname', () => {
  // The status endpoint deliberately does not report a hostname: the terminal
  // runs on the same machine as the server, and only the browser knows which
  // address it used to get there.
  assert.match(html, /window\.location\.hostname/)
  assert.ok(!/localhost:\$\{/.test(html))
})

test('the webapp is self-contained', () => {
  // Signal K installations are routinely offline at sea, so no external
  // stylesheet, font or script may be referenced.
  assert.equal(/<script[^>]+src=/.test(html), false)
  assert.equal(/<link[^>]+href=["']https?:/.test(html), false)
  assert.equal(/@import\s+url\(/.test(html), false)
})

test('every branch of the status payload has a rendering path', () => {
  for (const marker of [
    'renderTerminal',
    'renderError',
    'status.native.available',
    'status.allowIframe',
    'status.loopbackOnly',
    'res.status === 401'
  ]) {
    assert.ok(html.includes(marker), `webapp does not handle ${marker}`)
  }
})
