'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { load } = require('./helpers/harness')

const {
  DEFAULTS,
  LOG_LEVELS,
  PLUGIN_SCHEMA,
  PLUGIN_UI_SCHEMA,
  effectiveMode,
  normalizeBasePath,
  resolveOptions,
  resolveSsl
} = load('config.js')

test('resolveOptions fills in every default for an empty config', () => {
  // The server calls start({}) on a freshly enabled plugin, and the plugin CI
  // asserts that path does not throw.
  assert.deepEqual(resolveOptions({}), DEFAULTS)
  assert.deepEqual(resolveOptions(undefined), DEFAULTS)
  assert.deepEqual(resolveOptions(null), DEFAULTS)
  assert.deepEqual(resolveOptions('nonsense'), DEFAULTS)
  assert.deepEqual(resolveOptions([1, 2, 3]), DEFAULTS)
})

test('the default terminal port does not collide with the Signal K server', () => {
  assert.notEqual(DEFAULTS.port, 3000)
})

test('ports are coerced and out-of-range values fall back to the default', () => {
  assert.equal(resolveOptions({ port: '8080' }).port, 8080)
  assert.equal(resolveOptions({ port: 0 }).port, DEFAULTS.port)
  assert.equal(resolveOptions({ port: 70000 }).port, DEFAULTS.port)
  assert.equal(resolveOptions({ port: 3001.5 }).port, DEFAULTS.port)
  assert.equal(resolveOptions({ port: 'abc' }).port, DEFAULTS.port)
  assert.equal(resolveOptions({ ssh: { port: '2222' } }).ssh.port, 2222)
})

test('blank strings fall back to defaults but a blank password stays blank', () => {
  assert.equal(resolveOptions({ host: '   ' }).host, DEFAULTS.host)
  assert.equal(resolveOptions({ title: '' }).title, DEFAULTS.title)
  assert.equal(resolveOptions({ host: ' 127.0.0.1 ' }).host, '127.0.0.1')
  assert.equal(resolveOptions({ ssh: { password: '' } }).ssh.password, '')
  assert.equal(
    resolveOptions({ ssh: { password: 'hunter2' } }).ssh.password,
    'hunter2'
  )
})

test('normalizeBasePath produces a leading slash and no trailing slash', () => {
  assert.equal(normalizeBasePath(''), '/')
  assert.equal(normalizeBasePath('/'), '/')
  assert.equal(normalizeBasePath('///'), '/')
  assert.equal(normalizeBasePath('wetty'), '/wetty')
  assert.equal(normalizeBasePath('/wetty/'), '/wetty')
  assert.equal(normalizeBasePath('/wetty///'), '/wetty')
  assert.equal(normalizeBasePath('/a/b/'), '/a/b')
  assert.equal(normalizeBasePath(42), '/')
})

test('unknown enum values fall back instead of reaching WeTTY', () => {
  assert.equal(resolveOptions({ mode: 'telnet' }).mode, DEFAULTS.mode)
  assert.equal(resolveOptions({ mode: 'local' }).mode, 'local')
  assert.equal(resolveOptions({ logLevel: 'loud' }).logLevel, DEFAULTS.logLevel)
  for (const level of LOG_LEVELS) {
    assert.equal(resolveOptions({ logLevel: level }).logLevel, level)
  }
})

test('booleans only accept real booleans', () => {
  assert.equal(resolveOptions({ allowIframe: false }).allowIframe, false)
  assert.equal(
    resolveOptions({ allowIframe: 'no' }).allowIframe,
    DEFAULTS.allowIframe
  )
  assert.equal(
    resolveOptions({ ssh: { allowRemoteHosts: true } }).ssh.allowRemoteHosts,
    true
  )
})

test('SSL is only passed on when both key and certificate are configured', () => {
  assert.equal(resolveSsl(resolveOptions({})), undefined)
  assert.equal(
    resolveSsl(resolveOptions({ ssl: { enabled: true, keyPath: '/k.pem' } })),
    undefined
  )
  assert.equal(
    resolveSsl(
      resolveOptions({
        ssl: { enabled: false, keyPath: '/k.pem', certPath: '/c.pem' }
      })
    ),
    undefined
  )
  assert.deepEqual(
    resolveSsl(
      resolveOptions({
        ssl: { enabled: true, keyPath: '/k.pem', certPath: '/c.pem' }
      })
    ),
    { key: '/k.pem', cert: '/c.pem' }
  )
})

test('local mode is only honoured when the server runs as root', () => {
  const local = resolveOptions({ mode: 'local' })
  assert.equal(effectiveMode(local, true), 'local')
  assert.equal(effectiveMode(local, false), 'ssh')

  const ssh = resolveOptions({ mode: 'ssh' })
  assert.equal(effectiveMode(ssh, true), 'ssh')
  assert.equal(effectiveMode(ssh, false), 'ssh')
})

test('the config schema survives the JSON round trip the server does', () => {
  // The server persists schema() output as JSON; anything non-serialisable is
  // silently dropped and the config UI renders wrong.
  const roundTripped = JSON.parse(JSON.stringify(PLUGIN_SCHEMA))
  assert.deepEqual(roundTripped, PLUGIN_SCHEMA)
  assert.deepEqual(
    JSON.parse(JSON.stringify(PLUGIN_UI_SCHEMA)),
    PLUGIN_UI_SCHEMA
  )
  assert.equal(PLUGIN_SCHEMA.type, 'object')
  assert.ok(PLUGIN_SCHEMA.properties)
})

test('every schema property has a matching resolved option', () => {
  const resolved = resolveOptions({})
  for (const key of Object.keys(PLUGIN_SCHEMA.properties)) {
    assert.ok(key in resolved, `schema property "${key}" is never resolved`)
  }
  for (const key of Object.keys(resolved)) {
    assert.ok(
      key in PLUGIN_SCHEMA.properties,
      `option "${key}" is missing from the schema`
    )
  }
})

test('nested schema objects cover their resolved options too', () => {
  const resolved = resolveOptions({})
  for (const group of ['ssh', 'ssl']) {
    const properties = PLUGIN_SCHEMA.properties[group].properties
    assert.deepEqual(
      Object.keys(properties).sort(),
      Object.keys(resolved[group]).sort(),
      `${group} schema and options disagree`
    )
  }
})

test('schema defaults match the resolved defaults', () => {
  const check = (schemaProps, defaults, prefix) => {
    for (const [key, spec] of Object.entries(schemaProps)) {
      if (spec.properties) {
        check(spec.properties, defaults[key], `${prefix}${key}.`)
        continue
      }
      assert.deepEqual(
        spec.default,
        defaults[key],
        `${prefix}${key} default drifted from the code default`
      )
    }
  }
  check(PLUGIN_SCHEMA.properties, DEFAULTS, '')
})
