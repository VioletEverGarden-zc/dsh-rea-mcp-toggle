/**
 * Load Harness-provided modules and locate the Harness installation / profile,
 * without hard-coding a machine-specific path.
 *
 * Locating the Harness — search order
 * -----------------------------------
 *   1. an explicit argument (argv),
 *   2. `<repo>/.harness-root` — one line, the answer of last resort for a layout
 *      no standard location describes; easy to write and easy to delete
 *      (see `.harness-root.example`),
 *   3. `DSH_HARNESS_ROOT`,
 *   4. the well-known installation roots of this platform, each probed for the
 *      marker packages,
 *   5. the running Harness itself: its process command line names the `node.exe`
 *      inside the installation, so the root can be derived from it.
 *
 * Every candidate is VALIDATED against the marker packages, so a wrong guess
 * never silently wins — a directory that merely exists (for example the desktop
 * app's `%LOCALAPPDATA%\Programs\DeepSeek Harness` data directory, which holds
 * no Harness tree) is rejected.
 *
 * Why module resolution goes through this package's own `node_modules`
 * -------------------------------------------------------------------
 * `scripts/link-deps.mjs` creates `node_modules/@deepseek-ai` (a junction to the
 * Harness installation's scope) plus the few packages these scripts need. The
 * Harness itself usually lives OUTSIDE any checkout, so walking up from this file
 * can never find it; resolving from the package directory always can, because the
 * junction is there.
 *
 * @module scripts/lib/harness-paths.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This package's own directory: `<repo>/scripts/lib` → `<repo>`. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `require` anchored at the package directory, so the junctions are in scope. */
const requireFromPackage = createRequire(join(PACKAGE_DIR, 'package.json'))

/** Packages a valid Harness `node_modules` must contain. */
const HARNESS_MARKERS = [
  join('@deepseek-ai', 'cordis', 'package.json'),
  join('@deepseek-ai', 'dsh', 'package.json'),
  join('@deepseek-ai', 'dsh-tools', 'package.json'),
  // `js-yaml` is what keeps this check from matching this bundle's OWN
  // `node_modules` (created by link-deps.mjs, which links only the
  // `@deepseek-ai` scope and plain packages). Without it the search could
  // resolve the bundle directory as the Harness root and every
  // `require.resolve` of a Harness-provided package would fail.
  join('js-yaml', 'package.json'),
]

/** Directory name the desktop app gives the Harness tree it ships. */
const HARNESS_DIR_NAME = 'harness'

/**
 * Whether a directory is a Harness installation root.
 *
 * This package's own directory is excluded on purpose: `link-deps.mjs` puts the
 * `@deepseek-ai` junction and `js-yaml` INSIDE it, so without the guard the
 * checkout would validate as a Harness root and could be linked to itself.
 * @param candidate - absolute directory to test.
 * @returns true when every marker package is present under its `node_modules`.
 */
export function isHarnessRoot(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false
  const root = resolve(candidate)
  if (root === PACKAGE_DIR) return false
  const modules = join(root, 'node_modules')
  return HARNESS_MARKERS.every((marker) => existsSync(join(modules, marker)))
}

/**
 * Directories inside one installation prefix that may hold the Harness tree.
 *
 * A desktop install keeps it at `<app>/resources/harness`; a checkout keeps it at
 * the repository root. Both are probed, so either layout is found.
 * @param prefix - an installation prefix, already known to exist.
 * @param depth - remaining recursion depth.
 * @returns the valid Harness roots found under the prefix.
 */
function harnessRootsUnder(prefix, depth = 3) {
  const found = []
  if (isHarnessRoot(prefix)) found.push(prefix)
  if (depth <= 0) return found
  for (const child of ['resources', 'app', '.']) {
    const dir = child === '.' ? prefix : join(prefix, child)
    if (!existsSync(dir)) continue
    const nested = join(dir, HARNESS_DIR_NAME)
    if (existsSync(nested) && isHarnessRoot(nested)) found.push(nested)
    if (child === 'app') found.push(...harnessRootsUnder(dir, depth - 1))
  }
  return found
}

/**
 * Installation prefixes this platform conventionally uses.
 *
 * These are standard locations, not the author's paths: nothing here mentions a
 * specific drive, user name, or checkout.
 * @returns candidate prefixes that exist on disk.
 */
function wellKnownPrefixes() {
  const env = process.env
  const names = ['dsh-desktop', 'DeepSeek Harness', 'deepseek-harness']
  const roots = []
  const push = (base) => {
    if (base === undefined || base === '') return
    for (const name of names) roots.push(join(base, name))
  }
  if (process.platform === 'win32') {
    push(env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'))
    push(env.ProgramFiles)
    push(env['ProgramFiles(x86)'])
    push(env.LOCALAPPDATA)
  } else if (process.platform === 'darwin') {
    push('/Applications')
    push(env.HOME && join(env.HOME, 'Applications'))
  } else {
    push('/opt')
    push('/usr/local/lib')
    push('/usr/lib')
  }
  return roots.filter((root) => existsSync(root))
}

/**
 * The Harness the caller is currently running inside.
 *
 * The running `node.exe` lives at `<root>/node/node/bin/node.exe`, so the root is
 * derived from the process command line. This finds the installation even when it
 * sits somewhere no standard location describes.
 * @returns the derived root when it validates, else undefined.
 */
function fromRunningHarness() {
  const own = process.execPath
  const candidates = []
  // <root>/node/node/bin/node.exe → up four levels.
  let dir = dirname(own)
  for (let step = 0; step < 4; step += 1) {
    dir = dirname(dir)
    candidates.push(dir)
  }
  for (const candidate of candidates) {
    if (isHarnessRoot(candidate)) return candidate
  }
  return undefined
}

/** Contents of `<repo>/.harness-root`, when the file exists. */
function fromRepoMarkerFile() {
  const file = join(PACKAGE_DIR, '.harness-root')
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const value = line.trim()
      if (value === '' || value.startsWith('#')) continue
      if (isHarnessRoot(value)) return resolve(value)
      return undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Resolve the Harness installation root.
 * @param explicit - caller-supplied path (argv) that wins when it validates.
 * @returns absolute Harness root.
 * @throws when no candidate carries the marker packages.
 */
export function resolveHarnessRoot(explicit) {
  if (explicit !== undefined && explicit !== '' && isHarnessRoot(explicit)) {
    return resolve(explicit)
  }
  const marker = fromRepoMarkerFile()
  if (marker !== undefined) return marker
  if (process.env.DSH_HARNESS_ROOT && isHarnessRoot(process.env.DSH_HARNESS_ROOT)) {
    return resolve(process.env.DSH_HARNESS_ROOT)
  }
  for (const prefix of wellKnownPrefixes()) {
    const found = harnessRootsUnder(prefix)
    if (found.length > 0) return found[0]
  }
  const running = fromRunningHarness()
  if (running !== undefined) return running

  throw new Error(
    [
      'cannot locate the Harness installation.',
      'Give it one of these, in order of convenience:',
      '  * node scripts/link-deps.mjs "<HARNESS_ROOT>"',
      `  * a file ${join(PACKAGE_DIR, '.harness-root')} containing the root on one line (see .harness-root.example)`,
      '  * the DSH_HARNESS_ROOT environment variable',
      'A valid root contains node_modules/@deepseek-ai/{cordis,dsh,dsh-tools} and node_modules/js-yaml.',
      'With the desktop app that root is the `resources/harness` directory of its installation.',
    ].join('\n'),
  )
}

/**
 * Resolve one Harness-provided package to an absolute file URL.
 * @param id - package name, e.g. `@deepseek-ai/dsh-app-boot`.
 * @returns an absolute `file://` URL string.
 * @throws with an actionable message when the junction is missing.
 */
export function harnessModuleUrl(id) {
  try {
    return pathToFileURL(requireFromPackage.resolve(id)).href
  } catch (cause) {
    throw new Error(
      `cannot resolve "${id}" from this package. Run \`node scripts/link-deps.mjs\` first ` +
        '(it links the Harness scope into ./node_modules), or install the package there.',
      { cause },
    )
  }
}

/**
 * Dynamic-import one Harness-provided package.
 * @param id - package name.
 * @returns the imported module namespace.
 */
export function importHarnessModule(id) {
  return import(harnessModuleUrl(id))
}

/**
 * Whether this package's Harness link is present.
 * @returns true when `node_modules/@deepseek-ai/cordis` resolves.
 */
export function harnessLinkPresent() {
  try {
    requireFromPackage.resolve('@deepseek-ai/cordis')
    return true
  } catch {
    return false
  }
}

/**
 * Absolute path of one Harness package's own `package.json`.
 *
 * This is what `installAnchor` means to the boot code: the dsh app's manifest,
 * used as the FIRST resolution anchor for a profile bundle. Resolving it by
 * package name keeps the scripts independent of where the Harness is installed.
 * @param id - package name; defaults to the `dsh` CLI package.
 * @returns absolute manifest path.
 */
export function harnessManifestPath(id = '@deepseek-ai/dsh') {
  return requireFromPackage.resolve(`${id}/package.json`)
}

/**
 * Resolve a profile directory.
 *
 * Never guesses a path: it comes from an explicit argument or the environment
 * the Harness sets for profile-launched shells.
 * @param explicit - caller-supplied path (argv) that wins when it holds a manifest.
 * @returns absolute profile directory, or `undefined` when none resolves.
 */
export function resolveProfileDir(explicit) {
  const candidates = []
  if (explicit !== undefined && explicit !== '') candidates.push(resolve(explicit))
  if (process.env.DSH_PROFILE_DIR) candidates.push(resolve(process.env.DSH_PROFILE_DIR))
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    candidates.push(join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE))
  }
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Resolve the Harness home directory.
 * @param explicit - caller-supplied path (argv) that wins when set.
 * @returns absolute home directory, or `undefined`.
 */
export function resolveHarnessHome(explicit) {
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return undefined
}

/** How to report a missing profile to the operator. */
export const PROFILE_HELP =
  'cannot locate the profile directory: pass it as an argument, or run from a shell the Harness ' +
  'launched (which sets DSH_PROFILE_DIR / DSH_HOME + DSH_PROFILE)'

/** How to report a missing Harness home to the operator. */
export const HOME_HELP = 'cannot locate the Harness home: pass it as an argument or set DSH_HOME'
