'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')

const { load, freePort } = require('./helpers/harness')

const { isLocalHost, probeSshServer, sshHelpText } = load('ssh-probe.js')

/** Minimal stand-in for sshd: accepts a connection and sends `greeting`. */
const fakeServer = async (greeting) => {
  const port = await freePort()
  const server = net.createServer((socket) => {
    if (greeting !== null) {
      socket.write(greeting)
    }
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

test('a real SSH identification string is recognised', async (t) => {
  const server = await fakeServer('SSH-2.0-OpenSSH_9.6p1 Debian-3\r\n')
  t.after(() => server.close())

  const probe = await probeSshServer('127.0.0.1', server.port, 2000)
  assert.equal(probe.reachable, true)
  assert.equal(probe.banner, 'SSH-2.0-OpenSSH_9.6p1 Debian-3')
  assert.equal(probe.error, null)
  assert.equal(probe.port, server.port)
  assert.equal(sshHelpText(probe), '')
})

test('a listener that is not an SSH server is not accepted', async (t) => {
  // A plain connect is not proof of anything — plenty of things can be
  // listening on a port, and reporting them as a working SSH server would send
  // the user looking in the wrong place.
  const server = await fakeServer('HTTP/1.1 400 Bad Request\r\n')
  t.after(() => server.close())

  const probe = await probeSshServer('127.0.0.1', server.port, 2000)
  assert.equal(probe.reachable, false)
  assert.equal(probe.banner, null)
  assert.match(probe.error, /not an SSH server/)
})

test('a silent listener is reported rather than hanging', async (t) => {
  const server = await fakeServer(null)
  t.after(() => server.close())

  const probe = await probeSshServer('127.0.0.1', server.port, 300)
  assert.equal(probe.reachable, false)
  assert.match(probe.error, /did not identify itself/)
})

test('a closed port is reported as a refused connection', async () => {
  const port = await freePort()
  const probe = await probeSshServer('127.0.0.1', port, 2000)
  assert.equal(probe.reachable, false)
  assert.equal(probe.code, 'ECONNREFUSED')
})

test('the probe never rejects, whatever the host', async () => {
  const probe = await probeSshServer('no-such-host.invalid', 22, 2000)
  assert.equal(probe.reachable, false)
  assert.equal(typeof probe.error, 'string')
})

test('isLocalHost recognises the usual spellings of this machine', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '::1',
    '0.0.0.0'
  ]) {
    assert.equal(isLocalHost(host), true, host)
  }
  assert.equal(isLocalHost('nav.local'), false)
  assert.equal(isLocalHost('192.168.1.20'), false)
})

test('a refused local connection produces install instructions', () => {
  const help = sshHelpText({
    reachable: false,
    host: 'localhost',
    port: 22,
    banner: null,
    error: 'connect ECONNREFUSED 127.0.0.1:22',
    code: 'ECONNREFUSED'
  })
  assert.match(help, /no SSH server is running on this machine/)
  assert.match(help, /apt install -y openssh-server/)
  assert.match(help, /systemctl enable --now ssh/)
  assert.match(help, /raspi-config/)
  assert.match(help, /Venus OS/)
  assert.match(help, /Remote Login/)
  assert.match(help, /OpenSSH Server/)
  assert.match(help, /every session will fail/)
})

test('a remote host gets connectivity advice, not install instructions', () => {
  // Telling somebody to apt-get install on the Signal K box is useless when
  // the SSH server they configured lives somewhere else entirely.
  const help = sshHelpText({
    reachable: false,
    host: 'nav.local',
    port: 22,
    banner: null,
    error: 'connect ECONNREFUSED',
    code: 'ECONNREFUSED'
  })
  assert.match(help, /nav\.local/)
  assert.match(help, /firewall/)
  assert.equal(/apt install/.test(help), false)
})

test('each failure code gets its own explanation', () => {
  const build = (code) =>
    sshHelpText({
      reachable: false,
      host: 'localhost',
      port: 22,
      banner: null,
      error: 'boom',
      code
    })
  assert.match(build('ENOTFOUND'), /could not be resolved/)
  assert.match(build('ETIMEDOUT'), /firewall/)
  assert.match(build('EHOSTUNREACH'), /firewall/)
  assert.match(build('EACCES'), /could not be used for SSH/)
})

test('a reachable server produces no help text', () => {
  assert.equal(
    sshHelpText({
      reachable: true,
      host: 'localhost',
      port: 22,
      banner: 'SSH-2.0-OpenSSH_9.6p1',
      error: null,
      code: null
    }),
    ''
  )
})
