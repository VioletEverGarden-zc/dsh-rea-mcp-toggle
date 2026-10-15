/**
 * Browser half of `dsh-rea-mcp-toggle`: the REA MCP switch in the Session
 * header, next to the other title-adjacent actions.
 *
 * The switch renders state and takes the click; it owns no operation logic.
 * Both the read and the write go to the Host service `reaMcp` over the
 * contribution mounted below — the same methods the agent tool
 * `rea_mcp_toggle` calls.
 */
window.__ModuleLoader__.load({
  id: 'dsh-rea-mcp-toggle',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    const PACKAGE_NAME = 'dsh-rea-mcp-toggle'
    const NS = 'reaMcpToggle'

    const zh = {
      on: 'REA 开',
      off: 'REA 关',
      busy: '切换中…',
      titleOn: 'REA MCP 已开启：点击关闭（mcp__rea__* 工具对模型可见）',
      titleOff: 'REA MCP 已关闭：点击开启',
      titleUnknown: 'REA MCP 状态不可用',
      tools: '当前工具数',
      entry: '配置行',
      failed: 'REA 失败',
    }
    const en = {
      on: 'REA on',
      off: 'REA off',
      busy: 'Switching…',
      titleOn: 'REA MCP is ON: click to disable (mcp__rea__* tools are visible to the model)',
      titleOff: 'REA MCP is OFF: click to enable',
      titleUnknown: 'REA MCP state is unavailable',
      tools: 'tools now',
      entry: 'row',
      failed: 'REA failed',
    }

    const identity = (value) => value
    // Strict wire codec: the 0.1.5-line `schema` field is refused by the same
    // DescriptorStore.validate() the built-in Remote namespaces go through, so
    // the codec carries the create() factory face and nothing else. The
    // authoritative validation of a result is the Host side.
    const wireCodec = (typeSymbol) => ({
      mode: 'strict',
      typeSymbol,
      create: () => ({ parse: identity }),
    })
    const jsonParameter = (name, typeSymbol) => ({
      name,
      wire: name,
      source: 'json',
      codec: wireCodec(typeSymbol),
    })
    const CONTRIBUTION = {
      package: PACKAGE_NAME,
      descriptors: [
        {
          id: PACKAGE_NAME + '#reaMcp/getState',
          service: 'reaMcp',
          namespace: 'reaMcp',
          method: 'getState',
          invocation: { kind: 'direct' },
          parameters: [],
          result: wireCodec(PACKAGE_NAME + '#ReaMcpState'),
        },
        {
          id: PACKAGE_NAME + '#reaMcp/setEnabled',
          service: 'reaMcp',
          namespace: 'reaMcp',
          method: 'setEnabled',
          invocation: { kind: 'direct' },
          parameters: [jsonParameter('request', PACKAGE_NAME + '#SetReaMcpEnabledRequest')],
          result: wireCodec(PACKAGE_NAME + '#ReaMcpState'),
        },
      ],
    }

    /** One compact control; styling follows the host tokens the Theme probe lists. */
    function ReaMcpSwitch({ api, t }) {
      const [state, setState] = useState({
        enabled: false,
        toolCount: 0,
        entryId: 'rea-mcp',
        ready: false,
        busy: false,
        error: '',
      })

      const read = useCallback(async () => {
        try {
          const value = await api.getState()
          setState({
            enabled: value.enabled === true,
            toolCount: typeof value.toolCount === 'number' ? value.toolCount : 0,
            entryId: typeof value.entryId === 'string' ? value.entryId : 'rea-mcp',
            ready: true,
            busy: false,
            error: typeof value.error === 'string' ? value.error : '',
          })
        } catch (error) {
          setState((current) => ({
            ...current,
            ready: true,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      }, [api])

      useEffect(() => {
        let active = true
        api
          .getState()
          .then((value) => {
            if (!active) return
            setState({
              enabled: value.enabled === true,
              toolCount: typeof value.toolCount === 'number' ? value.toolCount : 0,
              entryId: typeof value.entryId === 'string' ? value.entryId : 'rea-mcp',
              ready: true,
              busy: false,
              error: typeof value.error === 'string' ? value.error : '',
            })
          })
          .catch((error) => {
            if (!active) return
            setState((current) => ({
              ...current,
              ready: true,
              busy: false,
              error: error instanceof Error ? error.message : String(error),
            }))
          })
        return () => {
          active = false
        }
      }, [api])

      const toggle = async () => {
        if (!state.ready || state.busy) return
        const next = !state.enabled
        setState((current) => ({ ...current, busy: true, error: '' }))
        try {
          const value = await api.setEnabled({ enabled: next })
          if (value === undefined || value === null) throw new Error(t('failed'))
          setState((current) => ({
            ...current,
            enabled: value.enabled === true,
            toolCount: typeof value.toolCount === 'number' ? value.toolCount : current.toolCount,
            entryId: typeof value.entryId === 'string' ? value.entryId : current.entryId,
            busy: false,
            ready: true,
            error: typeof value.error === 'string' ? value.error : '',
          }))
          // The host reports a saved-but-not-applied choice through `error` with
          // the row already converged; re-reading is what keeps the label honest.
          if (typeof value.error === 'string' && value.error !== '') await read()
        } catch (error) {
          setState((current) => ({
            ...current,
            busy: false,
            error: error instanceof Error ? error.message : String(error),
          }))
          await read()
        }
      }

      // An error must be visible in the control itself: a tooltip alone let a
      // failed toggle look like a dead button.
      const label = state.busy ? t('busy') : state.error !== '' ? t('failed') : state.enabled ? t('on') : t('off')
      const title = state.error !== ''
        ? state.error
        : state.enabled
          ? t('titleOn') + ' — ' + t('tools') + ': ' + String(state.toolCount) + ', ' + t('entry') + ': ' + state.entryId
          : t('titleOff') + ' — ' + t('entry') + ': ' + state.entryId

      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': state.enabled,
          'aria-label': label,
          title,
          disabled: !state.ready || state.busy,
          onClick: toggle,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '5px',
            // Fixed enough width that the state word is never the part that gets
            // cut: the header row squeezes its entries, and a label reading only
            // "REA" is indistinguishable from a decoration.
            minWidth: '66px',
            height: '24px',
            padding: '0 9px',
            boxSizing: 'border-box',
            borderRadius: '6px',
            border: '1px solid ' + (state.error !== '' ? 'var(--dsw-alias-state-error-primary, #d05a5a)' : 'var(--dsw-alias-border-l1, rgba(127,127,127,.35))'),
            background: state.enabled ? 'var(--dsw-alias-brand-primary, #247bbf)' : 'transparent',
            color: state.enabled ? '#fff' : 'var(--dsw-alias-label-secondary, inherit)',
            fontSize: '12px',
            lineHeight: '1',
            fontFamily: 'inherit',
            cursor: state.ready && !state.busy ? 'pointer' : 'default',
            opacity: state.ready || state.busy ? 1 : 0.55,
            whiteSpace: 'nowrap',
            flex: '0 0 auto',
            transition: 'background-color .12s ease, color .12s ease',
          },
        },
        h('span', {
          'aria-hidden': true,
          style: {
            width: '6px',
            height: '6px',
            flex: '0 0 auto',
            borderRadius: '50%',
            background: state.error !== ''
              ? 'var(--dsw-alias-state-error-primary, #d05a5a)'
              : state.enabled
                ? '#fff'
                : 'var(--dsw-alias-state-idle-primary, currentColor)',
          },
        }),
        label,
      )
    }

    const inject = ['slots', 'locale', 'remote']
    const SLOT = 'conversation.session.header.actions'

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rea-mcp-toggle: dictionaries')
      const mounted = ctx.remote.$mount(CONTRIBUTION)
      const api = {
        // The Remote caller answers with a `{ ok, value }` envelope (compare
        // dsh-personal-directive's client, which reads `result.value` the same
        // way). Reading the envelope's own fields instead of `value` left the
        // switch stuck: no state change, no error, nothing to see.
        getState: async () => {
          await mounted
          const remote = ctx.get('remote.reaMcp')
          if (remote === undefined) throw new Error('reaMcp remote namespace is unavailable')
          const result = await remote.getState()
          if (!result || result.ok !== true) {
            throw new Error(result?.error?.message || 'getState failed')
          }
          return result.value
        },
        setEnabled: async (request) => {
          await mounted
          const remote = ctx.get('remote.reaMcp')
          if (remote === undefined) throw new Error('reaMcp remote namespace is unavailable')
          const result = await remote.setEnabled(request)
          if (!result || result.ok !== true) {
            throw new Error(result?.error?.message || 'setEnabled failed')
          }
          return result.value
        },
      }
      const t = ctx.locale.bind(NS)
      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: 'rea-mcp-toggle',
            order: 1020,
            locale: NS,
            inject: () => ({ api, t }),
          },
          ReaMcpSwitch,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
