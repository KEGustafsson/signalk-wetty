import type { JsonSchema } from './types'

export const PLUGIN_ID = 'signalk-wetty'
export const PLUGIN_NAME = 'WeTTY Terminal'

/**
 * Where the terminal is genuinely embedded: reverse-proxied through Signal
 * K's own origin and port, under the router path Signal K mounts plugin
 * routes at. This is what makes it a Signal K *embedded* webapp rather than
 * a separate server framed from a different port. See src/embedded-proxy.ts.
 */
export const EMBEDDED_TERMINAL_SUBPATH = '/terminal'
export const EMBEDDED_TERMINAL_PATH = `/plugins/${PLUGIN_ID}${EMBEDDED_TERMINAL_SUBPATH}`

export type ConnectionMode = 'ssh' | 'local'

/**
 * WeTTY's own winston levels, plus `silent` — which is not a winston level but
 * a transport flag, and drops WeTTY's logging entirely rather than reporting
 * it. Everything else is reported through the plugin's own debug logging; see
 * routeLoggingToDebug() in src/wetty-runner.ts.
 */
export type LogLevel =
  'silent' | 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly'

export const LOG_LEVELS: LogLevel[] = [
  'silent',
  'error',
  'warn',
  'info',
  'http',
  'verbose',
  'debug',
  'silly'
]

export interface WettySshOptions {
  host: string
  port: number
  user: string
  auth: string
  knownHosts: string
  keyPath: string
  password: string
  allowRemoteHosts: boolean
  allowRemoteCommand: boolean
}

export interface WettySslOptions {
  enabled: boolean
  keyPath: string
  certPath: string
}

export interface ResolvedOptions {
  port: number
  host: string
  title: string
  allowIframe: boolean
  logLevel: LogLevel
  mode: ConnectionMode
  command: string
  ssh: WettySshOptions
  ssl: WettySslOptions
}

/**
 * Signal K itself listens on 3000 by default and WeTTY's own default is 3000
 * too, so the plugin deliberately defaults one port up to avoid a guaranteed
 * EADDRINUSE on a stock install.
 */
export const DEFAULT_PORT = 3001

export const DEFAULTS: ResolvedOptions = {
  port: DEFAULT_PORT,
  // Loopback-only by default: the terminal is reachable through the
  // embedded webapp (proxied through the Signal K server itself)
  // regardless of this setting. Widen it only to also expose the port
  // directly on the network, bypassing Signal K's own access control.
  host: '127.0.0.1',
  title: 'Signal K Terminal',
  allowIframe: true,
  // WeTTY would otherwise log every connection, disconnection and asset
  // request straight to the console it inherits — which is the Signal K server
  // log. Its output is reported through the plugin's debug logging instead, so
  // this level only decides how much shows up once debug is switched on.
  logLevel: 'info',
  mode: 'ssh',
  command: 'login',
  ssh: {
    host: 'localhost',
    port: 22,
    user: '',
    auth: 'password',
    knownHosts: '/dev/null',
    keyPath: '',
    password: '',
    allowRemoteHosts: false,
    allowRemoteCommand: false
  },
  ssl: {
    enabled: false,
    keyPath: '',
    certPath: ''
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

/** Strings are accepted so that a value typed into a text widget still works. */
const asPort = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return fallback
  }
  return parsed
}

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const asLogLevel = (value: unknown, fallback: LogLevel): LogLevel =>
  typeof value === 'string' && (LOG_LEVELS as string[]).includes(value)
    ? (value as LogLevel)
    : fallback

const asMode = (value: unknown, fallback: ConnectionMode): ConnectionMode =>
  value === 'ssh' || value === 'local' ? value : fallback

/**
 * Turns whatever the server hands us — including `{}` on first start, or a
 * config written by an older version of the plugin — into a fully populated
 * option set. Never throws.
 */
export const resolveOptions = (raw: unknown): ResolvedOptions => {
  const options = isRecord(raw) ? raw : {}
  const ssh = isRecord(options.ssh) ? options.ssh : {}
  const ssl = isRecord(options.ssl) ? options.ssl : {}

  return {
    port: asPort(options.port, DEFAULTS.port),
    host: asString(options.host, DEFAULTS.host),
    title: asString(options.title, DEFAULTS.title),
    allowIframe: asBoolean(options.allowIframe, DEFAULTS.allowIframe),
    logLevel: asLogLevel(options.logLevel, DEFAULTS.logLevel),
    mode: asMode(options.mode, DEFAULTS.mode),
    command: asString(options.command, DEFAULTS.command),
    ssh: {
      host: asString(ssh.host, DEFAULTS.ssh.host),
      port: asPort(ssh.port, DEFAULTS.ssh.port),
      user: asString(ssh.user, DEFAULTS.ssh.user),
      auth: asString(ssh.auth, DEFAULTS.ssh.auth),
      knownHosts: asString(ssh.knownHosts, DEFAULTS.ssh.knownHosts),
      keyPath: asString(ssh.keyPath, DEFAULTS.ssh.keyPath),
      password: typeof ssh.password === 'string' ? ssh.password : '',
      allowRemoteHosts: asBoolean(
        ssh.allowRemoteHosts,
        DEFAULTS.ssh.allowRemoteHosts
      ),
      allowRemoteCommand: asBoolean(
        ssh.allowRemoteCommand,
        DEFAULTS.ssh.allowRemoteCommand
      )
    },
    ssl: {
      enabled: asBoolean(ssl.enabled, DEFAULTS.ssl.enabled),
      keyPath: asString(ssl.keyPath, DEFAULTS.ssl.keyPath),
      certPath: asString(ssl.certPath, DEFAULTS.ssl.certPath)
    }
  }
}

/**
 * SSL is only handed to WeTTY when both halves of the key pair are configured;
 * a half-configured pair would make WeTTY throw on an unreadable file instead
 * of falling back to plain HTTP.
 */
export const resolveSsl = (
  options: ResolvedOptions
): { key: string; cert: string } | undefined =>
  options.ssl.enabled &&
  options.ssl.keyPath !== '' &&
  options.ssl.certPath !== ''
    ? { key: options.ssl.keyPath, cert: options.ssl.certPath }
    : undefined

/**
 * `local` mode only works when the server process can call `login(1)`, which
 * WeTTY gates on uid 0. Everything else has to go over SSH, so the resolved
 * mode is reported separately from the requested one.
 */
export const isRunningAsRoot = (): boolean =>
  typeof process.getuid === 'function' && process.getuid() === 0

export const effectiveMode = (
  options: ResolvedOptions,
  root = isRunningAsRoot()
): ConnectionMode => (options.mode === 'local' && root ? 'local' : 'ssh')

export const PLUGIN_SCHEMA: JsonSchema = {
  type: 'object',
  title: 'WeTTY terminal',
  description:
    'Runs a WeTTY web terminal inside the Signal K server process and adds it to the admin UI webapp list.',
  properties: {
    port: {
      type: 'number',
      title: 'Terminal port',
      description:
        'TCP port the terminal listens on. Must differ from the Signal K server port.',
      default: DEFAULTS.port,
      minimum: 1,
      maximum: 65535
    },
    host: {
      type: 'string',
      title: 'Bind address',
      description:
        'Address WeTTY itself binds to. The terminal is always reachable through the embedded webapp in the Signal K admin UI regardless of this setting. Set to 0.0.0.0 only to also expose the port directly on the network.',
      default: DEFAULTS.host
    },
    title: {
      type: 'string',
      title: 'Page title',
      default: DEFAULTS.title
    },
    allowIframe: {
      type: 'boolean',
      title: 'Allow embedding in an iframe',
      description:
        'Required for the terminal to show up inside the Signal K admin UI. Disable only if you always open the terminal in its own tab.',
      default: DEFAULTS.allowIframe
    },
    logLevel: {
      type: 'string',
      title: 'WeTTY log level',
      description:
        'How much of WeTTY\'s own logging is reported through this plugin\'s debug log, which is enabled under Server → Server Log. "silent" drops it entirely. WeTTY never writes to the server console directly.',
      enum: LOG_LEVELS,
      default: DEFAULTS.logLevel
    },
    mode: {
      type: 'string',
      title: 'Connection mode',
      description:
        'ssh: connect over SSH (works for any user, prompts for credentials). local: run login(1) directly, which WeTTY only permits when the server runs as root.',
      enum: ['ssh', 'local'],
      default: DEFAULTS.mode
    },
    command: {
      type: 'string',
      title: 'Command',
      description:
        'Command to run for each session. "login" starts an interactive login shell.',
      default: DEFAULTS.command
    },
    ssh: {
      type: 'object',
      title: 'SSH',
      properties: {
        host: {
          type: 'string',
          title: 'SSH host',
          default: DEFAULTS.ssh.host
        },
        port: {
          type: 'number',
          title: 'SSH port',
          default: DEFAULTS.ssh.port,
          minimum: 1,
          maximum: 65535
        },
        user: {
          type: 'string',
          title: 'SSH user',
          description:
            'Leave empty to have the terminal prompt for a username on every connection.',
          default: DEFAULTS.ssh.user
        },
        auth: {
          type: 'string',
          title: 'Preferred authentication',
          description:
            'Passed to ssh as PreferredAuthentications, e.g. "password", "publickey" or "publickey,password".',
          default: DEFAULTS.ssh.auth
        },
        knownHosts: {
          type: 'string',
          title: 'Known hosts file',
          description:
            'Set to a real known_hosts path to enable strict host key checking. The default of /dev/null disables it, which allows host key substitution — only keep it while the SSH host is localhost.',
          default: DEFAULTS.ssh.knownHosts
        },
        keyPath: {
          type: 'string',
          title: 'Private key file',
          description:
            'INSECURE: any client that reaches the terminal logs in without a password. Leave empty unless the port is firewalled off.',
          default: DEFAULTS.ssh.keyPath
        },
        password: {
          type: 'string',
          title: 'Password',
          description:
            'INSECURE: stored in clear text in the plugin configuration. Leave empty to be prompted in the terminal instead.',
          default: DEFAULTS.ssh.password
        },
        allowRemoteHosts: {
          type: 'boolean',
          title: 'Allow host/port in the URL',
          default: DEFAULTS.ssh.allowRemoteHosts
        },
        allowRemoteCommand: {
          type: 'boolean',
          title: 'Allow command/path in the URL',
          default: DEFAULTS.ssh.allowRemoteCommand
        }
      }
    },
    ssl: {
      type: 'object',
      title: 'HTTPS',
      properties: {
        enabled: {
          type: 'boolean',
          title: 'Serve the terminal over HTTPS',
          default: DEFAULTS.ssl.enabled
        },
        keyPath: {
          type: 'string',
          title: 'Key file',
          default: DEFAULTS.ssl.keyPath
        },
        certPath: {
          type: 'string',
          title: 'Certificate file',
          default: DEFAULTS.ssl.certPath
        }
      }
    }
  }
}

export const PLUGIN_UI_SCHEMA: Record<string, unknown> = {
  'ui:order': [
    'mode',
    'command',
    'port',
    'host',
    'title',
    'allowIframe',
    'logLevel',
    'ssh',
    'ssl'
  ],
  ssh: {
    password: {
      'ui:widget': 'password'
    }
  }
}
