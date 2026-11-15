// M2 API tests against the live `ai` Edge Function: FAQ fallback with no/offline providers, the ₹0
// paid-model refusal (using OpenRouter's real catalogue), origin checks, rate limits, admin tools.
// Test providers are removed afterwards. No real AI calls are paid for (fake keys, refused models).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { client, fn, makeClient, signIn, url, key } from './helpers.mjs'

const s = { providers: [] }
const ORIGIN = 'https://qa-salon.example.com'

async function chat(body, origin = ORIGIN) {
  const res = await fetch(`${url}/functions/v1/ai`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ action: 'chat', site_key: s.site.public_key, ...body }),
  })
  return { status: res.status, data: await res.json() }
}
const ask = (q, origin) => chat({ messages: [{ role: 'user', content: q }] }, origin)

after(async () => {
  for (const id of s.providers) await s.admin.from('ai_providers').delete().eq('id', id)
})

test('setup: salon client with FAQs', async () => {
  s.admin = await signIn(process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  // Make sure no other enabled provider interferes with these expectations.
  const { data: live } = await s.admin.from('ai_providers').select('id').eq('enabled', true)
  assert.equal(live.length, 0, 'tests expect no enabled providers on the project')
  s.c = await makeClient(s.admin, { preset: 'salon', name: 'QA Salon AI', siteUrl: ORIGIN })
  s.site = (await s.c.owner.from('sites').select('id, public_key').single()).data
  const ins = await s.c.owner.from('ai_site_settings').insert({ site_id: s.site.id, greeting: 'Hello!', handoff_whatsapp: '919800000000' })
  assert.ifError(ins.error)
  const faqs = await s.c.owner.from('ai_knowledge').insert([
    { site_id: s.site.id, question: 'What are your opening hours?', answer: 'Open 10am to 8pm, Tuesday to Sunday.' },
    { site_id: s.site.id, question: 'How much is a haircut?', answer: 'Haircuts start at ₹300.' },
  ])
  assert.ifError(faqs.error)
})

test('disabled assistant: widget config off, chat says disabled', async () => {
  const cfg = await client().rpc('ai_widget_config', { p_key: s.site.public_key })
  assert.equal(cfg.data.enabled, false)
  const r = await ask('when are you open')
  assert.equal(r.data.reason, 'disabled')
})

test('enabled, no AI provider: FAQ fallback answers', async () => {
  await s.c.owner.from('ai_site_settings').update({ enabled: true }).eq('site_id', s.site.id)
  assert.equal((await client().rpc('ai_widget_config', { p_key: s.site.public_key })).data.enabled, true)
  const r = await ask('What time do you open on Sunday?')
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.available, false)
  assert.equal(r.data.reason, 'no_provider')
  assert.equal(r.data.faq[0].answer, 'Open 10am to 8pm, Tuesday to Sunday.')
  // Directly, without the Edge Function (independent fallback path used by the widget).
  const direct = await client().rpc('faq_answer', { p_key: s.site.public_key, p_question: 'haircut price?' })
  assert.equal(direct.data[0].answer, 'Haircuts start at ₹300.')
})

test('origin check: other websites cannot use the assistant', async () => {
  assert.equal((await ask('hi', 'https://evil.example.com')).status, 403)
  assert.equal((await ask('hi', null)).status, 403)
})

test('paid OpenRouter model is refused at ₹0 → FAQ answer, refusal logged and audited', async () => {
  const { data: models } = await fn(s.admin, 'ai', { action: 'models', kind: 'openrouter' })
  assert.ok(models.models.length > 50)
  const paid = models.models.find((m) => !m.free && m.promptUsdPerM > 0)
  const free = models.models.find((m) => m.free)
  assert.ok(paid && free, 'catalogue has both free and paid models')
  s.free = free.id
  const ins = await s.admin.from('ai_providers').insert({ name: 'QA OR paid', kind: 'openrouter', base_url: 'x', model: paid.id, enabled: true, priority: 1 }).select('id, max_spend_inr').single()
  assert.ifError(ins.error)
  assert.equal(Number(ins.data.max_spend_inr), 0)
  s.providers.push(ins.data.id)
  await s.admin.rpc('set_ai_provider_token', { p_provider: ins.data.id, p_token: 'sk-or-v1-fake-test-key' })
  const r = await ask('How much is a haircut?')
  assert.equal(r.data.available, false)
  assert.equal(r.data.reason, 'offline')
  assert.equal(r.data.faq[0].answer, 'Haircuts start at ₹300.')
  const { data: prov } = await s.admin.from('ai_providers').select('last_check_ok, last_error, spent_inr').eq('id', ins.data.id).single()
  assert.equal(prov.last_check_ok, false)
  assert.match(prov.last_error, /not free and the spending limit is ₹0/)
  assert.equal(Number(prov.spent_inr), 0)
  const { data: logs } = await s.admin.from('audit_logs').select('details').eq('action', 'ai:refused_model').eq('entity_id', ins.data.id)
  assert.equal(logs.length, 1)
  const t = await fn(s.admin, 'ai', { action: 'test', provider_id: ins.data.id })
  assert.equal(t.data.ok, false)
  assert.match(t.data.error, /not free/)
  await s.admin.from('ai_providers').update({ enabled: false }).eq('id', ins.data.id)
})

test('free OpenRouter model with an invalid key → provider error → FAQ answer', async () => {
  const ins = await s.admin.from('ai_providers').insert({ name: 'QA OR free', kind: 'openrouter', base_url: 'x', model: s.free, enabled: true, priority: 2 }).select('id').single()
  s.providers.push(ins.data.id)
  await s.admin.rpc('set_ai_provider_token', { p_provider: ins.data.id, p_token: 'sk-or-v1-invalid' })
  const r = await ask('opening hours')
  assert.equal(r.data.available, false)
  assert.equal(r.data.faq[0].question, 'What are your opening hours?')
  const { data: prov } = await s.admin.from('ai_providers').select('last_error').eq('id', ins.data.id).single()
  assert.match(prov.last_error, /HTTP 401/)
  await s.admin.from('ai_providers').update({ enabled: false }).eq('id', ins.data.id)
})

test('self-hosted server offline → FAQ answer; usage counted', async () => {
  const ins = await s.admin.from('ai_providers').insert({ name: 'QA Ollama offline', kind: 'ollama', base_url: 'https://ai-offline.tomorrowweb.invalid', model: 'qwen2.5:1.5b', enabled: true, timeout_ms: 4000 }).select('id').single()
  assert.ifError(ins.error)
  s.providers.push(ins.data.id)
  const r = await ask('haircut cost')
  assert.equal(r.data.available, false)
  assert.equal(r.data.faq[0].answer, 'Haircuts start at ₹300.')
  const { data: usage } = await s.c.owner.from('ai_usage').select('faq_answers, failures, refusals, ai_answers').eq('scope', `site:${s.site.id}`)
  const sum = usage.reduce((a, u) => ({ faq: a.faq + u.faq_answers, fail: a.fail + u.failures, ref: a.ref + u.refusals, ai: a.ai + u.ai_answers }), { faq: 0, fail: 0, ref: 0, ai: 0 })
  assert.ok(sum.faq >= 4 && sum.fail >= 2 && sum.ref >= 1, JSON.stringify(sum))
  assert.equal(sum.ai, 0)
  await s.admin.from('ai_providers').update({ enabled: false }).eq('id', ins.data.id)
})

test('per-visitor hourly limit switches to FAQ answers', async () => {
  const up = await s.admin.from('ai_site_settings').update({ per_ip_per_hour: 1 }).eq('site_id', s.site.id)
  assert.ifError(up.error)
  const owner = await s.c.owner.from('ai_site_settings').update({ per_ip_per_hour: 500 }).eq('site_id', s.site.id)
  assert.ok(owner.error, 'client cannot raise the limit')
  await ask('hours?')
  const r = await ask('hours again?')
  assert.equal(r.data.reason, 'rate_limited')
  assert.ok(r.data.faq.length > 0, 'still answers from FAQs')
})

test('dashboard assist: permission checks; offline message when no provider works', async () => {
  const denied = await fn(s.c.owner, 'ai', { action: 'assist', task: 'spec', input: 'Change header' })
  assert.equal(denied.status, 403)
  const notMine = await fn(s.c.owner, 'ai', { action: 'models', kind: 'openrouter' })
  assert.equal(notMine.status, 403)
  const r = await fn(s.admin, 'ai', { action: 'assist', task: 'spec', input: 'Please change the phone number on the contact page' })
  assert.equal(r.status, 200)
  assert.equal(r.data.available, false)
  assert.match(r.data.message, /AI is offline/)
})
