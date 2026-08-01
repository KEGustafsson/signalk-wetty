# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `POST /plugins/signalk-wetty/rebuild-native` now answers `202` immediately and
  reports progress through `rebuild` in the status payload, instead of holding
  the response open for the whole compile. A proxy in front of the admin UI
  would otherwise time out and report a failure for a build still in progress.
- A second rebuild request while one is running is refused with `409` rather
  than starting a second `node-gyp` run in the same build directory.

### Fixed

- A `node-pty` rebuild that hits its timeout now settles instead of leaving the
  caller waiting forever — killing the child does not guarantee a `close` event,
  particularly on Windows where the child is a shell wrapper.
- `docker/entrypoint.sh` sets the Signal K port through `PORT`; the `-p` flag it
  used before is not a `signalk-server` option and was silently ignored.
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
