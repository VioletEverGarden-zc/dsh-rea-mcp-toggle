/**
 * Host half of `dsh-rea-mcp-toggle`.
 *
 * One implementation of one operation — "should the REA MCP row run?" — shared
 * by both callers:
 *
 *   * the Web UI Session-header switch, over the Typert Remote namespace
 *     `reaMcp` (`getState` / `setEnabled`);
 *   * the agent tool `rea_mcp_toggle` (`status` / `set` / `probe`), which calls
 *     the very same service methods.
 *
 * Why the choice is NOT stored as a profile-layer `disabled` row
 * -------------------------------------------------------------
 * Measured with the Harness's own composition algorithm
 * (`scripts/probe-layer-order.mjs`, which drives `readProfilePatches` and
 * `composeEntries` from `@deepseek-ai/dsh-app-boot`):
 *
 *   * the REA row is declared by the hand-maintained HOME layer,
 *     `%DSH_HOME%/cordis.patch.yml`, and that layer is applied LAST of all
 *     layers — after the profile's own `cordis.patch.yml`;
 *   * the home layer contributes the row with `insert`, and an `insert` pushes a
 *     fresh row object, so the profile layer's `{ id: rea-mcp, disabled: true }`
 *     is overwritten by the home layer's re-declaration;
 *   * the composed `rea-mcp` row therefore never carries `disabled: true`, the
 *     live `Entry.disabled` stays `false`, and the shipped `plugin_manager`
 *     reports `application: "overridden"` for it too.
 *
 * So the state lives in a profile-scoped state file this plugin owns, and the
 * home layer carries one seam that lets that file decide the row:
 *
 *   - id: rea-mcp
 *     disabled: !!js >-
 *       Boolean(ctx.get('profileContext')?.dir) && (() => { ... })()
 *
 * The expression is evaluated where `disabled` is read, so it survives the home
 * layer's re-insertion and applies on every boot and on every Loader
 * reconcile. This plugin never writes the home file and never writes the
 * profile patch; it writes only its own state file, atomically.
 *
 * Runtime effect — no restart
 * ---------------------------
 * `Entry.update({ disabled })` is applied EXACTLY ONCE per toggle: it disposes
 * the MCP client fiber (unregistering every `mcp__rea__*` tool) or re-inits it
 * when the row is switched back on.
 *
 * Applying it more than once is a defect, not a retry: `@deepseek-ai/dsh-mcp-client`
 * spawns one stdio child per init, so a second `update()` produced two REA
 * processes for one "on" click (observed: two children, one enable).
 *
 * Known upstream limitation, measured but not fixable from here: that package's
 * teardown snapshots its child handle before awaiting it —
 *
 *     const close = closeClient
 *     client = void 0
 *     closeClient = void 0
 *     if (close !== void 0) await close()
 *
 * — so a connection attempt still in flight when the row is disposed assigns a
 * fresh `closeClient` after the snapshot and its child is never closed. The
 * result is one orphan REA process left per disable. The row itself is off
 * (fiber disposed, zero `mcp__rea__*` tools), so nothing is advertised to the
 * model; the leftover process only holds memory until the Harness exits.
 */
import { statSync } from 'node:fs'
import { readStateFile, stateFilePath, writeStateFile } from './state.js'

const PACKAGE_NAME = 'dsh-rea-mcp-toggle'

/** Loader entry id of the REA MCP row (inventory identity: `include:rea-mcp`). */
const REA_ENTRY_ID = 'rea-mcp'
/** Exact module the row must load, so a same-id row of another kind is refused. */
const REA_MODULE_NAME = '@deepseek-ai/dsh-mcp-client'
/** Tool-name prefix the MCP client publishes for this server. */
const REA_TOOL_PREFIX = 'mcp__rea__'

/**
 * Process-realm shape checkers. The Typert wire is typed by the descriptors
 * below; these only keep the narrow Runtime contract explicit, which is why
 * this bundle declares no schema library.
 */
function anyValue() {
  return { parse: (value) => value }
}

/**
 * Explicit Remote manifest: the Host face of the `reaMcp` namespace.
 *
 * Every invocation is a JSON parameter and a direct call on the service
 * instance; `ctx.typert.register()` accepts exactly this object, and the same
 * object is exported as `TYPERT` for any static Typert Loader that reads it.
 */
const MANIFEST = {
  package: PACKAGE_NAME,
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: PACKAGE_NAME + '#reaMcp/getState',
      service: 'reaMcp',
      namespace: 'reaMcp',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: PACKAGE_NAME + '#ReaMcpState',
        create: anyValue,
      },
    },
    {
      id: PACKAGE_NAME + '#reaMcp/setEnabled',
      service: 'reaMcp',
      namespace: 'reaMcp',
      method: 'setEnabled',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'request',
          wire: 'request',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: PACKAGE_NAME + '#SetReaMcpEnabledRequest',
            create: anyValue,
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: PACKAGE_NAME + '#ReaMcpState',
        create: anyValue,
      },
    },
  ],
  model: { services: [], events: [], objects: [] },
}

/** One human-readable line for the agent tool result. */
function summarize(state) {
  if (state.error !== '') return `REA MCP (${state.entryId}): unavailable — ${state.error}`
  return state.enabled
    ? `REA MCP (${state.entryId}) is ON: ${state.toolCount} tool(s); the choice is saved.`
    : `REA MCP (${state.entryId}) is OFF: the mcp__rea__* tools are not callable; the choice is saved.`
}

/** The state fields the tool renders, one per line, because the view shows text only. */
function detail(state) {
  return [
    `entry=${state.entryId} module=${state.moduleName}`,
    `enabled=${state.enabled} persisted=${state.persisted} tools=${state.toolCount} seam=${state.seam}`,
    `stateFile=${state.stateFile}`,
  ].join('\n')
}

/** The diagnostic report as text, for the same reason as {@link detail}. */
function probeDetail(report) {
  const lines = [`seam=${report.seam} reaTools=${report.reaToolCount} stateFile=${report.stateFile}`]
  lines.push(
    `stateFileExists=${report.stateFileExists} stateFileValue=${report.stateFileValue} services=${JSON.stringify(report.services)}`,
  )
  const remote = report.remote
  if (remote !== undefined) {
    lines.push(
      `remote hasLiveClient=${String(remote.hasLiveClient)} error=${remote.error ?? '(none)'}`,
    )
    for (const endpoint of remote.declared ?? []) {
      lines.push(
        `  endpoint ${endpoint.endpoint} resolvable=${endpoint.resolvable} ` +
          `inStore=${endpoint.inStore} serviceLive=${endpoint.serviceLive}`,
      )
    }
  }
  for (const entry of report.entries ?? []) {
    lines.push(
      `row id=${entry.id} composite=${entry.compositeId} module=${entry.moduleName} ` +
        `rawDisabled=${JSON.stringify(entry.rawDisabled)} effectiveDisabled=${entry.effectiveDisabled} ` +
        `fiberState=${entry.fiberState} parentTree=${entry.parentTreeEntryId}`,
    )
  }
  return lines.join('\n')
}

/**
 * The single implementation both callers use.
 *
 * Deliberately NOT a `TypertRemoteService` subclass. That base class calls
 * `bindTypertRemote(this, this.name)`, and `this.name` on a Cordis `Service` is
 * the `Service.name` SYMBOL, not the service key string — the resulting binding
 * failed the gateway's `validateBinding` with
 *
 *     Receiver must be an instance of class ReaMcpToggle
 *
 * on every Client call. Registering the service through `ctx.provide()` and
 * building the binding object here reproduces exactly what the working
 * `dsh-personal-directive` gateway does (plain class, explicit key), without
 * taking a dependency on the Typert protocol package.
 */
class ReaMcpToggle {
  /**
   * @param ctx - owning Cordis context; also registers the `reaMcp` service.
   */
  constructor(ctx) {
    this.ctx = ctx
    this.ctx.provide('reaMcp', this)
    // Visible binding consumed by the Gateway's source-mode discovery. The
    // identity fields are checked, so they must name THIS instance and the
    // exact wire namespace.
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: 'reaMcp',
      namespace: 'reaMcp',
    })
  }

  /** Resolve the live Loader entry for the REA row, or an explicit reason. */
  #resolve() {
    const loader = this.ctx.get('loader')
    if (loader === undefined) return { error: 'the Loader service is not running in this Host' }
    const entries = []
    for (const entry of loader.entries()) {
      if (entry.options.id === REA_ENTRY_ID) entries.push(entry)
    }
    if (entries.length === 0) {
      return {
        error:
          'no `' +
          REA_ENTRY_ID +
          '` entry is active in this profile. REA is registered by the home layer ' +
          '(%DSH_HOME%/cordis.patch.yml); restore or recreate that row first.',
      }
    }
    if (entries.length > 1) {
      return {
        error:
          'the id `' +
          REA_ENTRY_ID +
          '` resolves to ' +
          entries.length +
          ' entries, so no single row can be switched safely.',
      }
    }
    return { entry: entries[0] }
  }

  /** Count the tools this Host currently publishes for the REA server. */
  #toolCount() {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return null
    try {
      return tools.schemas().filter((tool) => String(tool.name).startsWith(REA_TOOL_PREFIX)).length
    } catch {
      return null
    }
  }

  /** Whether the home layer's `!!js` seam is present for this row. */
  #seamPresent() {
    const resolved = this.#resolve()
    if (resolved.error !== undefined) return false
    const raw = resolved.entry.options.disabled
    return raw !== null && typeof raw === 'object' && typeof raw.__jsExpr === 'string'
  }

  /**
   * Read the current switch state.
   * @returns the REA row's id, module, live enablement, tool count, and the
   *   persisted choice with any error that explains a mismatch.
   */
  getState() {
    const statePath = stateFilePath(this.ctx)
    const persisted = readStateFile(statePath)
    const resolved = this.#resolve()
    if (resolved.error !== undefined) {
      return {
        entryId: REA_ENTRY_ID,
        moduleName: REA_MODULE_NAME,
        enabled: false,
        toolCount: 0,
        persisted: persisted === true,
        seam: false,
        stateFile: statePath,
        error: resolved.error,
      }
    }
    const entry = resolved.entry
    return {
      entryId: entry.options.id,
      moduleName: String(entry.options.name),
      enabled: entry.disabled !== true,
      toolCount: this.#toolCount() ?? 0,
      persisted: persisted === undefined ? entry.disabled !== true : persisted,
      seam: this.#seamPresent(),
      stateFile: statePath,
      error: '',
    }
  }

  /**
   * Switch the REA row on or off, persist the choice, and apply it live.
   *
   * Idempotent: a request that already matches both the persisted and the live
   * state reports `changed: false` and writes nothing.
   * @param request - `{ enabled }`; anything but an explicit `true` means off.
   * @returns the resulting state plus whether this call changed anything.
   */
  async setEnabled(request) {
    const enabled = request !== null && typeof request === 'object' && request.enabled === true
    const before = this.getState()
    if (before.error !== '') return { ...before, changed: false }

    if (before.enabled === enabled && before.persisted === enabled) {
      return { ...before, changed: false }
    }

    let changed = false
    try {
      writeStateFile(stateFilePath(this.ctx), enabled)
      changed = true
    } catch (error) {
      return {
        ...before,
        changed: false,
        error:
          'the choice could not be saved to ' +
          stateFilePath(this.ctx) +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
      }
    }

    const resolved = this.#resolve()
    if (resolved.error !== undefined) return { ...before, changed, error: resolved.error }
    let applied = 'ok'
    try {
      // `undefined` deletes the key, which re-inits a disabled row.
      await resolved.entry.update({ disabled: enabled ? undefined : true })
    } catch (error) {
      applied = error instanceof Error ? error.message : String(error)
    }

    const after = await this.#afterApply(enabled, 700)
    if (applied !== 'ok' && after.enabled !== enabled) {
      return {
        ...after,
        changed,
        error:
          'the choice was saved but could not be applied live: ' +
          applied +
          '. Restart the Harness to pick it up.',
      }
    }
    if (after.enabled !== enabled) {
      return {
        ...after,
        changed,
        error:
          'the choice was saved but the row is still ' +
          (after.enabled ? 'ON' : 'OFF') +
          '; restart the Harness to pick it up.',
      }
    }
    return { ...after, changed }
  }

  /**
   * Observe the row until it reaches the requested state.
   *
   * Applied exactly once by the caller: re-applying `disabled` to settle things
   * re-inits the row, and for `@deepseek-ai/dsh-mcp-client` each init spawns
   * another stdio child — re-applying is what created duplicate REA processes,
   * so this only waits and reports.
   * @param enabled - the state the row must reach.
   * @param dwellMs - how long to keep confirming a state that is already right.
   * @returns the state after the dwell.
   */
  async #afterApply(enabled, dwellMs) {
    const started = Date.now()
    for (;;) {
      const state = this.getState()
      if (state.error !== '' || state.enabled !== enabled) return state
      const remaining = dwellMs - (Date.now() - started)
      if (remaining <= 0) return state
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 200)))
    }
  }

  /**
   * Diagnostic snapshot: the live Loader rows, the wiring this plugin depends
   * on, and whether the home layer's seam is present. Reads Loader truth
   * directly, which is what separates "the file says disabled" from "the
   * runtime disabled it".
   */
  probe() {
    const loader = this.ctx.get('loader')
    if (loader === undefined) return { entries: [], error: 'no Loader service' }
    const entries = []
    for (const entry of loader.entries()) {
      const id = String(entry.options.id)
      if (!id.includes('rea')) continue
      const parentTreeEntry = entry.parent.tree.ctx.fiber.entry
      entries.push({
        id,
        compositeId: entry.id,
        moduleName: String(entry.options.name),
        rawDisabled: entry.options.disabled ?? null,
        effectiveDisabled: entry.disabled === true,
        fiberState: entry.fiber === undefined ? null : entry.fiber.state,
        parentTreeEntryId: parentTreeEntry === undefined ? null : String(parentTreeEntry.id),
      })
    }
    const statePath = stateFilePath(this.ctx)
    return {
      entries,
      reaToolCount: this.#toolCount(),
      seam: this.#seamPresent(),
      stateFile: statePath,
      stateFileExists: (() => {
        try {
          return statSync(statePath).isFile()
        } catch {
          return false
        }
      })(),
      stateFileValue: readStateFile(statePath) ?? null,
      services: {
        loader: loader !== undefined,
        tools: this.ctx.get('tools') !== undefined,
        typert: this.ctx.get('typert') !== undefined,
        pluginManager: this.ctx.get('pluginManager') !== undefined,
        typertGateway: this.ctx.get('typertGateway') !== undefined,
      },
      // What the Client's `ctx.get('remote.reaMcp')` depends on: the strict
      // descriptors this Host contributed must be resolvable by endpoint.
      remote: this.#remoteDiagnostics(),
    }
  }

  /** What the Client's `ctx.get('remote.reaMcp')` depends on: the strict
   * descriptors this Host contributed must be resolvable by endpoint.
   * @returns per-endpoint resolvability plus the live-client flag.
   */
  #remoteDiagnostics() {
    const typert = this.ctx.get('typert')
    if (typert === undefined) return { error: 'no typert service' }
    const local = typert.local
    if (local === undefined || typeof local.get !== 'function') {
      return { error: 'typert.local is unavailable' }
    }
    const declared = []
    for (const invocation of MANIFEST.invocations) {
      const endpoint = `${invocation.namespace}/${invocation.method}`
      let found = null
      try {
        found = local.get(endpoint) ?? null
      } catch (error) {
        found = { thrown: error instanceof Error ? error.message : String(error) }
      }
      declared.push({
        endpoint,
        resolvable: found !== null,
        inStore: typeof local.hasSeen === 'function' ? local.hasSeen(endpoint) === true : null,
        serviceKey: invocation.service,
        serviceLive: this.ctx.get(invocation.service) !== undefined,
      })
    }
    const gateway = this.ctx.get('typertGateway')
    return {
      declared,
      hasLiveClient:
        gateway !== undefined && typeof gateway.hasLiveClient === 'function'
          ? gateway.hasLiveClient() === true
          : null,
    }
  }

  /**
   * Call this bundle's own endpoints through the Host's Typert gateway — the
   * exact path the browser's `remote.reaMcp` call takes.
   *
   * This is the check that caught the real defect: the gateway validates the
   * receiver's `typertRemote` binding before invoking, so a bad binding fails
   * here with the same message the UI surfaced
   * ("Receiver must be an instance of class ReaMcpToggle") instead of only
   * showing up in the browser.
   * @returns per-endpoint outcome, including the gateway's own error text.
   */
  async selfTest() {
    const gateway = this.ctx.get('typertGateway')
    if (gateway === undefined || typeof gateway.invoke !== 'function') {
      return { error: 'the Typert gateway is not running in this Host' }
    }
    // A diagnostic must not decide the switch: remember what the user chose and
    // put it back no matter how the probe ends.
    const before = readStateFile(stateFilePath(this.ctx))
    const results = []
    try {
      for (const request of [
        // A zero-argument endpoint must be called with an EMPTY OBJECT, not with
        // `args` omitted: the gateway's argument validation builds from the
        // payload and rejects `undefined` ("Cannot convert undefined or null to
        // object"). The browser's Remote caller always sends `{}`, which is why
        // only this self-test ever tripped over it.
        { namespace: 'reaMcp', method: 'getState', args: {} },
        { namespace: 'reaMcp', method: 'setEnabled', args: { request: { enabled: false } } },
      ]) {
        try {
          const value = await gateway.invoke({ ...request, peer: undefined })
          results.push({ endpoint: `${request.namespace}/${request.method}`, ok: true, value })
        } catch (error) {
          results.push({
            endpoint: `${request.namespace}/${request.method}`,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      if (before !== undefined) await this.setEnabled({ enabled: before })
    }
    return { results, restoredTo: before ?? null }
  }
}

export const name = PACKAGE_NAME
export const inject = ['loader', 'tools', 'typert']

/** Host entry point: mount the Remote service, the tool, and the manifest. */
export function apply(ctx) {
  const service = new ReaMcpToggle(ctx)
  ctx.effect(() => ctx.typert.register(MANIFEST), 'rea-mcp-toggle: remote manifest')

  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: String(value?.summary ?? JSON.stringify(value)) },
    ],
  }

  const tool = {
    name: 'rea_mcp_toggle',
    description:
      'Read or change whether the REA MCP server (the `rea-mcp` row, tools named mcp__rea__*) ' +
      'runs in this Harness profile. The choice is saved in the profile and survives restarts, and ' +
      'it takes effect immediately without restarting the Harness. Use action "status" to query, ' +
      '"set" to switch, "probe" for loader-row diagnostics, and "selftest" to check that the ' +
      'Web UI can reach this plugin. "set" is idempotent.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'set', 'probe', 'selftest'],
          description:
            'status reads the current switch state; set switches it; probe returns loader-row ' +
            'diagnostics; selftest calls this plugin through the Remote gateway the Web UI uses.',
        },
        enabled: {
          type: 'boolean',
          description: 'Required for action "set": true enables REA, false disables it.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output,
    async execute(args) {
      if (args === null || typeof args !== 'object' || typeof args.action !== 'string') {
        return { ok: false, summary: 'action must be "status", "set", "probe", or "selftest".' }
      }
      if (args.action === 'status') {
        const state = service.getState()
        return { ok: state.error === '', summary: `${summarize(state)}\n${detail(state)}`, state }
      }
      if (args.action === 'probe') {
        const report = service.probe()
        return { ok: true, summary: probeDetail(report), state: report }
      }
      if (args.action === 'selftest') {
        const report = await service.selfTest()
        const lines = []
        if (report.error !== undefined) lines.push(`selftest unavailable: ${report.error}`)
        for (const result of report.results ?? []) {
          lines.push(
            result.ok === true
              ? `gateway ${result.endpoint} ok -> ${JSON.stringify(result.value)}`
              : `gateway ${result.endpoint} FAILED -> ${result.error}`,
          )
        }
        if (report.restoredTo !== undefined) lines.push(`restoredTo=${String(report.restoredTo)}`)
        return { ok: (report.results ?? []).every((result) => result.ok === true), summary: lines.join('\n'), state: report }
      }
      if (args.action !== 'set') {
        return { ok: false, summary: 'action must be "status", "set", "probe", or "selftest".' }
      }
      if (typeof args.enabled !== 'boolean') {
        return { ok: false, summary: 'action "set" needs a boolean `enabled`.' }
      }
      const state = await service.setEnabled({ enabled: args.enabled })
      return {
        ok: state.error === '',
        summary:
          (state.error === '' ? summarize(state) : `${summarize(state)} ${state.error}`) + `\n${detail(state)}`,
        changed: state.changed === true,
        state,
      }
    },
  }

  ctx.effect(() => ctx.tools.register(tool), 'rea-mcp-toggle: agent tool')
}

/** Host contribution read by a static Typert Loader; same object as registered. */
export const TYPERT = MANIFEST
