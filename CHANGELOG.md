# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-08-04

### Fixed

- Restarting the plugin and then opening a terminal that prompts for a
  username killed the whole Signal K server with SIGSEGV — no stack trace,
  no log line, just a process that was suddenly gone (and, under a container
  restart policy, a server that came back a few seconds later). The bundled
  `pty.node` was reinstalled with `fs.copyFileSync` on every `start()`, and
  from the second one onwards that rewrote, in place, the very file node-pty
  already had mapped into the server's address space; the next call into it
  faulted. In `ssh` mode the only call that ever reaches node-pty is WeTTY's
  own username prompt, which is why it took an empty `ssh.user` to show up.
  The prebuild is now left alone when it already holds the right bytes, and
  otherwise staged beside the target and renamed into place, so a mapping
  another process is holding is never disturbed (see `src/native.ts`).

- WeTTY's service worker request logged a `NotFoundError: Not Found` stack
  trace on every terminal load from a browser in a secure context. WeTTY
  serves the file with `res.sendFile()` using an absolute path and no `root`
  option, so `send` applies its dotfile rule to every segment of the
  filesystem path — and Signal K always lives in `~/.signalk`, which matches.
  The file was there all along; only WeTTY's own path handling refused to
  send it. The proxy now answers that one request itself, so it never reaches
  WeTTY. What it serves is deliberately not WeTTY's own worker: that worker
  has never run on a Signal K install — the 404 meant it was never installed
  — so switching its caching on in front of the terminal's socket.io traffic
  would buy an offline cache of a page that is useless without the server it
  talks to. The worker served instead registers, deletes WeTTY's own cache by
  name, unregisters itself, and installs no `fetch` handler at all, so nothing
  on the terminal's path is ever intercepted. Cache Storage is keyed per
  origin rather than per worker scope, so it deliberately does not enumerate
  the origin's caches — the admin UI and every other Signal K webapp and
  plugin share that storage (see `src/service-worker-asset.ts`).
- WeTTY's own username prompt (shown in `ssh` mode whenever no SSH user is
  configured) reported its exit with a bare `console.error()` call, bypassing
  the winston logger entirely — so `Process exited with code: 0` reached the
  Signal K server console on every such session, even with the WeTTY log
  level set to "silent". It is now routed through the plugin's debug log like
  every other WeTTY log line (see `src/login-console-patch.ts`).
- The built-in SSH client showed a spurious
  `Permission denied, please try again.` before the very first password
  prompt on every connection. Local PAM-backed SSH servers commonly open
  keyboard-interactive authentication with one round that carries no prompts
  at all — a handshake step, not a login attempt — and that round's rejection
  was being reported as a wrong password the user never had a chance to type.
  The message now only appears once a real, user-submitted answer has
  actually been rejected (see `src/ssh-pty-bridge.ts`).

## [0.1.1] - 2026-08-02

### Added

- Genuine Signal K webapp embedding, in the sense the admin UI actually uses:
  a Module Federation bundle (`public/remoteEntry.js`, built by
  `webpack.config.js` from `src/components/AppPanel.tsx`) that the admin UI
  loads and renders inline at `/admin/#/e/signalk-wetty`, inside its own
  layout — not a plain link to a separate page. The `signalk-embeddable-webapp`
  keyword is what makes the admin UI use that route at all. The panel itself
  is deliberately thin: it iframes the existing webapp page, which now
  reaches WeTTY through a reverse proxy under
  `/plugins/signalk-wetty/terminal/` (WebSocket upgrades included) rather
  than a separate port the admin UI just framed. WeTTY's own basePath is
  always set to that same path so its self-generated asset and socket.io
  links resolve correctly, and WeTTY's own port is loopback-only by default,
  never reachable from the network unless the Bind address setting is
  deliberately widened. See the README's "How it works" and "Security"
  sections. Forwarding WebSocket upgrades takes the server's own
  `http.Server`, which is reached through a request the plugin's router
  serves rather than off the plugin `app` object — nothing outside the
  documented `@signalk/server-api` surface is touched.
- SSH availability check. In `ssh` mode the plugin now connects to the
  configured SSH host at start and waits for the server's identification
  string, so a missing or stopped sshd is reported once with instructions for
  the platform instead of showing up as an unexplained session failure every
  time somebody opens the terminal. The terminal still starts, the webapp shows
  the fix above it, and `GET /plugins/signalk-wetty/ssh-check` re-runs the check
  so a freshly started sshd can be confirmed without restarting the plugin.
- A built-in SSH client. `ssh` mode no longer shells out to the system `ssh`
  (and `sshpass`) binaries — WeTTY's own PTY spawn is transparently redirected
  to a pure-JS `ssh2` connection instead (see `src/ssh-pty-bridge.ts`), so no
  `openssh-client` install is needed inside the Signal K machine or container,
  which is what minimal Docker images used to be missing. Covers host/port/
  user with password or private-key auth, plus an interactive password prompt
  in the terminal itself when none is configured; does not support
  `ssh_config`, ProxyJump/bastion hosts, agent forwarding, or GSSAPI. As a
  side effect, a configured password is never exposed on a process's argv the
  way `sshpass -p <password>` used to.

### Changed

- WebSocket upgrade forwarding no longer reads the HTTP server off the plugin
  `app` object. That property is not part of the documented
  `@signalk/server-api` surface — Signal K's own plugin CI fails a build for
  reaching into it, and it can move without notice. The server is taken from
  the first request the plugin's router serves instead: the terminal page
  always loads over HTTP before its session upgrades, so the forwarder is in
  place by the time it is needed, and it is removed again on stop. The
  embedding behaves exactly as before.
- WeTTY no longer writes to the Signal K server console. Its winston console
  transport is redirected into the plugin's own `app.debug()`, which the
  server gates per plugin, so every connection, disconnection and asset
  request WeTTY logs is reported with the plugin's other debug output instead
  of unconditionally in the server log. The redirect is installed before
  WeTTY starts rather than after, so its own startup logging goes the same
  way. `WeTTY log level` still decides how much of it is reported and gained
  a `silent` option that drops it entirely.
- `Bind address` defaults to `127.0.0.1` (was `0.0.0.0`): the terminal is
  reachable through the embedded webapp regardless of this setting, so the
  direct port no longer needs to be exposed by default.
- `URL base path` is no longer a plugin setting. WeTTY's basePath is always
  the embedded proxy's own mount path now — a user-supplied value would
  break the embedding, since WeTTY's self-generated links would no longer
  match where the proxy actually reaches it.
- `GET /plugins/signalk-wetty/status`'s `message` field now describes the
  embedded path instead of the direct `scheme://host:port`, and `basePath`
  always reports that same path. The `loopbackOnly` field was removed; it no
  longer has a meaningful use now that the webapp does not build the
  terminal URL from the bind address.
- `POST /plugins/signalk-wetty/rebuild-native` now answers `202` immediately and
  reports progress through `rebuild` in the status payload, instead of holding
  the response open for the whole compile. A proxy in front of the admin UI
  would otherwise time out and report a failure for a build still in progress.
- A second rebuild request while one is running is refused with `409` rather
  than starting a second `node-gyp` run in the same build directory.

### Removed

- The local Docker integration environment (`docker/`, `npm run docker:up` /
  `docker:down`). It was never exercised by CI, and duplicated what
  `npm run integration` already covers against a real `signalk-server`
  install — kept up to date is more valuable than a second, drifting copy.

### Fixed

- The webapp icon never showed up: the admin UI resolves `signalk.appIcon`
  as `/<package name>/<appIcon>` — relative to what is actually served at
  `/signalk-wetty/` (the `public/` directory) — but it was declared as
  `./public/app-icon.svg`, a package-relative path, which resolved to
  `/signalk-wetty/public/app-icon.svg` and 404ed. `signalk.screenshots` was
  already correct as package-relative paths; only `appIcon` uses this
  different, undocumented convention.
- The root of the embedded terminal (`/plugins/signalk-wetty/terminal/`)
  redirected forever: WeTTY's own middleware 301s a trailing-slash request
  down to the no-slash path, and the proxy's mount-path stripping/re-adding
  reconstructed the same trailing slash on the redirected request, looping.
  Fixed by forwarding the bare root without a trailing slash.
- The terminal could not actually be embedded in the admin UI: WeTTY's own
  CSP always includes helmet's default `frame-ancestors 'self'`, which blocks
  framing from a different origin — the previous norm, since the admin UI and
  the terminal ran on different ports — even with `allowIframe: true` set.
  Also stripped `upgrade-insecure-requests` from the CSP when no TLS
  certificate is configured, which otherwise made browsers upgrade a later
  request to HTTPS against a server that only speaks plain HTTP
  (`SSL_ERROR_RX_RECORD_TOO_LONG`).
- A terminal session used to crash the entire Signal K server process, not
  just the plugin, on systems where `/usr/bin/env` comes from uutils-coreutils
  instead of GNU coreutils (Ubuntu 26.04 among them): WeTTY's own
  `env --version` parsing assumed GNU's output format and threw inside an
  `exec()` callback with no promise left to catch it. Fixed by feeding
  WeTTY's version probe a synthetic, safely-parseable answer before the real
  command runs.
- A `node-pty` rebuild that hits its timeout now settles instead of leaving the
  caller waiting forever — killing the child does not guarantee a `close` event,
  particularly on Windows where the child is a shell wrapper.
- Text files are checked out with LF everywhere, so the format check passes on
  Windows CI runners.
- Interactive SSH login (blank `SSH user`/password) could fail silently with
  no prompt and no error: `ssh2` gates the built-in client's keyboard-interactive
  attempt on a connection flag that was never set, so every attempt was
  rejected locally before ever reaching the server. Also, a wrong password
  ended the session immediately with no feedback; it now retries up to 3
  times, like `ssh` itself, showing "Permission denied, please try again."
  between attempts.

## [0.1.0] - 2026-08-01

Initial release.

### Added

- Embedded [WeTTY](https://github.com/butlerx/wetty) 3.x web terminal, started
  and stopped with the plugin inside the Signal K server process.
- Admin UI webapp (`signalk-webapp`) that embeds the terminal in an iframe and
  falls back to an "open in a new tab" link when embedding is disabled.
- Plugin configuration for port, bind address, base path, page title, iframe
  embedding, log level, connection mode (`ssh` or `local`), command, SSH
  settings and HTTPS key pair.
- `GET /plugins/signalk-wetty/status` describing the running terminal, and
  `POST /plugins/signalk-wetty/rebuild-native` to compile `node-pty` after an
  app store install.
- Detection and clear reporting of an uncompiled `node-pty`, which is the
  expected state after an app store install because the server installs
  plugins with `npm install --ignore-scripts`.
- Signal K plugin CI workflow, unit and live-server test suites, a local
  Docker integration environment and a `signalk-server` smoke test.

[Unreleased]: https://github.com/KEGustafsson/signalk-wetty/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/KEGustafsson/signalk-wetty/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/KEGustafsson/signalk-wetty/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/KEGustafsson/signalk-wetty/releases/tag/v0.1.0
