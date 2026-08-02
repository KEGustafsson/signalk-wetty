import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(dirname, '..')

if (process.platform !== 'linux') {
  throw new Error(
    `node-pty prebuilds must be produced on Linux runners, not ${process.platform}. ` +
      'Run the "Native node-pty prebuilds" GitHub Actions workflow to build linux-x64, linux-arm64 and linux-arm.'
  )
}

if (!['arm', 'arm64', 'x64'].includes(process.arch)) {
  throw new Error(
    `node-pty prebuilds are only produced for arm/arm64/x64, not ${process.arch}`
  )
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
execFileSync(npm, ['rebuild', 'node-pty', '--foreground-scripts'], {
  cwd: root,
  stdio: 'inherit'
})

const nodePtyEntry = require.resolve('node-pty')
const nodePtyPackage = path.resolve(path.dirname(nodePtyEntry), '..')
const source = path.join(nodePtyPackage, 'build', 'Release', 'pty.node')
if (!fs.existsSync(source)) {
  throw new Error(`node-pty rebuild finished, but ${source} was not created`)
}

const destination = path.join(
  root,
  'native-prebuilds',
  `linux-${process.arch}`,
  'pty.node'
)
fs.mkdirSync(path.dirname(destination), { recursive: true })
fs.copyFileSync(source, destination)
console.log(`Wrote ${path.relative(root, destination)}`)
