/**
 * Mechanism probe: which patch layer decides the `rea-mcp` row's `disabled`
 * flag, and does a later `insert` that re-declares the id win?
 *
 * Uses the Harness's own `applyEntryPatches` / `composeEntries`, so the answer
 * is the boot algorithm's answer, not an assumption. Read-only.
 *
 * Usage: node scripts/probe-layer-order.mjs [profileDir] [homeDir]
 * Run `node scripts/link-deps.mjs` once first: Harness packages resolve through
 * this package's own node_modules link.
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

const live = appBoot.readProfilePatches('dsh', context)
const show = (label, patches) => {
  const rows = appBoot.composeEntries([patches]).filter((row) => row.id === 'rea-mcp')
  console.log(label, '->', JSON.stringify(rows))
}

show('A. live layers as they are now', live)

// B. An override patch placed in the PROFILE layer (what the plugin manager writes).
const profileIndex = live.findIndex((p) => p.id === 'rea-mcp-toggle' && p.disabled === false)
const override = { id: 'rea-mcp', disabled: true }
const b = [...live.slice(0, profileIndex + 1), override, ...live.slice(profileIndex + 1)]
show('B. profile-layer override appended before the home layer', b)

// C. A later `insert` that re-declares the id AFTER the home layer.
const afterHome = [...live, { insert: [{ id: 'rea-mcp', name: '@deepseek-ai/dsh-mcp-client', disabled: true }] }]
show('C. insert re-declaring rea-mcp after the home layer', afterHome)

// D. Same as C, but with the flag as a !!js expression object.
const jsRow = { insert: [{ id: 'rea-mcp', name: '@deepseek-ai/dsh-mcp-client', disabled: { __jsExpr: 'true' } }] }
show('D. insert after the home layer with a !!js disabled', [...live, jsRow])
