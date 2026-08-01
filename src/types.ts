/**
 * Minimal structural types for the parts of the Signal K plugin API this
 * plugin actually touches. Declaring them locally (instead of depending on
 * `@signalk/server-api`) keeps the runtime dependency surface empty and lets
 * the plugin load on older server versions.
 */

export type JsonSchema = Record<string, unknown>

export interface PluginServerApp {
  debug: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  setPluginStatus: (msg: string) => void
  setPluginError: (msg: string) => void
}

/** The subset of Express' Router surface used by `registerWithRouter`. */
export interface PluginRouterLike {
  get: (path: string, handler: RouteHandler) => unknown
  post: (path: string, handler: RouteHandler) => unknown
}

export interface RouteRequest {
  query?: Record<string, unknown>
}

export interface RouteResponse {
  status: (code: number) => RouteResponse
  json: (body: unknown) => unknown
}

export type RouteHandler = (req: RouteRequest, res: RouteResponse) => void

/** Payload of `GET /plugins/signalk-wetty/status`, consumed by the webapp. */
export interface PluginStatus {
  running: boolean
  message: string
  error: string | null
  scheme: 'http' | 'https'
  port: number
  basePath: string
  /** True when the bind address only accepts connections from the server itself. */
  loopbackOnly: boolean
  allowIframe: boolean
  requestedMode: string
  effectiveMode: string
  runningAsRoot: boolean
  native: {
    available: boolean
    error: string | null
    help: string
  }
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
