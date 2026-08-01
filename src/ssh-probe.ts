import net from 'node:net'

/**
 * In the default `ssh` connection mode every terminal session shells out to
 * `ssh`. When no SSH server is listening the WeTTY page still loads perfectly
 * and then each session dies immediately, which looks like a plugin fault
 * rather than a missing service. Probing the SSH port once at start turns that
 * into a plain statement of what is wrong and how to fix it.
 */

export interface SshProbeResult {
  reachable: boolean
  host: string
  port: number
  /** The server's identification string, e.g. "SSH-2.0-OpenSSH_9.6p1". */
  banner: string | null
  error: string | null
  /** Node's socket error code, when the failure produced one. */
  code: string | null
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0'])

export const isLocalHost = (host: string): boolean =>
  LOCAL_HOSTS.has(host.toLowerCase())

/**
 * Opens a TCP connection and waits for the SSH identification string defined
 * by RFC 4253 §4.2. A plain connect is not enough on its own: anything at all
 * can be listening on the port, and "something accepted the connection" would
 * be a misleading thing to report as a working SSH server.
 */
export const probeSshServer = (
  host: string,
  port: number,
  timeoutMs = 2500
): Promise<SshProbeResult> =>
  new Promise((resolve) => {
    const base = { host, port }
    const socket = new net.Socket()
    let settled = false
    let connected = false
    let banner = ''

    const settle = (result: Omit<SshProbeResult, 'host' | 'port'>) => {
      if (settled) {
        return
      }
      settled = true
      socket.destroy()
      resolve({ ...base, ...result })
    }

    socket.setTimeout(timeoutMs)

    socket.on('timeout', () => {
      settle(
        connected
          ? {
              reachable: false,
              banner: null,
              code: null,
              error: `something is listening on ${host}:${port} but it did not identify itself as an SSH server`
            }
          : {
              reachable: false,
              banner: null,
              code: 'ETIMEDOUT',
              error: `no answer from ${host}:${port} within ${timeoutMs}ms`
            }
      )
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      settle({
        reachable: false,
        banner: null,
        code: err.code ?? null,
        error: err.message
      })
    })

    socket.on('connect', () => {
      connected = true
    })

    socket.on('data', (chunk: Buffer) => {
      banner += chunk.toString('latin1')
      // The identification string ends at the first CR/LF. Give up on a server
      // that sends a lot of something else rather than buffering it.
      if (!banner.includes('\n') && banner.length < 512) {
        return
      }
      const line = banner.split(/\r?\n/)[0].trim()
      settle(
        line.startsWith('SSH-')
          ? { reachable: true, banner: line, code: null, error: null }
          : {
              reachable: false,
              banner: null,
              code: null,
              error: `${host}:${port} answered but is not an SSH server`
            }
      )
    })

    socket.on('close', () => {
      settle({
        reachable: false,
        banner: null,
        code: null,
        error: `${host}:${port} closed the connection before identifying itself`
      })
    })

    socket.connect(port, host)
  })

/**
 * Turns a failed probe into instructions. The wording leads with the most
 * likely cause for the host that was actually probed — a refused connection on
 * localhost almost always means the SSH server is simply not installed or not
 * running, whereas the same error against a remote host is as likely to be a
 * firewall.
 */
export const sshHelpText = (probe: SshProbeResult): string => {
  if (probe.reachable) {
    return ''
  }

  const target = `${probe.host}:${probe.port}`
  const local = isLocalHost(probe.host)

  const cause =
    probe.code === 'ECONNREFUSED'
      ? local
        ? `Nothing is listening on ${target}, so no SSH server is running on this machine.`
        : `${target} refused the connection — the SSH server is not running, or a firewall is rejecting it.`
      : probe.code === 'ENOTFOUND' || probe.code === 'EAI_AGAIN'
        ? `The host name "${probe.host}" could not be resolved.`
        : probe.code === 'ETIMEDOUT' || probe.code === 'EHOSTUNREACH'
          ? `${target} did not answer, which usually means a firewall is dropping the connection.`
          : `${target} could not be used for SSH: ${probe.error}.`

  const consequence =
    'The terminal page will still load, but every session will fail until this is fixed.'

  if (!local) {
    return `${cause} ${consequence} Check that an SSH server is running on ${probe.host} and that port ${probe.port} is reachable from this machine, or point the plugin at a different SSH host.`
  }

  return [
    cause,
    consequence,
    'To enable SSH:',
    '• Debian, Ubuntu, Raspberry Pi OS and OpenPlotter — sudo apt install -y openssh-server && sudo systemctl enable --now ssh (on a Pi you can also use sudo raspi-config → Interface Options → SSH).',
    '• Venus OS — enable SSH on LAN in Settings → General, or run svc -u /service/ssh.',
    '• macOS — System Settings → General → Sharing → Remote Login.',
    '• Windows — Settings → System → Optional features → Add → OpenSSH Server, then Start-Service sshd.',
    'Alternatively, switch the plugin to a different SSH host, or to local mode if the Signal K server runs as root.'
  ].join(' ')
}
