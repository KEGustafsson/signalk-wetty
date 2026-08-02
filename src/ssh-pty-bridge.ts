import fs from 'node:fs'
import { Client } from 'ssh2'
import type {
  AuthenticationType,
  AuthHandlerMiddleware,
  ClientChannel,
  ConnectConfig,
  Prompt
} from 'ssh2'
import type { WettySshOptions } from './config'
import { resolutionPaths } from './native'

/**
 * WeTTY's `ssh` connection mode shells out to the real `ssh` (and `sshpass`)
 * binaries through `node-pty` — see `command/ssh.js` and `spawn.js` in the
 * `wetty` package. This module replaces that one call with a pure-JS `ssh2`
 * connection, shaped to look like the `node-pty` handle WeTTY expects, so
 * the rest of WeTTY (asset serving, the socket.io protocol, xterm.js, CSP,
 * metrics) keeps working completely unmodified — see installSshPtyPatch().
 */

export interface IDisposable {
  dispose: () => void
}

/** The subset of node-pty's `IPty` that `wetty/build/server/spawn.js` calls. */
export interface FakePty {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  readonly process: string
  onData: (listener: (data: string) => void) => IDisposable
  onExit: (
    listener: (e: { exitCode: number; signal?: number }) => void
  ) => IDisposable
  write: (data: string | Buffer) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
  pause: () => void
  resume: () => void
}

export interface PtyStartOptions {
  cols?: number
  rows?: number
}

/**
 * WeTTY only ever spawns `ssh` (optionally via `sshpass`) as
 * `/usr/bin/env <flags...> ssh ... -- <address> [command]`. The two other
 * `pty.spawn('/usr/bin/env', ...)` call sites in WeTTY — the username-prompt
 * helper (`['node', ...]`) and local mode's `login(1)` — never include
 * `'ssh'` in their argv, so this check is unambiguous without depending on
 * flag order, which WeTTY is free to change between versions.
 */
export const looksLikeSshSpawn = (file: string, args: string[]): boolean =>
  file === '/usr/bin/env' && args.includes('ssh')

export interface ParsedSshTarget {
  username: string
  host: string
  command: string | undefined
}

/**
 * WeTTY's `sshOptions()` always ends the ssh argv with `'--', address,
 * [command]`, where `address` is `user@host` — the one part of the argv that
 * reflects something resolved at runtime (an interactively-typed username, or
 * a URL-supplied host when `allowRemoteHosts` permits it). Everything else
 * needed to connect is already known from `WettySshOptions`, so only this
 * stable, standard `ssh` CLI convention is parsed back out of the argv.
 */
export const parseSshTarget = (args: string[]): ParsedSshTarget | undefined => {
  const separatorIndex = args.indexOf('--')
  const address = separatorIndex === -1 ? undefined : args[separatorIndex + 1]
  if (!address) {
    return undefined
  }
  const atIndex = address.lastIndexOf('@')
  if (atIndex === -1) {
    return undefined
  }
  return {
    username: address.slice(0, atIndex),
    host: address.slice(atIndex + 1),
    command: args[separatorIndex + 2]
  }
}

/**
 * Parses an OpenSSH `known_hosts` file into the raw host key blobs recorded
 * for `host`. Hashed hostnames (`|1|salt|hash`) are not supported — a niche
 * combination with this plugin's own strict-checking toggle, which most
 * setups leave disabled (the default `knownHosts` is `/dev/null`).
 */
const knownHostKeysFor = (knownHostsPath: string, host: string): Buffer[] => {
  let content: string
  try {
    content = fs.readFileSync(knownHostsPath, 'utf8')
  } catch {
    return []
  }
  const keys: Buffer[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const [hostsField, , keyBase64] = trimmed.split(/\s+/)
    if (!keyBase64 || !hostsField.split(',').includes(host)) {
      continue
    }
    try {
      keys.push(Buffer.from(keyBase64, 'base64'))
    } catch {
      // Unparseable line — skip rather than fail the whole check over it.
    }
  }
  return keys
}

/**
 * `knownHosts !== '/dev/null'` is this plugin's existing convention for
 * "verify strictly" (see `config.ts`'s schema description) — preserved
 * exactly, just backed by ssh2's `hostVerifier` instead of `ssh`'s own
 * `StrictHostKeyChecking`/`UserKnownHostsFile` options.
 */
const makeHostVerifier = (
  knownHosts: string,
  host: string
): ((key: Buffer) => boolean) | undefined => {
  if (knownHosts === '' || knownHosts === '/dev/null') {
    return undefined
  }
  const trusted = knownHostKeysFor(knownHosts, host)
  return (key: Buffer) => trusted.some((entry) => entry.equals(key))
}

type AuthAction =
  { type: 'publickey' } | { type: 'password' } | { type: 'interactive' }

/**
 * Mirrors `ssh`'s `PreferredAuthentications` (this plugin's `ssh.auth`
 * option): only the methods it lists are attempted, in that order. A
 * `password` entry with no password configured means "prompt for it",
 * matching what real `ssh` does when `sshpass` isn't in the picture.
 */
const buildAuthPlan = (sshConfig: WettySshOptions): AuthAction[] => {
  const preferred = sshConfig.auth
    .split(',')
    .map((method) => method.trim())
    .filter(Boolean)
  const plan: AuthAction[] = []
  if (preferred.includes('publickey') && sshConfig.keyPath !== '') {
    plan.push({ type: 'publickey' })
  }
  if (preferred.includes('password')) {
    plan.push(
      sshConfig.password !== '' ? { type: 'password' } : { type: 'interactive' }
    )
  }
  return plan
}

const asAuthList = (
  authsLeft: AuthenticationType[] | null
): AuthenticationType[] | null => (Array.isArray(authsLeft) ? authsLeft : null)

let nextPid = 1

/**
 * Builds a `node-pty`-shaped handle backed by an `ssh2` connection instead of
 * a spawned `ssh` process. Called synchronously from the patched
 * `node-pty.spawn()` (see installSshPtyPatch()), so the handle is returned
 * immediately and the actual connect/auth/shell sequence happens in the
 * background — every method buffers or queues until the SSH channel is
 * actually open, the same way a real PTY's caller never waits on the child
 * process actually starting.
 */
export const spawnSshPty = (
  sshConfig: WettySshOptions,
  args: string[],
  ptyOptions: PtyStartOptions
): FakePty => {
  const pid = nextPid
  nextPid += 1
  const cols = ptyOptions.cols ?? 80
  const rows = ptyOptions.rows ?? 30
  const target = parseSshTarget(args)

  const dataListeners: Array<(data: string) => void> = []
  const exitListeners: Array<
    (e: { exitCode: number; signal?: number }) => void
  > = []
  const emitData = (data: string): void => {
    dataListeners.forEach((listener) => listener(data))
  }
  let exited = false
  const emitExit = (exitCode: number): void => {
    if (exited) {
      return
    }
    exited = true
    exitListeners.forEach((listener) => listener({ exitCode }))
  }

  if (!target) {
    // Should never happen — sshOptions() always emits `-- <user@host>` — but
    // failing closed as a normal (non-zero) shell exit is safer than
    // throwing out of a monkey-patched spawn(), which node-pty's caller
    // does not expect.
    queueMicrotask(() => {
      emitData(
        'signalk-wetty: could not read the SSH destination from WeTTY\r\n'
      )
      emitExit(1)
    })
    return {
      pid,
      cols,
      rows,
      process: 'ssh',
      onData: (listener) => {
        dataListeners.push(listener)
        return { dispose: () => {} }
      },
      onExit: (listener) => {
        exitListeners.push(listener)
        return { dispose: () => {} }
      },
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {}
    }
  }

  const conn = new Client()
  let channel: ClientChannel | undefined
  let killedBeforeReady = false
  let pausedBeforeReady = false
  let pendingResize: { cols: number; rows: number } | undefined
  let pendingWrites: string[] = []

  // Interactive prompt buffering — mirrors the buffer-and-submit-on-Enter
  // pattern `wetty/build/server/command/login.js`'s own username prompt
  // already uses, just applied to a password prompt instead. Echo is
  // suppressed (nothing is written back for typed characters), matching a
  // real terminal password prompt.
  let promptBuffer = ''
  let awaitingPrompt: ((answer: string) => void) | undefined

  const askInteractively = (promptText: string): Promise<string> =>
    new Promise((resolve) => {
      emitData(promptText)
      awaitingPrompt = resolve
    })

  const feedPromptInput = (input: string): void => {
    for (const ch of input) {
      if (!awaitingPrompt) {
        return
      }
      if (ch === '\r' || ch === '\n') {
        const resolve = awaitingPrompt
        const answer = promptBuffer
        awaitingPrompt = undefined
        promptBuffer = ''
        emitData('\r\n')
        resolve(answer)
        continue
      }
      if (ch === '\x7f' || ch === '\x08') {
        promptBuffer = promptBuffer.slice(0, -1)
        continue
      }
      if (ch === '\x03') {
        awaitingPrompt = undefined
        promptBuffer = ''
        conn.end()
        return
      }
      promptBuffer += ch
    }
  }

  conn.on(
    'keyboard-interactive',
    (_name, _instructions, _lang, prompts: Prompt[], finish) => {
      void (async () => {
        const answers: string[] = []
        for (const prompt of prompts) {
          answers.push(await askInteractively(prompt.prompt))
        }
        finish(answers)
      })()
    }
  )

  const authPlan = buildAuthPlan(sshConfig)
  let planIndex = 0
  let triedKeyboardInteractive = false

  const authHandler: AuthHandlerMiddleware = (
    authsLeftRaw,
    _partialSuccess,
    next
  ) => {
    const authsLeft = asAuthList(authsLeftRaw)
    while (planIndex < authPlan.length) {
      const action = authPlan[planIndex]
      if (action.type === 'publickey') {
        planIndex += 1
        try {
          const key = fs.readFileSync(sshConfig.keyPath)
          next({ type: 'publickey', username: target.username, key })
        } catch {
          continue // Unreadable key file — fall through to the next plan step.
        }
        return
      }
      if (action.type === 'password') {
        planIndex += 1
        next({
          type: 'password',
          username: target.username,
          password: sshConfig.password
        })
        return
      }
      // action.type === 'interactive': try keyboard-interactive once, then
      // fall back to a manually-prompted password if the server only offers
      // the plain 'password' method.
      if (
        !triedKeyboardInteractive &&
        (authsLeft === null || authsLeft.includes('keyboard-interactive'))
      ) {
        triedKeyboardInteractive = true
        next('keyboard-interactive')
        return
      }
      if (authsLeft === null || authsLeft.includes('password')) {
        planIndex += 1
        askInteractively(`${target.username}@${target.host}'s password: `).then(
          (password) => {
            next({ type: 'password', username: target.username, password })
          }
        )
        return
      }
      planIndex += 1
    }
    // No auth method left to try — ssh2's types don't declare `false` as a
    // valid argument here, but the library documents it as how to signal
    // "give up", which surfaces as a normal auth-failure error below.
    ;(next as unknown as (authName: false) => void)(false)
  }

  conn.on('ready', () => {
    const window = { term: 'xterm-256color', cols, rows }
    const onChannel = (err: Error | undefined, ch: ClientChannel): void => {
      if (err) {
        emitData(`${err.message}\r\n`)
        conn.end()
        emitExit(1)
        return
      }
      channel = ch
      if (killedBeforeReady) {
        ch.end()
        return
      }
      let exitCode = 0
      ch.on('data', (chunk: Buffer) => emitData(chunk.toString('utf8')))
      ch.stderr.on('data', (chunk: Buffer) => emitData(chunk.toString('utf8')))
      ch.on('exit', (code: number | null) => {
        exitCode = code ?? 0
      })
      ch.on('close', () => {
        emitExit(exitCode)
        conn.end()
      })
      if (pendingResize) {
        ch.setWindow(pendingResize.rows, pendingResize.cols, 0, 0)
        pendingResize = undefined
      }
      if (pausedBeforeReady) {
        ch.pause()
      }
      pendingWrites.forEach((data) => ch.write(data))
      pendingWrites = []
    }
    if (target.command) {
      conn.exec(target.command, { pty: window }, onChannel)
    } else {
      conn.shell(window, onChannel)
    }
  })

  conn.on('error', (err) => {
    emitData(`${err.message}\r\n`)
    emitExit(1)
  })

  const hostVerifier = makeHostVerifier(sshConfig.knownHosts, target.host)
  const connectConfig: ConnectConfig = {
    host: target.host,
    port: sshConfig.port,
    username: target.username,
    authHandler,
    readyTimeout: 20000,
    ...(hostVerifier ? { hostVerifier } : {})
  }
  conn.connect(connectConfig)

  return {
    pid,
    cols,
    rows,
    process: `ssh ${target.host}`,
    onData: (listener) => {
      dataListeners.push(listener)
      return {
        dispose: () => {
          const i = dataListeners.indexOf(listener)
          if (i !== -1) {
            dataListeners.splice(i, 1)
          }
        }
      }
    },
    onExit: (listener) => {
      exitListeners.push(listener)
      return {
        dispose: () => {
          const i = exitListeners.indexOf(listener)
          if (i !== -1) {
            exitListeners.splice(i, 1)
          }
        }
      }
    },
    write: (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      if (awaitingPrompt) {
        feedPromptInput(text)
        return
      }
      if (channel) {
        channel.write(text)
      } else {
        pendingWrites.push(text)
      }
    },
    resize: (newCols, newRows) => {
      if (channel) {
        channel.setWindow(newRows, newCols, 0, 0)
      } else {
        pendingResize = { cols: newCols, rows: newRows }
      }
    },
    kill: () => {
      if (channel) {
        channel.end()
      } else {
        killedBeforeReady = true
      }
      conn.end()
    },
    pause: () => {
      if (channel) {
        channel.pause()
      } else {
        pausedBeforeReady = true
      }
    },
    resume: () => {
      pausedBeforeReady = false
      channel?.resume()
    }
  }
}

export interface NodePtySpawnModule {
  spawn: (file: string, args: string[] | string, options: unknown) => unknown
}

const resolveSharedNodePty = (): NodePtySpawnModule | undefined => {
  try {
    const resolved = require.resolve('node-pty', { paths: resolutionPaths() })
    return require(resolved) as NodePtySpawnModule
  } catch {
    return undefined
  }
}

const readPtyStartOptions = (options: unknown): PtyStartOptions => {
  if (typeof options !== 'object' || options === null) {
    return {}
  }
  const record = options as Record<string, unknown>
  return {
    cols: typeof record.cols === 'number' ? record.cols : undefined,
    rows: typeof record.rows === 'number' ? record.rows : undefined
  }
}

/**
 * Replaces the shared `node-pty` module's `spawn()` — the same instance
 * WeTTY resolves via `import pty from 'node-pty'` and calls as
 * `pty.spawn(...)`, a plain property lookup rather than a destructured
 * import, so reassigning it here is visible to WeTTY's own code. Every call
 * that isn't an SSH spawn (WeTTY's username-prompt helper, local mode's
 * `login(1)`) passes straight through to the real `node-pty`.
 *
 * Returns a no-op remover when `node-pty` can't be resolved (e.g. it isn't
 * installed) — nothing to patch, and probeNodePty() already reports that
 * case separately.
 */
export const installSshPtyPatch = (
  sshConfig: WettySshOptions,
  nodePtyModule: NodePtySpawnModule | undefined = resolveSharedNodePty()
): (() => void) => {
  if (!nodePtyModule) {
    return () => {}
  }
  const original = nodePtyModule.spawn
  nodePtyModule.spawn = (
    file: string,
    args: string[] | string,
    options: unknown
  ) => {
    if (typeof args !== 'string' && looksLikeSshSpawn(file, args)) {
      return spawnSshPty(sshConfig, args, readPtyStartOptions(options))
    }
    return original(file, args, options)
  }
  return () => {
    nodePtyModule.spawn = original
  }
}
