'use strict'

const path = require('node:path')
const net = require('node:net')

const DIST = path.resolve(__dirname, '..', '..', 'dist')

const load = (name) => require(path.join(DIST, name))

/** Records everything the plugin reports back to the server. */
const createMockApp = () => {
  const calls = { debug: [], error: [], status: [], pluginError: [] }
  return {
    calls,
    debug: (msg) => calls.debug.push(msg),
    error: (msg) => calls.error.push(msg),
    setPluginStatus: (msg) => calls.status.push(msg),
    setPluginError: (msg) => calls.pluginError.push(msg),
    lastStatus: () => calls.status[calls.status.length - 1],
    lastError: () => calls.pluginError[calls.pluginError.length - 1]
  }
}

/**
 * Stand-in for the `wetty` package. Records the arguments WeTTY would have
 * been started with so the option mapping can be asserted without binding a
 * port or compiling a native module.
 */
const createFakeWetty = ({ failWith } = {}) => {
  const state = { starts: [], closes: 0, transports: [{ level: 'http' }] }
  return {
    state,
    module: {
      start: async (ssh, server, command, forcessh, ssl) => {
        state.starts.push({ ssh, server, command, forcessh, ssl })
        if (failWith) {
          throw failWith
        }
        return {
          close: (cb) => {
            state.closes += 1
            if (cb) {
              cb()
            }
          }
        }
      },
      getLogger: () => ({ transports: state.transports })
    }
  }
}

/** Collects the routes the plugin registers and lets tests invoke them. */
const createMockRouter = () => {
  const handlers = new Map()
  const router = {
    get: (routePath, handler) => handlers.set(`GET ${routePath}`, handler),
    post: (routePath, handler) => handlers.set(`POST ${routePath}`, handler),
    use: (routePath, handler) => handlers.set(`USE ${routePath}`, handler)
  }
  const call = (key, req = {}) =>
    new Promise((resolve, reject) => {
      const handler = handlers.get(key)
      if (!handler) {
        reject(new Error(`no handler registered for ${key}`))
        return
      }
      let statusCode = 200
      const res = {
        status(code) {
          statusCode = code
          return res
        },
        json(body) {
          resolve({ statusCode, body })
          return res
        }
      }
      try {
        handler(req, res)
      } catch (err) {
        reject(err)
      }
    })
  return { router, handlers, call }
}

const nativeAvailable = () => load('native.js').probeNodePty().available

/** Asks the OS for a port nobody else is using, for the live-server tests. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

module.exports = {
  DIST,
  load,
  createMockApp,
  createFakeWetty,
  createMockRouter,
  nativeAvailable,
  freePort
}
