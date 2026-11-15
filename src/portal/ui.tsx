// Portal UI kit: app shell with auth guard, and small shared components.
import { createContext, type ComponentChildren } from 'preact'
import { useCallback, useContext, useEffect, useState } from 'preact/hooks'
import { logoPaths } from '../components/logo-paths'
import { adminNav, businessNav, type NavItem } from './nav'
import {
  currentBusinessId, loadContext, membership, setCurrentBusiness, sb, type Ctx, type Membership,
} from './lib'

// ── Context ──
interface App {
  ctx: Ctx
  bizId: string | null
  biz: Membership | null
  isAdmin: boolean
  reload: () => Promise<void>
  toast: (msg: string, tone?: 'ok' | 'bad') => void
}
const AppCtx = createContext<App | null>(null)
export const useApp = () => useContext(AppCtx)!

export function Logo({ variant = 'hor' }: { variant?: 'hor' | 'stack' }) {
  const p = logoPaths[variant]
  return (
    <svg class={`logo logo-${variant}`} viewBox={`0 0 ${p.w} ${p.h}`} fill="currentColor" role="img" aria-label="Tomorrow Web" style={{ height: variant === 'hor' ? '1rem' : 'auto', width: 'auto', display: 'block' }}>
      <path d={p.d} fill-rule="evenodd" />
    </svg>
  )
}

type Guard = 'any' | 'admin' | 'business'

/**
 * Wraps every signed-in portal page. Redirects to login when signed out and to the
 * password page while a temporary password is in use. `need` restricts the page.
 */
export function Portal(props: { title: string; need?: Guard; module?: string; perm?: string; children: (app: App) => ComponentChildren }) {
  const [ctx, setCtx] = useState<Ctx | null | undefined>(undefined)
  const [bizId, setBizId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: string }[]>([])

  const toast = useCallback((msg: string, tone: 'ok' | 'bad' = 'ok') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  const reload = useCallback(async () => {
    const c = await loadContext()
    if (!c) {
      location.replace(`/portal/login/?next=${encodeURIComponent(location.pathname + location.search)}`)
      return
    }
    if (c.profile.must_change_password && !location.pathname.startsWith('/portal/password')) {
      location.replace('/portal/password/')
      return
    }
    setCtx(c)
    setBizId(currentBusinessId(c))
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  if (ctx === undefined || ctx === null) return <div class="p-loading">Loading…</div>

  const isAdmin = ctx.profile.role === 'admin'
  const biz = membership(ctx, bizId)
  const app: App = { ctx, bizId, biz, isAdmin, reload, toast }

  let denied = ''
  if (props.need === 'admin' && !isAdmin) denied = 'This page is only for the Tomorrow Web administrator.'
  if (props.need === 'business') {
    if (!biz && !isAdmin) denied = 'You are not part of a business yet.'
    else if (!biz && isAdmin) denied = 'Pick a business to manage from Clients & businesses.'
    else if (props.module && !biz!.modules.includes(props.module)) denied = 'This feature is not switched on for this business.'
    else if (props.perm && !(isAdmin || biz!.role === 'owner' || biz!.permissions.includes(props.perm))) denied = 'You don’t have permission to open this page.'
  }

  return (
    <AppCtx.Provider value={app}>
      <div class={`p-shell${open ? ' is-open' : ''}`}>
        <Sidebar app={app} onBiz={(id) => { setCurrentBusiness(id); setBizId(id) }} onClose={() => setOpen(false)} />
        <div>
          <div class="p-topbar">
            <button class="btn btn-ghost p-btn" type="button" onClick={() => setOpen(true)} aria-label="Open menu">Menu</button>
            <Logo />
          </div>
          <main class="p-main" id="main">
            {denied ? (
              <div class="p-notice" data-tone="warn" role="alert">{denied}</div>
            ) : (
              props.children(app)
            )}
          </main>
        </div>
      </div>
      <div class="p-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div class="p-toast" data-tone={t.tone} key={t.id}>{t.msg}</div>
        ))}
      </div>
    </AppCtx.Provider>
  )
}

function Sidebar({ app, onBiz, onClose }: { app: App; onBiz: (id: string) => void; onClose: () => void }) {
  const { ctx, biz, isAdmin } = app
  const here = typeof location !== 'undefined' ? location.pathname : ''
  const link = (n: NavItem) => (
    <a href={n.href} aria-current={here === n.href || (n.href !== '/portal/admin/' && here.startsWith(n.href)) ? 'page' : undefined}>{n.label}</a>
  )
  const visible = (n: NavItem) => {
    if (!biz) return false
    if (n.ownerOnly) return biz.role === 'owner'
    if (n.module && !biz.modules.includes(n.module)) return false
    if (n.perm && !(biz.role === 'owner' || biz.permissions.includes(n.perm))) return false
    return true
  }
  return (
    <aside class="p-side" aria-label="Portal navigation">
      <a class="p-brand" href="/portal/" onClick={onClose}>
        <Logo />
      </a>
      {ctx.memberships.length > 1 && (
        <label class="p-field">
          <span class="sr-only">Business</span>
          <select class="p-biz" value={biz?.business_id ?? ''} onChange={(e) => onBiz((e.target as HTMLSelectElement).value)}>
            {ctx.memberships.map((m) => (
              <option value={m.business_id} key={m.business_id}>{m.business_name}</option>
            ))}
          </select>
        </label>
      )}
      <nav class="p-nav">
        <a href="/portal/" aria-current={here === '/portal/' ? 'page' : undefined}>Dashboard</a>
        {biz && (
          <>
            <h3>{biz.business_name}</h3>
            {businessNav.filter(visible).map(link)}
          </>
        )}
        {isAdmin && (
          <>
            <h3>Tomorrow Web</h3>
            {adminNav.map(link)}
          </>
        )}
        <h3>You</h3>
        <a href="/portal/account/" aria-current={here.startsWith('/portal/account') ? 'page' : undefined}>Account</a>
      </nav>
      <div class="p-side-foot">
        <div>{ctx.profile.full_name || ctx.profile.email}</div>
        <div class="p-small">{isAdmin ? 'Administrator' : biz ? biz.role[0].toUpperCase() + biz.role.slice(1) : ''}</div>
        <button class="btn btn-ghost p-btn" type="button" onClick={async () => { await sb().auth.signOut(); location.href = '/portal/login/' }}>Sign out</button>
      </div>
    </aside>
  )
}

// ── Small components ──
export function PageHead(props: { title: string; sub?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <header class="p-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub && <p>{props.sub}</p>}
      </div>
      {props.children && <div class="p-actions">{props.children}</div>}
    </header>
  )
}

export function Stat({ n, label }: { n: ComponentChildren; label: string }) {
  return (
    <div class="p-card p-stat">
      <span class="p-stat-n">{n}</span>
      <span class="p-stat-l">{label}</span>
    </div>
  )
}

export function Badge({ tone, children }: { tone?: 'ok' | 'warn' | 'bad' | 'ai'; children: ComponentChildren }) {
  return <span class="p-badge" data-tone={tone}>{children}</span>
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="p-empty">{children}</div>
}

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [props.onClose])
  return (
    <div class="p-modal-back" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="p-modal" role="dialog" aria-modal="true" aria-label={props.title}>
        <div class="p-row">
          <h2>{props.title}</h2>
          <span class="p-spacer" />
          <button class="btn btn-ghost p-btn" type="button" onClick={props.onClose}>Close</button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

export function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label class="p-field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small>{props.hint}</small>}
    </label>
  )
}

/** Shows a one-time secret (temporary password) with a copy button. */
export function OneTimeSecret({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div class="p-notice" data-tone="ok">
      <div>
        <strong>{label}</strong>
        <div class="p-row" style={{ marginTop: '0.4rem' }}>
          <code class="p-secret">{value}</code>
          <button class="btn btn-ghost p-btn" type="button" onClick={() => { navigator.clipboard?.writeText(value); setCopied(true) }}>{copied ? 'Copied' : 'Copy'}</button>
        </div>
        <p class="p-small p-muted" style={{ margin: '0.5rem 0 0' }}>Shown once. Send it privately (for example on WhatsApp). They must choose a new password when they first sign in.</p>
      </div>
    </div>
  )
}

/** Loads data with loading/error state and a reload function. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const run = useCallback(async () => {
    setLoading(true)
    try {
      setData(await fn())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, deps)
  useEffect(() => {
    run()
  }, [run])
  return { data, error, loading, reload: run, setData }
}

export function ErrorNote({ error }: { error: string }) {
  return error ? <div class="p-notice" data-tone="bad" role="alert">{error}</div> : null
}

/** Simple "submitting" wrapper for async button/form actions with toast feedback. */
export function useAction() {
  const { toast } = useApp()
  const [busy, setBusy] = useState(false)
  const run = useCallback(async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true)
    try {
      const r = await fn()
      if (okMsg) toast(okMsg)
      return r
    } catch (e) {
      toast((e as Error).message, 'bad')
      return undefined
    } finally {
      setBusy(false)
    }
  }, [toast])
  return { busy, run }
}

export function formData(e: Event) {
  e.preventDefault()
  const f = e.currentTarget as HTMLFormElement
  return Object.fromEntries(new FormData(f).entries()) as Record<string, string>
}
