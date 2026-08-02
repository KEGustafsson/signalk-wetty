'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { load } = require('./helpers/harness')
const {
  loadWebapp,
  runningStatus,
  find,
  textOf
} = require('./helpers/webapp-dom')

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

test('the terminal is reached through the same-origin embedded proxy path', () => {
  // Genuinely embedded: reverse-proxied through this same origin, so the URL
  // is just this plugin's own route — no separate host, port or scheme to
  // work out from the browser.
  assert.match(html, /\$\{API\}\/terminal/)
  assert.ok(!/window\.location\.hostname/.test(html))
})

test('the webapp is self-contained', () => {
  // Signal K installations are routinely offline at sea, so no external
  // stylesheet, font or script may be referenced.
  assert.equal(/<script[^>]+src=/.test(html), false)
  assert.equal(/<link[^>]+href=["']https?:/.test(html), false)
  assert.equal(/@import\s+url\(/.test(html), false)
})

test('the rebuild is polled rather than awaited on one long request', () => {
  // Compiling node-pty takes minutes; a proxy in front of the admin UI would
  // cut off a held response and report a failure for a healthy build.
  assert.match(html, /awaitRebuild/)
  assert.match(html, /status\.rebuild\.running/)
})

test('a missing SSH server is surfaced above the terminal', () => {
  // The terminal still loads without sshd — it is the sessions inside it that
  // fail — so the warning has to appear before the user types anything.
  assert.match(html, /sshWarning/)
  assert.match(html, /status\.ssh\.checked/)
  assert.match(html, /status\.ssh\.help/)
  assert.match(html, /\$\{API\}\/ssh-check/)
})

test('every branch of the status payload has a rendering path', () => {
  for (const marker of [
    'renderTerminal',
    'renderError',
    'status.native.available',
    'status.allowIframe',
    'status.sshClient.available',
    'status.ssh.reachable',
    'res.status === 401'
  ]) {
    assert.ok(html.includes(marker), `webapp does not handle ${marker}`)
  }
})

test('a running terminal still renders when status contains an SSH warning', async () => {
  // Missing ssh/sshd is a session problem, not a reason to replace the running
  // terminal with the generic unavailable screen.
  const { root, settle } = loadWebapp({
    status: runningStatus({
      error: 'ssh: connect to host localhost port 22: Connection refused',
      ssh: {
        checked: true,
        reachable: false,
        error: 'Connection refused',
        help: 'sudo apt install -y openssh-server'
      }
    })
  })
  await settle()

  const iframe = find(root, 'iframe')
  assert.ok(iframe, 'the running terminal was replaced instead of kept')
  assert.equal(iframe.src, `/plugins/${PLUGIN_ID}/terminal/`)

  const text = textOf(root)
  assert.match(text, /No SSH server/)
  assert.match(text, /openssh-server/)
  assert.doesNotMatch(text, /Terminal unavailable/)
})

test('a running terminal still renders when the SSH client is missing', async () => {
  const { root, settle } = loadWebapp({
    status: runningStatus({
      sshClient: {
        available: false,
        error: 'ssh: command not found',
        help: 'apt update && apt install -y openssh-client'
      }
    })
  })
  await settle()

  assert.ok(
    find(root, 'iframe'),
    'the running terminal was replaced instead of kept'
  )
  const text = textOf(root)
  assert.match(text, /No SSH client/)
  assert.match(text, /openssh-client/)
  assert.doesNotMatch(text, /Terminal unavailable/)
})

test('a terminal that is not running renders the unavailable screen', async () => {
  // The other side of the same branch: without this, a renderTerminal() that
  // ignored `running` would still satisfy the tests above.
  const { root, settle } = loadWebapp({
    status: runningStatus({
      running: false,
      error: 'WeTTY failed to start',
      native: { available: true, help: '' }
    })
  })
  await settle()

  assert.equal(find(root, 'iframe'), null)
  assert.match(textOf(root), /Terminal unavailable/)
  assert.match(textOf(root), /WeTTY failed to start/)
})

test('embedding disabled offers a link instead of the terminal frame', async () => {
  const { root, settle } = loadWebapp({
    status: runningStatus({ allowIframe: false })
  })
  await settle()

  assert.equal(find(root, 'iframe'), null)
  const link = find(root, 'a')
  assert.ok(link, 'no link to open the terminal')
  assert.equal(link.href, `/plugins/${PLUGIN_ID}/terminal/`)
  assert.match(textOf(root), /Terminal ready/)
})
