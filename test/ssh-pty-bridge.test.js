'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const ssh2 = require('ssh2')

const { load, DIST } = require('./helpers/harness')

const { resolveOptions } = load('config.js')
const { looksLikeSshSpawn, parseSshTarget, spawnSshPty, installSshPtyPatch } =
  load('ssh-pty-bridge.js')

// Real argv shapes copied from wetty/build/server/command/ssh.js and
// spawn.js, so a WeTTY upgrade that reorders flags doesn't silently break
// detection without a test noticing.
const SSHPASS_ARGS = [
  '-S',
  'sshpass',
  '-p',
  'secret',
  'ssh',
  '-t',
  '-p',
  '22',
  '-o',
  'PreferredAuthentications=password',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'EscapeChar=none',
  '--',
  'alice@localhost'
]
const PLAIN_SSH_ARGS = [
  'ssh',
  '-t',
  '-i',
  '/etc/signalk/ssh/id_ed25519',
  '-o',
  'UserKnownHostsFile=/dev/null',
  '-o',
  'StrictHostKeyChecking=no',
  '-o',
  'EscapeChar=none',
  '--',
  'bob@nav.local',
  '$SHELL -c "cd /root;$SHELL"'
]
const LOGIN_PROMPT_ARGS = [
  'node',
  '/app/node_modules/wetty/build/server/buffer.js'
]

test('looksLikeSshSpawn matches every shape WeTTY produces for ssh mode', () => {
  assert.equal(looksLikeSshSpawn('/usr/bin/env', SSHPASS_ARGS), true)
  assert.equal(looksLikeSshSpawn('/usr/bin/env', PLAIN_SSH_ARGS), true)
})

test('looksLikeSshSpawn ignores WeTTYs other /usr/bin/env spawns', () => {
  assert.equal(looksLikeSshSpawn('/usr/bin/env', LOGIN_PROMPT_ARGS), false)
  // Local mode's login(1) is not spawned through /usr/bin/env at all.
  assert.equal(looksLikeSshSpawn('login', ['-f', 'alice']), false)
})

test('parseSshTarget reads the address WeTTY resolved, with or without a trailing command', () => {
  assert.deepEqual(parseSshTarget(SSHPASS_ARGS), {
    username: 'alice',
    host: 'localhost',
    command: undefined
  })
  assert.deepEqual(parseSshTarget(PLAIN_SSH_ARGS), {
    username: 'bob',
    host: 'nav.local',
    command: '$SHELL -c "cd /root;$SHELL"'
  })
})

test('parseSshTarget returns undefined for argv that does not fit the convention', () => {
  assert.equal(parseSshTarget(['ssh', 'no-separator-here']), undefined)
  assert.equal(parseSshTarget(['--', 'no-at-sign']), undefined)
  assert.equal(parseSshTarget([]), undefined)
})

test('loading ssh-pty-bridge does not eagerly require ssh2', () => {
  // ssh-pty-bridge.js is reached through an unconditional import chain
  // (index.js -> wetty-runner.js -> here), so a top-level `require('ssh2')`
  // would make requiring the plugin's own entry point fail whenever ssh2
  // is not installed, in every connection mode. ssh2 must only be resolved
  // once an actual SSH spawn happens. Checked in a fresh child process,
  // rather than in-process, because this test file's own `require('ssh2')`
  // above (for the fake SSH server used below) would otherwise contaminate
  // an in-process require.cache check.
  const modulePath = path.join(DIST, 'ssh-pty-bridge.js')
  const script = `
    require(${JSON.stringify(modulePath)});
    const sep = require('node:path').sep;
    const loaded = Object.keys(require.cache).some((p) => p.includes(sep + 'ssh2' + sep));
    process.stdout.write(String(loaded));
  `
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8'
  })
  assert.equal(
    output,
    'false',
    'ssh2 must not be loaded merely from requiring ssh-pty-bridge.js'
  )
})

test('installSshPtyPatch replaces spawn and the remover restores it', () => {
  const original = (file, args) => ({ tag: 'real-node-pty', file, args })
  const fakeModule = { spawn: original }
  const sshConfig = resolveOptions({}).ssh

  const remove = installSshPtyPatch(sshConfig, fakeModule)
  assert.notEqual(fakeModule.spawn, original)

  // A non-ssh spawn — WeTTY's username-prompt helper — passes straight
  // through to the real node-pty untouched.
  const result = fakeModule.spawn('/usr/bin/env', LOGIN_PROMPT_ARGS, {})
  assert.deepEqual(result, {
    tag: 'real-node-pty',
    file: '/usr/bin/env',
    args: LOGIN_PROMPT_ARGS
  })

  remove()
  assert.equal(fakeModule.spawn, original)
})

test('installSshPtyPatch resolves the real shared node-pty by default', () => {
  // Mirrors clearPrometheusRegistry() in wetty-runner.ts, which resolves
  // prom-client the same way — node-pty is hoisted to a single top-level
  // install in this repo, so `require('node-pty')` here reaches the exact
  // same module instance installSshPtyPatch's own resolutionPaths()-based
  // lookup does.
  const nodePty = require('node-pty')
  const original = nodePty.spawn
  const sshConfig = resolveOptions({}).ssh

  const remove = installSshPtyPatch(sshConfig)
  assert.notEqual(nodePty.spawn, original)
  remove()
  assert.equal(nodePty.spawn, original)
})

/**
 * A throwaway in-process SSH server, so spawnSshPty() can be exercised
 * end-to-end without Docker, a system sshd, or a system ssh client — the
 * whole point of replacing WeTTY's shell-out with a JS client. Accepts only
 * password auth with a fixed password, and echoes back whatever the client
 * sends, prefixed so the round trip is unambiguous in assertions.
 */
const startTestSshServer = () =>
  new Promise((resolve) => {
    const hostKey = ssh2.utils.generateKeyPairSync('ed25519')
    const windowChanges = []
    const authAttempts = []
    const server = new ssh2.Server(
      { hostKeys: [hostKey.private] },
      (client) => {
        client.on('authentication', (ctx) => {
          authAttempts.push(ctx.method)
          if (ctx.method === 'password' && ctx.password === 'letmein') {
            ctx.accept()
            return
          }
          ctx.reject(['password'])
        })
        client.on('ready', () => {
          client.on('session', (accept) => {
            const session = accept()
            session.on('pty', (acceptPty) => acceptPty())
            session.on('window-change', (acceptResize, _reject, info) => {
              windowChanges.push(info)
              acceptResize?.()
            })
            session.on('shell', (acceptShell) => {
              const stream = acceptShell()
              stream.write('ready\r\n')
              stream.on('data', (chunk) => {
                const text = chunk.toString('utf8')
                if (text.includes('bye')) {
                  stream.exit(0)
                  stream.end()
                  return
                }
                stream.write(`echo:${text}`)
              })
            })
          })
        })
      }
    )
    server.windowChanges = windowChanges
    server.authAttempts = authAttempts
    server.listen(0, '127.0.0.1', () => resolve(server))
  })

const waitFor = async (predicate, timeoutMs = 2000) => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('spawnSshPty carries a real shell session over ssh2, no ssh binary involved', async () => {
  const server = await startTestSshServer()
  const { port } = server.address()
  const sshConfig = resolveOptions({
    ssh: { auth: 'password', password: 'letmein', knownHosts: '/dev/null' }
  }).ssh

  const chunks = []
  const exits = []
  // The target host/user comes from the argv (parseSshTarget); the port
  // is not part of that convention, so it's carried on sshConfig instead —
  // exactly like WeTTY's own sshOptions()/spawnSshPty split.
  const config = { ...sshConfig, port }
  const session = spawnSshPty(config, ['--', 'tester@127.0.0.1'], {
    cols: 80,
    rows: 24
  })
  session.onData((data) => chunks.push(data))
  session.onExit((e) => exits.push(e))

  await waitFor(() => chunks.join('').includes('ready'))

  session.write('hello\r')
  await waitFor(() => chunks.join('').includes('echo:hello'))

  session.resize(120, 40)
  await waitFor(() => server.windowChanges.length > 0)
  assert.equal(server.windowChanges[0].cols, 120)
  assert.equal(server.windowChanges[0].rows, 40)

  session.write('bye\r')
  await waitFor(() => exits.length > 0)
  assert.equal(exits[0].exitCode, 0)

  // Deterministic teardown: server.close() waits for open connections to
  // end, and relying solely on the server-side stream.exit()/end() to bring
  // the client down first is a race — kill the session explicitly instead
  // of trusting it resolves before the test's own timeout does.
  session.kill()
  await new Promise((resolve) => server.close(resolve))
})

test('spawnSshPty reports a clean exit when authentication fails', async () => {
  const server = await startTestSshServer()
  const { port } = server.address()
  const sshConfig = {
    ...resolveOptions({
      ssh: {
        auth: 'password',
        password: 'wrong-password',
        knownHosts: '/dev/null'
      }
    }).ssh,
    port
  }

  const chunks = []
  const exits = []
  const session = spawnSshPty(sshConfig, ['--', 'tester@127.0.0.1'], {
    cols: 80,
    rows: 24
  })
  session.onData((data) => chunks.push(data))
  session.onExit((e) => exits.push(e))

  await waitFor(() => exits.length > 0, 5000)
  assert.equal(exits[0].exitCode, 1)

  session.kill()
  await new Promise((resolve) => server.close(resolve))
})

test('auth methods are attempted in the configured order, not publickey-first', async () => {
  const server = await startTestSshServer()
  const { port } = server.address()
  // A syntactically valid key the test server will never accept, so a
  // publickey attempt is observable without ever succeeding via it.
  const throwawayKey = ssh2.utils.generateKeyPairSync('ed25519')
  const keyPath = require('node:path').join(
    require('node:os').tmpdir(),
    `signalk-wetty-test-key-${Date.now()}`
  )
  require('node:fs').writeFileSync(keyPath, throwawayKey.private)

  try {
    const sshConfig = {
      ...resolveOptions({
        ssh: { auth: 'password,publickey', password: 'letmein', keyPath }
      }).ssh,
      port
    }

    const chunks = []
    const session = spawnSshPty(sshConfig, ['--', 'tester@127.0.0.1'], {
      cols: 80,
      rows: 24
    })
    session.onData((data) => chunks.push(data))

    await waitFor(() => chunks.join('').includes('ready'))
    // auth: 'password,publickey' lists password first, so that must be
    // what the server sees attempted first, regardless of which auth
    // action buildAuthPlan happens to build internally.
    assert.equal(server.authAttempts[0], 'password')

    session.kill()
  } finally {
    require('node:fs').unlinkSync(keyPath)
    await new Promise((resolve) => server.close(resolve))
  }
})

test('Ctrl-C at an interactive password prompt still ends the session', async () => {
  const server = await startTestSshServer()
  const { port } = server.address()
  // No password configured, so spawnSshPty falls back to prompting for one
  // in the terminal itself instead of ever reaching the server with a
  // 'password' attempt.
  const sshConfig = {
    ...resolveOptions({ ssh: { auth: 'password', password: '' } }).ssh,
    port
  }

  const chunks = []
  const exits = []
  const session = spawnSshPty(sshConfig, ['--', 'tester@127.0.0.1'], {
    cols: 80,
    rows: 24
  })
  session.onData((data) => chunks.push(data))
  session.onExit((e) => exits.push(e))

  await waitFor(() => chunks.join('').includes('password'))
  session.write('\x03') // Ctrl-C

  // Before the connection-level `close` handler, this hung forever: the
  // password prompt's `conn.end()` neither opened a channel nor raised an
  // `error`, so onExit never fired.
  await waitFor(() => exits.length > 0, 2000)

  await new Promise((resolve) => server.close(resolve))
})
