#!/usr/bin/env node
/**
 * Idempotent seam guard for dsh-rea-mcp-toggle.
 *
 * `rea setup --client dsh` (run when REA is installed or upgraded) rewrites the
 * whole file `%DSH_HOME%/cordis.patch.yml`. The rewritten file keeps the
 * `rea-mcp` row with fresh `config`, but drops the caller-owned row-level
 * `disabled: !!js` expression — which is the seam this plugin reads. The toggle
 * then turns into a silent no-op: the UI still flips, the state file is still
 * written, and the REA row never consults either of them.
 *
 * This script only APPENDS the seam. It never rewrites the file, so an error
 * cannot truncate it, and it copies the file to a timestamped backup first.
 * When the seam is already present it prints nothing and exits 0, so it is safe
 * to run on every DSH session start (SessionStart hook) without polluting the
 * session context.
 *
 * Exit codes
 *   0  seam present, or appended just now
 *   1  I/O error
 *   2  patch file missing / DSH home unknown
 *   3  no `id: rea-mcp` row: refusing to touch the file
 *
 * Usage
 *   node scripts/ensure_seam.mjs                     # reads $DSH_HOME
 *   node scripts/ensure_seam.mjs --home "D:\.dsh"    # explicit DSH home
 *   node scripts/ensure_seam.mjs --quiet             # suppress the success line
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ANCHOR = 'id: rea-mcp'
const SEAM_MARK = 'disabled: !!js'

const SEAM = `      # ── 开关缝：由 dsh-rea-mcp-toggle 插件读取 ──────────────────────────
      # 让 rea-mcp 行可被 Harness Web UI 开关 / rea_mcp_toggle 工具切换，且重启后仍生效。
      # rea setup --client dsh 重写本文件时会丢掉这个 disabled 表达式；
      # scripts/ensure_seam.mjs 负责幂等回填（只追加，绝不重写）。
      # 状态文件：%DSH_PROFILE_DIR%\\.rea-mcp-toggle.state.json 形如 {"enabled": true}
      # 缺失/损坏时保持启用，不会让 harness 起不来。
      disabled: !!js >-
        Boolean(ctx.get('profileContext')?.dir) && (() => { try { return process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8') && JSON.parse(process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:path').join(ctx.get('profileContext').dir, '.rea-mcp-toggle.state.json'), 'utf8')).enabled === false } catch { return false } })()
`

function parseArgs (argv) {
  const out = { home: process.env.DSH_HOME || '', quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--home' || a === '-H') out.home = argv[++i] || ''
    else if (a.startsWith('--home=')) out.home = a.slice('--home='.length)
    else if (a === '--quiet' || a === '-q') out.quiet = true
    else if (a === '--help' || a === '-h') {
      console.log('usage: node scripts/ensure_seam.mjs [--home <DSH_HOME>] [--quiet]')
      process.exit(0)
    }
  }
  return out
}

function stamp () {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const { home, quiet } = parseArgs(process.argv.slice(2))

if (!home) {
  console.error('[ensure_seam] DSH home unknown: set DSH_HOME or pass --home <dir>')
  process.exit(2)
}

const patch = join(home, 'cordis.patch.yml')
if (!existsSync(patch)) {
  console.error(`[ensure_seam] patch file missing: ${patch}`)
  process.exit(2)
}

let text
try {
  text = readFileSync(patch, 'utf8')
} catch (err) {
  console.error(`[ensure_seam] unreadable patch: ${err.message}`)
  process.exit(1)
}

// Already seam-guarded (or the seam was intentionally removed with the row):
// a re-written file without the row is handled by the anchor check below.
if (text.includes(SEAM_MARK)) process.exit(0)

if (!text.includes(ANCHOR)) {
  console.error(`[ensure_seam] refusing to append: no "${ANCHOR}" row in ${patch}`)
  process.exit(3)
}

const backup = `${patch}.bak-${stamp()}`
try {
  copyFileSync(patch, backup)
  const nl = text.endsWith('\n') ? '' : '\n'
  appendFileSync(patch, nl + SEAM, 'utf8')
} catch (err) {
  console.error(`[ensure_seam] append failed: ${err.message}`)
  process.exit(1)
}

if (!quiet) {
  console.log(`[ensure_seam] seam restored in ${patch} (backup ${backup.split(/[\\/]/).pop()})`)
  console.log('[ensure_seam] restart the DSH session so the rewritten rea-mcp row is reloaded.')
}
process.exit(0)
