import type { IncomingMessage, ServerResponse } from 'node:http'

/** Where WeTTY's client bundle registers its service worker, mount-relative. */
export const SERVICE_WORKER_PATH = '/sw.js'

/**
 * WeTTY serves its service worker with
 * `res.sendFile(assetsPath('sw.js'))` — an absolute path and no `root`
 * option, which makes `send` split the whole filesystem path into segments
 * and apply its dotfile rule to every one of them. Signal K always lives in
 * `~/.signalk`, so `.signalk` matches, `dotfiles` defaults to `'ignore'`,
 * and the request 404s with a `NotFoundError` in the server log even though
 * the file is right there. Every Signal K install hits this; only browsers
 * in a secure context ever ask for the file, so it looks intermittent.
 *
 * What gets served in its place is deliberately *not* WeTTY's own worker.
 * That worker has never actually run on a Signal K install — the 404 meant
 * it was never installed — so serving it would switch on caching behaviour
 * nobody here has ever run, in front of the terminal's own socket.io
 * traffic, to buy an offline cache of a page that is useless without the
 * server it talks to. This one registers, unregisters itself, drops any
 * cache a previous version left behind, and installs no `fetch` handler at
 * all, so nothing on the terminal's path is ever intercepted. The request
 * gets its 200, the log stays clean, and any worker already installed in a
 * browser is cleaned up on its next visit.
 */
const UNREGISTERING_SERVICE_WORKER = `// Served by signalk-wetty in place of WeTTY's own service worker.
// It exists to answer the request WeTTY itself cannot serve from ~/.signalk,
// and to remove any worker an earlier version registered. It installs no
// fetch handler, so it never intercepts terminal traffic.
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
      await self.registration.unregister()
    })(),
  )
})
`

const BODY = Buffer.from(UNREGISTERING_SERVICE_WORKER, 'utf8')

/** The request path with any query string removed. */
const pathnameOf = (url: string | undefined): string =>
  (url ?? '').split(/[?#]/)[0]

export interface ServiceWorkerHandler {
  /**
   * Returns true when it has taken over the response, false when the request
   * is not for the service worker and should go on to WeTTY as usual.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => boolean
}

export const createServiceWorkerHandler = (): ServiceWorkerHandler => ({
  handle: (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false
    }
    if (pathnameOf(req.url) !== SERVICE_WORKER_PATH) {
      return false
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
    res.setHeader('Content-Length', String(BODY.length))
    // Must not be cached: a browser holding the old worker would keep it.
    res.setHeader('Cache-Control', 'no-store')
    // The registration's scope is the directory the script is served from,
    // so no Service-Worker-Allowed header is needed to widen it.
    res.end(req.method === 'HEAD' ? undefined : BODY)
    return true
  }
})
