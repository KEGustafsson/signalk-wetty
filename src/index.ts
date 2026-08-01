import {
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
import {
  nativeHelpText,
  probeNodePty,
  rebuildNodePty,
  type NativeProbeResult
} from './native'
import { WettyRunner } from './wetty-runner'
import type { PluginDeps } from './deps'
import type {
  PluginRouterLike,
  PluginServerApp,
  PluginStatus,
  RouteResponse,
  SignalKPlugin
} from './types'

const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

const buildStatus = (
  options: ResolvedOptions,
  running: boolean,
  message: string,
  error: string | null,
  native: NativeProbeResult
): PluginStatus => ({
  running,
  message,
  error,
  scheme: resolveSsl(options) ? 'https' : 'http',
  port: options.port,
  basePath: options.basePath,
  loopbackOnly: options.host === '127.0.0.1' || options.host === '::1',
  allowIframe: options.allowIframe,
  requestedMode: options.mode,
  effectiveMode: effectiveMode(options),
  runningAsRoot: isRunningAsRoot(),
  native: {
    available: native.available,
    error: native.error ?? null,
    help: nativeHelpText(native)
  }
})

/** Signal K plugin entry point. */
function signalkWetty(
  app: PluginServerApp,
  deps: PluginDeps = {}
): SignalKPlugin {
  const probeNative = deps.probeNative ?? probeNodePty
  const rebuildNative = deps.rebuildNative ?? rebuildNodePty
  const debug = (msg: string) => {
    try {
      app.debug(msg)
    } catch {
      // A server without app.debug is still a usable server.
    }
  }

  const runner = new WettyRunner(deps.loadWetty, debug)

  let options: ResolvedOptions = resolveOptions({})
  let native: NativeProbeResult = { available: false, error: 'not probed yet' }
  let message = 'Not started'
  let error: string | null = null

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
    const scheme = resolveSsl(options) ? 'https' : 'http'
    const where = `${scheme}://<server>:${options.port}${
      options.basePath === '/' ? '/' : options.basePath
    }`
    const how =
      effectiveMode(options) === 'local'
        ? 'local login shell'
        : `ssh to ${options.ssh.host}:${options.ssh.port}`
    const downgraded =
      options.mode === 'local' && effectiveMode(options) === 'ssh'
        ? ' (local mode needs the server to run as root, falling back to SSH)'
        : ''
    return `Terminal on ${where} — ${how}${downgraded}`
  }

  const redactedOptions = (): string =>
    JSON.stringify({
      ...options,
      ssh: { ...options.ssh, password: options.ssh.password ? '***' : '' }
    })

  const start = async (rawOptions: unknown): Promise<void> => {
    options = resolveOptions(rawOptions)
    native = probeNative()

    if (!native.available) {
      // Starting anyway would produce a page that dies on the first keystroke,
      // which is far harder to diagnose from the admin UI than a clear status.
      setError(`${native.error}. ${nativeHelpText(native)}`)
      return
    }

    try {
      await runner.start(options)
      setStatus(describeRunning())
      debug(`WeTTY started with ${redactedOptions()}`)
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
    try {
      await runner.stop()
    } catch (err) {
      debug(`Ignoring error while stopping WeTTY: ${describeError(err)}`)
    }
    setStatus('Stopped')
  }

  const registerWithRouter = (router: PluginRouterLike): void => {
    router.get('/status', (_req, res: RouteResponse) => {
      res.json(buildStatus(options, runner.running, message, error, native))
    })

    router.post('/rebuild-native', (_req, res: RouteResponse) => {
      const probe = probeNative()
      if (probe.available) {
        native = probe
        res.json({
          ok: true,
          nativeAvailable: true,
          output: 'node-pty is already built — nothing to do.'
        })
        return
      }
      setStatus('Rebuilding node-pty, this can take several minutes…')
      rebuildNative(probe)
        .then((result) => {
          native = probeNative()
          if (result.ok && native.available) {
            setStatus(
              'node-pty rebuilt — restart the plugin to start the terminal'
            )
          } else {
            setError(`node-pty rebuild failed. ${nativeHelpText(native)}`)
          }
          res.json({ ...result, nativeAvailable: native.available })
        })
        .catch((err: unknown) => {
          const detail = describeError(err)
          setError(`node-pty rebuild failed: ${detail}`)
          res
            .status(500)
            .json({ ok: false, nativeAvailable: false, output: detail })
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
