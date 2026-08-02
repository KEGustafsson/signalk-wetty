# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  sections — this uses `app.server`, which is outside the documented
  `@signalk/server-api` surface, so the plugin is no longer aimed at the
  official app store.
- SSH availability check. In `ssh` mode the plugin now connects to the
  configured SSH host at start and waits for the server's identification
  string, so a missing or stopped sshd is reported once with instructions for
  the platform instead of showing up as an unexplained session failure every
  time somebody opens the terminal. The terminal still starts, the webapp shows
  the fix above it, and `GET /plugins/signalk-wetty/ssh-check` re-runs the check
  so a freshly started sshd can be confirmed without restarting the plugin.
- SSH client availability check. In `ssh` mode every session shells out to
  the local `ssh` binary, and on a minimal container image there may not be
  one — exactly what happened during this work. The plugin now checks for it
  on start (`sshClient` in the status payload) and, if missing, reports it
  and shows an install command in the webapp, the same way a missing SSH
  server is reported. `local` mode never probes for it.

### Changed

- WeTTY no longer writes to the Signal K server console. `WeTTY log level`
  gained a `silent` option and now defaults to it, so a plugin nobody is
  debugging stops logging every connection, disconnection and asset request
  into the server log. The level is also applied before WeTTY starts rather
  than after, so its own startup logging is suppressed too. Set any other
  level to get the old output back; the plugin's own diagnostics are
  unaffected and still go through `app.debug()`.
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

[Unreleased]: https://github.com/KEGustafsson/signalk-wetty/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/KEGustafsson/signalk-wetty/releases/tag/v0.1.0
