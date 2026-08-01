import type { NativeProbeResult, RebuildResult } from './native'
import type { WettyLoader } from './wetty-runner'

/**
 * Seams the test suite injects into the plugin factory. The Signal K server
 * only ever passes the app object, so every entry falls back to the real
 * implementation.
 */
export interface PluginDeps {
  loadWetty?: WettyLoader
  probeNative?: () => NativeProbeResult
  rebuildNative?: (probe: NativeProbeResult) => Promise<RebuildResult>
}
