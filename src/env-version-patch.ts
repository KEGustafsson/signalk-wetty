import cp from 'node:child_process'

type ExecCallback = (
  error: Error | null,
  stdout: string,
  stderr: string
) => void

export interface ExecLike {
  exec: typeof cp.exec
}

const ENV_VERSION_COMMAND = '/usr/bin/env --version'

// Comfortably below the `-S` threshold WeTTY checks for (9), so it always
// takes the conservative code path it already falls back to when the probe
// fails — regardless of what /usr/bin/env on this system actually is.
const FAKE_GNU_ENV_VERSION_OUTPUT = 'env (GNU coreutils) 8.0\n'

const isCallback = (value: unknown): value is ExecCallback =>
  typeof value === 'function'

/**
 * WeTTY shells out to `env --version` before every session and parses the
 * output assuming GNU coreutils (`env (GNU coreutils) 9.x`) to decide
 * whether to pass `-S` to `env` when spawning the PTY. On a system where
 * `/usr/bin/env` comes from uutils-coreutils instead — the Rust
 * reimplementation some newer distros (Ubuntu 26.04 among them) now ship —
 * the real output is `env (uutils coreutils) 0.x`, WeTTY's parsing returns
 * `undefined`, and the resulting `.split()` call throws inside the
 * `exec()` callback. That callback has no promise left to reject and no
 * try/catch around it, so the throw becomes an uncaughtException on the
 * whole Signal K server process — every terminal session takes the entire
 * server down with it. A plugin-level `uncaughtException` handler cannot
 * reliably save this either: Signal K registers its own ahead of any
 * plugin's, and it exits before a later handler gets a turn.
 *
 * Feeding WeTTY's probe a synthetic, GNU-shaped answer before the real
 * `exec` call ever runs avoids the crash entirely, for exactly that one
 * command, without changing behaviour for anything else that shells out.
 */
export const installEnvVersionPatch = (target: ExecLike = cp): (() => void) => {
  const original = target.exec
  target.exec = ((command: string, ...rest: unknown[]) => {
    const callback = rest[rest.length - 1]
    if (command === ENV_VERSION_COMMAND && isCallback(callback)) {
      queueMicrotask(() => callback(null, FAKE_GNU_ENV_VERSION_OUTPUT, ''))
      return undefined
    }
    return Reflect.apply(original, target, [command, ...rest])
  }) as typeof cp.exec
  return () => {
    target.exec = original
  }
}
