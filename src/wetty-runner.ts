import type { LogLevel, ResolvedOptions } from './config'
import { EMBEDDED_TERMINAL_PATH, effectiveMode, resolveSsl } from './config'
import type { PatchableHttpServer } from './csp-patch'
import { installCspPatch } from './csp-patch'
import { installEnvVersionPatch } from './env-version-patch'
import { resolutionPaths } from './native'

/**
 * WeTTY 3.x is an ESM-only package, and this plugin is compiled to CommonJS so
 * it loads on every Signal K server version. TypeScript rewrites a literal
 * `import()` into `require()` under `module: commonjs`, which fails on an ESM
 * package, so the dynamic import is built through `Function` to survive
 * transpilation untouched.
 */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string
) => Promise<unknown>

interface WettySshConfig {
  user: string
  host: string
  auth: string
  pass: string
  key: string
  port: number
  knownHosts: string
  config: string
  allowRemoteHosts: boolean
  allowRemoteCommand: boolean
}

interface WettyServerConfig {
  base: string
  port: number
  host: string
  title: string
  allowIframe: boolean
  socket: false
}

/** The Node HTTP server underneath WeTTY's socket.io server. */
export interface HttpServerLike extends PatchableHttpServer {
  listening?: boolean
  close: (cb?: (err?: Error) => void) => void
  closeAllConnections?: () => void
  on?: (event: string, handler: (err: Error) => void) => void
  once?: (event: string, handler: (err?: Error) => void) => void
  removeListener?: (event: string, handler: (...args: never[]) => void) => void
}

/** The socket.io `Server` WeTTY hands back, narrowed to what we use. */
export interface WettyHandle {
  close: (cb?: () => void) => void
  httpServer?: HttpServerLike
}

/** A winston transport, narrowed to the two properties that silence it. */
export interface WettyLogTransport {
  level?: string
  silent?: boolean
}

export interface WettyModule {
  start: (
    ssh: WettySshConfig,
    server: WettyServerConfig,
    command: string,
    forcessh: boolean,
    ssl?: { key: string; cert: string }
  ) => Promise<WettyHandle>
  getLogger?: () => { transports?: WettyLogTransport[] } | undefined
}

export type WettyLoader = () => Promise<WettyModule>

export const defaultLoader: WettyLoader = async () =>
  (await dynamicImport('wetty')) as WettyModule

export const toWettyConfig = (
  options: ResolvedOptions
): { ssh: WettySshConfig; server: WettyServerConfig; forcessh: boolean } => ({
  ssh: {
    user: options.ssh.user,
    host: options.ssh.host,
    auth: options.ssh.auth,
    pass: options.ssh.password,
    key: options.ssh.keyPath,
    port: options.ssh.port,
    knownHosts: options.ssh.knownHosts,
    config: options.ssh.configFile,
    allowRemoteHosts: options.ssh.allowRemoteHosts,
    allowRemoteCommand: options.ssh.allowRemoteCommand
  },
  server: {
    // Always the embedded proxy's own mount path, never user-configurable:
    // WeTTY's self-generated asset/socket.io links are only correct when
    // this matches exactly where the browser actually reaches it through
    // the proxy. See src/embedded-proxy.ts.
    base: EMBEDDED_TERMINAL_PATH,
    port: options.port,
    host: options.host,
    title: options.title,
    allowIframe: options.allowIframe,
    socket: false
  },
  forcessh: effectiveMode(options) === 'ssh'
})

const isDuplicateMetricError = (err: unknown): boolean =>
  err instanceof Error && /has already been registered/i.test(err.message)

/**
 * WeTTY calls prom-client's `collectDefaultMetrics()` on every start, and
 * prom-client throws when the same metric name is registered twice. A plugin
 * restart therefore has to hand it a clean default registry, or the second
 * `start()` fails — which is exactly what the Signal K plugin CI checks for.
 */
const clearPrometheusRegistry = (): void => {
  try {
    const promClient = require(
      require.resolve('prom-client', { paths: resolutionPaths() })
    ) as {
      register?: { clear?: () => void }
    }
    promClient.register?.clear?.()
  } catch {
    // prom-client only exists as a transitive dependency of wetty; if wetty
    // is not installed there is no registry to clear.
  }
}

/**
 * WeTTY logs to a console transport it inherits from the Signal K server
 * process, so its output lands in the server log whether anybody wanted it
 * there or not. `silent` is not a winston level but a transport flag, so it is
 * applied as one — leaving the level alone, which keeps the transport quiet
 * rather than falling back to the logger's own default level.
 */
const applyLogLevel = (mod: WettyModule, level: LogLevel): void => {
  try {
    const transports = mod.getLogger?.()?.transports
    transports?.forEach((transport) => {
      if (level === 'silent') {
        transport.silent = true
        return
      }
      transport.silent = false
      transport.level = level
    })
  } catch {
    // Logging configuration is best effort — never fail a start over it.
  }
}

/**
 * WeTTY calls `server.listen()` without waiting for the result, so a bind
 * failure such as EADDRINUSE arrives as an `error` event *after* its promise
 * has already resolved. Left alone that event is unhandled and takes the whole
 * Signal K server process down with it, so the listen outcome is awaited
 * explicitly and turned back into a rejection.
 */
const awaitListening = (
  handle: WettyHandle,
  timeoutMs: number
): Promise<void> => {
  const server = handle.httpServer
  const once = server?.once?.bind(server)
  const off = server?.removeListener?.bind(server)
  if (!server || !once || server.listening) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const settle = (err?: Error) => {
      clearTimeout(timer)
      off?.('listening', onListening as (...args: never[]) => void)
      off?.('error', onError as (...args: never[]) => void)
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    const onListening = () => settle()
    const onError = (err?: Error) =>
      settle(err ?? new Error('WeTTY server failed to listen'))
    // A server that is neither listening nor failing after the timeout is
    // treated as started; a status message beats a start that never returns.
    const timer = setTimeout(() => settle(), timeoutMs)

    once('listening', onListening)
    once('error', onError)
  })
}

/**
 * Owns a single WeTTY instance: at most one server is running at a time and
 * `stop()` is always safe to call, including when `start()` never succeeded.
 */
export class WettyRunner {
  private handle: WettyHandle | undefined
  private startCount = 0
  private removeEnvVersionPatch: (() => void) | undefined

  constructor(
    private readonly loader: WettyLoader = defaultLoader,
    private readonly log: (msg: string) => void = () => {}
  ) {}

  get running(): boolean {
    return this.handle !== undefined
  }

  async start(options: ResolvedOptions, listenTimeoutMs = 5000): Promise<void> {
    if (this.handle) {
      await this.stop()
    }

    // Installed before WeTTY is even loaded, so there is no window in which
    // a session could reach the real, crash-prone `env --version` call. See
    // src/env-version-patch.ts.
    this.removeEnvVersionPatch = installEnvVersionPatch()

    const mod = await this.loader()

    // Applied before start() rather than after it: WeTTY logs its own startup
    // through the same logger, so configuring it afterwards still lets those
    // lines through to the Signal K server log.
    applyLogLevel(mod, options.logLevel)

    const { ssh, server, forcessh } = toWettyConfig(options)
    const ssl = resolveSsl(options)

    // Only a restart can hit the duplicate-metric case, so the first start is
    // left alone and keeps WeTTY's own `wetty_connections` gauge registered.
    if (this.startCount > 0) {
      clearPrometheusRegistry()
    }

    let handle: WettyHandle
    try {
      try {
        handle = await mod.start(ssh, server, options.command, forcessh, ssl)
      } catch (err) {
        if (!isDuplicateMetricError(err)) {
          throw err
        }
        this.log('Clearing the Prometheus registry and retrying WeTTY start')
        clearPrometheusRegistry()
        handle = await mod.start(ssh, server, options.command, forcessh, ssl)
      }
    } catch (err) {
      // Nothing ever started, so stop() will not run to clean this up.
      this.removeEnvVersionPatch?.()
      this.removeEnvVersionPatch = undefined
      throw err
    }
    this.startCount += 1

    // WeTTY's own allowIframe only clears X-Frame-Options, and helmet's
    // upgrade-insecure-requests is sent even when WeTTY has no certificate to
    // actually serve HTTPS with — both need patching out of the CSP header
    // before any request is served. See src/csp-patch.ts.
    const cspDirectivesToStrip: string[] = []
    if (options.allowIframe) {
      cspDirectivesToStrip.push('frame-ancestors')
    }
    if (!ssl) {
      cspDirectivesToStrip.push('upgrade-insecure-requests')
    }
    if (handle.httpServer) {
      installCspPatch(handle.httpServer, cspDirectivesToStrip)
    }

    try {
      await awaitListening(handle, listenTimeoutMs)
    } catch (err) {
      this.handle = handle
      await this.stop()
      throw err
    }

    // Anything that goes wrong later — a socket error, a late EADDRINUSE on a
    // second address — must be logged rather than left to crash the server.
    handle.httpServer?.on?.('error', (err: Error) => {
      this.log(`WeTTY server error: ${err.message}`)
    })

    this.handle = handle

    // Again, in case start() added transports of its own.
    applyLogLevel(mod, options.logLevel)
  }

  /**
   * Closes the socket.io server and the HTTP server underneath it. Browsers
   * hold keep-alive connections open, so idle sockets are dropped explicitly
   * and the whole thing is bounded by a timeout — a plugin `stop()` that never
   * settles blocks the server's own shutdown.
   */
  async stop(timeoutMs = 5000): Promise<void> {
    const handle = this.handle
    this.handle = undefined
    this.removeEnvVersionPatch?.()
    this.removeEnvVersionPatch = undefined
    if (!handle) {
      return
    }

    await new Promise<void>((resolve) => {
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      }

      // Deliberately not unref'd: an unref'd timer loses the race when the
      // process has nothing else keeping the loop alive, and stop() would then
      // never settle.
      const timer = setTimeout(() => {
        this.log(`WeTTY did not shut down within ${timeoutMs}ms, continuing`)
        done()
      }, timeoutMs)

      try {
        handle.close(done)
        handle.httpServer?.closeAllConnections?.()
      } catch (err) {
        this.log(
          `Error while stopping WeTTY: ${err instanceof Error ? err.message : String(err)}`
        )
        done()
      }
    })
  }
}
