/**
 * Browser half of the DeepAI Code router: the Settings → DeepAI Code page.
 *
 * The page is a settings section registered into the `settings.section` slot.
 * It talks to the Host through this plugin's own routes under `/deepaicode/*`,
 * which the Host half registers on the composition's web server, so no second
 * application, iframe, or cross-origin call is involved.
 *
 * Registered through the browser module table as a lazy factory whose id equals
 * the package name; React comes from that table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepaicode-auto',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'deepaicode'
    /** Browser-relative routes; the Host registers the same paths absolutely. */
    const ROUTES = {
      status: 'deepaicode/status',
      signIn: 'deepaicode/sign-in',
      apiKey: 'deepaicode/api-key',
      signOut: 'deepaicode/sign-out',
      refresh: 'deepaicode/refresh',
    }
    /** How often a pending sign-in is polled, in milliseconds. */
    const POLL_MS = 2000
    /** Settings navigation position: between Freebuff and the Plugins section. */
    const SECTION_ORDER = 13

    const DICTIONARY = {
      'section.title': 'DeepAI Code',
      'header.subtitle': 'Provider deepaicode',
      'header.models': 'models',
      'header.live': 'live catalog',
      'header.publishedTable': 'published table',
      'header.refresh': 'Refresh',
      'connection.title': 'Connection',
      'connection.connected': 'Connected',
      'connection.disconnected': 'Not connected',
      'connection.via': 'Credential from',
      'connection.source.config': 'plugin configuration',
      'connection.source.environment': 'environment variable',
      'connection.source.store': 'saved sign-in',
      'connection.source.desktop': 'DeepAI Code desktop app',
      'connection.source.none': 'nowhere yet',
      'connection.connect': 'Connect with browser',
      'connection.waiting': 'Waiting for the browser sign-in to finish…',
      'connection.openAgain': 'Open the sign-in page again',
      'connection.cancel': 'Cancel',
      'connection.disconnect': 'Disconnect',
      'connection.higherLayer': 'A higher layer still supplies this key, so it stays in effect.',
      'allowance.title': 'Daily allowance',
      'allowance.remaining': 'left today',
      'allowance.unknown': 'Not read yet — press Refresh.',
      'allowance.resets': 'Refreshes at',
      'allowance.spent': 'Frontier requests spend Theos per token.',
      'key.title': 'Paste an account key',
      'key.help': 'Use this when the browser sign-in cannot run on this machine. The key is verified before it is saved.',
      'key.placeholder': 'Account API key (UUID)',
      'key.save': 'Save key',
      'routing.title': 'Routing',
      'routing.auto': 'Auto (DeepAiCode)',
      'routing.frontierReady': 'Frontier models ready',
      'routing.unmeteredReady': 'Unmetered models ready',
      'routing.fallbacks': 'Recent fallbacks',
      'routing.noFallbacks': 'None — no request has needed a fallback.',
      'routing.exhausted': 'Retired today',
      'free.title': 'Free models',
      'free.count': 'unmetered models',
      'free.verified': 'verified against the live catalog',
      'free.snapshot': 'from the published table, not verified',
      'free.never': 'Not verified yet — press Refresh.',
      'free.next': 'next check',
      'free.unchanged': 'No change since the last check.',
      'free.newlyFree': 'Newly free',
      'free.noLongerFree': 'Now paid — moved to the Frontier tier',
      'free.removed': 'No longer listed upstream',
      'free.hint': 'Verified against the live catalog once a day and again whenever a model fails.',
      'error.busy': 'The previous action has not finished yet.',
      'error.request': 'The DeepAI Code host route refused this request',
    }

    const CSS = `
.dc-page { display: flex; flex-direction: column; gap: 16px; color: var(--dsw-alias-label-primary); font-size: 13px; }
.dc-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.dc-title { margin: 0; font-size: 15px; font-weight: 600; }
.dc-sub { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); }
.dc-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.dc-card-title { margin: 0; font-size: 13px; font-weight: 600; }
.dc-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dc-status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.dc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
.dc-dot--on { background: var(--dsw-alias-state-success-primary); }
.dc-dot--warn { background: var(--dsw-alias-state-warn-primary); }
.dc-dot--error { background: var(--dsw-alias-state-error-primary); }
.dc-muted { color: var(--dsw-alias-label-secondary); font-weight: 400; }
.dc-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); border-radius: 8px; padding: 6px 12px; font: inherit; cursor: pointer; }
.dc-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dc-btn:disabled { opacity: 0.55; cursor: default; }
.dc-btn--primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dc-btn--quiet { background: transparent; }
.dc-alert { border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); border-radius: 8px; padding: 8px 12px; }
.dc-alert--info { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.dc-url { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; color: var(--dsw-alias-label-secondary); }
.dc-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
.dc-bar-fill { height: 100%; background: var(--dsw-alias-brand-primary); }
.dc-dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; }
.dc-dl dt { color: var(--dsw-alias-label-secondary); }
.dc-dl dd { margin: 0; }
.dc-input { flex: 1 1 260px; min-width: 200px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 6px 10px; font: inherit; }
.dc-list { margin: 0; padding-left: 18px; color: var(--dsw-alias-label-secondary); }
.dc-list li { margin: 2px 0; }
`

    /**
     * Translate face supplied to the page. The factory has no hooks of its own,
     * so the bound translator and the live locale snapshot travel through one
     * context value instead of being closed over at registration time.
     */
    const LocaleContext = React.createContext({
      translate: key => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'en', locales: [], revision: 0 }),
    })

    /**
     * Call one Host route and decode its JSON answer.
     * @param {string} path - browser-relative route.
     * @param {object} [options] - fetch options.
     * @returns {Promise<any>} the decoded body.
     */
    async function request(path, options = {}) {
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
        ...options,
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        const message = payload && typeof payload.message === 'string'
          ? payload.message
          : `${DICTIONARY['error.request']} (HTTP ${response.status})`
        throw new Error(message)
      }
      return payload
    }

    /**
     * Re-render the page whenever the active locale changes.
     * @param {any} locale - the client locale service.
     * @returns {void}
     */
    function useLocaleRevision(locale) {
      React.useSyncExternalStore(
        React.useCallback(callback => locale.subscribe(callback), [locale]),
        React.useCallback(() => locale.getSnapshot(), [locale]),
      )
    }

    /**
     * Format a Theos amount without inventing precision it does not have.
     * @param {number | null | undefined} value - the amount.
     * @returns {string} the formatted amount, or an em dash.
     */
    function theos(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return Math.abs(value) >= 10 ? String(Math.round(value)) : String(Math.round(value * 100) / 100)
    }

    /**
     * Format one relative age.
     * @param {number | null} ageMs - milliseconds since an event.
     * @returns {string} a short human description.
     */
    function age(ageMs) {
      if (typeof ageMs !== 'number' || !Number.isFinite(ageMs)) return '—'
      const minutes = Math.floor(ageMs / 60000)
      if (minutes < 1) return 'just now'
      if (minutes < 60) return `${minutes} min ago`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} h ago`
      return `${Math.floor(hours / 24)} d ago`
    }

    /**
     * The Settings → DeepAI Code page.
     * @param {{close: () => void}} props - owner props supplied by the settings shell.
     * @returns {object} the rendered page.
     */
    function DeepAiCodeSection(props) {
      const locale = React.useContext(LocaleContext)
      useLocaleRevision(locale)
      const t = React.useCallback(key => locale.translate(key), [locale])

      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [keyDraft, setKeyDraft] = React.useState('')

      const signInState = status && status.signIn ? status.signIn.state : 'idle'

      /**
       * Run one action with shared busy and failure handling.
       * @param {string} name - action name for the busy indicator.
       * @param {() => Promise<any>} operation - the action.
       * @returns {Promise<void>} resolves when the action settled.
       */
      const run = React.useCallback(async (name, operation) => {
        setBusy(name)
        setFailure(null)
        try {
          const next = await operation()
          if (next && typeof next === 'object' && 'signedIn' in next) setStatus(next)
          return next
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
          return undefined
        } finally {
          setBusy(null)
        }
      }, [])

      const load = React.useCallback(async () => {
        try {
          const next = await request(ROUTES.status)
          setStatus(next)
          setFailure(null)
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
        }
      }, [])

      // First read, then one repeating read while a sign-in is pending: the
      // attempt completes inside the Host, so polling is how the page learns.
      React.useEffect(() => { void load() }, [load])
      React.useEffect(() => {
        if (signInState !== 'pending') return undefined
        const timer = setTimeout(() => { void load() }, POLL_MS)
        return () => clearTimeout(timer)
      }, [signInState, status, load])

      const connect = () => run('connect', async () => {
        const attempt = await request(ROUTES.signIn, { method: 'POST' })
        if (attempt && typeof attempt.url === 'string') {
          window.open(attempt.url, '_blank', 'noopener')
          setNotice(null)
        }
        await load()
      })

      const cancel = () => run('cancel', async () => {
        await request(ROUTES.signIn, { method: 'DELETE' })
        await load()
      })

      const disconnect = () => run('disconnect', async () => {
        const next = await request(ROUTES.signOut, { method: 'POST' })
        setStatus(next)
        setNotice(next && next.signedIn ? t('connection.higherLayer') : null)
      })

      const refresh = () => run('refresh', () => request(ROUTES.refresh, { method: 'POST' }))

      const saveKey = () => run('key', async () => {
        const next = await request(ROUTES.apiKey, {
          method: 'POST',
          body: JSON.stringify({ apiKey: keyDraft.trim() }),
        })
        setStatus(next)
        setKeyDraft('')
        setNotice(null)
      })

      const copyUrl = () => {
        const url = status && status.signIn ? status.signIn.url : undefined
        if (typeof url !== 'string') return
        navigator.clipboard?.writeText(url).then(() => setNotice(url), () => setNotice(url))
      }

      const connected = Boolean(status && status.signedIn)
      const allowance = status ? status.allowance : null
      const balance = allowance ? allowance.balance : null
      const granted = allowance ? allowance.granted : null
      const ratio = typeof balance === 'number' && typeof granted === 'number' && granted > 0
        ? Math.max(0, Math.min(1, balance / granted))
        : 0
      const dotClass = connected ? 'dc-dot dc-dot--on' : 'dc-dot dc-dot--warn'
      const sourceKey = status && status.credentialSource ? `connection.source.${status.credentialSource}` : 'connection.source.none'
      const catalog = status ? status.catalog : { count: 0, live: false }
      const routerState = status ? status.router : { frontierReady: 0, unmeteredReady: 0, recentHandoffs: [], exhausted: [] }
      const verification = status ? status.verification : null

      return h('div', { className: 'dc-page' },
        h('style', null, CSS),
        h('header', { className: 'dc-header' },
          h('div', null,
            h('h3', { className: 'dc-title' }, t('section.title')),
            h('p', { className: 'dc-sub' },
              `${t('header.subtitle')} · lane ${status ? status.provider.lane : '—'} · `
              + `${catalog.count} ${t('header.models')} (${catalog.live ? t('header.live') : t('header.publishedTable')})`,
            ),
          ),
          h('button', {
            type: 'button', className: 'dc-btn dc-btn--quiet',
            disabled: busy !== null, onClick: refresh,
          }, t('header.refresh')),
        ),

        failure !== null ? h('div', { className: 'dc-alert', role: 'alert' }, failure) : null,
        notice !== null ? h('div', { className: 'dc-alert dc-alert--info' }, notice) : null,

        h('section', { className: 'dc-card' },
          h('h4', { className: 'dc-card-title' }, t('connection.title')),
          h('div', { className: 'dc-status', 'aria-live': 'polite' },
            h('span', { className: dotClass, 'aria-hidden': true }),
            h('span', null, connected ? t('connection.connected') : t('connection.disconnected')),
            h('span', { className: 'dc-muted' }, `${t('connection.via')} ${t(sourceKey)}`),
          ),
          connected && status && status.username !== ''
            ? h('div', { className: 'dc-muted' }, status.username)
            : null,

          signInState === 'pending'
            ? h('div', { className: 'dc-row' },
              h('span', { className: 'dc-muted' }, t('connection.waiting')),
              h('button', { type: 'button', className: 'dc-btn dc-btn--quiet', onClick: copyUrl },
                t('connection.openAgain')),
              h('button', { type: 'button', className: 'dc-btn dc-btn--quiet', onClick: cancel, disabled: busy !== null },
                t('connection.cancel')),
            )
            : null,
          signInState === 'pending' && status && status.signIn && status.signIn.url
            ? h('div', { className: 'dc-url' }, status.signIn.url)
            : null,
          signInState === 'failed' && status && status.signIn && status.signIn.error
            ? h('div', { className: 'dc-alert', role: 'alert' }, status.signIn.error)
            : null,

          h('div', { className: 'dc-row' },
            h('button', {
              type: 'button', className: 'dc-btn dc-btn--primary',
              disabled: busy !== null || signInState === 'pending', onClick: connect,
            }, t('connection.connect')),
            h('button', {
              type: 'button', className: 'dc-btn',
              disabled: busy !== null || !connected, onClick: disconnect,
            }, t('connection.disconnect')),
          ),
        ),

        h('section', { className: 'dc-card' },
          h('h4', { className: 'dc-card-title' }, t('allowance.title')),
          typeof balance === 'number'
            ? h(React.Fragment, null,
              h('div', { className: 'dc-status' },
                h('span', null, `${theos(balance)} ${t('allowance.remaining')}`),
                h('span', { className: 'dc-muted' }, typeof granted === 'number' ? `of ${theos(granted)}` : ''),
              ),
              h('div', { className: 'dc-bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': granted ?? 0, 'aria-valuenow': balance },
                h('div', { className: 'dc-bar-fill', style: { width: `${Math.round(ratio * 100)}%` } })),
              allowance && allowance.refreshAt
                ? h('div', { className: 'dc-muted' }, `${t('allowance.resets')} ${new Date(allowance.refreshAt).toLocaleString()}`)
                : null,
            )
            : h('div', { className: 'dc-muted' }, t('allowance.unknown')),
          h('div', { className: 'dc-muted' }, t('allowance.spent')),
        ),

        h('section', { className: 'dc-card' },
          h('h4', { className: 'dc-card-title' }, t('key.title')),
          h('div', { className: 'dc-muted' }, t('key.help')),
          h('div', { className: 'dc-row' },
            h('input', {
              className: 'dc-input',
              type: 'password',
              value: keyDraft,
              placeholder: t('key.placeholder'),
              autoComplete: 'off',
              spellCheck: false,
              onChange: event => setKeyDraft(event.target.value),
            }),
            h('button', {
              type: 'button', className: 'dc-btn',
              disabled: busy !== null || keyDraft.trim() === '', onClick: saveKey,
            }, t('key.save')),
          ),
        ),

        h('section', { className: 'dc-card' },
          h('h4', { className: 'dc-card-title' }, t('routing.title')),
          h('dl', { className: 'dc-dl' },
            h('dt', null, t('routing.auto')),
            h('dd', null, `lane ${status ? status.provider.lane : '—'} · ${catalog.count} ${t('header.models')} · ${catalog.live ? t('header.live') : t('header.publishedTable')} ${age(catalog.ageMs)}`),
            h('dt', null, t('routing.frontierReady')),
            h('dd', null, String(routerState.frontierReady)),
            h('dt', null, t('routing.unmeteredReady')),
            h('dd', null, String(routerState.unmeteredReady)),
            routerState.exhausted && routerState.exhausted.length > 0
              ? h('dt', null, t('routing.exhausted'))
              : null,
            routerState.exhausted && routerState.exhausted.length > 0
              ? h('dd', null, routerState.exhausted.join(', '))
              : null,
          ),
          h('div', null,
            h('div', { className: 'dc-muted' }, t('routing.fallbacks')),
            routerState.recentHandoffs && routerState.recentHandoffs.length > 0
              ? h('ul', { className: 'dc-list' }, routerState.recentHandoffs.map((handoff, index) =>
                h('li', { key: `${handoff.from}-${handoff.to}-${index}` },
                  `${handoff.from} → ${handoff.to} (${handoff.reason})`)))
              : h('div', { className: 'dc-muted' }, t('routing.noFallbacks')),
          ),
        ),

        h('section', { className: 'dc-card' },
          h('h4', { className: 'dc-card-title' }, t('free.title')),
          verification === null
            ? h('div', { className: 'dc-muted' }, t('free.never'))
            : h(React.Fragment, null,
              h('div', { className: 'dc-status' },
                h('span', null, `${String(verification.freeIds.length)} ${t('free.count')}`),
                h('span', { className: 'dc-muted' },
                  `${verification.verified ? t('free.verified') : t('free.snapshot')} · ${age(verification.ageMs)}`),
              ),
              h('div', { className: 'dc-url' }, verification.freeIds.join(', ')),
              verification.nextCheckAt
                ? h('div', { className: 'dc-muted' }, `${t('free.next')} ${new Date(verification.nextCheckAt).toLocaleString()}`)
                : null,
              verification.added.length > 0
                ? h('div', null, `${t('free.newlyFree')}: ${verification.added.join(', ')}`)
                : null,
              verification.reclassified.length > 0
                ? h('div', { className: 'dc-alert' },
                  `${t('free.noLongerFree')}: ${verification.reclassified.map(entry => `${entry.id} (${String(entry.theos)} Theos)`).join(', ')}`)
                : null,
              verification.removed.length > 0
                ? h('div', { className: 'dc-muted' }, `${t('free.removed')}: ${verification.removed.join(', ')}`)
                : null,
              verification.added.length === 0 && verification.reclassified.length === 0 && verification.removed.length === 0
                ? h('div', { className: 'dc-muted' }, t('free.unchanged'))
                : null,
              h('div', { className: 'dc-muted' }, t('free.hint')),
            ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // A module reload (HMR, or the bundle being toggled while the page is
        // open) runs apply again against the same locale service, and the
        // namespace allows exactly one occupant. Falling back to the keys keeps
        // the section usable instead of letting a duplicate registration empty
        // it out.
        let translate = key => key
        try {
          ctx.locale.register(NS, 'en', DICTIONARY)
          translate = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('deepaicode: the settings page keeps untranslated labels', error)
        }

        const face = {
          translate,
          subscribe: callback => ctx.locale.subscribe(callback),
          getSnapshot: () => ctx.locale.getSnapshot(),
        }

        /**
         * Wrap the page so it always reads through the current locale face.
         * @returns {object} the element.
         */
        const Wrapped = () => h(LocaleContext.Provider, { value: face }, h(DeepAiCodeSection))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'deepaicode',
          order: SECTION_ORDER,
          label: () => translate('section.title'),
        }, Wrapped))
      },
    }
  },
})
