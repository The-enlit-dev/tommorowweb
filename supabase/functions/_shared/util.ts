// Shared helpers for Tomorrow Web Edge Functions.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2.118.0'

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', ...extra } })
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Service-role client: bypasses RLS. Only ever used inside Edge Functions. */
export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export interface Caller {
  user: User
  profile: { id: string; email: string; role: 'admin' | 'user'; must_change_password: boolean; disabled: boolean }
}

/** Resolves the signed-in caller from the Authorization header. */
export async function getCaller(req: Request, admin: SupabaseClient): Promise<Caller> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) throw new HttpError(401, 'Not signed in.')
  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Your session has expired. Please sign in again.')
  const { data: profile } = await admin.from('profiles').select('id, email, role, must_change_password, disabled').eq('id', data.user.id).single()
  if (!profile) throw new HttpError(403, 'No profile for this account.')
  if (profile.disabled) throw new HttpError(403, 'This account is disabled.')
  if (profile.must_change_password) throw new HttpError(403, 'Please change your temporary password first.')
  return { user: data.user, profile }
}

export function requireAdmin(c: Caller) {
  if (c.profile.role !== 'admin') throw new HttpError(403, 'Only the Tomorrow Web administrator can do this.')
}

/** Readable temporary password: 4 groups, no ambiguous characters. ~80 bits of entropy. */
export function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length])
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-')
}

export async function audit(
  admin: SupabaseClient,
  c: Caller | null,
  action: string,
  details: Record<string, unknown> = {},
  opts: { business_id?: string | null; entity?: string; entity_id?: string } = {},
) {
  await admin.from('audit_logs').insert({
    actor_id: c?.profile.id ?? null,
    actor_email: c?.profile.email ?? null,
    business_id: opts.business_id ?? null,
    action,
    entity: opts.entity ?? null,
    entity_id: opts.entity_id ?? null,
    details,
  })
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function clean(s: unknown, max = 200) {
  return typeof s === 'string' ? s.trim().slice(0, max) : ''
}

/** Wraps a handler with CORS, JSON parsing and error handling. */
export function handler(fn: (req: Request, body: Record<string, unknown>) => Promise<Response>) {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405)
    try {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      return await fn(req, body)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      console.error(e)
      return json({ error: 'Something went wrong. Please try again.' }, 500)
    }
  }
}

export const ALL_PERMISSIONS = [
  'orders.view',
  'orders.update',
  'pos.sell',
  'products.manage',
  'inventory.manage',
  'customers.view',
  'discounts.manage',
  'reports.view',
  'refunds.issue',
  'team.manage',
  'settings.manage',
] as const

export const DEFAULT_PERMISSIONS: Record<'manager' | 'employee', string[]> = {
  employee: ['orders.view', 'orders.update', 'pos.sell'],
  manager: ['orders.view', 'orders.update', 'pos.sell', 'products.manage', 'inventory.manage', 'customers.view', 'discounts.manage', 'reports.view'],
}
