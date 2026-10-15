/**
 * Verify the home-layer `!!js` seam end to end, without touching any real
 * profile file.
 *
 * It parses a patch list written in the Cordis entry-list YAML dialect
 * (`!!js`, through the same `entryListSchema` the Loader uses), then evaluates
 * the resulting expression with the Loader's own evaluator
 * (`new Function('ctx','expr','with (ctx) { return eval(expr) }')`) under three
 * conditions: no state file, `enabled: false`, and `enabled: true`.
 *
 * Usage: node scripts/probe-seam.mjs
 * Run `node scripts/link-deps.mjs` once first: Harness packages are resolved
 * through this package's own node_modules link.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importHarnessModule } from './lib/harness-paths.mjs'

const includeModule = await importHarnessModule('@deepseek-ai/cordis-plugin-include')
const yaml = await importHarnessModule('js-yaml')

/** The exact expression the home layer carries. */
const EXPR =
  "Boolean(ctx.get('profileContext')?.dir) && (() => { try { return process.getBuiltinModule('node:fs')" +
  ".readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, " +
  "'.rea-mcp-toggle.state.json'), 'utf8')" +
  " && JSON.parse(process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8')).enabled === false } catch { return false } })()"

const seam = `- id: rea-mcp
  disabled: !!js >-
    ${EXPR}
`

const rows = yaml.load(seam, { schema: includeModule.entryListSchema })
const rea = rows.find((row) => row.id === 'rea-mcp')
console.log('parsed disabled node:', JSON.stringify(rea?.disabled))
if (rea === undefined || typeof rea.disabled?.__jsExpr !== 'string') {
  console.log('FAIL: the assembled seam did not parse into a !!js expression')
  process.exit(1)
}
const expression = rea.disabled.__jsExpr

// The Loader's own evaluator, copied from @deepseek-ai/cordis-plugin-loader.
const evaluate = new Function('ctx', 'expr', 'with (ctx) {\n  return eval(expr)\n}')

const dir = mkdtempSync(join(tmpdir(), 'rea-seam-'))
const statePath = join(dir, '.rea-mcp-toggle.state.json')
const context = () => ({ get: (key) => (key === 'profileContext' ? { dir } : undefined) })

const run = (label) => {
  let value
  try {
    value = evaluate(context(), expression)
  } catch (error) {
    value = `THREW: ${error.message}`
  }
  console.log(label.padEnd(28), '->', value)
  return value
}

try {
  const missing = run('no state file')
  writeFileSync(statePath, `${JSON.stringify({ enabled: false })}\n`, 'utf8')
  const off = run('state enabled: false')
  writeFileSync(statePath, `${JSON.stringify({ enabled: true })}\n`, 'utf8')
  const on = run('state enabled: true')
  const noContext = evaluate({ get: () => undefined }, expression)
  console.log('no profileContext'.padEnd(28), '->', noContext)

  const ok = missing === false && off === true && on === false && noContext === false
  console.log(ok ? 'PASS: the seam disables exactly when the state file says enabled:false' : 'FAIL')
  process.exitCode = ok ? 0 : 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
