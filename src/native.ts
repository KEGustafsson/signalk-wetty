import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * WeTTY allocates its PTYs through `node-pty`, which is a compiled addon. The
 * Signal K app store installs plugins with `npm install --ignore-scripts`, so
 * on any platform without a shipped prebuild (notably every Linux target —
 * node-pty only ships darwin and win32 binaries) the addon is present as
 * source but never compiled. Detecting that up front turns a confusing crash
 * inside WeTTY into an actionable plugin status message.
 */

export interface NativeProbeResult {
  available: boolean
  /** Directory of the resolved node-pty package, when it could be located. */
  packageDir?: string
  /** Directory to run `npm rebuild` from, i.e. the parent of node_modules. */
  projectDir?: string
  error?: string
}

export interface RebuildResult {
  ok: boolean
  output: string
}

const MODULE_NOT_FOUND = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'])

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

/**
 * Candidate resolution roots, in order: this plugin's own directory (npm
 * hoists node-pty next to the plugin in the common case), then WeTTY's own
 * package directory (for a nested install).
 */
const resolutionPaths = (): string[] => {
  const paths = [__dirname]
  try {
    // wetty is ESM-only, so only the package root is exported; resolving the
    // entry point and walking up is the portable way to find its directory.
    const wettyEntry = require.resolve('wetty')
    paths.push(
      path.dirname(wettyEntry),
      path.resolve(path.dirname(wettyEntry), '..')
    )
  } catch {
    // wetty itself is missing; probeNodePty() will report that separately.
  }
  return paths
}

export const probeNodePty = (): NativeProbeResult => {
  let resolved: string
  try {
    resolved = require.resolve('node-pty', { paths: resolutionPaths() })
  } catch (err) {
    return {
      available: false,
      error: `node-pty could not be resolved: ${errorMessage(err)}`
    }
  }

  // node-pty's entry point sits in lib/, so the package root is one level up.
  const packageDir = path.resolve(path.dirname(resolved), '..')
  const nodeModulesDir = path.dirname(packageDir)
  const projectDir = path.dirname(nodeModulesDir)

  try {
    require(resolved)
    return { available: true, packageDir, projectDir }
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : ''
    const hint = MODULE_NOT_FOUND.has(code)
      ? 'the compiled binding is missing'
      : 'the compiled binding could not be loaded'
    return {
      available: false,
      packageDir,
      projectDir,
      error: `node-pty is installed but ${hint}: ${errorMessage(err)}`
    }
  }
}

export const nativeHelpText = (probe: NativeProbeResult): string => {
  if (probe.available) {
    return ''
  }
  const where = probe.projectDir ? ` in ${probe.projectDir}` : ''
  return [
    'The terminal needs the node-pty native module, which the Signal K app store',
    'cannot compile because it installs plugins with --ignore-scripts.',
    `Run "npm rebuild node-pty --build-from-source"${where}, or use the Rebuild`,
    'button on the WeTTY Terminal webapp, then restart the plugin.',
    'Building requires python3, make and a C++ compiler (build-essential).'
  ].join(' ')
}

/**
 * Runs `npm rebuild node-pty` for the install that {@link probeNodePty}
 * located. Resolves rather than rejects on a failed build so the caller can
 * surface the compiler output to the user.
 */
export const rebuildNodePty = (
  probe: NativeProbeResult,
  timeoutMs = 10 * 60 * 1000
): Promise<RebuildResult> =>
  new Promise((resolve) => {
    if (!probe.projectDir) {
      resolve({
        ok: false,
        output: 'node-pty is not installed, so there is nothing to rebuild.'
      })
      return
    }

    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(
      npm,
      ['rebuild', 'node-pty', '--build-from-source', '--foreground-scripts'],
      {
        cwd: probe.projectDir,
        env: process.env,
        shell: process.platform === 'win32'
      }
    )

    let output = ''
    const collect = (chunk: Buffer) => {
      // Keep only the tail: a failing node-gyp run produces a lot of noise and
      // the interesting error is always at the end.
      output = (output + chunk.toString()).slice(-16384)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      output += `\nTimed out after ${Math.round(timeoutMs / 1000)}s.`
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        output: `${output}\nFailed to run npm: ${err.message}`
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: output.trim() })
    })
  })
