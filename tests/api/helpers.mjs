// Shared helpers for API tests that run against the real Supabase project.
// Credentials come from environment variables (never committed):
//   TW_QA_EMAIL / TW_QA_PASSWORD — the QA administrator account.
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_KEY } from '../../src/lib/supabase-config.js'

export const url = SUPABASE_URL
export const key = SUPABASE_KEY

export function client() {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

/** Signs in; if the account still has a temporary password, sets `newPassword` and confirms it. */
export async function signIn(email, password, newPassword) {
  const sb = client()
  const { error } = await sb.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  const { data: ctx } = await sb.rpc('my_context')
  if (ctx?.profile?.must_change_password) {
    if (!newPassword) throw new Error(`${email} must change password`)
    const { error: e2 } = await sb.auth.updateUser({ password: newPassword })
    if (e2) throw new Error(`password change failed: ${e2.message}`)
    const { error: e3 } = await sb.rpc('mark_password_changed')
    if (e3) throw e3
  }
  return sb
}

export async function fn(sb, name, body) {
  const { data: s } = await sb.auth.getSession()
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: key, ...(s?.session ? { authorization: `Bearer ${s.session.access_token}` } : {}) },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    data = { raw: text }
  }
  return { status: res.status, data }
}

export const uid = () => Math.random().toString(36).slice(2, 8)
export const qaEmail = (label) => `qa-${label}-${uid()}@tomorrowweb.test`
export const strongPassword = () => `Qa-${crypto.randomUUID()}`

/** Creates a client business + owner through the admin function and signs the owner in. */
export async function makeClient(admin, { preset = 'website_only', name = 'QA Biz', siteUrl } = {}) {
  const email = qaEmail('owner')
  const r = await fn(admin, 'admin-users', {
    action: 'create_client', email, full_name: `${name} Owner`,
    business: { name: `${name} ${uid()}`, preset, city: 'Pune', site_url: siteUrl },
  })
  if (r.status !== 200) throw new Error(`create_client failed: ${JSON.stringify(r.data)}`)
  const owner = await signIn(email, r.data.temp_password, strongPassword())
  return { owner, email, biz: r.data.business_id, data: r.data }
}
