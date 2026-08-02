/**
 * WeTTY's `ssh` mode prompts for a username itself whenever a session has no
 * `remote-user` header, no `/ssh/<user>` path and no static `ssh.user`
 * configured — see `config.ts`'s "Leave empty to have the terminal prompt
 * for a username on every connection" option, and
 * `wetty/build/server/command/address.js`'s call to `login()`. That prompt
 * runs as its own `node-pty` process (`wetty/build/server/login.js`,
 * spawning `buffer.js`), and when it exits, `login.js` reports the exit code
 * with a bare `console.error(...)` call rather than going through WeTTY's
 * winston logger.
 *
 * `routeLoggingToDebug()` (see wetty-runner.ts) only ever sees winston
 * records, so it never sees this one: every session that goes through the
 * username prompt writes `Process exited with code: 0` straight to the
 * Signal K server console — even with the WeTTY log level set to "silent".
 *
 * There is no module reference to patch — `console.error` is a bare global
 * call, not something `login.js` exposes — so instead the one message shape
 * it ever produces is matched by text and redirected to the plugin's own
 * debug log, the same place every other WeTTY log line ends up. Anything
 * else logged through `console.error` (including a real error with more than
 * one argument) passes through unchanged.
 */
const LOGIN_EXIT_MESSAGE = /^Process exited with code: -?\d+$/

export interface ConsoleErrorLike {
  error: (...args: unknown[]) => void
}

export const installLoginExitPatch = (
  log: (msg: string) => void,
  target: ConsoleErrorLike = console
): (() => void) => {
  const original = target.error
  target.error = (...args: unknown[]) => {
    if (
      args.length === 1 &&
      typeof args[0] === 'string' &&
      LOGIN_EXIT_MESSAGE.test(args[0])
    ) {
      log(`WeTTY ${args[0]}`)
      return
    }
    Reflect.apply(original, target, args)
  }
  return () => {
    target.error = original
  }
}
