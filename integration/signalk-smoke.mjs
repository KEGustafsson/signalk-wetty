#!/usr/bin/env node
/**
 * End-to-end smoke test against a real Signal K server.
 *
 * Packs the plugin exactly the way npm would, installs it into a throwaway
 * signalk-server, enables it, boots the server and checks that:
 *
 *   1. the server loads the plugin,
 *   2. the plugin is published as a webapp in the admin UI,
 *   3. the plugin's status route answers,
 *   4. the WeTTY terminal really is listening on its own port.
 *
 * This is the same shape as the `enable-signalk-integration` job in the
 * Signal K reusable plugin CI, kept here so it can be run locally:
 *
 *   npm run integration
 *
 * Environment:
 *   SIGNALK_VERSION   signalk-server version to install (default: latest)
 *   SK_PORT           Signal K server port (default: 3200)
 *   WETTY_PORT        terminal port (default: 3201)
 *   KEEP_WORKDIR      set to 1 to keep the temporary install for inspection
 */

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pkg = require(path.join(ROOT, 'package.json'))

const SIGNALK_VERSION = process.env.SIGNALK_VERSION || 'latest'
const SK_PORT = Number(process.env.SK_PORT || 3200)
const WETTY_PORT = Number(process.env.WETTY_PORT || 3201)
const BOOT_TIMEOUT_MS = 120000

const log = (msg) => console.log(`\n→ ${msg}`)

const run = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    encoding: 'utf8',
    ...opts
  })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`)
  }
  return result
}

const capture = (cmd, args, opts = {}) => {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts
  })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`)
  }
  return result.stdout
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (label, check) => {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) {
        return value
      }
    } catch (err) {
      lastError = err
    }
    await sleep(1000)
  }
  throw new Error(`timed out waiting for ${label}: ${lastError ?? 'no result'}`)
}

const getJson = async (url) => {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`GET ${url} -> HTTP ${res.status}`)
  }
  return res.json()
}

const checks = []
const check = (name, condition, detail = '') => {
  checks.push({ name, ok: Boolean(condition), detail })
  console.log(
    `  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`
  )
}

let workdir
let server

try {
  log('Building and packing the plugin')
  run(npm, ['run', 'build'], { cwd: ROOT })
  const packJson = capture(
    npm,
    ['pack', '--ignore-scripts', '--json', '--pack-destination', os.tmpdir()],
    { cwd: ROOT }
  )
  const tarball = path.join(
    os.tmpdir(),
    JSON.parse(packJson.slice(packJson.search(/^\s*\[/m)))[0].filename
  )

  workdir = await mkdtemp(path.join(os.tmpdir(), 'signalk-wetty-it-'))
  log(`Installing signalk-server@${SIGNALK_VERSION} into ${workdir}`)
  run(npm, ['init', '-y'], { cwd: workdir, stdio: 'ignore' })
  run(npm, ['install', `signalk-server@${SIGNALK_VERSION}`], { cwd: workdir })

  log('Installing the packed plugin')
  // No --ignore-scripts here: this test exercises the working path, where
  // node-pty compiles. The app store's --ignore-scripts install is covered by
  // the plugin CI's "Simulate App Store install" step and by the plugin's own
  // native-module status reporting.
  run(npm, ['install', tarball], { cwd: workdir })

  log('Enabling the plugin')
  const pluginId = pkg.name.replace(/@/g, '_').replace(/\//g, '_')
  // WeTTY's own basePath is always this path (see wetty-runner.ts), whether
  // reached directly on its own port or through the Signal K-embedded proxy.
  const embeddedTerminalPath = `/plugins/${pluginId}/terminal`
  await mkdir(path.join(workdir, 'plugin-config-data'), { recursive: true })
  await writeFile(
    path.join(workdir, 'plugin-config-data', `${pluginId}.json`),
    JSON.stringify(
      {
        enabled: true,
        configuration: { port: WETTY_PORT, host: '127.0.0.1' }
      },
      null,
      2
    )
  )

  log(`Starting signalk-server on port ${SK_PORT}`)
  // PORT rather than a CLI flag: signalk-server resolves its listen port from
  // process.env.PORT (src/ports.ts) and ignores an unknown -p argument.
  server = spawn(
    npm,
    ['exec', '--', 'signalk-server', '--sample-nmea0183-data'],
    {
      cwd: workdir,
      env: {
        ...process.env,
        SIGNALK_NODE_CONFIG_DIR: workdir,
        PORT: String(SK_PORT)
      },
      stdio: ['ignore', 'inherit', 'inherit']
    }
  )
  server.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`signalk-server exited early with code ${code}`)
    }
  })

  const base = `http://127.0.0.1:${SK_PORT}`
  await waitFor('the Signal K server to answer', () =>
    getJson(`${base}/signalk`)
  )
  log('Server is up, running checks')

  const plugins = await waitFor('the plugin to be loaded', async () => {
    const list = await getJson(`${base}/skServer/plugins`)
    return list.some((p) => p.id === pluginId) ? list : null
  })
  const entry = plugins.find((p) => p.id === pluginId)
  check('the server loads the plugin', Boolean(entry), `id=${pluginId}`)
  check('the plugin is enabled', entry?.data?.enabled !== false)

  const webapps = await getJson(`${base}/skServer/webapps`)
  check(
    'the plugin is published as an admin UI webapp',
    webapps.some((w) => w.name === pkg.name)
  )

  const status = await waitFor('the plugin status route', () =>
    getJson(`${base}/plugins/${pluginId}/status`)
  )
  check(
    'the status route answers',
    status && typeof status.running === 'boolean'
  )
  check(
    'node-pty is compiled in this environment',
    status.native?.available,
    status.native?.error || ''
  )
  check(
    'the terminal reports itself as running',
    status.running,
    status.message
  )
  check(
    'the reported port matches the configuration',
    status.port === WETTY_PORT
  )

  if (status.running) {
    const page = await waitFor('the terminal page', async () => {
      const res = await fetch(
        `http://127.0.0.1:${WETTY_PORT}${embeddedTerminalPath}/`
      )
      return res.ok ? res.text() : null
    })
    check('the terminal serves its page', page.includes('id="terminal"'))

    const handshake = await fetch(
      `http://127.0.0.1:${WETTY_PORT}${embeddedTerminalPath}/socket.io/?EIO=4&transport=polling`
    )
    check(
      'the terminal answers a socket.io handshake',
      handshake.ok && (await handshake.text()).includes('"sid"')
    )

    // The actual embedding: reachable through Signal K's own port, not
    // WeTTY's, with no path-rewriting bugs (see the root-path redirect loop
    // this same check would have caught).
    const embeddedPage = await fetch(`${base}${embeddedTerminalPath}/`)
    check(
      'the terminal is reachable through the Signal K-embedded proxy',
      embeddedPage.ok && (await embeddedPage.text()).includes('id="terminal"')
    )
  }

  const webappPage = await fetch(`${base}/${pkg.name}/`)
  check('the webapp is served by the Signal K server', webappPage.ok)

  const remoteEntry = await fetch(`${base}/${pkg.name}/remoteEntry.js`)
  const remoteEntryBody = remoteEntry.ok ? await remoteEntry.text() : ''
  const federationName = pkg.name.replace(/[-@/]/g, '_')
  check(
    'the Module Federation bundle is served and exposes AppPanel',
    remoteEntry.ok &&
      remoteEntryBody.includes(`var ${federationName}`) &&
      remoteEntryBody.includes('./AppPanel')
  )
} finally {
  if (server && server.exitCode === null) {
    log('Stopping signalk-server')
    server.kill('SIGTERM')
    await sleep(2000)
    if (server.exitCode === null) {
      server.kill('SIGKILL')
    }
  }
  if (workdir && process.env.KEEP_WORKDIR !== '1') {
    await rm(workdir, { recursive: true, force: true })
  } else if (workdir) {
    console.log(`\nKept working directory: ${workdir}`)
  }
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
if (failed.length > 0) {
  console.error(`Failed: ${failed.map((c) => c.name).join(', ')}`)
  process.exitCode = 1
}
