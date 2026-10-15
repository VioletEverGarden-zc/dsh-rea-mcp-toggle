/**
 * Schema gate for the model-facing half of this bundle.
 *
 * `ctx.tools.register()` takes a RAW JSON Schema and `dsh-llm-deepseek` ships it
 * verbatim as `input_schema`; the provider then validates it. `defineTool()` is
 * the other face: there `parameters` is an author-side property map, and a
 * property marked `required: true` is hoisted by the compiler into the owning
 * object's `required: [...]`. Writing the author-side marker into a raw schema
 * (what `index.js` did until 2026-10-13) sends `"required": true` to the
 * provider verbatim, and every turn dies with
 *
 *   Invalid schema for function 'rea_mcp_toggle': true is not of type 'array'
 *
 * before a single tool call runs. This script reads the `parameters` literal
 * straight out of the Host module, so the check cannot drift from the shipped
 * schema, and validates it with the Harness' own checker in the Harness'
 * installation (the same `assertSupportedJsonSchema` the runtime uses).
 *
 * Usage:
 *   node scripts/check-tool-schema.mjs [index.js]      # default: index.js
 * The Harness installation is located automatically (see scripts/lib/harness-paths.mjs).
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importHarnessModule } from './lib/harness-paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(process.argv[2] ?? resolve(here, '..'), process.argv[2] === undefined ? 'index.js' : '')

const tools = await importHarnessModule('@deepseek-ai/dsh-tools')

/** Slice one balanced `{ ... }` literal starting at the given `{` index. */
function balanced(text, openIndex) {
  let depth = 0
  let quote = ''
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(openIndex, i + 1)
    }
  }
  throw new Error('unbalanced literal in ' + target)
}

const source = readFileSync(target, 'utf8')
const toolStart = source.indexOf("name: 'rea_mcp_toggle'")
if (toolStart < 0) throw new Error('no `rea_mcp_toggle` definition found in ' + target)
const paramsKey = source.indexOf('parameters:', toolStart)
const parameters = eval('(' + balanced(source, source.indexOf('{', paramsKey)) + ')')

/** Argument cases the tool promises to accept or reject. */
const CASES = [
  ['{action:"status"}', { action: 'status' }, true],
  ['{action:"probe"}', { action: 'probe' }, true],
  ['{action:"set",enabled:true}', { action: 'set', enabled: true }, true],
  ['{action:"set",enabled:false}', { action: 'set', enabled: false }, true],
  ['{action:"set"}', { action: 'set' }, true],
  ['{} (action omitted)', {}, false],
  ['{action:"jump"}', { action: 'jump' }, false],
  ['{action:"status",nope:1}', { action: 'status', nope: 1 }, false],
]

console.log('file        : ' + target)
console.log('input_schema: ' + JSON.stringify(parameters))

let failed = false
try {
  tools.assertSupportedJsonSchema(parameters)
  console.log('assertSupportedJsonSchema: PASS')
} catch (error) {
  failed = true
  console.log('assertSupportedJsonSchema: ' + error.name + ' — ' + error.message)
}

for (const [label, args, expectAccepted] of CASES) {
  const violations = tools.validateJsonSchemaValue(parameters, args, '')
  const accepted = violations.length === 0
  if (accepted !== expectAccepted) failed = true
  console.log(
    (accepted === expectAccepted ? 'ok  ' : 'BAD ') +
      (accepted ? 'accept ' : 'reject ') +
      label +
      (violations.length > 0 ? ' → ' + violations.join('; ') : ''),
  )
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(failed ? 1 : 0)
