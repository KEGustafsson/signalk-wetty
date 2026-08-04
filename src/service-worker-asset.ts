import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import { resolutionPaths } from './native'

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
 * Serving the same file from the proxy avoids the rule entirely — WeTTY
 * never sees the request, so nothing gets the chance to reject it — and
 * leaves the service worker actually working rather than merely quiet.
 */
export const wettyServiceWorkerFile = (
  resolveEntry: () => string = () =>
    require.resolve('wetty', { paths: resolutionPaths() }),
  exists: (file: string) => boolean = fs.existsSync
): string | undefined => {
  let entry: string
  try {
    entry = resolveEntry()
  } catch {
    // wetty is an optional dependency; a missing one is reported elsewhere.
    return undefined
  }
  // wetty's own assetsPath() resolves against `<package>/build`, which is
  // also where its entry point lives — both spellings are tried so a
  // repackaged layout still finds the file.
  const buildDir = path.dirname(entry)
  const candidates = [
    path.join(buildDir, 'sw.js'),
    path.join(buildDir, '..', 'build', 'sw.js')
  ]
  return candidates.find((candidate) => exists(candidate))
}

/** The request path with any query string removed. */
const pathnameOf = (url: string | undefined): string =>
  (url ?? '').split(/[?#]/)[0]

export interface ServiceWorkerHandler {
  /** Whether the file was found — false leaves every request to the proxy. */
  available: boolean
  /**
   * Returns true when it has taken over the response, false when the request
   * is not for the service worker and should go on to WeTTY as usual.
   */
  handle: (req: IncomingMessage, res: ServerResponse) => boolean
}

/**
 * Reads the file once, at proxy-creation time: it is about a kilobyte, WeTTY
 * is already running by then, and a cached buffer keeps the request path free
 * of I/O that could fail halfway through a response.
 */
export const createServiceWorkerHandler = (
  onError: (msg: string) => void,
  locate: () => string | undefined = wettyServiceWorkerFile,
  read: (file: string) => Buffer = fs.readFileSync
): ServiceWorkerHandler => {
  let body: Buffer | undefined
  const file = locate()
  if (file) {
    try {
      body = read(file)
    } catch (err) {
      onError(
        `Could not read WeTTY's service worker: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  } else {
    onError(
      "Could not locate WeTTY's service worker — it will 404, which is harmless"
    )
  }

  const payload = body
  return {
    available: payload !== undefined,
    handle: (req, res) => {
      if (!payload) {
        return false
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return false
      }
      if (pathnameOf(req.url) !== SERVICE_WORKER_PATH) {
        return false
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.setHeader('Content-Length', String(payload.length))
      // A service worker that outlives the plugin version it shipped with is
      // worse than one re-fetched on every load, and it is a kilobyte.
      res.setHeader('Cache-Control', 'no-cache')
      // The registration's scope is the directory the script is served from,
      // so no Service-Worker-Allowed header is needed to widen it.
      res.end(req.method === 'HEAD' ? undefined : payload)
      return true
    }
  }
}
