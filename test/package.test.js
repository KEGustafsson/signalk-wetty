'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * Local mirror of the checks the Signal K reusable plugin-ci workflow runs, so
 * a packaging mistake fails in `npm test` instead of three minutes into CI.
 * See SignalK/signalk-server/.github/workflows/plugin-ci.yml.
 */

const ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

test('the package is discoverable as a Signal K plugin and webapp', () => {
  assert.ok(pkg.keywords.includes('signalk-node-server-plugin'))
  assert.ok(pkg.keywords.includes('signalk-webapp'))
  assert.equal(pkg['signalk-plugin-enabled-by-default'], false)
})

test('version, main and engines are set the way the app store expects', () => {
  assert.match(pkg.version, SEMVER)
  assert.ok(pkg.main, 'main is required')
  assert.ok(pkg.engines && pkg.engines.node, 'engines.node is required')
})

test('the built entry point exists and exports a factory', () => {
  const entry = path.join(ROOT, pkg.main)
  assert.ok(fs.existsSync(entry), `${pkg.main} is missing — run npm run build`)
  assert.equal(typeof require(entry), 'function')
})

test('there are no install-time scripts, which the app store would skip', () => {
  for (const script of ['preinstall', 'install', 'postinstall']) {
    assert.equal(
      pkg.scripts[script],
      undefined,
      `${script} would never run under npm install --ignore-scripts`
    )
  }
})

test('wetty is optional so an app store install is never left broken', () => {
  // node-pty ships no Linux prebuild and the app store installs with
  // --ignore-scripts, so wetty must not be a hard dependency: npm would fail
  // the install outright and the plugin could not report the problem.
  assert.equal(pkg.dependencies, undefined)
  assert.ok(pkg.optionalDependencies.wetty)
})

test('the app store icon is WeTTYs own', () => {
  // Copied from the wetty package rather than drawn here, so the entry is
  // recognisable as WeTTY in the app store and the admin UI webapp list.
  assert.equal(pkg.signalk.appIcon, './public/wetty-icon.svg')
  const icon = fs.readFileSync(path.join(ROOT, 'public/wetty-icon.svg'), 'utf8')
  assert.match(icon, /butlerx\/wetty/, 'the icon must keep its attribution')
  assert.match(icon, /MIT/)
  assert.match(icon, /<svg[^>]*viewBox="0 0 512 512"/)
})

test('declared app store assets exist on disk', () => {
  const declared = [
    pkg.signalk.appIcon,
    ...(pkg.signalk.screenshots || [])
  ].filter(Boolean)
  assert.ok(declared.length > 1, 'expected an icon and at least one screenshot')
  for (const asset of declared) {
    const rel = asset.replace(/^\.?\//, '')
    assert.ok(
      fs.statSync(path.join(ROOT, rel)).isFile(),
      `${asset} is declared in package.json but is not a file`
    )
  }
})

test('published files cover the entry point and the webapp', () => {
  assert.ok(pkg.files.some((f) => f.replace(/\/$/, '') === 'dist'))
  assert.ok(pkg.files.some((f) => f.replace(/\/$/, '') === 'public'))
})

test('release notes are published in one of the forms the app store reads', () => {
  const hasChangelog = fs.existsSync(path.join(ROOT, 'CHANGELOG.md'))
  const hasReleaseYml = fs.existsSync(path.join(ROOT, '.github', 'release.yml'))
  assert.ok(hasChangelog || hasReleaseYml)
})

test('no source file hardcodes a home directory path', () => {
  const offenders = []
  const hardcoded = /["'`]\/home\/[a-zA-Z][a-zA-Z0-9_-]*\//
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(js|ts|mjs|cjs|sh)$/.test(entry.name)) {
        if (hardcoded.test(fs.readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(ROOT, full))
        }
      }
    }
  }
  walk(ROOT)
  assert.deepEqual(offenders, [])
})

test('no source file reaches into server internals', () => {
  // app.server, app.deltaCache and friends are errors in the Signal K plugin
  // CI: they are not part of the plugin API.
  const internals = /\bapp\.(server|deltaCache|pluginsMap|securityStrategy)\b/
  const offenders = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (/\.(js|ts|mjs|cjs)$/.test(entry.name)) {
        const code = fs
          .readFileSync(full, 'utf8')
          .split('\n')
          .filter(
            (line) =>
              !line.trim().startsWith('*') && !line.trim().startsWith('//')
          )
          .join('\n')
        if (internals.test(code)) {
          offenders.push(path.relative(ROOT, full))
        }
      }
    }
  }
  walk(path.join(ROOT, 'src'))
  walk(path.join(ROOT, 'test'))
  assert.deepEqual(offenders, [])
})
