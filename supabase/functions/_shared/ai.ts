// Provider-agnostic AI core shared by the `ai` Edge Function and unit tests.
// Pure TypeScript using fetch only (no Deno or npm imports), so Node can test it directly.
//
// Spending rule: a provider with max_spend_inr = 0 (the default) may only use models whose every
// price is exactly zero. Anything else — a paid model, a model that changed from free to paid, or
// a model that disappeared — is refused and the caller falls back to FAQ answers. Paid models are
// possible only when the administrator explicitly sets a non-zero rupee limit, and stop at it.

export type ProviderKind = 'ollama' | 'llamacpp' | 'openrouter'

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  base_url: string
  model: string
  enabled?: boolean
  priority?: number
  timeout_ms: number
  max_tokens: number
  max_spend_inr: number
  spent_inr: number
  usd_inr_rate: number
  rpm_limit?: number
  daily_limit?: number
  token?: string | null
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelInfo {
  id: string
  name: string
  free: boolean
  /** USD per million tokens; null when unknown/variable. */
  promptUsdPerM: number | null
  completionUsdPerM: number | null
  context: number | null
  pricing: Record<string, string>
}

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

export class AiError extends Error {
  code: 'timeout' | 'http' | 'bad_response' | 'network' | 'refused'
  status?: number
  constructor(code: AiError['code'], message: string, status?: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

// ── Pricing ──────────────────────────────────────────────────────────────
/** True only if every listed price parses to exactly 0. Missing, variable (-1) or non-numeric → not free. */
export function isFree(pricing: Record<string, unknown> | null | undefined): boolean {
  if (!pricing || typeof pricing !== 'object') return false
  const values = Object.values(pricing)
  if (!values.length) return false
  return values.every((v) => {
    if (v === null || v === undefined || v === '') return true // absent price component (e.g. no image pricing)
    const n = Number(v)
    return Number.isFinite(n) && n === 0
  }) && ['prompt', 'completion'].every((k) => k in pricing && Number((pricing as any)[k]) === 0)
}

const perM = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null
}

export function parseOpenRouterModels(json: any): ModelInfo[] {
  const data: any[] = Array.isArray(json?.data) ? json.data : []
  return data
    .filter((m) => typeof m?.id === 'string')
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' ? m.name : m.id,
      free: isFree(m.pricing),
      promptUsdPerM: perM(m.pricing?.prompt),
      completionUsdPerM: perM(m.pricing?.completion),
      context: Number.isFinite(Number(m.context_length)) ? Number(m.context_length) : null,
      pricing: m.pricing ?? {},
    }))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.name.localeCompare(b.name))
}

export type Gate =
  | { ok: true; paid: boolean; model: ModelInfo | null }
  | { ok: false; reason: 'model_unavailable' | 'model_paid' | 'spend_limit_reached' }

/**
 * Decides whether a provider's configured model may be used right now.
 * Self-hosted providers have no per-token charge, so they always pass.
 */
export function gateModel(p: Provider, models: ModelInfo[] | null): Gate {
  if (p.kind !== 'openrouter') return { ok: true, paid: false, model: null }
  const m = models?.find((x) => x.id === p.model)
  if (!m) return { ok: false, reason: 'model_unavailable' }
  if (m.free) return { ok: true, paid: false, model: m }
  if (!(Number(p.max_spend_inr) > 0)) return { ok: false, reason: 'model_paid' }
  if (Number(p.spent_inr) >= Number(p.max_spend_inr)) return { ok: false, reason: 'spend_limit_reached' }
  return { ok: true, paid: true, model: m }
}

export const REFUSAL_TEXT: Record<string, string> = {
  model_unavailable: 'The selected model is no longer offered.',
  model_paid: 'The selected model is not free and the spending limit is ₹0, so it was refused.',
  spend_limit_reached: 'The spending limit for this provider has been reached.',
}

// ── Transport ────────────────────────────────────────────────────────────
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

async function request(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    throw (e as Error)?.name === 'AbortError' ? new AiError('timeout', `No answer within ${Math.round(timeoutMs / 1000)}s`) : new AiError('network', `Unreachable: ${(e as Error).message}`)
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error ?? text.slice(0, 200) ?? res.statusText
    throw new AiError('http', `HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`, res.status)
  }
  if (body === null) throw new AiError('bad_response', 'Response was not JSON')
  return body
}

const selfHostedBase = (p: Provider) => p.base_url.replace(/\/+$/, '').replace(/\/v1$/, '')
const authHeaders = (p: Provider): Record<string, string> => (p.token ? { Authorization: `Bearer ${p.token}` } : {})

/** Removes hidden reasoning blocks some open models emit. */
export const stripThinking = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

export interface ChatResult {
  text: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  ms: number
}

export async function callProvider(p: Provider, messages: ChatMessage[], opts: { fetchImpl?: FetchLike; paidAllowed?: boolean } = {}): Promise<ChatResult> {
  const f = opts.fetchImpl ?? fetch
  const t0 = Date.now()
  const headers = { 'content-type': 'application/json', ...authHeaders(p) }
  let body: any
  if (p.kind === 'ollama') {
    body = await request(f, `${selfHostedBase(p)}/api/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: p.model, messages, stream: false, options: { num_predict: p.max_tokens, temperature: 0.3 } }),
    }, p.timeout_ms)
    const text = stripThinking(String(body?.message?.content ?? ''))
    if (!text) throw new AiError('bad_response', 'Empty reply')
    return { text, promptTokens: Number(body.prompt_eval_count ?? 0), completionTokens: Number(body.eval_count ?? 0), costUsd: 0, ms: Date.now() - t0 }
  }
  const url = p.kind === 'openrouter' ? `${OPENROUTER_BASE}/chat/completions` : `${selfHostedBase(p)}/v1/chat/completions`
  const payload: Record<string, unknown> = { model: p.model, messages, max_tokens: p.max_tokens, temperature: 0.3, stream: false }
  if (p.kind === 'openrouter') {
    if (!p.token) throw new AiError('refused', 'OpenRouter API key is not set')
    // Second guard: OpenRouter itself refuses to route to any priced endpoint when paid use isn't allowed.
    if (!opts.paidAllowed) payload.provider = { max_price: { prompt: 0, completion: 0, request: 0, image: 0 }, allow_fallbacks: false }
    payload.usage = { include: true }
    Object.assign(headers, { 'X-Title': 'Tomorrow Web' })
  }
  body = await request(f, url, { method: 'POST', headers, body: JSON.stringify(payload) }, p.timeout_ms)
  const text = stripThinking(String(body?.choices?.[0]?.message?.content ?? ''))
  if (!text) throw new AiError('bad_response', body?.error?.message ? String(body.error.message) : 'Empty reply')
  const cost = Number(body?.usage?.cost ?? 0)
  return {
    text,
    promptTokens: Number(body?.usage?.prompt_tokens ?? 0),
    completionTokens: Number(body?.usage?.completion_tokens ?? 0),
    costUsd: Number.isFinite(cost) && cost > 0 ? cost : 0,
    ms: Date.now() - t0,
  }
}

/** Models offered by a provider (OpenRouter: public catalogue with prices). */
export async function listModels(p: Provider, fetchImpl: FetchLike = fetch): Promise<ModelInfo[]> {
  if (p.kind === 'openrouter') return parseOpenRouterModels(await request(fetchImpl, `${OPENROUTER_BASE}/models`, { headers: {} }, 15000))
  const selfHosted = (id: string): ModelInfo => ({ id, name: id, free: true, promptUsdPerM: 0, completionUsdPerM: 0, context: null, pricing: {} })
  if (p.kind === 'ollama') {
    const body = await request(fetchImpl, `${selfHostedBase(p)}/api/tags`, { headers: authHeaders(p) }, Math.min(p.timeout_ms, 15000))
    return (body?.models ?? []).map((m: any) => selfHosted(String(m.name ?? m.model)))
  }
  const body = await request(fetchImpl, `${selfHostedBase(p)}/v1/models`, { headers: authHeaders(p) }, Math.min(p.timeout_ms, 15000))
  return (body?.data ?? []).map((m: any) => selfHosted(String(m.id)))
}

// ── Chain ────────────────────────────────────────────────────────────────
export interface Attempt {
  provider: string
  name: string
  outcome: 'refused' | 'failed'
  reason: string
}
export type ChainResult =
  | ({ ok: true; provider: Provider; attempts: Attempt[] } & ChatResult)
  | { ok: false; attempts: Attempt[] }

/**
 * Tries providers in order. OpenRouter models are re-checked against the live catalogue first
 * (getModels may return null if the catalogue can't be fetched — then OpenRouter is skipped,
 * because "free" can't be confirmed).
 */
export async function runChain(
  providers: Provider[],
  messages: ChatMessage[],
  deps: {
    fetchImpl?: FetchLike
    getModels: (p: Provider) => Promise<ModelInfo[] | null>
    allowed?: (p: Provider) => Promise<boolean> | boolean // rate limits etc.
  },
): Promise<ChainResult> {
  const attempts: Attempt[] = []
  for (const p of providers) {
    if (deps.allowed && !(await deps.allowed(p))) {
      attempts.push({ provider: p.id, name: p.name, outcome: 'refused', reason: 'rate_limited' })
      continue
    }
    let paid = false
    if (p.kind === 'openrouter') {
      const models = await deps.getModels(p)
      if (!models) {
        attempts.push({ provider: p.id, name: p.name, outcome: 'failed', reason: 'catalogue_unavailable' })
        continue
      }
      const gate = gateModel(p, models)
      if (!gate.ok) {
        attempts.push({ provider: p.id, name: p.name, outcome: 'refused', reason: gate.reason })
        continue
      }
      paid = gate.paid
    }
    try {
      const r = await callProvider(p, messages, { fetchImpl: deps.fetchImpl, paidAllowed: paid })
      if (!paid && r.costUsd > 0) {
        // Should be impossible (max_price 0); never let it go unnoticed.
        attempts.push({ provider: p.id, name: p.name, outcome: 'refused', reason: 'unexpected_cost' })
        return { ok: true, provider: p, attempts, ...r }
      }
      return { ok: true, provider: p, attempts, ...r }
    } catch (e) {
      attempts.push({ provider: p.id, name: p.name, outcome: 'failed', reason: (e as Error).message.slice(0, 200) })
    }
  }
  return { ok: false, attempts }
}

// ── Prompting ────────────────────────────────────────────────────────────
export function cleanMessages(input: unknown, maxTurns = 8, maxChars = 1000): ChatMessage[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-maxTurns)
    .map((m) => ({ role: m.role, content: String(m.content).trim().slice(0, maxChars) }))
}

export interface Grounding {
  businessName: string
  facts?: string | null
  faqs?: { question: string; answer: string }[]
  whatsapp?: string | null
  contactUrl?: string | null
}

export function buildSystemPrompt(g: Grounding): string {
  const handoff = [g.whatsapp ? `WhatsApp +${g.whatsapp}` : '', g.contactUrl ? `the contact page (${g.contactUrl})` : ''].filter(Boolean).join(' or ')
  const faq = (g.faqs ?? []).slice(0, 5).map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
  return [
    `You are the website assistant for ${g.businessName}. Answer visitors' questions briefly (at most 3 short sentences), in the language they use.`,
    'Only use the information below. If the answer is not there, say you are not sure and suggest contacting the business.',
    'Never invent prices, availability, offers, phone numbers or opening hours. Do not give medical, legal or financial advice.',
    handoff ? `To book, order or ask something you can't answer, suggest ${handoff}.` : '',
    g.facts ? `\nBusiness information:\n${g.facts.slice(0, 6000)}` : '',
    faq ? `\nFrequently asked questions:\n${faq}` : '',
  ].filter(Boolean).join('\n')
}

/** Dashboard writing tasks. Output is always labelled AI-generated in the UI. */
export const ASSIST_TASKS: Record<string, { system: string; maxTokens: number }> = {
  spec: {
    system: 'You turn a small business client\'s website change request into a clear task for a web developer. Write plain text with short sections: Goal, Pages affected, Exact changes (bullets), Questions to ask the client. Do not invent details; list unknowns as questions.',
    maxTokens: 600,
  },
  blog_draft: {
    system: 'You draft blog posts for a small business website in India. Write in Markdown, 400-600 words, with ## subheadings, plain friendly language and no invented facts, prices, statistics or quotes. Leave [placeholders] where the business must add specifics.',
    maxTokens: 1200,
  },
  blog_polish: {
    system: 'You improve the clarity, grammar and flow of a blog post written in Markdown. Keep the meaning, facts, structure and tone. Return only the improved Markdown.',
    maxTokens: 1500,
  },
  audit_summary: {
    system: 'You summarise verified website audit findings for a small business owner in plain language. Use only the findings provided. Give 3-5 bullet points of the most important improvements, most impactful first. Do not add new findings.',
    maxTokens: 500,
  },
  outreach: {
    system: 'You draft a short, polite, personalised first message (under 120 words) from a Pune web studio to a local business, based only on the verified details provided. No exaggeration, no fake urgency, no claims you cannot back up. Include a clear opt-out line.',
    maxTokens: 300,
  },
}
