// Portal core: Supabase client, session context types, edge-function calls and formatting.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_KEY, SUPABASE_URL } from '../lib/supabase-config.js'

let _sb: SupabaseClient | null = null
export function sb(): SupabaseClient {
  if (!_sb) {
    _sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tw-portal-auth' },
    })
  }
  return _sb
}

export type Role = 'owner' | 'manager' | 'employee'
export interface Membership {
  business_id: string
  business_name: string
  role: Role
  permissions: string[]
  modules: string[]
}
export interface Ctx {
  profile: {
    id: string
    email: string
    full_name: string
    phone: string | null
    role: 'admin' | 'user'
    must_change_password: boolean
    disabled: boolean
  }
  memberships: Membership[]
}

export async function loadContext(): Promise<Ctx | null> {
  const { data: s } = await sb().auth.getSession()
  if (!s.session) return null
  const { data, error } = await sb().rpc('my_context')
  if (error || !data?.profile) return null
  const ctx = data as Ctx
  // The administrator can work inside any client business (RLS allows admins everything).
  if (ctx.profile.role === 'admin' && !ctx.profile.must_change_password) {
    const { data: all } = await sb().from('businesses').select('id, name, business_modules(module_key, enabled)').order('name')
    for (const b of all ?? []) {
      if (ctx.memberships.some((m) => m.business_id === b.id)) continue
      ctx.memberships.push({
        business_id: b.id,
        business_name: b.name,
        role: 'owner',
        permissions: [],
        modules: ((b as any).business_modules ?? []).filter((x: any) => x.enabled).map((x: any) => x.module_key),
      })
    }
  }
  return ctx
}

/** Calls an Edge Function with the signed-in user's token. Throws with a readable message. */
export async function callFn<T = any>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data: s } = await sb().auth.getSession()
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_KEY,
      ...(s.session ? { authorization: `Bearer ${s.session.access_token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data as T
}

/** Throws a readable error from a Supabase response. */
export function check<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(friendlyError(r.error.message))
  return r.data
}

export function friendlyError(msg: string) {
  if (/row-level security|permission denied|42501/i.test(msg)) return 'You don’t have permission to do that.'
  if (/duplicate key/i.test(msg)) return 'That already exists.'
  if (/JWT|session/i.test(msg)) return 'Your session has expired. Please sign in again.'
  return msg
}

// ── Current business (for people in more than one) ──
const BIZ_KEY = 'tw-portal-biz'
export function currentBusinessId(ctx: Ctx): string | null {
  let id: string | null = null
  try {
    id = localStorage.getItem(BIZ_KEY)
  } catch {
    /* storage unavailable */
  }
  if (id && ctx.memberships.some((m) => m.business_id === id)) return id
  return ctx.memberships[0]?.business_id ?? null
}
export function setCurrentBusiness(id: string) {
  try {
    localStorage.setItem(BIZ_KEY, id)
  } catch {
    /* ignore */
  }
}

export function membership(ctx: Ctx, bizId: string | null) {
  return ctx.memberships.find((m) => m.business_id === bizId) ?? null
}
export function can(ctx: Ctx, bizId: string | null, perm: string) {
  if (ctx.profile.role === 'admin') return true
  const m = membership(ctx, bizId)
  return !!m && (m.role === 'owner' || m.permissions.includes(perm))
}
export function hasModule(ctx: Ctx, bizId: string | null, mod: string) {
  const m = membership(ctx, bizId)
  return !!m && m.modules.includes(mod)
}

// ── Storage ──
export const mediaUrl = (path: string | null | undefined) =>
  path ? `${SUPABASE_URL}/storage/v1/object/public/media/${path.split('/').map(encodeURIComponent).join('/')}` : ''

/** Safe file name for storage paths: keeps letters, digits, dot, dash, underscore. */
export const safeName = (name: string) =>
  name.normalize('NFKD').replace(/[^\w.\-]+/g, '-').replace(/-+/g, '-').slice(-80) || 'file'

export async function upload(bucket: 'media' | 'attachments', path: string, file: File) {
  const { error } = await sb().storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type || undefined })
  if (error) throw new Error(/mime|type/i.test(error.message) ? 'That file type isn’t allowed.' : /size|large/i.test(error.message) ? 'That file is too large.' : friendlyError(error.message))
  return path
}

/**
 * Sends an email alert to Tomorrow Web through the site's free Netlify Forms (form "portal-alert",
 * declared in the portal layout). Best effort: it never blocks or fails the user's action.
 */
export function notifyAdmin(fields: Record<string, string>) {
  try {
    const body = new URLSearchParams({ 'form-name': 'portal-alert', ...fields })
    fetch('/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }).catch(() => {})
  } catch {
    /* ignore */
  }
}

// ── Formatting ──
const inrFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
export const inr = (n: number | string | null | undefined) => inrFmt.format(Number(n ?? 0))
export const dt = (s: string | null | undefined) =>
  s ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s)) : '—'
export const d = (s: string | null | undefined) => (s ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(s)) : '—')
export const bytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)
export const qs = (k: string) => new URLSearchParams(location.search).get(k)
export const ago = (s: string | null | undefined) => {
  if (!s) return 'never'
  const diff = (Date.now() - new Date(s).getTime()) / 1000
  if (diff < 90) return 'just now'
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`
  return `${Math.round(diff / 86400)} days ago`
}

/** Builds CSV text; cells starting with = + - @ are prefixed with ' to block spreadsheet formula injection. */
export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0])
  const esc = (v: unknown) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}

export function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['\ufeff' + toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
