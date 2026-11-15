// AI: administrator infrastructure dashboard and the client's assistant settings + FAQ editor.
import { useMemo, useState } from 'preact/hooks'
import { ago, callFn, check, d, sb } from '../lib'
import { Badge, CopyBox, Empty, ErrorNote, Field, Modal, PageHead, Portal, Stat, useAction, useApp, useLoad, formData } from '../ui'

const OR_LIMITS_CHECKED = '2026-11-15'
const KIND_LABEL: Record<string, string> = { openrouter: 'OpenRouter', ollama: 'Ollama (self-hosted)', llamacpp: 'llama.cpp (self-hosted)' }
const fmtUsdM = (n: number | null) => (n == null ? 'variable' : n === 0 ? '0' : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`)

// ── Admin ─────────────────────────────────────────────────────────────────
export function AdminAI() {
  return (
    <Portal title="AI infrastructure" need="admin">
      {(app) => <AdminAIBody app={app} />}
    </Portal>
  )
}

function AdminAIBody({ app }: { app: ReturnType<typeof useApp> }) {
  const { busy, run } = useAction()
  const [editing, setEditing] = useState<any>(null)
  const [testResult, setTestResult] = useState<any>(null)
  const [keyInfo, setKeyInfo] = useState<any>(null)
  const data = useLoad(async () => {
    const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)
    const [prov, usage, settings, refusals] = await Promise.all([
      sb().from('ai_providers').select('*').order('priority').order('created_at'),
      sb().from('ai_usage').select('*').gte('day', since).order('day', { ascending: false }),
      sb().from('ai_site_settings').select('*, sites(name, url, public_key, businesses(name))'),
      sb().from('audit_logs').select('at, details').eq('action', 'ai:refused_model').order('at', { ascending: false }).limit(8),
    ])
    return { providers: check(prov) as any[], usage: check(usage) as any[], settings: check(settings) as any[], refusals: check(refusals) as any[] }
  })
  const x = data.data
  const totals = useMemo(() => {
    const t = { requests: 0, ai: 0, faq: 0, fail: 0, refused: 0, costUsd: 0 }
    for (const u of x?.usage ?? []) { t.requests += u.requests; t.ai += u.ai_answers; t.faq += u.faq_answers; t.fail += u.failures; t.refused += u.refusals; t.costUsd += Number(u.cost_usd) }
    return t
  }, [x])
  const providerName = (id: string) => (id ? x?.providers.find((p) => p.id === id)?.name ?? 'removed provider' : 'FAQ only')
  const siteName = (scope: string) => {
    if (scope === 'dashboard') return 'Portal (dashboard AI)'
    const s = x?.settings.find((st) => `site:${st.site_id}` === scope)
    return s ? `${s.sites?.businesses?.name} — ${s.sites?.name}` : scope.slice(0, 13)
  }

  return (
    <>
      <PageHead title="AI infrastructure" sub="Providers, free-model checks, spending limits, usage and per-site controls.">
        <button class="btn btn-ink p-btn" onClick={() => setEditing({})}>Add provider</button>
      </PageHead>
      <div class="p-notice" style={{ marginBottom: '1rem' }}>
        <div>
          <strong>Free models only, ₹0 spending limit by default.</strong> A paid model, or a free model that becomes paid or disappears,
          is refused automatically and visitors get FAQ answers instead. Paid models are only possible if you set a spending limit above ₹0
          for a provider — that change is recorded in the audit log. This platform never buys credits or turns on billing.
          <div class="p-small p-muted" style={{ marginTop: '0.4rem' }}>
            OpenRouter’s free models, their availability and limits can change at any time. As checked on {OR_LIMITS_CHECKED}: 20 requests/minute,
            and 50 requests/day (1,000/day once at least 10 credits have ever been bought) for “:free” models. FAQ answers work with every provider offline.
          </div>
        </div>
      </div>
      <ErrorNote error={data.error} />
      {testResult && (
        <div class="p-notice" data-tone={testResult.ok ? 'ok' : 'bad'} style={{ marginBottom: '1rem' }}>
          <div>
            <strong>{testResult.provider}: {testResult.ok ? `working (${testResult.ms} ms)` : 'not working'}</strong>
            <div class="p-small">Model {testResult.model} · {testResult.model_listed ? 'listed by the provider' : 'not listed by the provider'} · {testResult.gate ?? ''}</div>
            {testResult.reply && <div class="p-small">Reply: “{testResult.reply}”</div>}
            {testResult.error && <div class="p-small">Error: {testResult.error}</div>}
          </div>
        </div>
      )}

      <div class="p-grid" style={{ marginBottom: '1rem' }}>
        <Stat n={totals.requests} label="Requests (14 days)" />
        <Stat n={totals.ai} label="AI answers" />
        <Stat n={totals.faq} label="FAQ answers" />
        <Stat n={`₹${(totals.costUsd * 90).toFixed(2)}`} label="Spent (approx.)" />
      </div>

      <div class="p-card" style={{ marginBottom: '1rem' }}>
        <h2>Providers</h2>
        <p class="p-small p-muted">Tried in priority order (lowest first). Self-hosted servers must be reached over https, e.g. through a Cloudflare Tunnel, with an access token.</p>
        {x?.providers.length ? (
          <div class="p-table-wrap">
            <table class="p-table">
              <thead><tr><th>Provider</th><th>Model</th><th>Status</th><th>Spending</th><th>Limits</th><th></th></tr></thead>
              <tbody>
                {x.providers.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong><div class="p-small p-muted">{KIND_LABEL[p.kind]} · priority {p.priority}</div>{p.token_secret_id ? <Badge tone="ok">key saved</Badge> : <Badge>no key</Badge>}</td>
                    <td class="p-small"><code>{p.model}</code></td>
                    <td class="p-small">
                      {p.enabled ? <Badge tone="ok">enabled</Badge> : <Badge>off</Badge>}{' '}
                      {p.last_check_at && (p.last_check_ok ? <Badge tone="ok">OK {p.last_check_ms} ms</Badge> : <Badge tone="bad">failing</Badge>)}
                      <div class="p-muted">{p.last_check_at ? `checked ${ago(p.last_check_at)}` : 'never checked'}</div>
                      {!p.last_check_ok && p.last_error && <div style={{ color: 'var(--danger)' }}>{p.last_error}</div>}
                    </td>
                    <td class="p-small">{Number(p.max_spend_inr) === 0 ? <Badge tone="ok">₹0 · free only</Badge> : <Badge tone="warn">limit ₹{p.max_spend_inr}</Badge>}<div class="p-muted">spent ₹{Number(p.spent_inr).toFixed(2)}</div></td>
                    <td class="p-small">{p.rpm_limit}/min · {p.daily_limit}/day</td>
                    <td>
                      <div class="p-row">
                        <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { setTestResult(await callFn('ai', { action: 'test', provider_id: p.id })); await data.reload() })}>Test</button>
                        {p.kind === 'openrouter' && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => setKeyInfo({ name: p.name, ...(await callFn('ai', { action: 'key_info', provider_id: p.id })) }))}>Key usage</button>}
                        <button class="btn btn-ghost p-btn" onClick={() => setEditing(p)}>Edit</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !data.loading && <Empty>No AI provider yet. Visitors get FAQ answers. Add OpenRouter (free models) or your own Ollama / llama.cpp server.</Empty>}
      </div>

      {keyInfo && (
        <div class="p-card" style={{ marginBottom: '1rem' }}>
          <h2>OpenRouter key — {keyInfo.name}</h2>
          {!keyInfo.configured ? <p>No API key saved for this provider.</p> : !keyInfo.ok ? <p style={{ color: 'var(--danger)' }}>{keyInfo.error}</p> : (
            <ul class="p-small">
              <li>Free tier (never bought credits): {String(keyInfo.key.is_free_tier)}</li>
              {keyInfo.key.free_model_daily_requests && <li>Free-model requests today: {keyInfo.key.free_model_daily_requests.used} of {keyInfo.key.free_model_daily_requests.limit} (remaining {keyInfo.key.free_model_daily_requests.remaining})</li>}
              <li>Credit limit on key: {keyInfo.key.limit == null ? 'none set' : `$${keyInfo.key.limit}`}{keyInfo.key.limit_remaining != null && ` (remaining $${keyInfo.key.limit_remaining})`}</li>
              <li>Credits used: total ${keyInfo.key.usage ?? 0} · today ${keyInfo.key.usage_daily ?? 0} · this month ${keyInfo.key.usage_monthly ?? 0}</li>
            </ul>
          )}
          <p class="p-small p-muted">Tip: in OpenRouter, set a $0 credit limit on this key as an extra safeguard.</p>
        </div>
      )}

      <div class="p-card" style={{ marginBottom: '1rem' }}>
        <h2>Websites</h2>
        {x?.settings.length ? (
          <div class="p-table-wrap">
            <table class="p-table">
              <thead><tr><th>Website</th><th>Assistant</th><th>Answers</th><th>Provider</th><th>Daily cap</th><th>Per visitor / hour</th></tr></thead>
              <tbody>
                {x.settings.map((st) => (
                  <SiteRow key={st.site_id} st={st} providers={x.providers} onSaved={data.reload} />
                ))}
              </tbody>
            </table>
          </div>
        ) : <p class="p-muted">No website has set up the assistant yet (clients do this in their portal → AI assistant).</p>}
      </div>

      <div class="p-grid-2">
        <div class="p-card">
          <h2>Usage (last 14 days)</h2>
          {x?.usage.length ? (
            <div class="p-table-wrap">
              <table class="p-table">
                <thead><tr><th>Day</th><th>Where</th><th>Provider</th><th class="num">AI</th><th class="num">FAQ</th><th class="num">Failed</th><th class="num">Refused</th><th class="num">Tokens</th></tr></thead>
                <tbody>
                  {x.usage.map((u, i) => (
                    <tr key={i}>
                      <td>{d(u.day)}</td><td class="p-small">{siteName(u.scope)}</td><td class="p-small">{providerName(u.provider)}</td>
                      <td class="num">{u.ai_answers}</td><td class="num">{u.faq_answers}</td><td class="num">{u.failures}</td><td class="num">{u.refusals}</td>
                      <td class="num">{Number(u.prompt_tokens) + Number(u.completion_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p class="p-muted">No usage yet.</p>}
        </div>
        <div class="p-card">
          <h2>Refused models</h2>
          {x?.refusals.length ? (
            <ul class="p-small" style={{ paddingLeft: '1rem' }}>
              {x.refusals.map((r, i) => <li key={i}>{ago(r.at)}: <strong>{r.details.provider}</strong> — <code>{r.details.model}</code>: {r.details.explanation}</li>)}
            </ul>
          ) : <p class="p-muted">None. Paid or unavailable models would be listed here.</p>}
        </div>
      </div>

      {editing && <ProviderForm p={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await data.reload() }} toast={app.toast} />}
    </>
  )
}

function SiteRow({ st, providers, onSaved }: { st: any; providers: any[]; onSaved: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const save = (patch: Record<string, unknown>) => run(async () => { check(await sb().from('ai_site_settings').update(patch).eq('site_id', st.site_id)); await onSaved() }, 'Saved')
  return (
    <tr>
      <td class="p-small"><strong>{st.sites?.businesses?.name}</strong><div class="p-muted">{st.sites?.name}</div></td>
      <td>{st.enabled ? <Badge tone="ok">on</Badge> : <Badge>off</Badge>}</td>
      <td>
        <select disabled={busy} value={st.ai_enabled ? 'ai' : 'faq'} onChange={(e) => save({ ai_enabled: (e.target as HTMLSelectElement).value === 'ai' })} aria-label="Answer mode">
          <option value="ai">AI + FAQ</option><option value="faq">FAQ only</option>
        </select>
      </td>
      <td>
        <select disabled={busy} value={st.provider_id ?? ''} onChange={(e) => save({ provider_id: (e.target as HTMLSelectElement).value || null })} aria-label="Provider">
          <option value="">Any enabled (priority order)</option>
          {providers.map((p) => <option value={p.id} key={p.id}>{p.name}</option>)}
        </select>
      </td>
      <td><input type="number" min="0" max="10000" defaultValue={st.daily_cap} disabled={busy} style={{ width: '6rem' }} aria-label="Daily cap" onChange={(e) => save({ daily_cap: Number((e.target as HTMLInputElement).value) })} /></td>
      <td><input type="number" min="1" max="500" defaultValue={st.per_ip_per_hour} disabled={busy} style={{ width: '6rem' }} aria-label="Per visitor per hour" onChange={(e) => save({ per_ip_per_hour: Number((e.target as HTMLInputElement).value) })} /></td>
    </tr>
  )
}

function ProviderForm({ p, onClose, onSaved, toast }: { p: any; onClose: () => void; onSaved: () => Promise<unknown>; toast: (m: string, t?: 'ok' | 'bad') => void }) {
  const { busy, run } = useAction()
  const [kind, setKind] = useState<string>(p.kind ?? 'openrouter')
  const [model, setModel] = useState<string>(p.model ?? '')
  const [browsing, setBrowsing] = useState(false)
  return (
    <Modal title={p.id ? `Edit ${p.name}` : 'Add AI provider'} onClose={onClose}>
      <form class="p-form" onSubmit={(e) => {
        const f = formData(e)
        const spend = Number(f.max_spend_inr || 0)
        if (spend > 0 && Number(p.max_spend_inr ?? 0) !== spend &&
          !confirm(`Allow PAID models for “${f.name}” up to ₹${spend}? Charges are billed by the provider to your own account and credits. Click Cancel to keep free models only.`)) return
        const row = {
          name: f.name.trim(), kind, base_url: kind === 'openrouter' ? 'https://openrouter.ai/api/v1' : f.base_url.trim(), model: model.trim(),
          enabled: !!f.enabled, priority: Number(f.priority || 100), timeout_ms: Number(f.timeout_s || 20) * 1000, max_tokens: Number(f.max_tokens || 400),
          max_spend_inr: spend, usd_inr_rate: Number(f.usd_inr_rate || 90), rpm_limit: Number(f.rpm_limit || 20), daily_limit: Number(f.daily_limit || 200),
        }
        run(async () => {
          const saved = p.id
            ? (check(await sb().from('ai_providers').update(row).eq('id', p.id).select('id').single()) as any)
            : (check(await sb().from('ai_providers').insert(row).select('id').single()) as any)
          if (f.token) check(await sb().rpc('set_ai_provider_token', { p_provider: saved.id, p_token: f.token }))
          if (f.clear_token) check(await sb().rpc('set_ai_provider_token', { p_provider: saved.id, p_token: '' }))
          await onSaved()
        }, 'Provider saved')
      }}>
        <div class="row2">
          <Field label="Name"><input name="name" required maxLength={80} defaultValue={p.name ?? (kind === 'openrouter' ? 'OpenRouter (free models)' : 'My AI server')} /></Field>
          <Field label="Type">
            <select value={kind} onChange={(e) => setKind((e.target as HTMLSelectElement).value)} disabled={!!p.id}>
              <option value="openrouter">OpenRouter</option><option value="ollama">Ollama (self-hosted)</option><option value="llamacpp">llama.cpp server (self-hosted)</option>
            </select>
          </Field>
        </div>
        {kind !== 'openrouter' && (
          <Field label="Server address (https)" hint="e.g. https://ai.yourdomain.in — through a Cloudflare Tunnel. Never expose Ollama directly."><input name="base_url" type="url" required defaultValue={p.base_url ?? ''} /></Field>
        )}
        <Field label="Model" hint={kind === 'openrouter' ? 'Pick a free model (ends in “:free”). It is re-checked against OpenRouter’s price list before every request.' : 'e.g. qwen2.5:1.5b-instruct'}>
          <div class="p-row">
            <input value={model} onInput={(e) => setModel((e.target as HTMLInputElement).value)} required style={{ flex: 1 }} />
            {(kind === 'openrouter' || p.id) && <button type="button" class="btn btn-ghost p-btn" onClick={() => setBrowsing(true)}>Browse</button>}
          </div>
        </Field>
        <Field label={kind === 'openrouter' ? 'OpenRouter API key' : 'Access token (optional)'} hint={p.token_secret_id ? 'A key is saved (hidden). Type a new one to replace it.' : 'Stored encrypted in Supabase Vault. Never shown again.'}>
          <input name="token" type="password" autoComplete="off" />
        </Field>
        {p.token_secret_id && <label class="p-check"><input type="checkbox" name="clear_token" /> Remove the saved key</label>}
        <div class="row2">
          <Field label="Priority (lower = tried first)"><input name="priority" type="number" defaultValue={p.priority ?? 100} /></Field>
          <Field label="Timeout (seconds)"><input name="timeout_s" type="number" min="2" max="60" defaultValue={(p.timeout_ms ?? 20000) / 1000} /></Field>
        </div>
        <div class="row2">
          <Field label="Max reply length (tokens)"><input name="max_tokens" type="number" min="16" max="4000" defaultValue={p.max_tokens ?? 400} /></Field>
          <Field label="Requests per minute / per day"><div class="p-row"><input name="rpm_limit" type="number" min="1" max="600" defaultValue={p.rpm_limit ?? 20} style={{ width: '45%' }} /><input name="daily_limit" type="number" min="1" max="100000" defaultValue={p.daily_limit ?? (kind === 'openrouter' ? 45 : 500)} style={{ width: '50%' }} /></div></Field>
        </div>
        <fieldset class="p-card">
          <legend class="p-small">Spending limit</legend>
          <div class="row2">
            <Field label="Maximum spend (₹)" hint="0 = free models only (recommended)."><input name="max_spend_inr" type="number" min="0" step="1" defaultValue={p.max_spend_inr ?? 0} /></Field>
            <Field label="USD → INR rate for tracking"><input name="usd_inr_rate" type="number" min="1" step="0.01" defaultValue={p.usd_inr_rate ?? 90} /></Field>
          </div>
        </fieldset>
        <label class="p-check"><input type="checkbox" name="enabled" defaultChecked={p.enabled ?? false} /> Enabled</label>
        <button class="btn btn-ink p-btn" disabled={busy}>Save provider</button>
      </form>
      {browsing && <ModelBrowser kind={kind} providerId={p.id} onPick={(id) => { setModel(id); setBrowsing(false) }} onClose={() => setBrowsing(false)} toast={toast} />}
    </Modal>
  )
}

function ModelBrowser({ kind, providerId, onPick, onClose }: { kind: string; providerId?: string; onPick: (id: string) => void; onClose: () => void; toast: any }) {
  const [q, setQ] = useState('')
  const [freeOnly, setFreeOnly] = useState(true)
  const list = useLoad(async () => (await callFn('ai', kind === 'openrouter' && !providerId ? { action: 'models', kind: 'openrouter' } : { action: 'models', provider_id: providerId })).models as any[])
  const rows = (list.data ?? []).filter((m) => (!freeOnly || m.free) && (!q || `${m.id} ${m.name}`.toLowerCase().includes(q.toLowerCase())))
  return (
    <Modal title="Choose a model" onClose={onClose}>
      <div class="p-row" style={{ marginBottom: '0.75rem' }}>
        <input class="p-input" placeholder="Search models" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ flex: 1 }} />
        {kind === 'openrouter' && <label class="p-check"><input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly((e.target as HTMLInputElement).checked)} /> Free only</label>}
      </div>
      <ErrorNote error={list.error} />
      {list.loading ? <div class="p-loading">Loading models…</div> : (
        <div class="p-table-wrap" style={{ maxHeight: '55vh', overflow: 'auto' }}>
          <table class="p-table">
            <thead><tr><th>Model</th><th>Price per 1M tokens (in / out)</th><th>Context</th><th></th></tr></thead>
            <tbody>
              {rows.slice(0, 200).map((m) => (
                <tr key={m.id}>
                  <td class="p-small"><strong>{m.name}</strong><div class="p-muted"><code>{m.id}</code></div></td>
                  <td class="p-small">{m.free ? <Badge tone="ok">Free</Badge> : <><Badge tone="warn">Paid</Badge> {fmtUsdM(m.promptUsdPerM)} / {fmtUsdM(m.completionUsdPerM)}{m.promptUsdPerM != null && <div class="p-muted">≈ ₹{((m.promptUsdPerM + m.completionUsdPerM) * 90).toFixed(0)} per 1M in+out</div>}</>}</td>
                  <td class="p-small">{m.context ? `${Math.round(m.context / 1000)}k` : '—'}</td>
                  <td><button class="btn btn-ghost p-btn" onClick={() => onPick(m.id)}>Use</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p class="p-small p-muted">Prices and availability come live from the provider and can change. Paid models are refused while the spending limit is ₹0.</p>
    </Modal>
  )
}

// ── Client: assistant settings, FAQs, preview ─────────────────────────────
export function Assistant() {
  return (
    <Portal title="AI assistant" need="business" module="ai_assistant" perm="settings.manage">
      {(app) => <AssistantBody app={app} />}
    </Portal>
  )
}

function AssistantBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [siteId, setSiteId] = useState<string | null>(null)
  const [faqForm, setFaqForm] = useState<any>(null)
  const [preview, setPreview] = useState<{ q: string; r: any } | null>(null)
  const sites = useLoad(async () => check(await sb().from('sites').select('id, name, url, public_key').eq('business_id', bizId).order('created_at')) as any[], [bizId])
  const site = sites.data?.find((s) => s.id === siteId) ?? sites.data?.[0] ?? null
  const data = useLoad(async () => {
    if (!site) return null
    let st = check(await sb().from('ai_site_settings').select('*').eq('site_id', site.id).maybeSingle()) as any
    if (!st) st = check(await sb().from('ai_site_settings').insert({ site_id: site.id }).select('*').single())
    const faqs = check(await sb().from('ai_knowledge').select('*').eq('site_id', site.id).order('sort').order('created_at')) as any[]
    const usage = check(await sb().from('ai_usage').select('*').eq('scope', `site:${site.id}`).order('day', { ascending: false }).limit(14)) as any[]
    return { st, faqs, usage }
  }, [site?.id])

  if (sites.loading) return <div class="p-loading">Loading…</div>
  if (!site) return <><PageHead title="AI assistant" /><Empty>No website is linked to this business yet.</Empty></>
  if (data.error) return <ErrorNote error={data.error} />
  if (!data.data) return <div class="p-loading">Loading…</div>
  const { st, faqs, usage } = data.data
  const embed = `<script src="${location.origin}/widget.js" data-site="${site.public_key}" defer></script>`
  const week = usage.slice(0, 7).reduce((a, u) => ({ ai: a.ai + u.ai_answers, faq: a.faq + u.faq_answers }), { ai: 0, faq: 0 })

  return (
    <>
      <PageHead title="AI assistant" sub={<>A chat assistant for visitors to <strong>{site.name}</strong>. It answers from your FAQs and business information, and hands people over to you for bookings and prices.</>} />
      {(sites.data?.length ?? 0) > 1 && (
        <label class="p-field" style={{ maxWidth: '320px', marginBottom: '1rem' }}><span>Website</span>
          <select value={site.id} onChange={(e) => setSiteId((e.target as HTMLSelectElement).value)}>{sites.data!.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}</select>
        </label>
      )}
      <div class="p-grid" style={{ marginBottom: '1rem' }}>
        <Stat n={st.enabled ? 'On' : 'Off'} label="Assistant on your site" />
        <Stat n={faqs.filter((f) => f.active).length} label="Active FAQs" />
        <Stat n={week.ai} label="AI answers (7 days)" />
        <Stat n={week.faq} label="FAQ answers (7 days)" />
      </div>
      {!st.ai_enabled && <div class="p-notice" style={{ marginBottom: '1rem' }}>This assistant answers from your FAQs only.</div>}

      <div class="p-grid-2">
        <form class="p-card p-form" onSubmit={(e) => {
          const f = formData(e)
          run(async () => {
            check(await sb().from('ai_site_settings').update({
              enabled: !!f.enabled, greeting: f.greeting.trim() || null, business_facts: f.business_facts.trim() || null,
              handoff_whatsapp: f.handoff_whatsapp.replace(/\D/g, '') || null, handoff_url: f.handoff_url.trim() || null,
            }).eq('site_id', site.id))
            await data.reload()
          }, 'Saved')
        }}>
          <h2>Settings</h2>
          <label class="p-check"><input type="checkbox" name="enabled" defaultChecked={st.enabled} /> Show the assistant on my website</label>
          <Field label="Greeting"><input name="greeting" maxLength={300} defaultValue={st.greeting ?? ''} placeholder="Hi! How can we help?" /></Field>
          <div class="row2">
            <Field label="WhatsApp number for hand-over" hint="With country code, e.g. 919876543210"><input name="handoff_whatsapp" inputMode="numeric" defaultValue={st.handoff_whatsapp ?? ''} /></Field>
            <Field label="Contact / booking page"><input name="handoff_url" defaultValue={st.handoff_url ?? ''} placeholder="/contact/ or https://…" /></Field>
          </div>
          <Field label="About your business (for AI answers)" hint="Opening hours, location, services, what you don’t offer. The assistant never invents anything beyond this and your FAQs.">
            <textarea name="business_facts" rows={7} maxLength={6000} defaultValue={st.business_facts ?? ''} />
          </Field>
          <button class="btn btn-ink p-btn" disabled={busy}>Save settings</button>
        </form>

        <div class="p-stack">
          <form class="p-card p-form" onSubmit={(e) => {
            const f = formData(e)
            const q = f.q.trim()
            if (!q) return
            run(async () => setPreview({ q, r: await callFn('ai', { action: 'chat', preview: true, site_key: site.public_key, messages: [{ role: 'user', content: q }] }) }))
          }}>
            <h2>Try it</h2>
            <div class="p-row"><input name="q" placeholder="Ask what a visitor might ask" style={{ flex: 1 }} /><button class="btn btn-ink p-btn" disabled={busy}>Ask</button></div>
            {preview && (
              <div class="p-card">
                <div class="p-small p-muted">“{preview.q}”</div>
                {preview.r.available ? (
                  <><p style={{ whiteSpace: 'pre-wrap' }}>{preview.r.reply}</p><Badge tone="ai">AI answer · {preview.r.provider}</Badge></>
                ) : preview.r.faq?.length ? (
                  <><p style={{ whiteSpace: 'pre-wrap' }}>{preview.r.faq[0].answer}</p><Badge>From your FAQs</Badge>
                    <div class="p-small p-muted" style={{ marginTop: '0.4rem' }}>{preview.r.reason === 'no_provider' || preview.r.reason === 'offline' ? 'AI is offline right now, so the best FAQ was used.' : preview.r.reason === 'faq_only' ? 'FAQ-only mode.' : ''}</div></>
                ) : <p class="p-muted">No answer found. Add an FAQ for this question.</p>}
              </div>
            )}
          </form>
          <div class="p-card">
            <h2>Add to your website</h2>
            <p class="p-small">Tomorrow Web adds this for you. For your developer, the code is:</p>
            <CopyBox value={embed} />
          </div>
        </div>
      </div>

      <div class="p-card" style={{ marginTop: '1rem' }}>
        <div class="p-row"><h2 style={{ margin: 0 }}>Frequently asked questions</h2><span class="p-spacer" /><button class="btn btn-ghost p-btn" onClick={() => setFaqForm({})}>Add FAQ</button></div>
        <p class="p-small p-muted">These answer visitors instantly — even if AI is unavailable.</p>
        {faqs.length ? (
          <div class="p-stack">
            {faqs.map((f) => (
              <div class="p-card" key={f.id}>
                <div class="p-row"><strong>{f.question}</strong>{!f.active && <Badge>hidden</Badge>}<span class="p-spacer" />
                  <button class="btn btn-ghost p-btn" onClick={() => setFaqForm(f)}>Edit</button>
                  <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => confirm('Delete this FAQ?') && run(async () => { check(await sb().from('ai_knowledge').delete().eq('id', f.id)); await data.reload() }, 'Deleted')}>Delete</button>
                </div>
                <p class="p-small" style={{ whiteSpace: 'pre-wrap', margin: '0.3rem 0 0' }}>{f.answer}</p>
              </div>
            ))}
          </div>
        ) : <Empty>No FAQs yet. Add your most common questions: opening hours, location, prices, booking, delivery.</Empty>}
      </div>

      {faqForm && (
        <Modal title={faqForm.id ? 'Edit FAQ' : 'Add FAQ'} onClose={() => setFaqForm(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const row = { site_id: site.id, question: f.question.trim(), answer: f.answer.trim(), active: !!f.active }
            run(async () => {
              if (faqForm.id) check(await sb().from('ai_knowledge').update(row).eq('id', faqForm.id))
              else check(await sb().from('ai_knowledge').insert(row))
              setFaqForm(null)
              await data.reload()
            }, 'FAQ saved')
          }}>
            <Field label="Question"><input name="question" required minLength={3} maxLength={300} defaultValue={faqForm.question ?? ''} /></Field>
            <Field label="Answer"><textarea name="answer" required rows={4} maxLength={2000} defaultValue={faqForm.answer ?? ''} /></Field>
            <label class="p-check"><input type="checkbox" name="active" defaultChecked={faqForm.active ?? true} /> Active</label>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}

/** Shared "AI assist" button for dashboard writing tasks. Labels output as AI-generated. */
export function AiAssistButton({ label, task, input, siteId, onResult, disabled }: { label: string; task: string; input: () => string; siteId?: string; onResult: (text: string, meta: any) => void; disabled?: boolean }) {
  const { busy, run } = useAction()
  const { toast } = useApp()
  return (
    <button type="button" class="btn btn-ghost p-btn" disabled={busy || disabled} title="Uses your connected AI provider. Review before using." onClick={() => run(async () => {
      const r = await callFn('ai', { action: 'assist', task, input: input(), site_id: siteId })
      if (!r.available) return toast(r.message ?? 'AI is offline right now.', 'bad')
      onResult(r.text, r)
      toast('AI draft added — please review it before using.')
    })}>{busy ? 'Thinking…' : `✦ ${label}`}</button>
  )
}
