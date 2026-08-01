import { execFileSync } from 'node:child_process'

/**
 * In `ssh` connection mode every terminal session shells out to the local
 * `ssh` binary. When it is missing — common on minimal container images,
 * which is exactly how this came up — the WeTTY page still loads perfectly
 * and each session then dies immediately with no explanation, exactly like a
 * missing SSH server. This probes for it once at start so the plugin can say
 * so plainly instead of leaving it to be discovered session by session.
 */

export interface SshClientProbe {
  available: boolean
  error: string | null
}

export type ExecFileSync = (
  command: string,
  args: string[],
  options: { stdio: 'ignore' }
) => unknown

const isEnoent = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err as { code?: unknown }).code === 'ENOENT'

export const probeSshClient = (
  exec: ExecFileSync = execFileSync
): SshClientProbe => {
  try {
    exec('ssh', ['-V'], { stdio: 'ignore' })
    return { available: true, error: null }
  } catch (err) {
    if (isEnoent(err)) {
      return { available: false, error: 'ssh: command not found' }
    }
    // Some OpenSSH builds exit non-zero on `-V` despite printing their
    // version correctly; anything other than ENOENT means the binary was
    // found and ran, which is all that matters here.
    return { available: true, error: null }
  }
}

export const sshClientHelpText = (probe: SshClientProbe): string => {
  if (probe.available) {
    return ''
  }
  return [
    'The terminal needs an SSH client to connect, and none is installed on this machine.',
    'Install one: "apt install openssh-client" (Debian, Ubuntu, Raspberry Pi OS),',
    '"apk add openssh-client" (Alpine), or the equivalent for this system.',
    'The terminal page will still load, but every session will fail until this is fixed.'
  ].join(' ')
}
