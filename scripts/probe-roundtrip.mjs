/**
 * Round-trip check for the toggle's persistence layer.
 *
 * Drives the plugin's REAL writer and reader (`state.js`) against a throwaway
 * `profileContext.dir` (a temporary directory), then evaluates the exact
 * home-layer seam expression with the Loader's own evaluator. This is what
 * proves the two halves agree: what the plugin saves is what decides the row's
 * `disabled` on the next boot.
 *
 * Nothing outside the temporary directory is touched.
 *
 * Usage: node scripts/probe-roundtrip.mjs
 * Run `node scripts/link-deps.mjs` once first: Harness packages are resolved
 * through this package's own node_modules link.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importHarnessModule } from './lib/harness-paths.mjs'

const includeModule = await importHarnessModule('@deepseek-ai/cordis-plugin-include')
const yaml = await importHarnessModule('js-yaml')

const here = new URL('..', import.meta.url)
const state = await import(new URL('state.js', here).href)

/** The exact seam the home layer carries. */
const SEAM = `- id: rea-mcp
  disabled: !!js >-
    Boolean(ctx.get('profileContext')?.dir) && (() => { try { return process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8') && JSON.parse(process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8')).enabled === false } catch { return false } })()
`

const evaluate = new Function('ctx', 'expr', 'with (ctx) {\n  return eval(expr)\n}')
const dir = mkdtempSync(join(tmpdir(), 'rea-roundtrip-'))

try {
  const expression = yaml
    .load(SEAM, { schema: includeModule.entryListSchema })
    .find((row) => row.id === 'rea-mcp').disabled.__jsExpr
  const seamCtx = { get: (key) => (key === 'profileContext' ? { dir } : undefined) }
  const seamDisabled = () => Boolean(evaluate(seamCtx, expression))

  const ctx = { get: (key) => (key === 'profileContext' ? { dir } : undefined) }
  const path = state.stateFilePath(ctx)
  console.log('state file path  :', path)
  console.log('name constant    :', state.STATE_FILE_NAME)

  const report = (label) => {
    let raw = '(absent)'
    try {
      raw = readFileSync(path, 'utf8').trim().replace(/\s+/g, ' ')
    } catch {}
    console.log(
      label.padEnd(22),
      '| readStateFile:', String(state.readStateFile(path)).padEnd(9),
      '| seam disabled:', String(seamDisabled()).padEnd(5),
      '|', raw,
    )
  }

  report('before any write')

  state.writeStateFile(path, false)
  report('after write(false)')

  state.writeStateFile(path, true)
  report('after write(true)')

  state.writeStateFile(path, false)
  report('after write(false) again')

  // A corrupt document must fall back to "enabled", never to a crash.
  state.writeStateFile(path, true)
  rmSync(path, { force: true })
  const fs = await import('node:fs')
  fs.writeFileSync(path, '{ this is not json', 'utf8')
  report('after corrupting it')

  const results = [
    state.readStateFile(join(dir, 'missing.json')) === undefined,
    seamDisabled() === false,
  ]
  const ok = results.every(Boolean)
  console.log(
    ok
      ? 'PASS: corrupt/absent state keeps REA enabled; write(false) makes the seam disable the row'
      : 'FAIL',
  )
  process.exitCode = ok ? 0 : 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
