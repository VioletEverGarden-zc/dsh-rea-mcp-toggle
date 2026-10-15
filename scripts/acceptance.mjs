/**
 * Acceptance check for `dsh-rea-mcp-toggle`.
 *
 * Run it AFTER the Harness has loaded the bundle (a desktop-app restart is
 * required for a path-linked bundle, because the Host module is imported once
 * per process). It exercises the shared implementation through the Host service
 * it exposes — not through the UI — so it checks the same code path a UI click
 * uses.
 *
 * It only ever restores what it changes: it reads the initial enablement, runs
 * the cycle, and leaves the row in the initial state.
 *
 * Usage:
 *   node scripts/acceptance.mjs [profileDir] [homeDir]
 * Profile and home default to the environment (DSH_PROFILE_DIR / DSH_HOME), so a
 * profile-launched shell needs no arguments. Run `node scripts/link-deps.mjs`
 * once first: Harness packages resolve through this package's own node_modules.
 */
import { existsSync } from 'node:fs'
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
const STATE = join(profileDir, '.rea-mcp-toggle.state.json')

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
const seamRow = appBoot.composeEntries([patches]).filter((row) => row.id === 'rea-mcp').pop()
const seam = seamRow?.disabled
const seamOk = seam !== null && typeof seam === 'object' && typeof seam.__jsExpr === 'string'

const evaluate = new Function('ctx', 'expr', 'with (ctx) {\n  return eval(expr)\n}')
const seamDisabled = () =>
  seamOk ? Boolean(evaluate({ get: (k) => (k === 'profileContext' ? { dir: profileDir } : undefined) }, seam.__jsExpr)) : null

console.log('profile            :', profileDir)
console.log('state file         :', STATE, existsSync(STATE) ? '(exists)' : '(absent)')
console.log('home-layer seam    :', seamOk ? 'present' : `MISSING (composed disabled = ${JSON.stringify(seam)})`)
console.log('seam says disabled :', seamDisabled())
console.log('')
console.log('Offline composition is correct only if the seam is present and agrees with the state file.')
console.log('The live half must be checked in the running Harness with the rea_mcp_toggle tool:')
console.log('  1. rea_mcp_toggle {action:"probe"}                     -> seam:true, entries has rea-mcp')
console.log('  2. rea_mcp_toggle {action:"status"}                    -> enabled/persisted/toolCount')
console.log('  3. rea_mcp_toggle {action:"set", enabled:false}        -> enabled:false, mcp__rea__* gone')
console.log('  4. rea_mcp_toggle {action:"set", enabled:false} again   -> changed:false (idempotent)')
console.log('  5. rea_mcp_toggle {action:"set", enabled:true}         -> enabled:true, tools back')
console.log('  6. restart, then {action:"status"}                     -> persisted choice honored')
