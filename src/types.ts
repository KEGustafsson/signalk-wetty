import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Minimal structural types for the parts of the Signal K plugin API this
 * plugin actually touches. Declaring them locally (instead of depending on
 * `@signalk/server-api`) keeps the runtime dependency surface empty and lets
 * the plugin load on older server versions.
 */

export type JsonSchema = Record<string, unknown>

/**
 * Deliberately without the server's own `http.Server`: Signal K does not
 * offer plugins one, and the property some servers happen to carry it on is
 * not part of the plugin API. The embedded terminal reaches the HTTP server
 * through a request its router handles instead — see serverFromRequest() in
 * src/embedded-proxy.ts.
 */
export interface PluginServerApp {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  setPluginStatus: (msg: string) => void
  setPluginError: (msg: string) => void
}

/**
 * A plain middleware handler, as `express.Router#use` accepts — unlike
 * `RouteHandler` below, it works with real Node request/response objects
 * rather than the minimal structural stand-ins, which the embedded terminal
 * proxy needs to actually forward requests.
 */
export type UseHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void
) => void | Promise<void>

/** The subset of Express' Router surface used by `registerWithRouter`. */
export interface PluginRouterLike {
  get: (path: string, handler: RouteHandler) => unknown
  post: (path: string, handler: RouteHandler) => unknown
  use: (path: string, handler: UseHandler) => unknown
}

export interface RouteRequest {
  query?: Record<string, unknown>
}

export interface RouteResponse {
  status: (code: number) => RouteResponse
  json: (body: unknown) => unknown
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => void

/** Progress of a `node-pty` rebuild, polled by the webapp while it runs. */
export interface RebuildState {
  running: boolean
  startedAt: string | null
  finishedAt: string | null
  /** null until a rebuild has finished in this process. */
  ok: boolean | null
  output: string
}

/** Result of the SSH reachability check, and what to do when it failed. */
export interface SshCheck {
  /** False when the check does not apply, i.e. in local mode. */
  checked: boolean
  reachable: boolean
  host: string
  port: number
  banner: string | null
  error: string | null
  help: string
  checkedAt: string | null
}

/** Payload of `GET /plugins/signalk-wetty/status`, consumed by the webapp. */
export interface PluginStatus {
  running: boolean
  message: string
  error: string | null
  scheme: 'http' | 'https'
  port: number
  basePath: string
  allowIframe: boolean
  requestedMode: string
  effectiveMode: string
  runningAsRoot: boolean
  native: {
    available: boolean
    error: string | null
    help: string
  }
  rebuild: RebuildState
  /** Whether the local `ssh` binary is installed; irrelevant in local mode. */
  sshClient: {
    available: boolean
    error: string | null
    help: string
  }
  ssh: SshCheck
}

export interface SignalKPlugin {
  id: string
  name: string
  description: string
  schema: () => JsonSchema
  uiSchema: () => Record<string, unknown>
  start: (options: unknown) => Promise<void>
  stop: () => Promise<void>
  registerWithRouter: (router: PluginRouterLike) => void
}
