/**
 * Offline composition check for the REA row.
 *
 * Runs the Harness's own patch composition (`readProfilePatches` /
 * `composeEntries` from `@deepseek-ai/dsh-app-boot`) exactly as boot and as the
 * plugin manager's `reload()` do, and prints the composed `rea-mcp` row.
 * Read-only: it prints what a boot would mount and changes nothing.
 *
 * Usage:
 *   node scripts/probe-composition.mjs [profileDir] [homeDir]
 * Both default to the environment (DSH_PROFILE_DIR / DSH_HOME), so a
 * profile-launched shell needs no arguments. Run `node scripts/link-deps.mjs`
 * once first: Harness packages resolve through this package's own node_modules.
 */
import { join } from 'node:path'
import {
  harnessManifestPath,
  importHarnessModule,
  resolveHarnessHome,
  resolveProfileDir,
  HOME_HELP,
  PROFILE_HELP,
} from './lib/harness-paths.mjs'

const profileDir = resolveProfileDir(process.argv[2])
if (profileDir === undefined) throw new Error(PROFILE_HELP)
const homeDir = resolveHarnessHome(process.argv[3])
if (homeDir === undefined) throw new Error(HOME_HELP)

const appBoot = await importHarnessModule('@deepseek-ai/dsh-app-boot')

const context = {
  dir: profileDir,
  patchPath: join(profileDir, 'cordis.patch.yml'),
  home: homeDir,
  installAnchor: harnessManifestPath(),
  overlays: [],
  telemetryDisabledEnv: undefined,
}

const patches = appBoot.readProfilePatches('dsh', context)
console.log('--- last 4 raw patches ---')
console.log(JSON.stringify(patches.slice(-4), null, 2))
const rows = appBoot.composeEntries([patches])
const rea = rows.filter((row) => row.id === 'rea-mcp')

console.log('patch layers:', patches.length)
console.log('composed rea-mcp rows:', JSON.stringify(rea, null, 2))
const last = rea[rea.length - 1]
console.log('effective disabled:', last === undefined ? 'row absent' : Boolean(last.disabled))
