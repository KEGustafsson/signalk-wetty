'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { load } = require('./helpers/harness')

const {
  nativeHelpText,
  bundledNodePtyPrebuildPath,
  installBundledNodePtyPrebuild,
  nodePtyPrebuildTargetPath,
  nodePtyRebuildCommand,
  probeNodePty,
  rebuildNodePty,
  verifyNodePtyCommand
} = load('native.js')

test('probeNodePty returns a structured result and never throws', () => {
  const probe = probeNodePty()
  assert.equal(typeof probe.available, 'boolean')
  if (probe.available) {
    assert.equal(probe.error, undefined)
    assert.equal(path.basename(probe.packageDir), 'node-pty')
    assert.equal(path.basename(path.dirname(probe.packageDir)), 'node_modules')
    assert.equal(probe.projectDir, path.dirname(path.dirname(probe.packageDir)))
  } else {
    assert.equal(typeof probe.error, 'string')
  }
})

test('the probe result is stable across calls', () => {
  assert.equal(probeNodePty().available, probeNodePty().available)
})

test('nativeHelpText is empty when there is nothing to fix', () => {
  assert.equal(nativeHelpText({ available: true }), '')
})

test('nativeHelpText explains the app store limitation and the fix', () => {
  const help = nativeHelpText({
    available: false,
    projectDir: '/srv/signalk',
    error: 'missing'
  })
  assert.match(help, /--ignore-scripts/)
  assert.match(help, /npm rebuild node-pty --foreground-scripts/)
  assert.match(help, /\/srv\/signalk/)
  assert.match(help, /build-essential/)
})

test('the rebuild command avoids npm configs rejected by npm 11', () => {
  const command = nodePtyRebuildCommand()
  assert.deepEqual(command.args, [
    'rebuild',
    'node-pty',
    '--foreground-scripts'
  ])
  assert.equal(command.args.includes('--build-from-source'), false)
  assert.equal('env' in command, false)
})

test('linux node-pty prebuild paths match the package layout', () => {
  assert.equal(bundledNodePtyPrebuildPath('darwin', 'arm64'), null)
  assert.equal(
    nodePtyPrebuildTargetPath('/pkg/node-pty', 'linux', 'arm'),
    path.join('/pkg/node-pty', 'prebuilds', 'linux-arm', 'pty.node')
  )
  assert.match(
    bundledNodePtyPrebuildPath('linux', 'arm64'),
    /native-prebuilds[\\/]linux-arm64[\\/]pty\.node$/
  )
  assert.equal(
    nodePtyPrebuildTargetPath('/pkg/node-pty', 'linux', 'x64'),
    path.join('/pkg/node-pty', 'prebuilds', 'linux-x64', 'pty.node')
  )
})

test('a bundled prebuild is copied into node-ptys expected directory', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wetty-prebuild-'))
  const prebuildRoot = path.join(temp, 'native-prebuilds')
  const bundled = bundledNodePtyPrebuildPath('linux', 'arm64', prebuildRoot)
  try {
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, 'native-binary-placeholder')

    const packageDir = path.join(temp, 'node-pty')
    const installed = installBundledNodePtyPrebuild(
      packageDir,
      'linux',
      'arm64',
      prebuildRoot
    )
    assert.equal(
      installed,
      path.join(packageDir, 'prebuilds', 'linux-arm64', 'pty.node')
    )
    assert.equal(
      fs.readFileSync(installed, 'utf8'),
      'native-binary-placeholder'
    )
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('an already-correct prebuild is left completely untouched', () => {
  // The plugin installs the prebuild on every start(), and by the second one
  // node-pty is loaded with this exact file mapped into the server's address
  // space. Rewriting it in place pulls those pages out from under the running
  // process and the next pty spawn takes the whole server down with SIGSEGV,
  // so the second install must not write at all.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wetty-prebuild-'))
  const prebuildRoot = path.join(temp, 'native-prebuilds')
  const bundled = bundledNodePtyPrebuildPath('linux', 'arm64', prebuildRoot)
  try {
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, 'native-binary-placeholder')
    const packageDir = path.join(temp, 'node-pty')

    const installed = installBundledNodePtyPrebuild(
      packageDir,
      'linux',
      'arm64',
      prebuildRoot
    )
    // Dated deliberately into the past rather than compared against a
    // freshly-recorded mtime: both installs can land inside one filesystem
    // timestamp tick, which would let a rewrite pass unnoticed.
    const marked = new Date(Date.now() - 60_000)
    fs.utimesSync(installed, marked, marked)
    const before = fs.statSync(installed)

    const again = installBundledNodePtyPrebuild(
      packageDir,
      'linux',
      'arm64',
      prebuildRoot
    )
    const after = fs.statSync(again)

    assert.equal(again, installed)
    assert.equal(
      after.mtimeMs,
      before.mtimeMs,
      'the file must be neither rewritten nor replaced'
    )
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

test('a genuinely stale prebuild is replaced, leaving nothing behind', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wetty-prebuild-'))
  const prebuildRoot = path.join(temp, 'native-prebuilds')
  const bundled = bundledNodePtyPrebuildPath('linux', 'arm64', prebuildRoot)
  try {
    fs.mkdirSync(path.dirname(bundled), { recursive: true })
    fs.writeFileSync(bundled, 'new-native-binary')

    const packageDir = path.join(temp, 'node-pty')
    const target = path.join(packageDir, 'prebuilds', 'linux-arm64', 'pty.node')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, 'stale-binary-of-a-different-size')

    const installed = installBundledNodePtyPrebuild(
      packageDir,
      'linux',
      'arm64',
      prebuildRoot
    )

    assert.equal(installed, target)
    assert.equal(fs.readFileSync(installed, 'utf8'), 'new-native-binary')
    // The staging file must not survive in the directory node-pty scans.
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['pty.node'])
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
})

// Windows refuses to rename over a file that anything holds open, and its
// stat().ino carries no such guarantee — but bundledNodePtyPrebuildPath()
// returns null off Linux, so this path never runs there in the first place.
test(
  'replacing a stale prebuild leaves an already-open handle intact',
  { skip: process.platform === 'win32' ? 'POSIX rename semantics' : false },
  () => {
    // The whole point of renaming rather than copying: an inode another
    // process already mapped must keep the bytes it was loaded with.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wetty-prebuild-'))
    const prebuildRoot = path.join(temp, 'native-prebuilds')
    const bundled = bundledNodePtyPrebuildPath('linux', 'arm64', prebuildRoot)
    let heldOpen
    try {
      fs.mkdirSync(path.dirname(bundled), { recursive: true })
      fs.writeFileSync(bundled, 'new-native-binary')

      const packageDir = path.join(temp, 'node-pty')
      const target = path.join(
        packageDir,
        'prebuilds',
        'linux-arm64',
        'pty.node'
      )
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, 'stale-binary-of-a-different-size')
      const staleIno = fs.statSync(target).ino
      // Stands in for the mapping a running process would be holding.
      heldOpen = fs.openSync(target, 'r')

      const installed = installBundledNodePtyPrebuild(
        packageDir,
        'linux',
        'arm64',
        prebuildRoot
      )

      assert.notEqual(
        fs.statSync(installed).ino,
        staleIno,
        'a replacement must be a new inode, not the old one overwritten'
      )
      const held = Buffer.alloc(32)
      const read = fs.readSync(heldOpen, held, 0, 32, 0)
      assert.equal(
        held.subarray(0, read).toString('utf8'),
        'stale-binary-of-a-different-size',
        'an already-open handle must still see the bytes it was loaded with'
      )
    } finally {
      // Closed here rather than after the assertions: a failure above would
      // otherwise leak the handle and make the cleanup below fail too.
      if (heldOpen !== undefined) {
        fs.closeSync(heldOpen)
      }
      fs.rmSync(temp, { recursive: true, force: true })
    }
  }
)

test('the rebuild result is verified by loading node-pty afterwards', () => {
  const command = verifyNodePtyCommand('/srv/signalk', 1234)
  assert.equal(command.command, process.execPath)
  assert.deepEqual(command.args, ['-e', "require('node-pty')"])
  assert.equal(command.cwd, '/srv/signalk')
  assert.equal(command.timeoutMs, 1234)
})

test('rebuilding without a located install fails cleanly rather than spawning npm', async () => {
  const result = await rebuildNodePty({ available: false })
  assert.equal(result.ok, false)
  assert.match(result.output, /nothing to rebuild/)
})

test('a rebuild that cannot be started resolves instead of rejecting', async () => {
  // A non-existent cwd makes the spawn fail immediately, which stands in for
  // any environment where npm is not on PATH.
  // An explicit short timeout keeps the test bounded even on a platform where
  // the spawn unexpectedly succeeds; the default is ten minutes.
  const result = await rebuildNodePty(
    {
      available: false,
      projectDir: path.join(__dirname, 'no-such-directory-9f3a')
    },
    2000
  )
  assert.equal(result.ok, false)
  assert.equal(typeof result.output, 'string')
})

test('a rebuild always settles, timeout or not', async () => {
  // Runs in an empty temp directory so npm cannot touch this repo's
  // node_modules. Whether npm finishes first or the timeout kills it, the
  // promise must settle: if it did not, the request that started the rebuild
  // would hang until the client gave up, and this test would time out.
  const fs = require('node:fs')
  const os = require('node:os')
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wetty-rebuild-'))
  const started = Date.now()
  try {
    const result = await rebuildNodePty({ available: false, projectDir }, 250)
    assert.equal(typeof result.ok, 'boolean')
    assert.equal(typeof result.output, 'string')
    assert.ok(Date.now() - started < 60000, 'the rebuild should have settled')
  } finally {
    // Best effort. On Windows the kill reaches only the shell wrapper — the
    // very behaviour this test exists for — so npm can outlive it and keep the
    // directory locked. A stray directory under the OS temp root is not worth
    // failing a run over.
    try {
      fs.rmSync(projectDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200
      })
    } catch {
      // Left for the OS to reap.
    }
  }
})
