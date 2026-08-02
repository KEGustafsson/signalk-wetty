import {
  EMBEDDED_TERMINAL_PATH,
  EMBEDDED_TERMINAL_SUBPATH,
  PLUGIN_ID,
  PLUGIN_NAME,
  PLUGIN_SCHEMA,
  PLUGIN_UI_SCHEMA,
  effectiveMode,
  isRunningAsRoot,
  resolveOptions,
  resolveSsl,
  type ResolvedOptions
} from './config'
import type { EmbeddedProxy } from './embedded-proxy'
import {
  createEmbeddedProxy,
  installUpgradeForwarding,
  serverFromRequest
} from './embedded-proxy'
import {
  nativeHelpText,
  probeNodePty,
  rebuildNodePty,
  type NativeProbeResult
} from './native'
import { probeSshServer, sshHelpText } from './ssh-probe'
import { WettyRunner } from './wetty-runner'
import type { IncomingMessage, Server } from 'node:http'

import type { PluginDeps } from './deps'
import type {
  PluginRouterLike,
  PluginServerApp,
  PluginStatus,
  RebuildState,
  RouteResponse,
  SignalKPlugin,
  SshCheck
} from './types'

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

const idleRebuild = (): RebuildState => ({
  running: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  output: ''
})

/** Local mode never shells out to ssh, so there is nothing to check. */
const skippedSshCheck = (options: ResolvedOptions): SshCheck => ({
  checked: false,
  reachable: false,
  host: options.ssh.host,
  port: options.ssh.port,
  banner: null,
  error: null,
  help: '',
  checkedAt: null
})

const buildStatus = (
  options: ResolvedOptions,
  running: boolean,
  message: string,
  error: string | null,
  native: NativeProbeResult,
  rebuild: RebuildState,
  ssh: SshCheck
): PluginStatus => ({
  running,
  message,
  error,
  scheme: resolveSsl(options) ? 'https' : 'http',
  port: options.port,
  basePath: EMBEDDED_TERMINAL_PATH,
  allowIframe: options.allowIframe,
  requestedMode: options.mode,
  effectiveMode: effectiveMode(options),
  runningAsRoot: isRunningAsRoot(),
  native: {
    available: native.available,
    error: native.error ?? null,
    help: nativeHelpText(native)
  },
  rebuild,
  ssh
})

/** Signal K plugin entry point. */
function signalkWetty(
  app: PluginServerApp,
  deps: PluginDeps = {}
): SignalKPlugin {
  const probeNative = deps.probeNative ?? probeNodePty
  const rebuildNative = deps.rebuildNative ?? rebuildNodePty
  const probeSsh = deps.probeSsh ?? probeSshServer
  const debug = (msg: string) => {
    try {
      app.debug(msg)
    } catch {
      // A server without app.debug is still a usable server.
    }
  }

  const runner = new WettyRunner(deps.loadWetty, debug)

  let embeddedProxy: EmbeddedProxy | undefined
  let upgradeForwarders: Array<() => void> = []
  let forwardingServers = new WeakSet<Server>()
  let warnedWithoutServer = false

  let options: ResolvedOptions = resolveOptions({})
  let native: NativeProbeResult = { available: false, error: 'not probed yet' }
  let message = 'Not started'
  let error: string | null = null
  let rebuild: RebuildState = idleRebuild()
  let ssh: SshCheck = skippedSshCheck(options)

  /**
   * WebSocket upgrades bypass Express entirely, so forwarding them needs the
   * HTTP server itself — which Signal K does not hand to plugins. Rather than
   * reading it off the app object, where it is not part of the plugin API and
   * so can move without notice, it is taken from the first request the
   * plugin's own router handles: the terminal page always loads over HTTP
   * before its session upgrades, and that request necessarily arrived through
   * the very server the upgrade will arrive on.
   *
   * Done per server rather than once: a server reachable over both HTTP and
   * HTTPS serves the plugin's routes from more than one listener, and a
   * session opened through one of them must not depend on which listener
   * happened to be served first.
   */
  const ensureUpgradeForwarding = (req: IncomingMessage): void => {
    if (!embeddedProxy) {
      return
    }
    const server = serverFromRequest(req)
    if (!server) {
      if (!warnedWithoutServer) {
        warnedWithoutServer = true
        debug(
          'The terminal request carried no HTTP server — the page will load, but WebSocket sessions will not connect.'
        )
      }
      return
    }
    if (forwardingServers.has(server)) {
      return
    }
    forwardingServers.add(server)
    upgradeForwarders.push(
      installUpgradeForwarding(server, embeddedProxy.handleUpgrade)
    )
    debug('Forwarding WebSocket upgrades for the embedded terminal')
  }

  /** Detaches every upgrade listener installed by ensureUpgradeForwarding(). */
  const stopUpgradeForwarding = (): void => {
    upgradeForwarders.forEach((remove) => {
      remove()
    })
    upgradeForwarders = []
    forwardingServers = new WeakSet<Server>()
    warnedWithoutServer = false
  }

  const setStatus = (msg: string) => {
    message = msg
    error = null
    try {
      app.setPluginStatus(msg)
    } catch {
      // Older servers may not expose setPluginStatus.
    }
  }

  const setError = (msg: string) => {
    message = msg
    error = msg
    try {
      app.setPluginError(msg)
    } catch {
      // Older servers may not expose setPluginError.
    }
  }

  const describeRunning = (): string => {
    const how =
      effectiveMode(options) === 'local'
        ? 'local login shell'
        : `ssh to ${options.ssh.host}:${options.ssh.port}`
    const downgraded =
      options.mode === 'local' && effectiveMode(options) === 'ssh'
        ? ' (local mode needs the server to run as root, falling back to SSH)'
        : ''
    return `Terminal embedded at ${EMBEDDED_TERMINAL_PATH}/ — ${how}${downgraded}`
  }

  const redactedOptions = (): string =>
    JSON.stringify({
      ...options,
      ssh: { ...options.ssh, password: options.ssh.password ? '***' : '' }
    })

  /**
   * An unreachable SSH server means every session will fail, so start() and
   * GET /ssh-check share this rather than duplicating the report logic.
   */
  const applySshStatus = (): void => {
    if (ssh.checked && !ssh.reachable) {
      setError(
        `${describeRunning()} — but ${ssh.error}. The WeTTY Terminal webapp stays open and shows the fix instructions above the terminal.`
      )
    } else {
      setStatus(describeRunning())
    }
  }

  /**
   * Checks that something is actually answering as an SSH server, so a missing
   * sshd is reported once at start rather than as an unexplained session
   * failure every time somebody opens the terminal.
   */
  const checkSsh = async (): Promise<SshCheck> => {
    if (effectiveMode(options) !== 'ssh') {
      return skippedSshCheck(options)
    }
    try {
      const probe = await probeSsh(options.ssh.host, options.ssh.port)
      return {
        checked: true,
        reachable: probe.reachable,
        host: probe.host,
        port: probe.port,
        banner: probe.banner,
        error: probe.error,
        help: sshHelpText(probe),
        checkedAt: new Date().toISOString()
      }
    } catch (err) {
      // A probe that throws must never take the plugin down with it.
      const detail = describeError(err)
      debug(`SSH check failed unexpectedly: ${detail}`)
      return {
        ...skippedSshCheck(options),
        checked: true,
        error: detail
      }
    }
  }

  const start = async (rawOptions: unknown): Promise<void> => {
    options = resolveOptions(rawOptions)
    native = probeNative()
    ssh = skippedSshCheck(options)

    if (!native.available) {
      // Starting anyway would produce a page that dies on the first keystroke,
      // which is far harder to diagnose from the admin UI than a clear status.
      setError(`${native.error}. ${nativeHelpText(native)}`)
      return
    }

    try {
      await runner.start(options)
      debug(`WeTTY started with ${redactedOptions()}`)

      // Genuinely embeds the terminal — reverse-proxied through Signal K's
      // own origin and port, WebSocket upgrades included — rather than just
      // framing a separate server on its own port. See src/embedded-proxy.ts.
      // The forwarder itself is installed by the first request through the
      // plugin's router, which is where the HTTP server carrying it becomes
      // reachable — see ensureUpgradeForwarding().
      stopUpgradeForwarding()
      embeddedProxy = createEmbeddedProxy(
        { port: options.port },
        EMBEDDED_TERMINAL_PATH,
        (msg) => debug(msg)
      )

      // Checked after the terminal is up: a missing SSH server is not a
      // reason to withhold the page — sessions fail, but the page itself is
      // fine, and fixing it takes effect without touching the plugin ("Check
      // again" in the webapp re-probes the server).
      ssh = await checkSsh()
      applySshStatus()
    } catch (err) {
      const detail = describeError(err)
      const hint =
        /Cannot find (package|module) 'wetty'|ERR_MODULE_NOT_FOUND/i.test(
          detail
        )
          ? ' The wetty package is an optional dependency and is not installed — run "npm install wetty" next to the plugin.'
          : /EADDRINUSE/i.test(detail)
            ? ` Port ${options.port} is already in use — pick a different terminal port.`
            : ''
      setError(`Failed to start the terminal: ${detail}.${hint}`)
    }
  }

  const stop = async (): Promise<void> => {
    stopUpgradeForwarding()
    embeddedProxy = undefined
    try {
      await runner.stop()
    } catch (err) {
      debug(`Ignoring error while stopping WeTTY: ${describeError(err)}`)
    }
    setStatus('Stopped')
  }

  const registerWithRouter = (router: PluginRouterLike): void => {
    // The actual embedding: everything under this path is reverse-proxied
    // to WeTTY, which keeps listening on its own loopback-only port exactly
    // as before. Mounted here (rather than served directly) so the browser
    // only ever talks to Signal K's own origin — same-origin, same admin
    // session, no separate port to expose.
    router.use(EMBEDDED_TERMINAL_SUBPATH, async (req, res, next) => {
      if (!embeddedProxy) {
        res.statusCode = 503
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Terminal is not running' }))
        return
      }
      ensureUpgradeForwarding(req)
      await embeddedProxy.middleware(req, res, next)
    })

    router.get('/status', (_req, res: RouteResponse) => {
      res.json(
        buildStatus(
          options,
          runner.running,
          message,
          error,
          native,
          rebuild,
          ssh
        )
      )
    })

    // Re-runs the SSH check on demand, so somebody who has just installed and
    // started sshd can confirm it from the webapp without restarting anything.
    router.get('/ssh-check', (_req, res: RouteResponse) => {
      checkSsh()
        .then((result) => {
          ssh = result
          if (runner.running) {
            applySshStatus()
          }
          res.json(ssh)
        })
        .catch((err: unknown) => {
          res.status(500).json({
            ...skippedSshCheck(options),
            checked: true,
            error: describeError(err)
          })
        })
    })

    // The rebuild runs detached from the request. Compiling node-pty takes
    // minutes on a Raspberry Pi, and holding the response open that long means
    // any proxy or browser in front of the admin UI times out first and reports
    // a failure for a build that is still running happily. The webapp polls
    // GET /status for the outcome instead.
    router.post('/rebuild-native', (_req, res: RouteResponse) => {
      if (rebuild.running) {
        // Two rebuilds in one directory put two node-gyp runs in the same
        // build/ tree, which can leave node-pty broken rather than fixed.
        res.status(409).json({
          started: false,
          running: true,
          output: 'A node-pty rebuild is already running.'
        })
        return
      }

      const probe = probeNative()
      if (probe.available) {
        native = probe
        res.status(200).json({
          started: false,
          running: false,
          ok: true,
          nativeAvailable: true,
          output: 'node-pty is already built — nothing to do.'
        })
        return
      }

      rebuild = {
        running: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        ok: null,
        output: ''
      }
      setStatus('Rebuilding node-pty, this can take several minutes…')

      const finish = (ok: boolean, output: string) => {
        native = probeNative()
        rebuild = {
          ...rebuild,
          running: false,
          finishedAt: new Date().toISOString(),
          ok: ok && native.available,
          output
        }
        if (rebuild.ok) {
          setStatus(
            'node-pty rebuilt — restart the plugin to start the terminal'
          )
        } else {
          setError(`node-pty rebuild failed. ${nativeHelpText(native)}`)
        }
      }

      rebuildNative(probe)
        .then((result) => {
          finish(result.ok, result.output)
        })
        .catch((err: unknown) => {
          finish(false, describeError(err))
        })

      res.status(202).json({
        started: true,
        running: true,
        output: 'Rebuilding node-pty. Poll the status route for the outcome.'
      })
    })
  }

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      'Runs a WeTTY web terminal inside the Signal K server and publishes it as an admin UI webapp.',
    schema: () => PLUGIN_SCHEMA,
    uiSchema: () => PLUGIN_UI_SCHEMA,
    start,
    stop,
    registerWithRouter
  }
}

export = signalkWetty
