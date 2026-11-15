// Lead Finder (administrator only): leads list, saved searches, CSV import, duplicate review,
// settings, lead detail with research workflow, printable redesign reports.
import { useEffect, useMemo, useState } from 'preact/hooks'
import { classifyUrl, CSV_FIELDS, guessMapping, INDUSTRIES, industryByKey, normalizeEmail, normalizePhoneIN, parseCsv, PUNE_LOCALITIES, SCORE_DISCLAIMER, socialKey } from '../../../supabase/functions/_shared/leads'
import { ago, callFn, check, d, downloadCsv, dt, qs, sb } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Portal, Stat, useAction, useApp, useLoad, formData } from '../ui'
import { AiAssistButton } from './AI'
import { CrmPanel } from './Crm'

export const WEBSITE_STATE: Record<string, { label: string; tone?: 'ok' | 'warn' | 'bad' | 'ai' }> = {
  none_listed: { label: 'No website listed', tone: 'bad' },
  unverified: { label: 'Not verified', tone: 'warn' },
  broken: { label: 'Broken', tone: 'bad' },
  live: { label: 'Live', tone: 'ok' },
  redirects_elsewhere: { label: 'Redirects elsewhere', tone: 'warn' },
}
const RESEARCH: Record<string, string> = { to_research: 'To research', researching: 'Researching', verified: 'Verified', not_suitable: 'Not suitable' }
const CHECKLIST: [string, string][] = [
  ['exists', 'Business exists (seen on map / photos / reviews)'],
  ['phone', 'Phone number confirmed'],
  ['website', 'Website found (or confirmed none)'],
  ['social', 'Social pages checked'],
  ['dnc', 'Checked it’s OK to contact (no opt-out, DND rules respected)'],
]
const SOURCE_LABEL: Record<string, string> = { osm: 'OpenStreetMap', google_places: 'Google', manual: 'You', website: 'Their website', csv: 'CSV import' }
const OSM_CREDIT = 'Business data © OpenStreetMap contributors (ODbL)'
const ScoreBadge = ({ s }: { s: number | null }) => (s == null ? <span class="p-muted">—</span> : <Badge tone={s >= 60 ? 'ok' : s >= 35 ? 'warn' : undefined}>{s}</Badge>)

// ── Home with tabs ────────────────────────────────────────────────────────
export function LeadsHome() {
  return (
    <Portal title="Lead Finder" need="admin">
      {(app) => <LeadsHomeBody app={app} />}
    </Portal>
  )
}

function LeadsHomeBody({ app }: { app: ReturnType<typeof useApp> }) {
  const [tab, setTab] = useState(qs('tab') ?? 'leads')
  const go = (t: string) => { setTab(t); history.replaceState(null, '', `?tab=${t}`) }
  const counts = useLoad(async () => {
    const [all, open, queue] = await Promise.all([
      sb().from('leads').select('id', { count: 'exact', head: true }),
      sb().from('lead_duplicates').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      sb().from('lead_audits').select('id', { count: 'exact', head: true }).eq('status', 'queued'),
    ])
    return { leads: all.count ?? 0, dupes: open.count ?? 0, queue: queue.count ?? 0 }
  }, [tab])
  return (
    <>
      <PageHead title="Lead Finder" sub="Find local businesses that could use a better website — from public data only, with sources recorded.">
        <a class="btn btn-ghost p-btn" href="/portal/admin/leads/opportunities/">Top opportunities</a>
      </PageHead>
      <div class="p-tabs" role="tablist">
        {[['leads', `Leads (${counts.data?.leads ?? '…'})`], ['search', 'Find businesses'], ['import', 'Import CSV'], ['dupes', `Possible duplicates (${counts.data?.dupes ?? '…'})`], ['settings', 'Settings']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => go(k)}>{l}</button>
        ))}
      </div>
      {tab === 'leads' && <LeadsList app={app} queue={counts.data?.queue ?? 0} onQueueChange={counts.reload} />}
      {tab === 'search' && <Searches app={app} onRan={counts.reload} />}
      {tab === 'import' && <Import onDone={() => { counts.reload(); go('leads') }} />}
      {tab === 'dupes' && <Duplicates onChange={counts.reload} />}
      {tab === 'settings' && <LeadSettings />}
    </>
  )
}

// ── List ──────────────────────────────────────────────────────────────────
function LeadsList({ app, queue, onQueueChange }: { app: ReturnType<typeof useApp>; queue: number; onQueueChange: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const [f, setF] = useState({ q: '', industry: '', locality: '', website: '', research: '', min: '', dnc: false })
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [auditing, setAuditing] = useState<{ done: number; remaining: number } | null>(null)
  const list = useLoad(async () => {
    let q = sb().from('leads').select('id, name, industry, locality, city, website_state, website_url, primary_phone, primary_email, research_status, score, do_not_contact, sources, updated_at').order('score', { ascending: false, nullsFirst: false }).order('updated_at', { ascending: false }).limit(500)
    if (f.q) q = q.or(`name.ilike.%${f.q.replace(/[%,()]/g, ' ')}%,primary_phone.ilike.%${f.q.replace(/\D/g, '') || '§'}%,website_domain.ilike.%${f.q.replace(/[%,()]/g, ' ')}%`)
    if (f.industry) q = q.eq('industry', f.industry)
    if (f.locality) q = q.ilike('locality', f.locality)
    if (f.website) q = q.eq('website_state', f.website)
    if (f.research) q = q.eq('research_status', f.research)
    if (f.min) q = q.gte('score', Number(f.min))
    if (!f.dnc) q = q.eq('do_not_contact', false)
    return check(await q) as any[]
  }, [JSON.stringify(f)])
  const rows = list.data ?? []
  const localities = useMemo(() => [...new Set(rows.map((r) => r.locality).filter(Boolean))].sort(), [rows.length])
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }))
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  async function runQueue() {
    let remaining = 1, done = 0
    while (remaining > 0) {
      const r = await callFn('leads', { action: 'audit_next', limit: 1 })
      done += r.processed
      remaining = r.remaining
      setAuditing({ done, remaining })
      if (!r.processed && remaining) await new Promise((res) => setTimeout(res, 3000))
    }
    setAuditing(null)
    await list.reload(); await onQueueChange()
    app.toast(`Audits finished (${done}).`)
  }

  return (
    <>
      <div class="p-card" style={{ marginBottom: '1rem' }}>
        <div class="p-grid" style={{ gap: '0.6rem' }}>
          <input class="p-input" placeholder="Search name, phone or website" value={f.q} onInput={(e) => set('q', (e.target as HTMLInputElement).value)} />
          <select value={f.industry} onChange={(e) => set('industry', (e.target as HTMLSelectElement).value)} aria-label="Industry"><option value="">All industries</option>{INDUSTRIES.map((i) => <option value={i.key} key={i.key}>{i.label}</option>)}</select>
          <select value={f.locality} onChange={(e) => set('locality', (e.target as HTMLSelectElement).value)} aria-label="Locality"><option value="">All localities</option>{localities.map((l) => <option key={l}>{l}</option>)}</select>
          <select value={f.website} onChange={(e) => set('website', (e.target as HTMLSelectElement).value)} aria-label="Website"><option value="">Any website state</option>{Object.entries(WEBSITE_STATE).map(([k, v]) => <option value={k} key={k}>{v.label}</option>)}</select>
          <select value={f.research} onChange={(e) => set('research', (e.target as HTMLSelectElement).value)} aria-label="Research status"><option value="">Any research status</option>{Object.entries(RESEARCH).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select>
          <select value={f.min} onChange={(e) => set('min', (e.target as HTMLSelectElement).value)} aria-label="Minimum score"><option value="">Any score</option><option value="35">35+</option><option value="50">50+</option><option value="65">65+</option></select>
        </div>
        <div class="p-row" style={{ marginTop: '0.6rem' }}>
          <label class="p-check"><input type="checkbox" checked={f.dnc} onChange={(e) => set('dnc', (e.target as HTMLInputElement).checked)} /> Show do-not-contact</label>
          <span class="p-spacer" />
          <button class="btn btn-ghost p-btn" onClick={() => setAdding(true)}>Add lead</button>
          <button class="btn btn-ghost p-btn" disabled={!rows.length} onClick={() => downloadCsv(`leads-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => ({ name: r.name, industry: r.industry, locality: r.locality, city: r.city, phone: r.primary_phone, email: r.primary_email, website: r.website_url, website_state: r.website_state, score: r.score, research: r.research_status, do_not_contact: r.do_not_contact, sources: r.sources.join(' ') })))}>Export CSV</button>
          <button class="btn btn-ink p-btn" disabled={busy || !sel.size || !!auditing} onClick={() => run(async () => {
            const r = await callFn('leads', { action: 'audit_queue', lead_ids: [...sel] })
            setSel(new Set())
            await onQueueChange()
            app.toast(`${r.queued} audit${r.queued === 1 ? '' : 's'} queued`)
            await runQueue()
          })}>Audit selected ({sel.size})</button>
        </div>
        {(auditing || queue > 0) && (
          <div class="p-notice" style={{ marginTop: '0.6rem' }}>
            {auditing ? `Auditing websites… ${auditing.done} done, ${auditing.remaining} waiting. Keep this tab open.` : <>{queue} audit(s) waiting. <button class="p-link" onClick={() => runQueue()}>Run them now</button></>}
          </div>
        )}
      </div>
      <ErrorNote error={list.error} />
      {rows.length ? (
        <div class="p-table-wrap">
          <table class="p-table">
            <thead><tr><th><input type="checkbox" aria-label="Select all" checked={sel.size === rows.length} onChange={(e) => setSel((e.target as HTMLInputElement).checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th><th>Business</th><th>Website</th><th>Contact</th><th>Research</th><th class="num">Score</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} /></td>
                  <td><a href={`/portal/admin/leads/view/?id=${r.id}`}><strong>{r.name}</strong></a> {r.do_not_contact && <Badge tone="bad">do not contact</Badge>}
                    <div class="p-small p-muted">{[industryByKey(r.industry)?.label, r.locality, r.city].filter(Boolean).join(' · ')}</div></td>
                  <td><Badge tone={WEBSITE_STATE[r.website_state].tone}>{WEBSITE_STATE[r.website_state].label}</Badge></td>
                  <td class="p-small">{r.primary_phone ?? <span class="p-muted">no phone</span>}{r.primary_email && <div>{r.primary_email}</div>}</td>
                  <td class="p-small">{RESEARCH[r.research_status]}</td>
                  <td class="num"><ScoreBadge s={r.score} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !list.loading && <Empty>No leads match. Use “Find businesses” to search a locality, or import a CSV.</Empty>}
      <p class="p-small p-muted" style={{ marginTop: '0.75rem' }}>{OSM_CREDIT}. Scores: {SCORE_DISCLAIMER}</p>
      {adding && <AddLead onClose={() => setAdding(false)} onDone={(id) => { location.href = `/portal/admin/leads/view/?id=${id}` }} />}
    </>
  )
}

function AddLead({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { busy, run } = useAction()
  const [warn, setWarn] = useState<any>(null)
  return (
    <Modal title="Add a lead" onClose={onClose}>
      <form class="p-form" onSubmit={(e) => {
        const f = formData(e)
        run(async () => {
          if (!warn) {
            const p = await callFn('leads', { action: 'add', dry_run: true, ...f })
            const step = p.preview[0]
            if (step.action === 'update' || step.possible) return setWarn({ step, f })
          }
          const r = await callFn('leads', { action: 'add', ...f })
          onDone(r.lead_id)
        }, 'Lead saved')
      }}>
        {warn && (
          <div class="p-notice" data-tone="warn">
            {warn.step.action === 'update'
              ? <>This matches an existing lead (<a href={`/portal/admin/leads/view/?id=${warn.step.match.id}`} target="_blank">{warn.step.match.name}</a>, same {warn.step.reason.replace('_', ' ')}). Saving adds these details to it.</>
              : <>Looks similar to <a href={`/portal/admin/leads/view/?id=${warn.step.possible.id}`} target="_blank">{warn.step.possible.name}</a>. Saving creates a new lead and puts the pair in the duplicate review queue.</>}
          </div>
        )}
        <div class="row2">
          <Field label="Business name"><input name="name" required maxLength={200} /></Field>
          <Field label="Industry"><select name="industry"><option value="">—</option>{INDUSTRIES.map((i) => <option value={i.key} key={i.key}>{i.label}</option>)}</select></Field>
        </div>
        <div class="row2">
          <Field label="Locality"><input name="locality" list="tw-localities" /></Field>
          <Field label="City"><input name="city" defaultValue="Pune" /></Field>
        </div>
        <datalist id="tw-localities">{PUNE_LOCALITIES.map((l) => <option key={l} value={l} />)}</datalist>
        <div class="row2">
          <Field label="Public phone"><input name="phone" inputMode="tel" /></Field>
          <Field label="Public email"><input name="email" type="email" /></Field>
        </div>
        <div class="row2">
          <Field label="Website"><input name="website" placeholder="https://" /></Field>
          <Field label="Instagram / Facebook"><input name="social" /></Field>
        </div>
        <Field label="Contact person (only if publicly listed)"><input name="contact_person" maxLength={120} /></Field>
        <Field label="Notes / where you found it"><textarea name="notes" rows={2} maxLength={2000} /></Field>
        <button class="btn btn-ink p-btn" disabled={busy}>{warn ? 'Save anyway' : 'Save lead'}</button>
      </form>
    </Modal>
  )
}

// ── Searches ──────────────────────────────────────────────────────────────
function Searches({ app, onRan }: { app: ReturnType<typeof useApp>; onRan: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const [result, setResult] = useState<any>(null)
  const [inds, setInds] = useState<string[]>(['restaurant', 'cafe'])
  const searches = useLoad(async () => check(await sb().from('lead_searches').select('*').order('last_run_at', { ascending: false, nullsFirst: false })) as any[])
  const settings = useLoad(async () => check(await sb().from('lead_settings').select('places_enabled, places_monthly_cap').single()) as any)
  const runSearch = (payload: Record<string, unknown>) => run(async () => {
    setResult(null)
    const r = await callFn('leads', { action: 'discover', ...payload })
    setResult(r)
    await searches.reload(); await onRan()
  }, 'Search finished')
  return (
    <div class="p-grid-2">
      <form class="p-card p-form" onSubmit={(e) => {
        const f = formData(e)
        if (!inds.length) return app.toast('Choose at least one industry', 'bad')
        runSearch({ locality: f.locality, city: f.city, radius_m: Number(f.radius), industries: inds, source: f.source, name: f.name || undefined })
      }}>
        <h2>New search</h2>
        <div class="row2">
          <Field label="Locality" hint="Pune & PCMC suggestions; any area works."><input name="locality" list="tw-localities2" defaultValue="Baner" required /></Field>
          <Field label="City"><input name="city" defaultValue="Pune" required /></Field>
        </div>
        <datalist id="tw-localities2">{PUNE_LOCALITIES.map((l) => <option key={l} value={l} />)}</datalist>
        <div class="row2">
          <Field label="Radius"><select name="radius" defaultValue="1000"><option value="500">500 m</option><option value="1000">1 km</option><option value="2000">2 km</option><option value="3000">3 km</option><option value="5000">5 km</option></select></Field>
          <Field label="Source">
            <select name="source"><option value="osm">OpenStreetMap (free)</option>{settings.data?.places_enabled && <option value="google_places">Google Places (billed beyond free use)</option>}</select>
          </Field>
        </div>
        <fieldset class="p-card"><legend class="p-small">Industries</legend>
          <div class="p-grid" style={{ gap: '0.3rem' }}>
            {INDUSTRIES.map((i) => <label class="p-check" key={i.key}><input type="checkbox" checked={inds.includes(i.key)} onChange={(e) => setInds((x) => (e.target as HTMLInputElement).checked ? [...x, i.key] : x.filter((k) => k !== i.key))} /> {i.label}</label>)}
          </div>
        </fieldset>
        <Field label="Save as (optional name)"><input name="name" maxLength={120} placeholder="e.g. Baner cafés" /></Field>
        <button class="btn btn-ink p-btn" disabled={busy}>{busy ? 'Searching…' : 'Search and save'}</button>
        <p class="p-small p-muted">{OSM_CREDIT}. Only public business listings are used. Repeated searches update existing leads instead of duplicating them.</p>
      </form>
      <div class="p-stack">
        {result && (
          <div class="p-notice" data-tone="ok">
            <div><strong>{result.found} places found</strong> — {result.created} new, {result.updated} already known (updated), {result.possible} possible duplicate(s) to review{result.suppressed ? `, ${result.suppressed} skipped (deleted on request)` : ''}. New since last run: {result.new_since_last_run}.
              <div class="p-small p-muted">Source server: {result.server}</div></div>
          </div>
        )}
        <div class="p-card">
          <h2>Saved searches</h2>
          {searches.data?.length ? (
            <div class="p-table-wrap"><table class="p-table">
              <thead><tr><th>Search</th><th>Last run</th><th>Result</th><th></th></tr></thead>
              <tbody>{searches.data.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><div class="p-small p-muted">{s.locality ?? s.city} · {s.radius_m >= 1000 ? `${s.radius_m / 1000} km` : `${s.radius_m} m`} · {s.source === 'osm' ? 'OpenStreetMap' : 'Google Places'}</div></td>
                  <td class="p-small">{s.last_run_at ? ago(s.last_run_at) : 'never'}{s.last_error && <div style={{ color: 'var(--danger)' }}>{s.last_error}</div>}</td>
                  <td class="p-small">{s.last_run_found != null ? `${s.last_run_found} found · ${s.last_run_new} new` : '—'}</td>
                  <td><div class="p-row">
                    <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => runSearch({ search_id: s.id })}>Run again</button>
                    <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => confirm('Delete this saved search? Leads stay.') && run(async () => { check(await sb().from('lead_searches').delete().eq('id', s.id)); await searches.reload() }, 'Deleted')}>Delete</button>
                  </div></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p class="p-muted">No saved searches yet.</p>}
        </div>
      </div>
    </div>
  )
}

// ── CSV import ────────────────────────────────────────────────────────────
function Import({ onDone }: { onDone: () => void }) {
  const { busy, run } = useAction()
  const [csv, setCsv] = useState('')
  const [map, setMap] = useState<Record<string, number>>({})
  const [preview, setPreview] = useState<any[] | null>(null)
  const rows = useMemo(() => (csv ? parseCsv(csv) : []), [csv])
  const headers = rows[0] ?? []
  useEffect(() => { if (headers.length) setMap(guessMapping(headers) as Record<string, number>); setPreview(null) }, [csv])
  const summary = preview && preview.reduce((a, p) => ({ ...a, [p.action]: (a[p.action] ?? 0) + 1, possible: a.possible + (p.possible ? 1 : 0) }), { possible: 0 } as Record<string, number>)
  return (
    <div class="p-stack">
      <div class="p-card p-form">
        <h2>Import leads from CSV</h2>
        <p class="p-small p-muted">Up to 2,000 rows. Only import business details that are publicly listed. Duplicates (same phone, website or a similar name nearby) are merged or flagged — you’ll see a preview first.</p>
        <input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) setCsv(await file.text()) }} />
      </div>
      {headers.length > 0 && (
        <div class="p-card p-form">
          <h3>Match columns ({rows.length - 1} rows)</h3>
          <div class="p-grid" style={{ gap: '0.5rem' }}>
            {CSV_FIELDS.map((f) => (
              <Field key={f} label={f.replace('_', ' ')}>
                <select value={map[f] ?? ''} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; setMap((m) => { const n = { ...m }; if (v === '') delete n[f]; else n[f] = Number(v); return n }); setPreview(null) }}>
                  <option value="">— not in file —</option>
                  {headers.map((h, i) => <option value={i} key={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <div class="p-row">
            <button class="btn btn-ghost p-btn" disabled={busy || map.name === undefined} onClick={() => run(async () => setPreview((await callFn('leads', { action: 'import', csv, mapping: map, dry_run: true })).preview))}>Preview duplicates</button>
            <button class="btn btn-ink p-btn" disabled={busy || !preview} onClick={() => run(async () => {
              const r = await callFn('leads', { action: 'import', csv, mapping: map })
              alert(`Imported: ${r.created} new, ${r.updated} merged into existing leads, ${r.possible} flagged as possible duplicates, ${r.suppressed} skipped (deleted on request), ${r.invalid} invalid rows.`)
              onDone()
            })}>Import</button>
          </div>
        </div>
      )}
      {preview && (
        <div class="p-card">
          <h3>Preview: {summary!.create ?? 0} new · {summary!.update ?? 0} merge into existing · {summary!.possible} possible duplicates · {(summary!.skip_suppressed ?? 0) + (summary!.skip_invalid ?? 0)} skipped</h3>
          <div class="p-table-wrap" style={{ maxHeight: '50vh', overflow: 'auto' }}>
            <table class="p-table">
              <thead><tr><th>Row</th><th>Name</th><th>What will happen</th></tr></thead>
              <tbody>{preview.map((p) => (
                <tr key={p.row}>
                  <td class="num">{p.row}</td><td>{p.name ?? <span class="p-muted">—</span>}</td>
                  <td class="p-small">{p.action === 'create' ? (p.possible ? <>New — <Badge tone="warn">similar to {p.possible.name}</Badge></> : 'New lead')
                    : p.action === 'update' ? <>Merge into <strong>{p.match?.name}</strong> (same {String(p.reason).replace('_', ' ')})</>
                    : p.action === 'skip_suppressed' ? <Badge tone="bad">Skipped — deleted on request</Badge> : <Badge>Skipped — no name</Badge>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Duplicates ────────────────────────────────────────────────────────────
function Duplicates({ onChange }: { onChange: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const list = useLoad(async () => check(await sb().from('lead_duplicates').select('id, reason, similarity, created_at, a:leads!lead_duplicates_lead_id_fkey(id, name, locality, primary_phone, website_domain, sources), b:leads!lead_duplicates_other_id_fkey(id, name, locality, primary_phone, website_domain, sources)').eq('status', 'open').order('created_at')) as any[])
  const merge = (keep: string, drop: string) => run(async () => { check(await sb().rpc('merge_leads', { p_keep: keep, p_drop: drop })); await list.reload(); await onChange() }, 'Merged')
  const Side = ({ l }: { l: any }) => (
    <div><a href={`/portal/admin/leads/view/?id=${l.id}`} target="_blank"><strong>{l.name}</strong></a><div class="p-small p-muted">{l.locality ?? '—'} · {l.primary_phone ?? 'no phone'} · {l.website_domain ?? 'no website'} · {l.sources.map((s: string) => SOURCE_LABEL[s]).join(', ')}</div></div>
  )
  if (list.loading) return <div class="p-loading">Loading…</div>
  return list.data?.length ? (
    <div class="p-stack">
      {list.data.map((x) => (
        <div class="p-card" key={x.id}>
          <div class="p-small p-muted">Similar names nearby ({Math.round(x.similarity * 100)}% alike)</div>
          <div class="p-grid-2" style={{ margin: '0.5rem 0' }}><Side l={x.a} /><Side l={x.b} /></div>
          <div class="p-row">
            <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => merge(x.b.id, x.a.id)}>Same business — keep “{x.b.name}”</button>
            <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => merge(x.a.id, x.b.id)}>Same — keep “{x.a.name}”</button>
            <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().from('lead_duplicates').update({ status: 'dismissed', resolved_at: new Date().toISOString() }).eq('id', x.id)); await list.reload(); await onChange() }, 'Marked as different')}>Different businesses</button>
          </div>
        </div>
      ))}
    </div>
  ) : <Empty>No possible duplicates to review.</Empty>
}

// ── Settings ──────────────────────────────────────────────────────────────
function LeadSettings() {
  const { busy, run } = useAction()
  const s = useLoad(async () => check(await sb().from('lead_settings').select('*').single()) as any)
  const usage = useLoad(async () => check(await sb().from('lead_api_usage').select('*').order('month', { ascending: false }).limit(6)) as any[])
  if (!s.data) return <div class="p-loading">Loading…</div>
  return (
    <div class="p-grid-2">
      <form class="p-card p-form" onSubmit={(e) => {
        const f = formData(e)
        const enablePlaces = !!f.places_enabled
        if (enablePlaces && !s.data.places_enabled && !confirm('Google Places needs a Google Cloud project with BILLING ENABLED. Usage beyond Google’s monthly free allowance is charged to your Google account. Turn it on?')) return
        run(async () => {
          check(await sb().from('lead_settings').update({ pagespeed_enabled: !!f.pagespeed_enabled, places_enabled: enablePlaces, places_monthly_cap: Number(f.places_monthly_cap || 0) }).eq('id', 1))
          if (f.google_key) check(await sb().rpc('set_google_api_key', { p_key: f.google_key }))
          await s.reload()
        }, 'Settings saved')
      }}>
        <h2>Lead Finder settings</h2>
        <label class="p-check"><input type="checkbox" name="pagespeed_enabled" defaultChecked={s.data.pagespeed_enabled} /> Include Google PageSpeed scores in audits (free; works best with an API key)</label>
        <Field label="Google API key" hint={s.data.google_key_secret_id ? 'A key is saved (hidden). Type a new one to replace it.' : 'Stored encrypted in Supabase Vault. PageSpeed needs no billing.'}><input name="google_key" type="password" autoComplete="off" /></Field>
        <fieldset class="p-card">
          <legend class="p-small">Google Places (optional, can cost money)</legend>
          <p class="p-small p-muted">Off by default. Requires billing on your Google Cloud project; Google charges beyond its monthly free usage. Lead Finder works fully without it (OpenStreetMap, manual entry, CSV).</p>
          <label class="p-check"><input type="checkbox" name="places_enabled" defaultChecked={s.data.places_enabled} /> Enable Google Places searches</label>
          <Field label="Monthly request cap" hint="Searches stop for the month at this many requests. Keep it within Google’s free usage."><input name="places_monthly_cap" type="number" min="0" max="100000" defaultValue={s.data.places_monthly_cap} /></Field>
        </fieldset>
        <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
      </form>
      <div class="p-card">
        <h2>Paid API usage</h2>
        {usage.data?.length ? <ul class="p-small">{usage.data.map((u) => <li key={u.month + u.api}>{u.month}: {u.api} — {u.requests} requests</li>)}</ul> : <p class="p-muted">None. OpenStreetMap searches are free.</p>}
        <h3 style={{ marginTop: '1rem' }}>Compliance</h3>
        <ul class="p-small">
          <li>Only public business information is collected, with its source and date.</li>
          <li>Mark leads “do not contact” when asked; delete on request (they won’t be re-added by future searches).</li>
          <li>Calls and SMS: follow TRAI’s commercial communication (DND) rules. Email: include an opt-out. Personal data: India’s DPDP Act.</li>
        </ul>
      </div>
    </div>
  )
}

// ── Lead detail ───────────────────────────────────────────────────────────
export function LeadView() {
  return (
    <Portal title="Lead" need="admin">
      {(app) => <LeadBody app={app} id={qs('id') ?? ''} />}
    </Portal>
  )
}

function LeadBody({ app, id }: { app: ReturnType<typeof useApp>; id: string }) {
  const { busy, run } = useAction()
  const [addingContact, setAddingContact] = useState(false)
  const data = useLoad(async () => {
    const [l, cps, audits, finds, hits] = await Promise.all([
      sb().from('leads').select('*').eq('id', id).maybeSingle(),
      sb().from('lead_contact_points').select('*').eq('lead_id', id).order('kind').order('first_seen_at'),
      sb().from('lead_audits').select('*').eq('lead_id', id).order('queued_at', { ascending: false }).limit(5),
      sb().from('lead_findings').select('*').eq('lead_id', id).order('created_at', { ascending: false }),
      sb().from('lead_search_hits').select('first_seen_at, lead_searches(name)').eq('lead_id', id),
    ])
    const lead = check(l) as any
    if (!lead) throw new Error('Lead not found (it may have been merged or deleted).')
    return { lead, cps: check(cps) as any[], audits: check(audits) as any[], finds: check(finds) as any[], hits: check(hits) as any[] }
  }, [id])
  if (data.loading && !data.data) return <div class="p-loading">Loading…</div>
  if (data.error) return <ErrorNote error={data.error} />
  const { lead, cps, audits, finds, hits } = data.data!
  const lastAudit = audits.find((a) => a.status === 'done')
  const latestFinds = lastAudit ? finds.filter((f) => f.audit_id === lastAudit.id) : []
  const update = (patch: Record<string, unknown>, msg = 'Saved') => run(async () => { check(await sb().from('leads').update(patch).eq('id', id)); await callFn('leads', { action: 'rescore', lead_id: id }); await data.reload() }, msg)

  const completeness: [string, string, 'present' | 'unverified' | 'missing'][] = [
    ['phone', 'Phone', cps.some((c) => (c.kind === 'phone' || c.kind === 'whatsapp') && c.verified_by) ? 'present' : cps.some((c) => c.kind === 'phone' || c.kind === 'whatsapp') ? 'unverified' : 'missing'],
    ['email', 'Email', cps.some((c) => c.kind === 'email' && c.verified_by) ? 'present' : cps.some((c) => c.kind === 'email') ? 'unverified' : 'missing'],
    ['website', 'Website', lead.website_state === 'live' ? 'present' : lead.website_state === 'none_listed' ? 'missing' : 'unverified'],
    ['locality', 'Locality', lead.locality ? 'present' : 'missing'],
    ['person', 'Contact person', lead.contact_person ? 'present' : 'missing'],
  ]
  const q = encodeURIComponent(`${lead.name} ${lead.locality ?? ''} ${lead.city ?? ''}`.trim())

  return (
    <>
      <PageHead title={lead.name} sub={<>{[industryByKey(lead.industry)?.label ?? lead.category, lead.locality, lead.city].filter(Boolean).join(' · ')} {lead.do_not_contact && <Badge tone="bad">do not contact</Badge>}</>}>
        <a class="btn btn-ghost p-btn" href="/portal/admin/leads/">All leads</a>
        <a class="btn btn-ghost p-btn" href={`/portal/admin/leads/report/?id=${id}`}>Redesign report</a>
      </PageHead>

      <div class="p-grid-2">
        <div class="p-stack">
          <div class="p-card">
            <h2>What we know</h2>
            <div class="p-grid" style={{ gap: '0.4rem', marginBottom: '0.75rem' }}>
              {completeness.map(([k, label, st]) => (
                <div key={k} class="p-small"><Badge tone={st === 'present' ? 'ok' : st === 'unverified' ? 'warn' : 'bad'}>{st === 'present' ? '✓' : st === 'unverified' ? '?' : '✗'}</Badge> {label} <span class="p-muted">{st}</span></div>
              ))}
            </div>
            <div class="p-row p-small">
              <span class="p-muted">Research this:</span>
              <a href={`https://www.google.com/search?q=${q}`} target="_blank" rel="noopener">Google</a>
              <a href={`https://www.google.com/maps/search/${q}`} target="_blank" rel="noopener">Maps</a>
              <a href={`https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(lead.name)}`} target="_blank" rel="noopener">Instagram</a>
              {lead.osm_ref && <a href={`https://www.openstreetmap.org/${lead.osm_ref}`} target="_blank" rel="noopener">OpenStreetMap</a>}
            </div>
          </div>

          <div class="p-card">
            <div class="p-row"><h2 style={{ margin: 0 }}>Contact details</h2><span class="p-spacer" /><button class="btn btn-ghost p-btn" onClick={() => setAddingContact(true)}>Add</button></div>
            {cps.length ? (
              <div class="p-table-wrap"><table class="p-table">
                <thead><tr><th>Detail</th><th>Source</th><th>Verified</th><th></th></tr></thead>
                <tbody>{cps.map((c) => (
                  <tr key={c.id}>
                    <td class="p-small"><Badge>{c.kind}</Badge> {c.kind === 'website' || c.kind === 'social' ? <a href={c.value} target="_blank" rel="noopener nofollow">{c.value}</a> : c.value}</td>
                    <td class="p-small">{SOURCE_LABEL[c.source]}<div class="p-muted">first seen {d(c.first_seen_at)}</div>{c.expires_at && <div class="p-muted">Google data — expires {d(c.expires_at)} unless verified</div>}</td>
                    <td class="p-small">{c.verified_by ? <>{c.verified_by === 'person' ? 'Verified by you' : 'Checked automatically'}<div class="p-muted">{d(c.last_verified_at)}</div></> : <span class="p-muted">not verified</span>}</td>
                    <td><div class="p-row">
                      {c.verified_by !== 'person' && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().from('lead_contact_points').update({ verified_by: 'person', verified_by_user: app.ctx.profile.id, last_verified_at: new Date().toISOString(), expires_at: null }).eq('id', c.id)); await callFn('leads', { action: 'rescore', lead_id: id }); await data.reload() }, 'Marked verified')}>Verify</button>}
                      <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => confirm('Remove this detail?') && run(async () => { check(await sb().from('lead_contact_points').delete().eq('id', c.id)); await callFn('leads', { action: 'rescore', lead_id: id }); await data.reload() }, 'Removed')}>Remove</button>
                    </div></td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <p class="p-muted">No public contact details found yet.</p>}
          </div>

          <div class="p-card">
            <div class="p-row">
              <h2 style={{ margin: 0 }}>Website</h2>
              <Badge tone={WEBSITE_STATE[lead.website_state].tone}>{WEBSITE_STATE[lead.website_state].label}</Badge>
              <span class="p-spacer" />
              {lead.website_url && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { await callFn('leads', { action: 'check_website', lead_id: id }); await data.reload() }, 'Checked')}>Check now</button>}
              {lead.website_url && <button class="btn btn-ink p-btn" disabled={busy} onClick={() => run(async () => { await callFn('leads', { action: 'audit_queue', lead_ids: [id] }); await callFn('leads', { action: 'audit_next', limit: 1 }); await data.reload() }, 'Audit finished')}>{busy ? 'Auditing…' : 'Run audit'}</button>}
            </div>
            {lead.website_url ? <p class="p-small"><a href={lead.website_url} target="_blank" rel="noopener nofollow">{lead.website_url}</a>{lead.website_checked_at && <> · checked {ago(lead.website_checked_at)}</>}</p> : <p class="p-small p-muted">No source we checked lists a website. Add one if you find it.</p>}
            {lead.website_note && <p class="p-small p-muted">{lead.website_note}</p>}
            {lastAudit && (
              <>
                <p class="p-small">Last audit {dt(lastAudit.finished_at)} · HTTP {lastAudit.http_status ?? '—'} · {lastAudit.response_ms ?? '—'} ms{lastAudit.pagespeed?.performance != null && <> · PageSpeed mobile {lastAudit.pagespeed.performance}/100</>}{lastAudit.pagespeed?.error && <> · PageSpeed: {lastAudit.pagespeed.error}</>}</p>
                {latestFinds.filter((f) => f.source !== 'ai').length ? (
                  <ul class="p-small" style={{ paddingLeft: '1rem' }}>
                    {latestFinds.filter((f) => f.source !== 'ai').map((f) => <li key={f.id}><Badge tone={f.severity === 'high' ? 'bad' : f.severity === 'medium' ? 'warn' : undefined}>{f.severity}</Badge> <strong>{f.title}</strong> — <span class="p-muted">{f.evidence}</span> <span class="p-muted">({f.source === 'pagespeed' ? 'PageSpeed' : 'verified check'})</span></li>)}
                  </ul>
                ) : <p class="p-small">No problems found by the checks.</p>}
              </>
            )}
            {audits.find((a) => ['failed', 'skipped'].includes(a.status) && a.error) && !lastAudit && <p class="p-small p-muted">Audit: {audits.find((a) => a.error)?.error}</p>}
          </div>
        </div>

        <div class="p-stack">
          <CrmPanel lead={lead} onChange={data.reload} />

          <div class="p-card">
            <h2>Opportunity score <ScoreBadge s={lead.score} /></h2>
            <ul class="p-small" style={{ paddingLeft: '1rem' }}>{(lead.score_reasons as any[]).map((r, i) => <li key={i}>{r.points > 0 ? `+${r.points}` : r.points} — {r.text}</li>)}</ul>
            <p class="p-small p-muted">{SCORE_DISCLAIMER}</p>
            {!lead.do_not_contact && <OutreachDraft lead={lead} findings={latestFinds} />}
          </div>

          <form class="p-card p-form" onSubmit={(e) => {
            const f = formData(e)
            const checklist = Object.fromEntries(CHECKLIST.map(([k]) => [k, !!f[`ck_${k}`]]))
            update({ research_status: f.research_status, research_checklist: checklist, research_notes: f.research_notes.trim() || null, contact_person: f.contact_person.trim() || null,
              evidence_links: f.evidence_links.split(/\s+/).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 20) })
          }}>
            <h2>Research</h2>
            <Field label="Status"><select name="research_status" defaultValue={lead.research_status}>{Object.entries(RESEARCH).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select></Field>
            <div class="p-stack" style={{ gap: '0.3rem' }}>{CHECKLIST.map(([k, label]) => <label class="p-check" key={k}><input type="checkbox" name={`ck_${k}`} defaultChecked={!!lead.research_checklist?.[k]} /> {label}</label>)}</div>
            <Field label="Contact person (public info only)"><input name="contact_person" defaultValue={lead.contact_person ?? ''} maxLength={120} /></Field>
            <Field label="Notes"><textarea name="research_notes" rows={4} maxLength={8000} defaultValue={lead.research_notes ?? ''} /></Field>
            <Field label="Evidence links (one per line)"><textarea name="evidence_links" rows={2} defaultValue={(lead.evidence_links ?? []).join('\n')} /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Save research</button>
          </form>

          <div class="p-card">
            <h2>Sources</h2>
            <p class="p-small">{lead.sources.map((s: string) => SOURCE_LABEL[s] ?? s).join(', ')} · added {d(lead.created_at)} · last seen in a search {ago(lead.last_seen_at)}</p>
            {hits.length > 0 && <p class="p-small p-muted">Found by: {hits.map((h) => h.lead_searches?.name).filter(Boolean).join(', ')}</p>}
            {lead.osm_ref && <p class="p-small p-muted">{OSM_CREDIT}</p>}
          </div>

          <div class="p-card p-form">
            <h2>Contact preferences</h2>
            {lead.do_not_contact ? (
              <>
                <p class="p-small">Do not contact since {d(lead.dnc_at)}{lead.dnc_reason && ` — ${lead.dnc_reason}`}.</p>
                <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => confirm('Allow contacting this business again?') && update({ do_not_contact: false }, 'Contact allowed')}>Allow contact again</button>
              </>
            ) : (
              <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => { const r = prompt('Reason (e.g. asked not to be contacted)'); if (r !== null) update({ do_not_contact: true, dnc_reason: r || null }, 'Marked do not contact') }}>Mark do not contact</button>
            )}
            <button class="btn btn-ghost p-btn p-btn-danger" disabled={busy} onClick={() => {
              const r = prompt('Delete this business on its request? It will be removed and never re-added by searches. Reason (optional):')
              if (r !== null) run(async () => { check(await sb().rpc('delete_lead_on_request', { p_lead: id, p_reason: r || null })); location.href = '/portal/admin/leads/' }, 'Deleted')
            }}>Delete on request</button>
          </div>
        </div>
      </div>

      {addingContact && (
        <Modal title="Add contact detail" onClose={() => setAddingContact(false)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            run(async () => {
              const raw = f.value.trim()
              let value = raw, norm: string | null = null
              if (f.kind === 'phone') norm = value = normalizePhoneIN(raw) ?? ''
              else if (f.kind === 'email') norm = value = normalizeEmail(raw) ?? ''
              else {
                const u = classifyUrl(raw)
                if (u && (f.kind === 'website') === (u.kind === 'website')) { value = u.url; norm = u.kind === 'website' ? u.domain : socialKey(u.url) }
              }
              if (!norm) throw new Error(f.kind === 'website' ? 'Enter the business’s own website (social pages go under “Social profile”).' : `That doesn’t look like a valid ${f.kind}.`)
              const by = f.verified ? { verified_by: 'person', verified_by_user: app.ctx.profile.id, last_verified_at: new Date().toISOString() } : {}
              check(await sb().from('lead_contact_points').insert({ lead_id: id, kind: f.kind, value, value_norm: norm, source: 'manual', note: f.note || null, ...by }))
              await callFn('leads', { action: 'rescore', lead_id: id })
              setAddingContact(false)
              await data.reload()
            }, 'Added')
          }}>
            <Field label="Type"><select name="kind"><option value="phone">Phone</option><option value="email">Email</option><option value="website">Website</option><option value="social">Social profile</option></select></Field>
            <Field label="Value"><input name="value" required /></Field>
            <Field label="Where you found it"><input name="note" maxLength={300} /></Field>
            <label class="p-check"><input type="checkbox" name="verified" defaultChecked /> I confirmed this myself</label>
            <button class="btn btn-ink p-btn" disabled={busy}>Add</button>
          </form>
        </Modal>
      )}
    </>
  )
}

// ── Reports ───────────────────────────────────────────────────────────────
export function LeadReport() {
  return (
    <Portal title="Redesign report" need="admin">
      {() => <ReportBody id={qs('id') ?? ''} />}
    </Portal>
  )
}

const PRIORITY: Record<string, string> = {
  site_broken: 'Fix or replace the broken website so customers can reach you', no_viewport: 'Make the site work properly on phones', ps_slow: 'Speed up the site on mobile',
  no_contact_path: 'Add tap-to-call, WhatsApp and an enquiry form', no_https: 'Move to a secure https address', missing_description: 'Add search descriptions so Google shows the right text',
  missing_title: 'Add proper page titles for Google', broken_links: 'Fix broken links', outdated_copyright: 'Refresh the content and dates so the site looks current', img_alt: 'Describe images for accessibility and search',
  mixed_content: 'Remove insecure (http) files', no_nav: 'Add clear navigation', ps_seo: 'Improve basic search visibility', ps_accessibility: 'Improve accessibility', no_tap_to_call: 'Add tap-to-call / WhatsApp buttons',
  slow_response: 'Use faster hosting', heavy_page: 'Make the homepage lighter',
}
const SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3 } as Record<string, number>

function ReportBody({ id }: { id: string }) {
  const { busy, run } = useAction()
  const data = useLoad(async () => {
    const lead = check(await sb().from('leads').select('*').eq('id', id).single()) as any
    const audit = check(await sb().from('lead_audits').select('*').eq('lead_id', id).eq('status', 'done').order('finished_at', { ascending: false }).limit(1).maybeSingle()) as any
    const finds = audit ? (check(await sb().from('lead_findings').select('*').eq('audit_id', audit.id)) as any[]) : []
    return { lead, audit, finds }
  }, [id])
  if (data.loading && !data.data) return <div class="p-loading">Loading…</div>
  if (data.error) return <ErrorNote error={data.error} />
  const { lead, audit, finds } = data.data!
  const verified = finds.filter((f) => f.source !== 'ai').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity])
  const ai = finds.filter((f) => f.source === 'ai')
  const priorities = verified.filter((f) => PRIORITY[f.code] && f.severity !== 'info').slice(0, 6)
  return (
    <div class="print-area">
      <div class="p-row no-print" style={{ marginBottom: '1rem' }}>
        <a class="btn btn-ghost p-btn" href={`/portal/admin/leads/view/?id=${id}`}>Back to lead</a>
        <span class="p-spacer" />
        {audit && <AiAssistButton label={ai.length ? 'Redo AI summary' : 'Add AI summary'} task="audit_summary" input={() => `Business: ${lead.name} (${lead.locality ?? ''})\nWebsite: ${lead.website_url}\nVerified findings:\n${verified.map((f) => `- ${f.title}: ${f.evidence}`).join('\n')}`}
          onResult={async (text) => { await run(async () => { await sb().from('lead_findings').delete().eq('audit_id', audit.id).eq('source', 'ai'); check(await sb().from('lead_findings').insert({ lead_id: id, audit_id: audit.id, source: 'ai', code: 'ai_summary', severity: 'info', title: 'AI summary', evidence: text.slice(0, 4000) })); await data.reload() }) }} />}
        <button class="btn btn-ink p-btn" disabled={busy} onClick={() => print()}>Print / save PDF</button>
      </div>
      <PageHead title={`Website review: ${lead.name}`} sub={`${[lead.locality, lead.city].filter(Boolean).join(', ')} · prepared ${d(new Date().toISOString())} by Tomorrow Web`} />
      <div class="p-card" style={{ marginBottom: '1rem' }}>
        <h2>Summary</h2>
        <p>Website: {lead.website_url ? <a href={lead.website_url}>{lead.website_url}</a> : 'none listed in the public sources we checked'} — <strong>{WEBSITE_STATE[lead.website_state].label}</strong>.</p>
        {audit?.pagespeed?.performance != null && (
          <div class="p-grid">
            <Stat n={audit.pagespeed.performance} label="Mobile performance" />
            <Stat n={audit.pagespeed.seo ?? '—'} label="Search (SEO)" />
            <Stat n={audit.pagespeed.accessibility ?? '—'} label="Accessibility" />
            <Stat n={audit.pagespeed.lcp_ms != null ? `${(audit.pagespeed.lcp_ms / 1000).toFixed(1)}s` : '—'} label="Largest paint (mobile)" />
          </div>
        )}
      </div>
      {lead.website_state === 'none_listed' ? (
        <div class="p-card"><h2>Opportunity</h2><p>We couldn’t find a website for {lead.name}. A simple, fast site with your menu/services, location, hours and tap-to-call or WhatsApp buttons helps customers who search on Google and Maps find and contact you.</p></div>
      ) : (
        <>
          <div class="p-card" style={{ marginBottom: '1rem' }}>
            <h2>What we checked (verified)</h2>
            {audit ? (
              verified.length ? <ul>{verified.map((f) => <li key={f.id}><strong>{f.title}</strong> <span class="p-muted">— {f.evidence}</span> <span class="p-small p-muted">[{f.source === 'pagespeed' ? 'Google PageSpeed' : 'automatic check'}]</span></li>)}</ul> : <p>No problems found by our checks.</p>
            ) : <p class="p-muted">No audit yet — run one from the lead page.</p>}
            {audit && <p class="p-small p-muted">Checked {dt(audit.finished_at)}. Homepage HTTP {audit.http_status}, {audit.response_ms} ms, {audit.links_checked ?? 0} internal links tested.</p>}
          </div>
          {priorities.length > 0 && (
            <div class="p-card" style={{ marginBottom: '1rem' }}>
              <h2>Suggested priorities</h2>
              <ol>{priorities.map((f) => <li key={f.id}>{PRIORITY[f.code]}</li>)}</ol>
            </div>
          )}
        </>
      )}
      {ai.map((f) => (
        <div class="p-card" key={f.id} style={{ marginTop: '1rem' }}>
          <h2>Plain-language summary <Badge tone="ai">AI-generated — based only on the verified findings above</Badge></h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{f.evidence}</p>
        </div>
      ))}
      <p class="p-small p-muted" style={{ marginTop: '1rem' }}>Public information only. {lead.osm_ref ? OSM_CREDIT + '. ' : ''}PageSpeed data from Google PageSpeed Insights.</p>
    </div>
  )
}

export function Opportunities() {
  return (
    <Portal title="Top opportunities" need="admin">
      {() => <OpportunitiesBody />}
    </Portal>
  )
}

function OpportunitiesBody() {
  const [ind, setInd] = useState('')
  const [loc, setLoc] = useState('')
  const list = useLoad(async () => {
    let q = sb().from('leads').select('id, name, industry, locality, website_state, website_url, primary_phone, score, score_reasons').eq('do_not_contact', false).neq('research_status', 'not_suitable').not('score', 'is', null).order('score', { ascending: false }).limit(50)
    if (ind) q = q.eq('industry', ind)
    if (loc) q = q.ilike('locality', loc)
    return check(await q) as any[]
  }, [ind, loc])
  return (
    <div class="print-area">
      <PageHead title="Top redesign opportunities" sub={`Highest-scoring leads${loc ? ` in ${loc}` : ''}${ind ? ` · ${industryByKey(ind)?.label}` : ''}. ${SCORE_DISCLAIMER}`}>
        <button class="btn btn-ink p-btn no-print" onClick={() => print()}>Print / save PDF</button>
      </PageHead>
      <div class="p-row no-print" style={{ marginBottom: '1rem' }}>
        <select value={ind} onChange={(e) => setInd((e.target as HTMLSelectElement).value)} aria-label="Industry"><option value="">All industries</option>{INDUSTRIES.map((i) => <option value={i.key} key={i.key}>{i.label}</option>)}</select>
        <input class="p-input" list="tw-loc3" placeholder="Locality" value={loc} onChange={(e) => setLoc((e.target as HTMLInputElement).value)} style={{ maxWidth: '220px' }} />
        <datalist id="tw-loc3">{PUNE_LOCALITIES.map((l) => <option key={l} value={l} />)}</datalist>
      </div>
      <ErrorNote error={list.error} />
      {list.data?.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th class="num">Score</th><th>Business</th><th>Website</th><th>Why</th></tr></thead>
          <tbody>{list.data.map((l) => (
            <tr key={l.id}>
              <td class="num"><ScoreBadge s={l.score} /></td>
              <td><a href={`/portal/admin/leads/view/?id=${l.id}`}><strong>{l.name}</strong></a><div class="p-small p-muted">{[industryByKey(l.industry)?.label, l.locality].filter(Boolean).join(' · ')}{l.primary_phone && ` · ${l.primary_phone}`}</div></td>
              <td class="p-small">{WEBSITE_STATE[l.website_state].label}</td>
              <td class="p-small">{(l.score_reasons as any[]).filter((r) => r.points > 0).map((r) => r.text).join('; ')}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : !list.loading && <Empty>No scored leads yet.</Empty>}
      <p class="p-small p-muted" style={{ marginTop: '1rem' }}>{OSM_CREDIT}.</p>
    </div>
  )
}

function OutreachDraft({ lead, findings }: { lead: any; findings: any[] }) {
  const [text, setText] = useState('')
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <AiAssistButton label="Draft first message" task="outreach"
        input={() => `Business: ${lead.name}\nIndustry: ${industryByKey(lead.industry)?.label ?? lead.category ?? ''}\nLocality: ${lead.locality ?? ''}, ${lead.city ?? ''}\nWebsite state: ${WEBSITE_STATE[lead.website_state].label}\nVerified findings:\n${findings.filter((f) => f.source !== 'ai').map((f) => `- ${f.title}`).join('\n') || '- none'}`}
        onResult={(t) => setText(t)} />
      {text && (
        <div class="p-card" style={{ marginTop: '0.5rem' }}>
          <Badge tone="ai">AI-generated — review and edit before sending</Badge>
          <textarea rows={6} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} style={{ marginTop: '0.4rem' }} />
          <button class="btn btn-ghost p-btn" onClick={() => navigator.clipboard?.writeText(text)}>Copy</button>
        </div>
      )}
    </div>
  )
}
