/**
 * Local install step for `dsh-rea-mcp-toggle`.
 *
 * `plugin_manager install_bundle` links this package by path, so Node resolves
 * its bare imports from the package's REAL directory (this workspace) instead of
 * the profile's node_modules. The Harness resolves a profile bundle's imports
 * against the dsh installation, so this step points the package's own
 * `node_modules/@deepseek-ai` at the installation's scope, which is where the
 * Harness's own Cordis runtime and Typert protocol live. Without it the Host
 * half fails to import and the row reports "failed to import".
 *
 * Re-run after moving this package, after `pnpm install`, or when the Harness
 * installation path changes.
 *
 * Usage:
 *   node scripts/link-deps.mjs [harnessRoot]
 * The root is found the same way the other scripts find it (argument →
 * `.harness-root` → `DSH_HARNESS_ROOT` → this platform's standard installation
 * roots → the running Harness); see scripts/lib/harness-paths.mjs. Every
 * candidate is validated against the marker packages, so a wrong directory never
 * wins silently.
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarnessRoot } from './lib/harness-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')

const harnessRoot = resolveHarnessRoot(process.argv[2])
const scope = join(harnessRoot, 'node_modules', '@deepseek-ai')

const link = join(packageDir, 'node_modules')
try {
  if (lstatSync(link)) rmSync(link, { recursive: true, force: true })
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}
mkdirSync(link, { recursive: true })
symlinkSync(scope, join(link, '@deepseek-ai'), 'junction')
console.log('linked ' + join(link, '@deepseek-ai') + ' -> ' + scope)

// Plain packages the scripts import directly (they are Harness installations'
// own dependencies, so they are not inside the @deepseek-ai scope).
for (const name of ['react', 'js-yaml']) {
  const from = join(harnessRoot, 'node_modules', name)
  if (!existsSync(from)) {
    console.log('skipped ' + name + ' (not installed in the Harness tree)')
    continue
  }
  symlinkSync(from, join(link, name), 'junction')
  console.log('linked ' + join(link, name) + ' -> ' + from)
}
