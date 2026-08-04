import fs from 'node:fs'
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

/**
 * `ssh2` is loaded lazily, on the first actual SSH spawn, rather than
 * imported at module top. This file is reached through an unconditional
 * import chain — index.ts -> wetty-runner.ts -> here — so a static `ssh2`
 * import would make requiring the plugin's own entry point fail whenever
 * `ssh2` is not installed, in every connection mode, before start() (or its
 * own error handling) ever runs. Mirrors how `wetty` itself is only ever
 * dynamically imported inside WettyRunner.start().
 */
const loadSsh2 = (): typeof import('ssh2') =>
  require('ssh2') as typeof import('ssh2')

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
 * for `host` — matching both the plain `host` form and the `[host]:port`
 * form OpenSSH writes for a non-default port, since `ssh.port` is a
 * configurable option here. Hashed hostnames (`|1|salt|hash`) are not
 * supported — a niche combination with this plugin's own strict-checking
 * toggle, which most setups leave disabled (the default `knownHosts` is
 * `/dev/null`).
 */
const knownHostKeysFor = (
  knownHostsPath: string,
  host: string,
  port: number
): Buffer[] => {
  let content: string
  try {
    content = fs.readFileSync(knownHostsPath, 'utf8')
  } catch {
    return []
  }
  const accepted = new Set([host, `[${host}]:${port}`])
  const keys: Buffer[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue
    }
    const [hostsField, , keyBase64] = trimmed.split(/\s+/)
    if (
      !keyBase64 ||
      !hostsField.split(',').some((entry) => accepted.has(entry))
    ) {
      continue
    }
    // Buffer.from(..., 'base64') never throws — it silently drops invalid
    // characters — so a malformed line just produces a key that never
    // matches, which stays fail-closed without needing a try/catch here.
    keys.push(Buffer.from(keyBase64, 'base64'))
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
  host: string,
  port: number
): ((key: Buffer) => boolean) | undefined => {
  if (knownHosts === '' || knownHosts === '/dev/null') {
    return undefined
  }
  const trusted = knownHostKeysFor(knownHosts, host, port)
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
  for (const method of preferred) {
    if (method === 'publickey' && sshConfig.keyPath !== '') {
      plan.push({ type: 'publickey' })
    }
    if (method === 'password') {
      plan.push(
        sshConfig.password !== ''
          ? { type: 'password' }
          : { type: 'interactive' }
      )
    }
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

  const { Client } = loadSsh2()
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

  // Many PAM stacks (this is what a plain local `sshd` commonly does) open
  // keyboard-interactive with one round that carries zero prompts before the
  // real password prompt — a handshake step, not a login attempt. The user
  // is shown nothing and gets no chance to answer it, so its rejection must
  // never be reported as a wrong password; only set once a round has
  // actually asked the user something.
  let submittedRealAnswer = false

  conn.on(
    'keyboard-interactive',
    (_name, _instructions, _lang, prompts: Prompt[], finish) => {
      void (async () => {
        const answers: string[] = []
        for (const prompt of prompts) {
          answers.push(await askInteractively(prompt.prompt))
        }
        if (prompts.length > 0) {
          submittedRealAnswer = true
        }
        finish(answers)
      })()
    }
  )

  const authPlan = buildAuthPlan(sshConfig)
  let planIndex = 0
  let interactiveAttempts = 0
  // Matches `ssh`'s own client-side NumberOfPasswordPrompts default: a
  // server offering keyboard-interactive-via-PAM commonly never lists the
  // literal 'password' method at all, so without a client-side cap a wrong
  // guess had nothing else to fall back to and gave up after exactly one
  // attempt — silently, with no "wrong password" feedback shown.
  const MAX_INTERACTIVE_ATTEMPTS = 3

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
        let key: Buffer
        try {
          key = fs.readFileSync(sshConfig.keyPath)
        } catch {
          continue // Unreadable key file — fall through to the next plan step.
        }
        if (loadSsh2().utils.parseKey(key) instanceof Error) {
          // Most commonly an encrypted key: fs.readFileSync succeeds, so the
          // catch above never runs, and ssh2 would otherwise fail this deep
          // inside the handshake with a generic parse error the user can't
          // act on. This plugin has no passphrase option — the `ssh` binary
          // it replaced would have prompted for one interactively.
          emitData(
            `signalk-wetty: ${sshConfig.keyPath} could not be used as a private key (an encrypted key needs a passphrase, which is not supported)\r\n`
          )
          continue
        }
        next({ type: 'publickey', username: target.username, key })
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
      // action.type === 'interactive': keep retrying — preferring
      // keyboard-interactive, falling back to a manually-prompted password
      // — for as long as the server keeps offering either, capped at
      // MAX_INTERACTIVE_ATTEMPTS. Only gives up once neither is offered or
      // the cap is hit, matching a real `ssh` session's multiple tries
      // instead of ending after one guess.
      if (interactiveAttempts >= MAX_INTERACTIVE_ATTEMPTS) {
        planIndex += 1
        continue
      }
      if (submittedRealAnswer) {
        emitData('Permission denied, please try again.\r\n')
      }
      if (authsLeft === null || authsLeft.includes('keyboard-interactive')) {
        interactiveAttempts += 1
        next('keyboard-interactive')
        return
      }
      if (authsLeft.includes('password')) {
        interactiveAttempts += 1
        askInteractively(`${target.username}@${target.host}'s password: `).then(
          (password) => {
            submittedRealAnswer = true
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

  // Covers every quiet close `error` doesn't: Ctrl-C at the password prompt
  // and kill() before the channel opened both end the connection without an
  // error or an open channel, which otherwise left onExit never firing and
  // WeTTY's session (and its socket.io listeners) hanging forever. emitExit
  // is idempotent, so a channel close that already reported a real exit
  // code still wins over this fallback.
  conn.on('close', () => {
    awaitingPrompt?.('')
    awaitingPrompt = undefined
    emitExit(1)
  })

  const hostVerifier = makeHostVerifier(
    sshConfig.knownHosts,
    target.host,
    sshConfig.port
  )
  const connectConfig: ConnectConfig = {
    host: target.host,
    port: sshConfig.port,
    username: target.username,
    authHandler,
    // ssh2 gates the string-shorthand `next('keyboard-interactive')` on
    // this flag client-side, independently of the custom authHandler above:
    // without it, every such call is silently self-rejected before ever
    // reaching the server, `authsLeft` never narrows past its initial
    // `null`, and the manual password fallback below is never reached.
    tryKeyboard: true,
    readyTimeout: 20000,
    // A real `ssh` process has the same gap (no keepalive by default), so
    // this isn't fixing a regression — but an idle terminal behind a NAT or
    // stateful firewall can otherwise lose the TCP flow without either side
    // noticing, and the session hangs until the browser is reloaded.
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
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
