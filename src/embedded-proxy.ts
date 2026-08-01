import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { Socket } from 'node:net'

import { createProxyMiddleware } from 'http-proxy-middleware'
import type { RequestHandler } from 'http-proxy-middleware'

export type { RequestHandler }

export interface EmbeddedProxyTarget {
  /** Internal port WeTTY is actually listening on. Always reached over loopback. */
  port: number
}

export interface EmbeddedProxy {
  /**
   * Mounted at the plugin's router (e.g. `router.use('/terminal', middleware)`).
   * The router itself is already mounted by Signal K at `/plugins/<id>`, and
   * Express strips both mount prefixes before this ever sees a request, so
   * paths reaching WeTTY are already relative to its own root.
   */
  middleware: RequestHandler
  /**
   * Wired to Signal K's own HTTP server `'upgrade'` event. Raw upgrade
   * events bypass Express entirely, so the full mount path is matched and
   * stripped by hand here rather than relying on router-level stripping.
   */
  handleUpgrade: (req: IncomingMessage, socket: Socket, head: Buffer) => void
}

/**
 * Matches a raw upgrade request's URL against the plugin's full mount path
 * and, when it matches, strips that prefix — mirroring what Express's own
 * router-path stripping does for regular HTTP requests, which raw
 * `'upgrade'` events bypass entirely. `pathRewrite` (configured once, below)
 * re-adds WeTTY's own base path afterwards, exactly as it does for the HTTP
 * case, so the prefix is only ever added once.
 */
export const resolveUpgradeUrl = (
  requestUrl: string | undefined,
  fullMountPath: string
): string | null => {
  if (!requestUrl?.startsWith(fullMountPath)) {
    return null
  }
  return requestUrl.slice(fullMountPath.length) || '/'
}

/**
 * Reverse-proxies WeTTY — which keeps listening on its own loopback-only
 * port exactly as before — through Signal K's own origin, so the terminal is
 * genuinely embedded rather than just framed from a separate server on a
 * separate port. This is the same technique
 * github.com/KEGustafsson/signalk-embedded-webapp-proxy uses for arbitrary
 * web apps: `app.server` (the server's real `http.Server`) is exposed to
 * plugins specifically so WebSocket upgrades — which Express middleware
 * alone cannot intercept — can be forwarded too.
 */
export const createEmbeddedProxy = (
  target: EmbeddedProxyTarget,
  fullMountPath: string,
  onError: (msg: string) => void
): EmbeddedProxy => {
  const proxy = createProxyMiddleware({
    target: `http://127.0.0.1:${target.port}`,
    changeOrigin: true,
    // Upgrades are dispatched by hand in handleUpgrade, scoped to
    // fullMountPath, rather than auto-intercepted for every upgrade the
    // server's HTTP listener ever sees.
    ws: false,
    // Express strips fullMountPath before this middleware (and
    // resolveUpgradeUrl, by hand, for raw upgrades) ever sees a request; it
    // is added back here because WeTTY's own basePath is set to that exact
    // path (see toWettyConfig in wetty-runner.ts), so WeTTY's self-generated
    // asset and socket.io links are already correct for reaching it through
    // this proxy — nothing has to rewrite WeTTY's own HTML or JS.
    //
    // The root case is special: WeTTY's own page route is registered at
    // exactly fullMountPath, no trailing slash. Appending a bare "/" would
    // produce fullMountPath + "/", which WeTTY's own redirect middleware
    // 301s back down to fullMountPath — and stripping/re-adding the mount
    // prefix on that redirected request reproduces the same "/", looping
    // forever.
    pathRewrite: (path) =>
      path === '/' ? fullMountPath : `${fullMountPath}${path}`,
    on: {
      // http-proxy-middleware does not respond to the client on its own once
      // a custom error handler is set — leaving one out here would hang
      // every failed request until the browser's own timeout gives up.
      error: (err, _req, res) => {
        onError(`Embedded terminal proxy error: ${err.message}`)
        if (res instanceof Socket) {
          res.destroy()
          return
        }
        const serverRes = res as ServerResponse
        if (serverRes.headersSent) {
          serverRes.end()
          return
        }
        serverRes.writeHead(502, { 'Content-Type': 'application/json' })
        serverRes.end(JSON.stringify({ error: 'Terminal is not reachable' }))
      }
    }
  })

  return {
    middleware: proxy,
    handleUpgrade: (req, socket, head) => {
      const resolved = resolveUpgradeUrl(req.url, fullMountPath)
      if (resolved === null) {
        return
      }
      req.url = resolved
      proxy.upgrade(req, socket, head)
    }
  }
}

/**
 * Installs the upgrade forwarder on Signal K's own HTTP server. A no-op,
 * removable installation when `server` is unavailable — an older Signal K
 * server that does not expose `app.server` — so the rest of the terminal
 * (HTTP requests, including the initial page load) still works; only
 * WebSocket sessions would fail, with the failure visible as a stuck
 * connection rather than a plugin crash.
 */
export const installUpgradeForwarding = (
  server: Server | undefined,
  handleUpgrade: EmbeddedProxy['handleUpgrade']
): (() => void) => {
  if (!server) {
    return () => {}
  }
  server.on('upgrade', handleUpgrade)
  return () => {
    server.removeListener('upgrade', handleUpgrade)
  }
}
