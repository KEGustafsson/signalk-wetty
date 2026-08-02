# signalk-wetty

A [Signal K](https://signalk.org) server plugin that embeds
[WeTTY](https://github.com/butlerx/wetty) — a browser terminal built on xterm.js
— and publishes it as a webapp in the Signal K admin UI.

The terminal starts and stops with the plugin, inside the Signal K server
process. There is no separate service to install, no systemd unit and nothing to
keep running: enable the plugin and **Webapps → WeTTY Terminal** appears in the
admin UI.

<p align="center">
  <img src="doc/screenshot.jpg" alt="The terminal embedded in the Signal K admin UI" width="640">
</p>

## Requirements

|                 |                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js         | 20 or newer                                                                                                                                             |
| Signal K server | 2.x                                                                                                                                                     |
| Build tools     | `python3`, `make`, `g++` — see [Native module](#native-module-node-pty)                                                                                 |
| For SSH mode    | an `ssh` client on the machine (or container) running Signal K, and an SSH server to connect to — see [SSH availability check](#ssh-availability-check) |

## Install

Not published on the official Signal K app store — see
[How it works](#how-it-works) for why. Install from GitHub Packages, next to
your Signal K configuration:

```sh
cd ~/.signalk
printf "@kegustafsson:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}\n" > .npmrc
npm install @kegustafsson/signalk-wetty
```

The package is published at
<https://github.com/KEGustafsson/signalk-wetty/pkgs/npm/signalk-wetty>.
Set `GITHUB_TOKEN` to a GitHub token that can read packages for the
`KEGustafsson` account before running the install command.

Or, from a checkout of this repository, build and install a tarball directly:

```sh
npm install && npm run build && npm pack
cd ~/.signalk && npm install --save /path/to/signalk-wetty-<version>.tgz
```

Then restart the server and enable the plugin.

> **After installing, read [Native module](#native-module-node-pty) first.**
> Installing with `npm install --ignore-scripts` — what the app store would
> have used, and a reasonable thing to do yourself — leaves WeTTY's
> `node-pty` native module uncompiled. The plugin detects this and offers a
> one-click fix.

## How it works

```text
browser ──▶ Signal K server :3000 ──▶ /signalk-wetty/                the webapp shell
                                 ├──▶ /plugins/signalk-wetty/status
                                 │                            admin-only status route
                                 └──▶ /plugins/signalk-wetty/terminal/ ─┐
                                          reverse-proxied, WebSocket    │
                                          upgrades included             ▼
                                                              WeTTY on 127.0.0.1,
                                                          not exposed to the network
                                                                        │
                                                                        ▼
                                                                 ssh ──▶ your shell
```

Two separate mechanisms make this genuinely embedded, not just present on the
same server:

**The admin UI panel.** Signal K's admin UI uses [Webpack Module
Federation](https://webpack.js.org/concepts/module-federation/) for
embeddable webapps: a package whose `package.json` `keywords` include
`signalk-embeddable-webapp` gets a `<script src="/<name>/remoteEntry.js">`
loaded, and the admin UI mounts whatever component that bundle exposes as
`./AppPanel` directly inside its own layout, at `/admin/#/e/signalk-wetty` —
nav and header stay visible. Without that keyword and bundle, clicking a
webapp just navigates to `/<name>/` as an ordinary, separate page. `public/`
ships that pre-built bundle; `webpack.config.js` builds it from
`src/components/AppPanel.tsx`, which stays deliberately thin — it just
iframes the same `/signalk-wetty/` page a direct visit would load, so there
is only one implementation of the terminal UI to maintain.

**Reaching WeTTY itself.** WeTTY keeps running exactly as before, on its own
internal port, but that port is loopback-only by default and every
request — including the socket.io connection that upgrades to a WebSocket —
is reverse-proxied through Signal K's own origin and port, under
`/plugins/signalk-wetty/terminal/`. The browser only ever talks to Signal K;
WeTTY's port is never reachable from the network unless the Bind address
setting is deliberately widened. This works over `openplotter.local`, an IP
address or a Tailscale name exactly like the rest of the admin UI, since
there is no separate host or port to work out.

WebSocket upgrades need the Signal K server's own underlying HTTP server,
because Express middleware alone cannot intercept an `'upgrade'` event. This
is the same technique
[signalk-embedded-webapp-proxy](https://github.com/KEGustafsson/signalk-embedded-webapp-proxy)
uses to embed arbitrary web apps (Portainer, Grafana, Node-RED, …) in the
admin UI, with one difference: the server is not read off the plugin `app`
object, where it is not part of the documented `@signalk/server-api` and can
move without notice. It is taken from the first request the plugin's own
router serves — the terminal page always loads over HTTP before its session
upgrades, and that request necessarily arrived through the very server the
upgrade will arrive on. Nothing outside the documented plugin API is
touched, and there is no server-internal shape to break when Signal K
changes.

## Configuration

Everything below is set under **Server → Plugin Config → WeTTY Terminal**.

| Option                       | Default             | Notes                                                                                                                                                                                                  |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal port                | `3001`              | WeTTY's own internal port. The terminal is reachable through the embedded webapp regardless of this setting; it only matters if you also widen the bind address below.                                 |
| Bind address                 | `127.0.0.1`         | Loopback-only by default. Set to `0.0.0.0` only to also expose WeTTY directly on the network, bypassing Signal K's own access control — see [Security](#security).                                     |
| Page title                   | `Signal K Terminal` | Shown in the browser tab when the direct port is opened. WeTTY's base path is not configurable — it is always `/plugins/signalk-wetty/terminal`, the embedded webapp's own mount path.                 |
| Allow embedding in an iframe | `true`              | Only matters for the direct port: it is always same-origin (and so always framable) through the embedded webapp. Governs `X-Frame-Options` and the CSP `frame-ancestors` directive on the direct port. |
| WeTTY log level              | `info`              | WeTTY's own logging is reported through this plugin's debug log rather than written to the server console, so it appears only while plugin debugging is enabled. `silent` drops it entirely.           |
| Connection mode              | `ssh`               | See below.                                                                                                                                                                                             |
| Command                      | `login`             | Command run for each session. `login` starts an interactive login shell.                                                                                                                               |

### Connection mode

**`ssh` (default)** — every session runs `ssh` to the configured host, so the
user authenticates with their own account. This works no matter which user the
Signal K server runs as.

**`local`** — WeTTY runs `login(1)` directly, without SSH. WeTTY only permits
this when the server process runs as **root**; a typical `pi`/`signalk` service
account cannot call `login(1)`. When local mode is selected but the server is not
root, the plugin falls back to SSH and says so in its status line.

### SSH availability check

In `ssh` mode every session shells out to the local `ssh` binary, so the
plugin checks for it on start — this is a check of the machine (or
container) Signal K itself runs on, not the remote host being connected to.
A minimal container image easily ends up without one; that is exactly how
this check came to exist. If it is missing, the terminal page still loads —
only sessions fail — and the webapp shows an install command for the
platform:

```sh
# Debian, Ubuntu, Raspberry Pi OS, OpenPlotter
sudo apt update && sudo apt install -y openssh-client
# Alpine (a common base for minimal containers)
apk add openssh-client
```

Installing it does not take effect until the plugin restarts — unlike the
server check below, there is no live "Check again" for this one, since
nothing changes for the already-running process until then.

The plugin separately opens a connection to the configured SSH host on start
and waits for the server's identification string (`SSH-2.0-…`). A plain TCP
connect is not enough — anything can be listening on port 22, and reporting that
as a working SSH server would send you looking in the wrong place.

If nothing answers, the terminal still starts. The page loads fine without an
SSH server; it is the sessions inside it that fail, and the moment you start
sshd they work without touching the plugin. What you get instead is a plugin
error saying what is missing, and a panel above the terminal in the webapp with
the commands to fix it and a **Check again** button.

On this machine, that usually means installing or starting an SSH server:

```sh
# Debian, Ubuntu, Raspberry Pi OS, OpenPlotter
sudo apt install -y openssh-server && sudo systemctl enable --now ssh
# Raspberry Pi OS alternative: sudo raspi-config → Interface Options → SSH
```

- **Venus OS** — enable SSH on LAN in Settings → General, or `svc -u /service/ssh`.
- **macOS** — System Settings → General → Sharing → Remote Login.
- **Windows** — Settings → System → Optional features → Add → OpenSSH Server,
  then `Start-Service sshd`.

For a remote SSH host the advice is about reachability instead — a firewall or a
stopped service on that machine, not something to install locally.

`local` mode does not shell out to `ssh`, so the check is skipped entirely.

### SSH settings

| Option                     | Default            | Notes                                                                                                                            |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| SSH host / port            | `localhost` / `22` |                                                                                                                                  |
| SSH user                   | _empty_            | Empty means the terminal prompts for a username on every connection.                                                             |
| Preferred authentication   | `password`         | Passed to `ssh -o PreferredAuthentications`.                                                                                     |
| Known hosts file           | `/dev/null`        | Point at a real `known_hosts` to enable strict host key checking.                                                                |
| Private key file           | _empty_            | **Insecure.** Anything that reaches the terminal port logs in without a password.                                                |
| `ssh_config` file          | _empty_            | `ssh -F`.                                                                                                                        |
| Password                   | _empty_            | **Insecure.** Stored in clear text in the plugin configuration and requires `sshpass` on the server. Leave empty to be prompted. |
| Allow host/port in the URL | `false`            | Lets `?host=&port=` in the URL pick the SSH destination.                                                                         |
| Allow command/path in URL  | `false`            | Lets `?command=&path=` in the URL pick what runs.                                                                                |

### HTTPS

Set a key and certificate path and enable HTTPS to have WeTTY serve TLS itself.
Both paths must be set; a half-configured pair is ignored and the terminal stays
on plain HTTP.

## Security

The embedded webapp (`/plugins/signalk-wetty/terminal/`, and the
`/signalk-wetty/` page that loads it) is protected by Signal K's own admin
authentication for regular HTTP requests — the same as
`/plugins/signalk-wetty/status` and every other plugin route — because it now
runs through Signal K's own origin rather than a separate port. One nuance:
WebSocket upgrades are forwarded through a raw `'upgrade'` listener on the
server's own HTTP server (see [How it works](#how-it-works)), which bypasses Signal K's
normal Express middleware and so is not itself session-checked. In practice
this is not an open door — socket.io requires a session ID issued during its
initial HTTP polling handshake, which _is_ behind Signal K's auth, before it
accepts a WebSocket upgrade for that session — but it is a narrower guarantee
than the regular HTTP routes get, worth knowing if you are reasoning about
this precisely.

**If you widen the Bind address setting beyond `127.0.0.1`**, WeTTY's own
port becomes directly reachable and Signal K's authentication does not apply
to it at all. What protects a session opened that way is the SSH login inside
it — with the defaults (no stored password, no private key) a visitor gets an
SSH prompt and needs real credentials.

That changes if you configure a stored password or a private key path: those
turn the terminal into passwordless shell access for anyone who can reach the
port directly. Only use them with the bind address left at `127.0.0.1`, or
behind your own additional authenticating reverse proxy.

## Native module (`node-pty`)

WeTTY allocates PTYs through
[`node-pty`](https://github.com/microsoft/node-pty), a compiled addon.
`node-pty` ships prebuilt binaries for macOS and Windows only, so on Linux —
every Raspberry Pi, OpenPlotter and Venus OS install — it has to be compiled at
install time.

Published packages can include Linux x64, arm64 and armv7 `pty.node` prebuilds under
`native-prebuilds/`. When one matches the host, the plugin copies it into
`node-pty`'s expected `prebuilds/linux-*/pty.node` directory before loading
WeTTY, so no plugin install script is needed.

Run the **Native node-pty prebuilds** GitHub Actions workflow to build those
files on native Linux x64 and arm64 runners and commit them back into the
repository. The same workflow also publishes a GitHub Packages npm package as
`@kegustafsson/signalk-wetty`.

The Signal K app store installs plugins with `npm install --ignore-scripts`,
which skips that compile step. The plugin therefore:

- declares `wetty` as an **optional** dependency, so an app store install never
  fails outright,
- probes `node-pty` on start and, if it cannot be loaded, refuses to start WeTTY
  and reports exactly what is wrong in the plugin status,
- installs a bundled Linux x64/arm64/armv7 prebuild into `node-pty` when available,
- offers a **Rebuild node-pty** button in the webapp as a fallback, which runs
  `npm rebuild node-pty --foreground-scripts` in the Signal K install directory.

The equivalent from a shell:

```sh
sudo apt install -y python3 make g++      # Debian / Raspberry Pi OS
cd ~/.signalk && npm rebuild node-pty --foreground-scripts
```

Restart the plugin afterwards.

## HTTP API

Both routes are admin-only.

### `GET /plugins/signalk-wetty/status`

```json
{
  "running": true,
  "message": "Terminal embedded at /plugins/signalk-wetty/terminal/ — ssh to localhost:22",
  "error": null,
  "scheme": "http",
  "port": 3001,
  "basePath": "/plugins/signalk-wetty/terminal",
  "allowIframe": true,
  "requestedMode": "ssh",
  "effectiveMode": "ssh",
  "runningAsRoot": false,
  "native": { "available": true, "error": null, "help": "" },
  "rebuild": {
    "running": false,
    "startedAt": null,
    "finishedAt": null,
    "ok": null,
    "output": ""
  },
  "sshClient": { "available": true, "error": null, "help": "" },
  "ssh": {
    "checked": true,
    "reachable": true,
    "host": "localhost",
    "port": 22,
    "banner": "SSH-2.0-OpenSSH_9.6p1 Debian-3",
    "error": null,
    "help": "",
    "checkedAt": "2026-08-01T14:22:31.004Z"
  }
}
```

### `GET /plugins/signalk-wetty/ssh-check`

Re-runs the SSH availability check and returns the `ssh` block above, so you can
confirm a freshly started sshd without restarting the plugin.

### `POST /plugins/signalk-wetty/rebuild-native`

Compiles `node-pty`. Returns
`{ "ok": true, "nativeAvailable": true, "output": "…" }`. The build can take
several minutes on a Raspberry Pi.

## Development

```sh
npm install          # installs deps and compiles node-pty
npm run build        # TypeScript -> dist/, and the AppPanel bundle -> public/
npm test             # build + unit and live-server tests
npm run lint
npm run prettier:check
npm run coverage
```

### Test layout

| Suite                            | What it covers                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/config.test.js`            | Option resolution, coercion and the JSON Schema, including that schema defaults never drift from code defaults.                                                 |
| `test/plugin.test.js`            | The plugin surface, start/stop/restart, error reporting and all HTTP routes (including the embedded terminal proxy), against a fake WeTTY.                      |
| `test/wetty-runner.test.js`      | WeTTY option mapping, shutdown behaviour and the Prometheus-registry reset that makes restarts work.                                                            |
| `test/native.test.js`            | `node-pty` probing and the rebuild helper.                                                                                                                      |
| `test/ssh-probe.test.js`         | The SSH availability check against a fake server: a real banner, an impostor, a silent listener, a closed port, and the advice text.                            |
| `test/csp-patch.test.js`         | Stripping `frame-ancestors`/`upgrade-insecure-requests` from WeTTY's CSP header — see [How it works](#how-it-works).                                            |
| `test/env-version-patch.test.js` | The `env --version` crash workaround, against WeTTY's real parsing logic.                                                                                       |
| `test/embedded-proxy.test.js`    | The reverse proxy: path rewriting (including the root-path redirect-loop case), WebSocket upgrade dispatch, error handling.                                     |
| `test/webapp.test.js`            | That the webapp stays self-contained and handles every status branch.                                                                                           |
| `test/package.test.js`           | A local mirror of the app store packaging rules, including that the Module Federation bundle exposes `AppPanel` correctly.                                      |
| `test/live-server.test.js`       | A real WeTTY instance, reverse-proxied exactly as Signal K would: page, socket.io handshake, iframe headers, port reuse, a port clash. Skipped without a build. |

### Integration test

A real Signal K server with the plugin installed, packed and installed exactly
the way npm would:

```sh
npm run integration                       # packs, installs and boots signalk-server, then asserts
KEEP_WORKDIR=1 npm run integration        # keep the temporary install for inspection
SIGNALK_VERSION=2.23.0 npm run integration
```

### CI

`.github/workflows/signalk-ci.yml` calls Signal K's shared plugin workflow
(`SignalK/signalk-server/.github/workflows/plugin-ci.yml@master`), which is what
the app store reads test results from. It runs on Linux x64/arm64, macOS and
Windows across Node 22 and 24, validates the package against the app store rules,
exercises start/stop/restart and simulates an `--ignore-scripts` install. Manual
runs can additionally enable the armv7 (Cerbo GX) matrix.

That validation includes a scan for plugins reaching into server internals,
which is why the WebSocket-capable embedding (see
[How it works](#how-it-works)) takes the HTTP server from a request it serves
rather than from the plugin `app` object: the embedding works exactly the
same way, without depending on anything outside the documented
`@signalk/server-api` surface.

## Licence

MIT — see [LICENSE](LICENSE). WeTTY is MIT licensed and remains the copyright of
its authors.
