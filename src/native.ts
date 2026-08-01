import { spawn } from 'node:child_process'
import fs from 'node:fs'
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

export interface RebuildCommand {
  command: string
  args: string[]
}

interface SpawnCommand {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
}

const MODULE_NOT_FOUND = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'])
const SUPPORTED_PREBUILD_ARCHES = new Set(['arm64', 'x64'])

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export const bundledNodePtyPrebuildPath = (
  platform = process.platform,
  arch = process.arch,
  prebuildRoot = path.resolve(__dirname, '..', 'native-prebuilds')
): string | null => {
  if (platform !== 'linux' || !SUPPORTED_PREBUILD_ARCHES.has(arch)) {
    return null
  }
  return path.join(prebuildRoot, `linux-${arch}`, 'pty.node')
}

export const nodePtyPrebuildTargetPath = (
  packageDir: string,
  platform = process.platform,
  arch = process.arch
): string | null => {
  if (platform !== 'linux' || !SUPPORTED_PREBUILD_ARCHES.has(arch)) {
    return null
  }
  return path.join(packageDir, 'prebuilds', `linux-${arch}`, 'pty.node')
}

export const installBundledNodePtyPrebuild = (
  packageDir: string,
  platform = process.platform,
  arch = process.arch,
  prebuildRoot = path.resolve(__dirname, '..', 'native-prebuilds')
): string | null => {
  const source = bundledNodePtyPrebuildPath(platform, arch, prebuildRoot)
  const target = nodePtyPrebuildTargetPath(packageDir, platform, arch)
  if (!source || !target || !fs.existsSync(source)) {
    return null
  }

  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return target
}

/**
 * Candidate resolution roots for anything inside WeTTY's dependency tree, in
 * order: this plugin's own directory (npm hoists dependencies next to the
 * plugin in the common case), then WeTTY's own package directory (for a nested
 * install). Only directories belong here — `require.resolve`'s `paths` option
 * walks up from each entry looking for `node_modules`.
 */
export const resolutionPaths = (): string[] => {
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
  let prebuildInstallError: string | undefined

  try {
    installBundledNodePtyPrebuild(packageDir)
  } catch (err) {
    prebuildInstallError = errorMessage(err)
  }

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
      error: [
        `node-pty is installed but ${hint}: ${errorMessage(err)}`,
        prebuildInstallError
          ? `Bundled native prebuild could not be installed: ${prebuildInstallError}`
          : ''
      ]
        .filter(Boolean)
        .join(' ')
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
    `Run "npm rebuild node-pty --foreground-scripts"${where}, or use the Rebuild`,
    'button on the WeTTY Terminal webapp, then restart the plugin.',
    'Building requires python3, make and a C++ compiler (build-essential).'
  ].join(' ')
}

export const nodePtyRebuildCommand = (): RebuildCommand => ({
  command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
  args: ['rebuild', 'node-pty', '--foreground-scripts']
})

export const verifyNodePtyCommand = (
  projectDir: string,
  timeoutMs = 30 * 1000
): SpawnCommand => ({
  command: process.execPath,
  args: ['-e', "require('node-pty')"],
  cwd: projectDir,
  timeoutMs
})

const runCommand = ({
  command,
  args,
  cwd,
  timeoutMs
}: SpawnCommand): Promise<RebuildResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: process.platform === 'win32'
    })

    let output = ''
    const collect = (chunk: Buffer) => {
      // Keep only the tail: a failing node-gyp run produces a lot of noise and
      // the interesting error is always at the end.
      output = (output + chunk.toString()).slice(-16384)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    // The timeout has to settle the promise itself rather than rely on a
    // subsequent 'close': killing the process is not guaranteed to produce one.
    let settled = false
    const settle = (result: RebuildResult) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({
        ok: false,
        output:
          `${output}\nTimed out after ${Math.round(timeoutMs / 1000)}s.`.trim()
      })
    }, timeoutMs)
    timer.unref?.()

    child.on('error', (err) => {
      settle({
        ok: false,
        output: `${output}\nFailed to run ${command}: ${err.message}`.trim()
      })
    })

    child.on('close', (code) => {
      settle({ ok: code === 0, output: output.trim() })
    })
  })

/**
 * Runs `npm rebuild node-pty` for the install that {@link probeNodePty}
 * located. Resolves rather than rejects on a failed build so the caller can
 * surface the compiler output to the user.
 */
export const rebuildNodePty = async (
  probe: NativeProbeResult,
  timeoutMs = 10 * 60 * 1000
): Promise<RebuildResult> => {
  if (!probe.projectDir) {
    return {
      ok: false,
      output: 'node-pty is not installed, so there is nothing to rebuild.'
    }
  }

  const rebuild = nodePtyRebuildCommand()
  const rebuildResult = await runCommand({
    command: rebuild.command,
    args: rebuild.args,
    cwd: probe.projectDir,
    timeoutMs
  })

  if (!rebuildResult.ok) {
    return rebuildResult
  }

  const verify = await runCommand(verifyNodePtyCommand(probe.projectDir))
  if (verify.ok) {
    return rebuildResult
  }

  return {
    ok: false,
    output:
      `${rebuildResult.output}\nnode-pty still cannot be loaded after rebuild:\n${verify.output}`.trim()
  }
}
