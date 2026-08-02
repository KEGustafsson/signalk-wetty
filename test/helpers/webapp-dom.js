'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..', '..')
const HTML_PATH = path.join(ROOT, 'public', 'index.html')

/**
 * Stand-in for a DOM element. The webapp only ever creates nodes, assigns
 * plain properties onto them, appends or replaces children and registers click
 * handlers, so none of this needs a layout, CSS or event-propagation engine.
 */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName
    this.childNodes = []
    this.listeners = new Map()
  }

  append(...nodes) {
    this.childNodes.push(...nodes)
  }

  replaceChildren(...nodes) {
    this.childNodes = [...nodes]
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  /** Fires what a real click would, for the buttons the webapp attaches. */
  click() {
    const handlers = this.listeners.get('click') || []
    return Promise.all(handlers.map((handler) => handler()))
  }
}

/** Every node in the tree, the root included, in document order. */
const walk = (node) => {
  if (!(node instanceof FakeElement)) {
    return []
  }
  return [node, ...node.childNodes.flatMap(walk)]
}

const findAll = (node, tagName) =>
  walk(node).filter((candidate) => candidate.tagName === tagName)

const find = (node, tagName) => findAll(node, tagName)[0] || null

/** All text the tree would show, so assertions do not depend on its shape. */
const textOf = (node) => {
  if (typeof node === 'string') {
    return node
  }
  return walk(node)
    .map((candidate) => candidate.textContent || '')
    .join(' ')
}

/** The inline script from the webapp page, which is the whole client. */
const webappSource = () => {
  const html = fs.readFileSync(HTML_PATH, 'utf8')
  const match = html.match(/<script>([\s\S]*?)<\/script>/)
  if (!match) {
    throw new Error('public/index.html no longer contains an inline script')
  }
  return match[1]
}

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body
})

/**
 * Runs the webapp against a fake DOM and a stubbed server, so the rendering
 * can be asserted on the nodes it actually produces rather than on the text of
 * index.html. `routes` maps a path fragment to a handler returning a response;
 * `/status` is answered from `status` unless it is overridden.
 */
const loadWebapp = ({ status, routes = {} } = {}) => {
  const root = new FakeElement('div')
  const requests = []
  let pending = []

  const document = {
    getElementById: (id) => (id === 'root' ? root : null),
    createElement: (tagName) => new FakeElement(tagName)
  }

  const handlers = {
    '/status': () => jsonResponse(status),
    ...routes
  }

  const fetch = (url, options) => {
    requests.push({ url, options })
    const key = Object.keys(handlers).find((route) => url.includes(route))
    const promise = key
      ? Promise.resolve(handlers[key](url, options))
      : Promise.reject(new Error(`webapp requested an unstubbed route: ${url}`))
    pending.push(promise)
    return promise
  }

  // The page calls load() as it evaluates, so the boot render is the one under
  // test; settle() waits for it instead of re-running it from the test.
  const settle = async () => {
    for (let turn = 0; turn < 20 && pending.length > 0; turn += 1) {
      const inFlight = pending
      pending = []
      await Promise.allSettled(inFlight)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  const factory = new Function(
    'document',
    'fetch',
    `${webappSource()}
    return { renderTerminal, renderError, sshWarning, sshClientWarning, load }`
  )

  return { root, requests, settle, internals: factory(document, fetch) }
}

/** A status payload for a healthy, running terminal. */
const runningStatus = (overrides = {}) => ({
  running: true,
  error: null,
  message: null,
  requestedMode: 'ssh',
  effectiveMode: 'ssh',
  allowIframe: true,
  native: { available: true, help: '' },
  sshClient: { available: true, error: null, help: '' },
  ssh: { checked: true, reachable: true, error: null, help: '' },
  rebuild: { running: false, ok: true, output: '' },
  ...overrides
})

module.exports = {
  FakeElement,
  loadWebapp,
  runningStatus,
  find,
  findAll,
  textOf,
  jsonResponse
}
