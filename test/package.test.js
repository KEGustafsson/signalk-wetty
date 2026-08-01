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
  // Without this, the admin UI's Webapps list links straight to /signalk-wetty/
  // as a plain page navigation instead of rendering it inside the admin UI's
  // own layout at /admin/#/e/signalk-wetty — the difference between actually
  // being embedded and just being served from the same origin.
  assert.ok(pkg.keywords.includes('signalk-embeddable-webapp'))
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
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) {
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
  assert.ok(pkg.optionalDependencies.wetty)
  assert.equal(pkg.dependencies?.wetty, undefined)
})

test('hard dependencies are pure JS, never blocked by --ignore-scripts', () => {
  // Unlike wetty/node-pty, a hard dependency here must never need a native
  // compile step, or an --ignore-scripts app store install would break.
  for (const name of Object.keys(pkg.dependencies || {})) {
    assert.equal(
      fs.existsSync(path.join(ROOT, 'node_modules', name, 'binding.gyp')),
      false,
      `${name} looks like it needs a native build step`
    )
  }
})

test('the app store icon is a self-contained SVG', () => {
  // The app store serves the icon from a CDN, so it must not pull in a font,
  // a stylesheet or a remote image that would fail to load there.
  assert.equal(pkg.signalk.appIcon, './app-icon.svg')
  const icon = fs.readFileSync(
    path.join(ROOT, 'public', pkg.signalk.appIcon),
    'utf8'
  )
  assert.match(icon, /<svg[^>]*viewBox="0 0 128 128"/)
  // The xmlns declaration is a namespace name, not something the renderer
  // fetches, so only real references are checked here.
  assert.equal(/<image\b|@import|url\(\s*['"]?https?:/.test(icon), false)
  assert.equal(/(?:xlink:)?href\s*=\s*['"]https?:/.test(icon), false)
  // Pure shapes, no <text>: the icon has to stay readable at 16px in a browser
  // tab and on a compact app store card, where lettering turns to mush.
  assert.equal(/<text\b/.test(icon), false)
})

test('declared app store assets exist on disk', () => {
  // The admin UI resolves these two package.json fields against different
  // roots (confirmed against its own compiled source, not just inferred):
  // appIcon as `/${name}/${appIcon}`, i.e. relative to what is served at
  // /signalk-wetty/ — the public/ directory — while its own UI copy for
  // screenshots explicitly calls them "package-relative paths", i.e.
  // relative to the package root (which is why they still say
  // "./public/...”). Getting this asymmetry wrong is exactly what left the
  // webapp icon broken before this test caught it.
  assert.ok(
    fs.statSync(path.join(ROOT, 'public', pkg.signalk.appIcon)).isFile(),
    `${pkg.signalk.appIcon} (appIcon) is not a file under public/`
  )

  const screenshots = pkg.signalk.screenshots || []
  assert.ok(screenshots.length > 0, 'expected at least one screenshot')
  for (const asset of screenshots) {
    const rel = asset.replace(/^\.?\//, '')
    assert.ok(
      fs.statSync(path.join(ROOT, rel)).isFile(),
      `${asset} is declared in package.json but is not a file`
    )
  }
})

test('published files cover the entry point and the webapp', () => {
  assert.ok(pkg.files.some((f) => f.replace(/\/$/, '') === 'dist'))
  assert.ok(pkg.files.some((f) => f.replace(/\/$/, '') === 'native-prebuilds'))
  assert.ok(pkg.files.some((f) => f.replace(/\/$/, '') === 'public'))
})

test('the Module Federation bundle exposes AppPanel under the expected name', () => {
  // The admin UI derives both the <script> filename it looks for and the
  // global var that script must define from this exact transform of the
  // package name (see webpack.config.js) — get it wrong and the admin UI
  // reports "Module ... is not available" instead of loading the panel.
  const entry = path.join(ROOT, 'public/remoteEntry.js')
  assert.ok(
    fs.existsSync(entry),
    'public/remoteEntry.js is missing — run npm run build'
  )
  const federationName = pkg.name.replace(/[-@/]/g, '_')
  const code = fs.readFileSync(entry, 'utf8')
  assert.match(code, new RegExp(`\\bvar ${federationName}\\b`))
  assert.match(code, /\.\/AppPanel/)
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
  // app.deltaCache, app.pluginsMap and friends are errors in the Signal K
  // plugin CI: they are not part of the documented plugin API.
  //
  // app.server is a deliberate exception: it is not in @signalk/server-api
  // either, but it is the only way to forward WebSocket upgrades through the
  // server's own origin rather than running the terminal on a separate,
  // unauthenticated port — the same technique
  // github.com/KEGustafsson/signalk-embedded-webapp-proxy uses.
  // installUpgradeForwarding() (src/embedded-proxy.ts) explicitly checks for
  // an undefined server, so an older server that does not expose it degrades
  // to "the page loads, WebSocket sessions do not connect" rather than
  // breaking. This plugin is not published to the official app store, so
  // failing its app.server lint is an accepted trade-off, not an oversight.
  const internals = /\bapp\.(deltaCache|pluginsMap|securityStrategy)\b/
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
