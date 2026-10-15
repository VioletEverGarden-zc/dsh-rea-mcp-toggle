/**
 * Persistence for `dsh-rea-mcp-toggle`: one small JSON document per profile.
 *
 * This module is the single writer and reader of that file. The home layer's
 * `!!js` seam reads the same field with the same path, so the only thing that
 * has to stay in sync between the two halves is `STATE_FILE_NAME` and the shape
 * `{ enabled: boolean }` — both defined here.
 *
 * Nothing here touches the home patch file or the profile patch file.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * State file name inside the profile directory. Fixed rather than configurable
 * on purpose: the seam's expression hard-codes it, so a configurable path could
 * silently disagree with the seam.
 */
export const STATE_FILE_NAME = '.rea-mcp-toggle.state.json'

/** Absolute state-file path for one profile directory. */
export function stateFilePathIn(dir) {
  return join(dir, STATE_FILE_NAME)
}

/**
 * Absolute state-file path for the running profile.
 *
 * `profileContext.dir` is the same value the seam reads, so it is tried first;
 * the environment variables cover a Host without that service, and the package
 * directory is the last resort so the value is never empty.
 * @param ctx - the owning Cordis context, or anything with `get(name)`.
 * @returns an absolute path (not necessarily existing).
 */
export function stateFilePath(ctx) {
  const fromService = ctx?.get('profileContext')?.dir
  if (typeof fromService === 'string' && fromService !== '') return stateFilePathIn(fromService)
  const dir = process.env.DSH_PROFILE_DIR
  if (dir !== undefined && dir !== '') return stateFilePathIn(dir)
  const home = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE
  if (home !== undefined && home !== '' && profile !== undefined && profile !== '') {
    return stateFilePathIn(join(home, 'profiles', profile))
  }
  return stateFilePathIn(dirname(dirname(fileURLToPath(import.meta.url))))
}

/**
 * Read the persisted choice.
 * @param path - absolute state-file path.
 * @returns `true`/`false` for an explicit value, `undefined` when the file is
 *   absent, unreadable, or does not carry a boolean `enabled`.
 */
export function readStateFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.enabled === 'boolean') {
      return parsed.enabled
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the choice atomically, through a temporary file in the same
 * directory, so a reader never sees a partial document.
 * @param path - absolute state-file path.
 * @param enabled - the value the seam must read on the next boot.
 */
export function writeStateFile(path, enabled) {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ enabled, savedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}
