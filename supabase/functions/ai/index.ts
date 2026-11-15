// AI gateway. verify_jwt: false (the public website widget calls it without a login).
//   chat      — visitor assistant: origin check, rate limits, FAQ grounding, provider chain, FAQ fallback
//   assist    — signed-in dashboard writing help (change-request specs, blog drafts, audit summaries…)
//   models    — admin: models offered by a provider, with prices for OpenRouter
//   test      — admin: health check + test prompt for a provider (records the result)
//   key_info  — admin: OpenRouter key limits and usage (never returns the key)
// Provider keys live in Supabase Vault and are read here with the service role only.
import { audit, clean, getCaller, handler, HttpError, json, requireAdmin, serviceClient, userClient, UUID_RE } from '../_shared/util.ts'
import {
  ASSIST_TASKS, buildSystemPrompt, callProvider, cleanMessages, gateModel, listModels, OPENROUTER_BASE, REFUSAL_TEXT, runChain,
  type Attempt, type ModelInfo, type Provider,
} from '../_shared/ai.ts'

const admin = serviceClient()
const SALT = (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '').slice(-24)

// ── Helpers ───────────────────────────────────────────────────────────────
let catalogue: { at: number; models: ModelInfo[] } | null = null
async function getCatalogue(): Promise<ModelInfo[] | null> {
  if (catalogue && Date.now() - catalogue.at < 10 * 60_000) return catalogue.models
  try {
    const models = await listModels({ kind: 'openrouter' } as Provider)
    catalogue = { at: Date.now(), models }
    return models
  } catch (e) {
    console.error('openrouter catalogue', (e as Error).message)
    return catalogue?.models ?? null
  }
}

async function providers(): Promise<Provider[]> {
  const { data, error } = await admin.rpc('svc_ai_providers')
  if (error) throw error
  return (data ?? []) as Provider[]
}

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}
const today = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10) // IST date
const minute = () => Math.floor(Date.now() / 60_000)

async function hit(key: string, ttl: number): Promise<number> {
  const { data, error } = await admin.rpc('svc_ai_hit', { p_key: key, p_ttl_seconds: ttl })
  if (error) throw error
  return data as number
}

async function record(scope: string, business: string | null, provider: string, outcome: 'ai' | 'faq' | 'fail' | 'refused', tokens = { p: 0, c: 0 }, cost = 0) {
  await admin.rpc('svc_ai_record', {
    p_scope: scope, p_business: business, p_provider: provider, p_outcome: outcome,
    p_prompt_tokens: tokens.p, p_completion_tokens: tokens.c, p_cost_usd: cost,
  })
}

/** Records failures/refusals; model refusals are written to the audit log (once per provider per hour). */
const announced = new Map<string, number>()
async function noteAttempts(attempts: Attempt[], scope: string, business: string | null, all: Provider[]) {
  for (const a of attempts) {
    await record(scope, business, a.provider, a.outcome === 'refused' ? 'refused' : 'fail')
    const isModelRefusal = a.outcome === 'refused' && a.reason in REFUSAL_TEXT
    await admin.rpc('svc_ai_check', { p_provider: a.provider, p_ok: false, p_ms: 0, p_error: isModelRefusal ? REFUSAL_TEXT[a.reason] : a.reason })
    const k = `${a.provider}:${a.reason}`
    if (isModelRefusal && (announced.get(k) ?? 0) < Date.now() - 3600_000) {
      announced.set(k, Date.now())
      const p = all.find((x) => x.id === a.provider)
      await audit(admin, null, 'ai:refused_model', { provider: a.name, model: p?.model, reason: a.reason, explanation: REFUSAL_TEXT[a.reason] }, { entity: 'ai_providers', entity_id: a.provider })
    }
  }
}

/** Per-provider minute/day limits (protects free-tier quotas and self-hosted servers). */
const withinLimits = async (p: Provider) =>
  (await hit(`prov:${p.id}:${minute()}`, 90)) <= (p.rpm_limit ?? 20) && (await hit(`provday:${p.id}:${today()}`, 90_000)) <= (p.daily_limit ?? 200)

// ── chat (public) ─────────────────────────────────────────────────────────
async function chat(req: Request, body: Record<string, unknown>) {
  const key = clean(body.site_key, 80)
  const { data: site } = await admin.from('sites').select('id, business_id, url, allowed_origins, businesses(name)').eq('public_key', key).maybeSingle()
  if (!site) throw new HttpError(404, 'Unknown website.')
  const [{ data: mod }, { data: st }] = await Promise.all([
    admin.from('business_modules').select('enabled').eq('business_id', site.business_id).eq('module_key', 'ai_assistant').maybeSingle(),
    admin.from('ai_site_settings').select('*').eq('site_id', site.id).maybeSingle(),
  ])

  // Signed-in owners/admin can preview from the portal, before the assistant is switched on.
  let preview = false
  if (body.preview === true && req.headers.get('Authorization')) {
    const { data } = await userClient(req).from('ai_site_settings').select('site_id').eq('site_id', site.id).maybeSingle()
    preview = !!data
  }
  if (!preview) {
    if (!mod?.enabled || !st?.enabled) return json({ available: false, enabled: false, reason: 'disabled', faq: [] })
    const origin = req.headers.get('Origin') ?? ''
    const allowed: string[] = site.allowed_origins?.length ? site.allowed_origins : site.url ? [new URL(site.url).origin] : []
    if (!allowed.includes(origin)) throw new HttpError(403, 'This website is not allowed to use this assistant.')
  }

  const messages = cleanMessages(body.messages)
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content
  if (!question) throw new HttpError(400, 'Ask a question.')
  const scope = `site:${site.id}`
  const { data: faqData } = await admin.rpc('faq_answer', { p_key: key, p_question: question, p_limit: 3 })
  const faq = (faqData ?? []) as { question: string; answer: string; score: number }[]
  const fallback = async (reason: string) => {
    await record(scope, site.business_id, '', 'faq')
    return json({ available: false, reason, faq })
  }

  if (!preview) {
    const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown'
    const ipKey = await sha256(`${ip}:${today()}:${SALT}`)
    if ((await hit(`ip:${site.id}:${ipKey}`, 3600)) > (st?.per_ip_per_hour ?? 20)) return fallback('rate_limited')
    if ((await hit(`site:${site.id}:${today()}`, 90_000)) > (st?.daily_cap ?? 100)) return fallback('daily_cap')
  }
  if (st && st.ai_enabled === false) return fallback('faq_only')

  const all = await providers()
  const chain = all.filter((p) => p.enabled && (!st?.provider_id || p.id === st.provider_id))
  if (!chain.length) return fallback('no_provider')

  const system = buildSystemPrompt({
    businessName: (site as any).businesses?.name ?? 'this business', facts: st?.business_facts, faqs: faq,
    whatsapp: st?.handoff_whatsapp, contactUrl: st?.handoff_url,
  })
  const result = await runChain(chain, [{ role: 'system', content: system }, ...messages], { getModels: getCatalogue, allowed: withinLimits })
  await noteAttempts(result.attempts, scope, site.business_id, all)
  if (!result.ok) return fallback('offline')
  await record(scope, site.business_id, result.provider.id, 'ai', { p: result.promptTokens, c: result.completionTokens }, result.costUsd)
  await admin.rpc('svc_ai_check', { p_provider: result.provider.id, p_ok: true, p_ms: result.ms, p_error: null })
  return json({ available: true, reply: result.text, provider: result.provider.name, model: result.provider.model, ai_generated: true, faq })
}

// ── assist (signed in) ────────────────────────────────────────────────────
async function assist(req: Request, body: Record<string, unknown>) {
  const caller = await getCaller(req, admin)
  const task = clean(body.task, 30)
  const spec = ASSIST_TASKS[task]
  if (!spec) throw new HttpError(400, 'Unknown task.')
  const input = clean(body.input, 20000)
  if (input.length < 3) throw new HttpError(400, 'Nothing to work with yet.')
  let business: string | null = null
  if (task === 'blog_draft' || task === 'blog_polish') {
    const siteId = clean(body.site_id, 40)
    if (!UUID_RE.test(siteId)) throw new HttpError(400, 'Missing website.')
    const { data: can } = await userClient(req).rpc('can_manage_site', { p_site: siteId })
    if (!can) throw new HttpError(403, 'You don’t have permission to use AI for this website.')
    business = (await admin.from('sites').select('business_id').eq('id', siteId).single()).data?.business_id ?? null
  } else {
    requireAdmin(caller)
  }
  if ((await hit(`user:${caller.profile.id}:${today()}`, 90_000)) > 40) throw new HttpError(429, 'Daily AI limit reached for your account. Try again tomorrow.')

  const all = await providers()
  const chain = all.filter((p) => p.enabled).map((p) => ({ ...p, max_tokens: spec.maxTokens, timeout_ms: Math.max(p.timeout_ms, 30_000) }))
  const empty = { available: false, message: 'AI is offline right now (no AI provider is connected or reachable). Everything else works as normal.' }
  if (!chain.length) return json(empty)
  const result = await runChain(chain, [{ role: 'system', content: spec.system }, { role: 'user', content: input }], { getModels: getCatalogue, allowed: withinLimits })
  await noteAttempts(result.attempts, 'dashboard', business, all)
  if (!result.ok) return json({ ...empty, attempts: caller.profile.role === 'admin' ? result.attempts : undefined })
  await record('dashboard', business, result.provider.id, 'ai', { p: result.promptTokens, c: result.completionTokens }, result.costUsd)
  return json({ available: true, text: result.text, provider: result.provider.name, model: result.provider.model, ai_generated: true })
}

// ── admin tools ───────────────────────────────────────────────────────────
async function adminProvider(req: Request, body: Record<string, unknown>) {
  const caller = await getCaller(req, admin)
  requireAdmin(caller)
  const id = clean(body.provider_id, 40)
  if (body.kind === 'openrouter' && !id) return { caller, p: { kind: 'openrouter', id: '', name: 'OpenRouter' } as Provider }
  const p = (await providers()).find((x) => x.id === id)
  if (!p) throw new HttpError(404, 'Provider not found.')
  return { caller, p }
}

async function models(req: Request, body: Record<string, unknown>) {
  const { p } = await adminProvider(req, body)
  try {
    const list = p.kind === 'openrouter' ? await getCatalogue() : await listModels(p)
    if (!list) throw new Error('OpenRouter model list is unavailable right now.')
    return json({ models: list, checked_at: new Date().toISOString() })
  } catch (e) {
    throw new HttpError(502, `Couldn’t list models: ${(e as Error).message}`)
  }
}

async function test(req: Request, body: Record<string, unknown>) {
  const { caller, p } = await adminProvider(req, body)
  const out: Record<string, unknown> = { provider: p.name, model: p.model }
  try {
    const list = p.kind === 'openrouter' ? await getCatalogue() : await listModels(p)
    out.models_available = list?.length ?? 0
    out.model_listed = !!list?.some((m) => m.id === p.model)
    const gate = gateModel(p, list)
    out.gate = gate.ok ? (gate.paid ? 'paid model allowed by your spending limit' : 'free') : REFUSAL_TEXT[gate.reason]
    if (!gate.ok) {
      await admin.rpc('svc_ai_check', { p_provider: p.id, p_ok: false, p_ms: 0, p_error: REFUSAL_TEXT[gate.reason] })
      await audit(admin, caller, 'ai:test', { ...out, ok: false }, { entity: 'ai_providers', entity_id: p.id })
      return json({ ok: false, ...out, error: REFUSAL_TEXT[gate.reason] })
    }
    const r = await callProvider({ ...p, max_tokens: 20 }, [{ role: 'user', content: 'Reply with just the word OK.' }], { paidAllowed: gate.paid })
    await admin.rpc('svc_ai_check', { p_provider: p.id, p_ok: true, p_ms: r.ms, p_error: null })
    await record('dashboard', null, p.id, 'ai', { p: r.promptTokens, c: r.completionTokens }, r.costUsd)
    await audit(admin, caller, 'ai:test', { ...out, ok: true, ms: r.ms }, { entity: 'ai_providers', entity_id: p.id })
    return json({ ok: true, ...out, ms: r.ms, reply: r.text.slice(0, 200), cost_usd: r.costUsd })
  } catch (e) {
    const msg = (e as Error).message
    await admin.rpc('svc_ai_check', { p_provider: p.id, p_ok: false, p_ms: 0, p_error: msg })
    await audit(admin, caller, 'ai:test', { ...out, ok: false, error: msg }, { entity: 'ai_providers', entity_id: p.id })
    return json({ ok: false, ...out, error: msg })
  }
}

async function keyInfo(req: Request, body: Record<string, unknown>) {
  const { p } = await adminProvider(req, body)
  if (p.kind !== 'openrouter') throw new HttpError(400, 'Only OpenRouter has key information.')
  if (!p.token) return json({ configured: false })
  const res = await fetch(`${OPENROUTER_BASE}/key`, { headers: { Authorization: `Bearer ${p.token}` }, signal: AbortSignal.timeout(10_000) })
  const data = (await res.json().catch(() => ({})))?.data
  if (!res.ok || !data) return json({ configured: true, ok: false, error: `OpenRouter answered ${res.status}` })
  // Pass through limits and usage only.
  const pick = ['label', 'limit', 'limit_remaining', 'limit_reset', 'usage', 'usage_daily', 'usage_monthly', 'is_free_tier', 'free_model_daily_requests']
  return json({ configured: true, ok: true, key: Object.fromEntries(pick.filter((k) => k in data).map((k) => [k, data[k]])) })
}

Deno.serve(handler(async (req, body) => {
  switch (body.action) {
    case 'chat': return await chat(req, body)
    case 'assist': return await assist(req, body)
    case 'models': return await models(req, body)
    case 'test': return await test(req, body)
    case 'key_info': return await keyInfo(req, body)
    default: throw new HttpError(400, 'Unknown action.')
  }
}))
