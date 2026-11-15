// Lead Finder (administrator only; verify_jwt: true).
//   geocode        locality → coordinates (Nominatim, cached, attribution shown in the portal)
//   discover       run a saved or ad-hoc OpenStreetMap search (Overpass) and merge results into leads
//   places_search  optional Google Places Text Search — OFF by default, needs a key and a monthly cap
//   import         CSV import with column mapping; dry_run returns the duplicate preview
//   add            manual lead (same duplicate rules)
//   check_website  reachability check → website state (respects robots.txt)
//   audit_queue    queue website audits;  audit_next  process the next queued audit(s)
//   rescore        recompute opportunity scores
//   overpass_status  health check of the public OpenStreetMap (Overpass) servers
import { audit, clean, getCaller, handler, HttpError, json, requireAdmin, serviceClient, UUID_RE } from '../_shared/util.ts'
import {
  type Candidate, CSV_FIELDS, type CsvField, type ExistingLead, fromCsvRow, fromOsm, fromPlace, industryByKey, overpassQuery, parseCsv,
  planIngest, scoreLead, suppressionKeys, contactsFrom, type WebsiteState,
} from '../_shared/leads.ts'
import { analyzeHtml, findingsFor, parsePageSpeed, type Finding } from '../_shared/audit.ts'
import { checkLinks, fetchSite, NOTES, stateOf } from '../_shared/site.ts'

const admin = serviceClient()
const OSM_UA = 'TomorrowWebLeadFinder/1.0 (lead research; respects usage policies)'
// Public Overpass instances with worldwide data (wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter']

const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('')
const must = <T>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new HttpError(500, `${what}: ${r.error.message}`)
  return r.data
}

// ── Geocoding (free, no key) ──────────────────────────────────────────────
// Nominatim first; it refuses some cloud IP ranges (HTTP 403), so Photon (komoot, OSM data) and a
// place-name lookup through Overpass are tried next. Results are cached in lead_localities.
type Geo = { lat: number; lon: number; display_name: string; source: string }
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\"]/g, '\\$&')

async function viaNominatim(name: string, city: string): Promise<Geo | null> {
  const q = new URLSearchParams({ q: `${name}, ${city}, India`, format: 'jsonv2', limit: '1', countrycodes: 'in' })
  const r = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, { headers: { 'User-Agent': OSM_UA }, signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Nominatim HTTP ${r.status}`)
  const [hit] = await r.json()
  return hit ? { lat: Number(hit.lat), lon: Number(hit.lon), display_name: hit.display_name, source: 'nominatim' } : null
}

async function viaPhoton(name: string, city: string): Promise<Geo | null> {
  // Prefer settlement results (suburb, neighbourhood…) over hills, roads or shops with the same name.
  for (const placeOnly of [true, false]) {
    const q = new URLSearchParams({ q: `${name}, ${city}, India`, limit: '5', lang: 'en' })
    if (placeOnly) q.set('osm_tag', 'place')
    const r = await fetch(`https://photon.komoot.io/api/?${q}`, { headers: { 'User-Agent': OSM_UA }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw new Error(`Photon HTTP ${r.status}`)
    const f = ((await r.json()).features ?? []).find((x: any) => (x.properties?.countrycode ?? '').toUpperCase() === 'IN')
    if (!f) continue
    const p = f.properties
    return { lon: Number(f.geometry.coordinates[0]), lat: Number(f.geometry.coordinates[1]), display_name: [p.name, p.district, p.city, p.state, 'India'].filter(Boolean).join(', '), source: 'photon' }
  }
  return null
}

async function viaOverpass(name: string, city: string): Promise<Geo | null> {
  const n = reEsc(name), c = reEsc(city)
  const query = name.toLowerCase() === city.toLowerCase()
    ? `[out:json][timeout:20];area["ISO3166-1"="IN"]->.in;node["place"~"^(city|town)$"]["name"~"^${n}$",i](area.in);out 1;`
    : `[out:json][timeout:20];area["name"~"^${c}$",i]["boundary"="administrative"]->.c;node["place"~"^(suburb|neighbourhood|quarter|locality|village|hamlet|town)$"]["name"~"^${n}$",i](area.c);out 1;`
  const { elements } = await overpass(query, 30_000)
  const e = elements[0]
  return e ? { lat: Number(e.lat), lon: Number(e.lon), display_name: `${e.tags?.name ?? name}, ${city}, India`, source: 'overpass' } : null
}

async function geocode(name: string, city: string) {
  if (!name) throw new HttpError(400, 'Enter a locality or city.')
  const { data: cached } = await admin.from('lead_localities').select('*').ilike('name', name).ilike('city', city).maybeSingle()
  if (cached) return cached
  const errors: string[] = []
  for (const look of [viaNominatim, viaPhoton, viaOverpass]) {
    let hit: Geo | null = null
    try { hit = await look(name, city) } catch (e) { errors.push((e as Error).message); continue }
    if (hit && Number.isFinite(hit.lat) && Number.isFinite(hit.lon)) {
      return must(await admin.from('lead_localities').insert({ name, city, lat: hit.lat, lon: hit.lon, display_name: hit.display_name, source: hit.source }).select('*').single(), 'save locality')
    }
  }
  if (errors.length === 3) throw new HttpError(502, `Location lookup failed (${errors.join('; ')}). Try again in a minute, or enter coordinates.`)
  throw new HttpError(404, `Couldn’t find “${name}, ${city}”. Check the spelling or enter coordinates.`)
}

// ── Existing leads + suppression ──────────────────────────────────────────
async function loadExisting(): Promise<ExistingLead[]> {
  const leads = must(await admin.from('leads').select('id, name, locality, lat, lon, osm_ref, place_ref').limit(20000), 'load leads') as any[]
  const cps = must(await admin.from('lead_contact_points').select('lead_id, kind, value_norm').in('kind', ['website', 'phone', 'whatsapp']).limit(50000), 'load contacts') as any[]
  const by = new Map<string, ExistingLead>(leads.map((l) => [l.id, { ...l, domains: [], phones: [] }]))
  for (const c of cps) {
    const e = by.get(c.lead_id)
    if (!e) continue
    if (c.kind === 'website') e.domains.push(c.value_norm)
    else e.phones.push(c.value_norm)
  }
  return [...by.values()]
}

async function suppressedChecker(cands: (Candidate | null)[]) {
  const all = new Map<string, string>()
  for (const c of cands) if (c) for (const k of suppressionKeys(c)) all.set(k, await sha256(k))
  const hashes = [...new Set(all.values())]
  const hit = new Set<string>()
  for (let i = 0; i < hashes.length; i += 500) {
    const rows = must(await admin.from('lead_suppressions').select('key_hash').in('key_hash', hashes.slice(i, i + 500)), 'suppressions') as any[]
    rows.forEach((r) => hit.add(r.key_hash))
  }
  return (c: Candidate) => suppressionKeys(c).some((k) => hit.has(all.get(k)!))
}

// ── Ingest ────────────────────────────────────────────────────────────────
interface IngestResult { found: number; created: number; updated: number; possible: number; suppressed: number; invalid: number; leadIds: string[] }

async function preparePlan(cands: (Candidate | null)[]) {
  // Google Places details may be cached at most 30 days unless a person verified them.
  await admin.from('lead_contact_points').delete().eq('source', 'google_places').lt('expires_at', new Date().toISOString()).neq('verified_by', 'person')
  const existing = await loadExisting()
  return { plan: planIngest(cands, existing, await suppressedChecker(cands)), names: new Map(existing.map((e) => [e.id, e.name])) }
}

async function previewIngest(cands: (Candidate | null)[]) {
  const { plan, names } = await preparePlan(cands)
  return {
    preview: plan.map((s, i) => ({
      row: i + 1, name: s.candidate?.name ?? null, action: s.action, reason: s.reason ?? null,
      match: s.leadId ? { id: s.leadId, name: names.get(s.leadId) ?? (s.leadId.startsWith('new:') ? '(earlier row)' : null) } : null,
      possible: s.possibleOf ? { id: s.possibleOf.id, name: names.get(s.possibleOf.id) ?? '(earlier row)', similarity: s.possibleOf.similarity } : null,
      contacts: s.candidate?.contacts.length ?? 0,
    })),
  }
}

async function ingest(cands: (Candidate | null)[], opts: { searchId?: string; actor: string }): Promise<IngestResult> {
  const { plan } = await preparePlan(cands)
  const res: IngestResult = { found: cands.length, created: 0, updated: 0, possible: 0, suppressed: 0, invalid: 0, leadIds: [] }
  const tempToReal = new Map<string, string>()
  const now = new Date().toISOString()
  for (const s of plan) {
    if (s.action === 'skip_suppressed') { res.suppressed++; continue }
    if (s.action === 'skip_invalid') { res.invalid++; continue }
    const c = s.candidate
    let id: string
    if (s.action === 'create') {
      const row = must(await admin.from('leads').insert({
        name: c.name, industry: c.industry, category: c.category, city: c.city, locality: c.locality, address: c.address, lat: c.lat, lon: c.lon,
        osm_ref: c.source === 'osm' ? c.source_ref : null, place_ref: c.source === 'google_places' ? c.source_ref : null,
        sources: [c.source], contact_person: (c.extra?.contact_person as string) ?? null, research_notes: (c.extra?.notes as string) ?? null,
        extra: c.extra ?? {}, created_by: opts.actor,
      }).select('id').single(), 'create lead') as any
      id = row.id
      tempToReal.set(s.tempId!, id)
      res.created++
      if (s.possibleOf) {
        const other = tempToReal.get(s.possibleOf.id) ?? s.possibleOf.id
        if (UUID_RE.test(other)) {
          await admin.from('lead_duplicates').upsert({ lead_id: id, other_id: other, reason: 'similar_name_nearby', similarity: s.possibleOf.similarity }, { onConflict: 'lead_id,other_id', ignoreDuplicates: true })
          res.possible++
        }
      }
    } else {
      id = tempToReal.get(s.leadId!) ?? s.leadId!
      const { data: cur } = await admin.from('leads').select('osm_ref, place_ref, sources, industry, category, locality, address, lat, lon, city').eq('id', id).single()
      if (!cur) continue
      const patch: Record<string, unknown> = { last_seen_at: now, sources: [...new Set([...(cur.sources ?? []), c.source])] }
      if (c.source === 'osm' && !cur.osm_ref && c.source_ref) patch.osm_ref = c.source_ref
      if (c.source === 'google_places' && !cur.place_ref && c.source_ref) patch.place_ref = c.source_ref
      for (const k of ['industry', 'category', 'locality', 'address', 'lat', 'lon', 'city'] as const) if (cur[k] == null && c[k] != null) patch[k] = c[k]
      const up = await admin.from('leads').update(patch).eq('id', id)
      if (up.error && /duplicate key/.test(up.error.message)) { delete patch.osm_ref; delete patch.place_ref; await admin.from('leads').update(patch).eq('id', id) }
      res.updated++
    }
    res.leadIds.push(id)
    if (c.contacts.length) {
      await admin.from('lead_contact_points').upsert(c.contacts.map((x) => ({
        lead_id: id, kind: x.kind, value: x.value, value_norm: x.value_norm, source: c.source, source_ref: c.source_ref, last_seen_at: now,
        expires_at: c.source === 'google_places' ? new Date(Date.now() + 30 * 86400_000).toISOString() : null,
      })), { onConflict: 'lead_id,kind,value_norm', ignoreDuplicates: false })
    }
    if (opts.searchId) await admin.from('lead_search_hits').upsert({ search_id: opts.searchId, lead_id: id, last_seen_at: now }, { onConflict: 'search_id,lead_id', ignoreDuplicates: false })
  }
  await rescore([...new Set(res.leadIds)])
  return res
}

// ── Scoring ───────────────────────────────────────────────────────────────
async function rescore(ids: string[] | 'all') {
  const leadQ = admin.from('leads').select('id, website_state, industry, pagespeed_performance')
  const leads = must(ids === 'all' ? await leadQ.limit(20000) : ids.length ? await leadQ.in('id', ids) : { data: [], error: null }, 'leads') as any[]
  for (let i = 0; i < leads.length; i += 200) {
    const chunk = leads.slice(i, i + 200)
    const cids = chunk.map((l) => l.id)
    const cps = must(await admin.from('lead_contact_points').select('lead_id, kind').in('lead_id', cids).in('kind', ['phone', 'whatsapp', 'email']), 'contacts') as any[]
    const audits = must(await admin.from('lead_audits').select('id, lead_id, finished_at').in('lead_id', cids).eq('status', 'done').order('finished_at', { ascending: false }), 'audits') as any[]
    const latest = new Map<string, string>()
    for (const a of audits) if (!latest.has(a.lead_id)) latest.set(a.lead_id, a.id)
    const finds = latest.size ? (must(await admin.from('lead_findings').select('audit_id, code, source').in('audit_id', [...latest.values()]), 'findings') as any[]) : []
    for (const l of chunk) {
      const auditId = latest.get(l.id)
      const s = scoreLead({
        website_state: l.website_state as WebsiteState, industry: l.industry,
        has_phone: cps.some((c) => c.lead_id === l.id && c.kind !== 'email'), has_email: cps.some((c) => c.lead_id === l.id && c.kind === 'email'),
        findings: auditId ? finds.filter((f) => f.audit_id === auditId) : [], pagespeed_performance: l.pagespeed_performance,
      })
      await admin.from('leads').update({ score: s.score, score_reasons: s.reasons, scored_at: new Date().toISOString() }).eq('id', l.id)
    }
  }
}

async function checkWebsite(leadId: string) {
  const { data: lead } = await admin.from('leads').select('id, website_url, website_domain').eq('id', leadId).single()
  if (!lead) throw new HttpError(404, 'Lead not found.')
  if (!lead.website_url) return { state: 'none_listed' as WebsiteState }
  const f = await fetchSite(lead.website_url, 300_000)
  const state = stateOf(f, lead.website_url)
  const note = f.error ? NOTES[f.error] : state === 'broken' ? `The site answered with an error (HTTP ${f.status}).` : state === 'redirects_elsewhere' ? `Redirects to ${f.finalUrl}` : null
  await admin.from('leads').update({ website_state: state, website_checked_at: new Date().toISOString(), website_note: note }).eq('id', leadId)
  if (state === 'live') await admin.from('lead_contact_points').update({ last_verified_at: new Date().toISOString(), verified_by: 'check' }).eq('lead_id', leadId).eq('kind', 'website').eq('value_norm', lead.website_domain).is('verified_by', null)
  await rescore([leadId])
  return { state, status: f.status ?? null, final_url: f.finalUrl, note, ms: f.ms }
}

// ── Audits ────────────────────────────────────────────────────────────────
async function pageSpeed(url: string, key: string | null) {
  const q = new URLSearchParams({ url, strategy: 'mobile' })
  for (const c of ['performance', 'accessibility', 'seo', 'best-practices']) q.append('category', c)
  if (key) q.set('key', key)
  const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(75_000) })
  if (!r.ok) throw new Error(`PageSpeed ${r.status}${r.status === 429 ? ' (daily quota reached — add a Google API key)' : ''}`)
  return parsePageSpeed(await r.json())
}

async function runAudit(a: { id: string; lead_id: string }, settings: any) {
  const { data: lead } = await admin.from('leads').select('id, website_url, website_domain').eq('id', a.lead_id).single()
  const finish = (patch: Record<string, unknown>) => admin.from('lead_audits').update({ finished_at: new Date().toISOString(), ...patch }).eq('id', a.id)
  if (!lead?.website_url) return finish({ status: 'skipped', error: 'No website listed for this lead.' })
  const f = await fetchSite(lead.website_url)
  const state = stateOf(f, lead.website_url)
  await admin.from('leads').update({
    website_state: state, website_checked_at: new Date().toISOString(),
    website_note: f.error ? NOTES[f.error] : state === 'broken' ? `The site answered with an error (HTTP ${f.status}).` : state === 'redirects_elsewhere' ? `Redirects to ${f.finalUrl}` : null,
  }).eq('id', lead.id)
  const base = { url: lead.website_url, final_url: f.finalUrl, http_status: f.status ?? null, response_ms: f.ms, page_bytes: f.bytes, redirects: f.redirects }
  if (state !== 'live' || !f.html) {
    await finish({ ...base, status: f.error === 'robots' ? 'skipped' : 'done', error: f.error ? NOTES[f.error] : state === 'live' ? 'Not an HTML page' : null })
    if (state === 'broken') await admin.from('lead_findings').insert({ lead_id: lead.id, audit_id: a.id, source: 'check', code: 'site_broken', severity: 'high', title: `Website returns an error (HTTP ${f.status})`, evidence: f.finalUrl })
    await rescore([lead.id])
    return
  }
  const analysis = analyzeHtml(f.html, f.finalUrl)
  const links = await checkLinks(analysis.internalLinks)
  let ps = null, psError: string | null = null
  if (settings?.pagespeed_enabled) {
    try { ps = await pageSpeed(f.finalUrl, settings.google_key ?? null) } catch (e) { psError = (e as Error).message }
  }
  const findings: Finding[] = findingsFor(analysis, { requestedUrl: lead.website_url, finalUrl: f.finalUrl, status: f.status!, redirects: f.redirects, ms: f.ms, bytes: f.bytes }, { brokenLinks: links.broken, checkedLinks: links.checked, pagespeed: ps })
  if (findings.length) await admin.from('lead_findings').insert(findings.map((x) => ({ ...x, lead_id: lead.id, audit_id: a.id })))
  // Contact details published on the business's own website are verified by this check.
  const own = contactsFrom({ phones: analysis.tel, emails: analysis.mailto })
  if (own.length) {
    const now = new Date().toISOString()
    await admin.from('lead_contact_points').upsert(own.map((x) => ({ lead_id: lead.id, kind: x.kind, value: x.value, value_norm: x.value_norm, source: 'website', source_ref: f.finalUrl, last_seen_at: now, last_verified_at: now, verified_by: 'check' })), { onConflict: 'lead_id,kind,value_norm', ignoreDuplicates: false })
  }
  await admin.from('lead_contact_points').update({ last_verified_at: new Date().toISOString(), verified_by: 'check' }).eq('lead_id', lead.id).eq('kind', 'website').eq('value_norm', lead.website_domain).is('verified_by', null)
  const { internalLinks, ...analysisSummary } = analysis
  await finish({ ...base, status: 'done', analysis: { ...analysisSummary, internal_links: internalLinks.length }, pagespeed: ps ? ps : psError ? { error: psError } : null, links_checked: links.checked })
  if (ps?.performance != null) await admin.from('leads').update({ pagespeed_performance: ps.performance }).eq('id', lead.id)
  await rescore([lead.id])
}

// ── Google Places (optional, paid beyond free usage) ──────────────────────
async function placesSearch(search: any, actor: string) {
  const { data: settings } = await admin.rpc('svc_lead_settings')
  if (!settings?.places_enabled) throw new HttpError(403, 'Google Places is switched off. It needs a Google Cloud key with billing enabled — turn it on in Lead Finder settings only if you accept that.')
  if (!settings.google_key) throw new HttpError(400, 'Add a Google API key in Lead Finder settings first.')
  const cands: Candidate[] = []
  for (const ind of search.industries as string[]) {
    const n = await admin.rpc('svc_lead_api_hit', { p_api: 'places_text_search', p_cap: settings.places_monthly_cap })
    if ((n.data ?? -1) < 0) throw new HttpError(429, `Monthly Google Places cap (${settings.places_monthly_cap}) reached. Nothing more will be requested this month.`)
    const body: Record<string, unknown> = { textQuery: `${industryByKey(ind)?.places ?? ind} in ${search.locality ? `${search.locality}, ` : ''}${search.city}`, maxResultCount: 20, languageCode: 'en', regionCode: 'IN' }
    if (search.lat != null) body.locationBias = { circle: { center: { latitude: search.lat, longitude: search.lon }, radius: search.radius_m } }
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': settings.google_key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.primaryType,places.businessStatus' },
      body: JSON.stringify(body),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new HttpError(502, `Google Places: ${data?.error?.message ?? r.status}`)
    for (const p of data.places ?? []) {
      if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') continue
      const c = fromPlace(p, { city: search.city, locality: search.locality, industry: ind })
      if (c) cands.push(c)
    }
  }
  return await ingest(cands, { searchId: search.id, actor })
}

// ── Overpass ──────────────────────────────────────────────────────────────
// Tries each public instance in turn within a time budget that keeps the whole request under the
// Edge Function wall-clock limit; the error lists every instance's answer.
async function overpassOnce(url: string, query: string, timeoutMs: number, minimal = false) {
  const headers: Record<string, string> = minimal
    ? { 'content-type': 'application/x-www-form-urlencoded' }
    : { 'User-Agent': OSM_UA, Accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' }
  return await fetch(url, { method: 'POST', headers, body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(timeoutMs) })
}

async function overpass(query: string, budgetMs = 100_000) {
  const errors: string[] = []
  const t0 = Date.now()
  for (const url of OVERPASS) {
    const host = new URL(url).hostname
    for (const minimal of [false, true]) {
      const left = budgetMs - (Date.now() - t0)
      if (left < 5_000) break
      try {
        const r = await overpassOnce(url, query, Math.min(40_000, left), minimal)
        if (r.ok) {
          const data = await r.json().catch(() => null)
          if (data && Array.isArray(data.elements)) return { elements: data.elements as any[], server: host }
          errors.push(`${host}: unexpected reply`)
          break
        }
        await r.body?.cancel()
        errors.push(`${host}: HTTP ${r.status}`)
        if (r.status !== 406) break // only a 406 (headers refused) is worth retrying with minimal headers
      } catch (e) {
        errors.push(`${host}: ${(e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message.slice(0, 80)}`)
        break
      }
    }
  }
  throw new HttpError(503, `OpenStreetMap search servers are busy (${errors.join('; ')}). Try again in a minute.`)
}

/** Health check for the admin dashboard: how each public Overpass instance answers a tiny query right now. */
async function overpassStatus() {
  const q = '[out:json][timeout:10];node["amenity"="cafe"](around:200,18.5204,73.8567);out ids 1;'
  return await Promise.all(OVERPASS.map(async (url) => {
    const host = new URL(url).hostname
    const t0 = Date.now()
    try {
      let r = await overpassOnce(url, q, 20_000)
      let minimal = false
      if (r.status === 406) { await r.body?.cancel(); r = await overpassOnce(url, q, 20_000, true); minimal = true }
      await r.body?.cancel()
      return { host, status: r.status, ok: r.ok, ms: Date.now() - t0, minimal_headers: minimal }
    } catch (e) {
      return { host, status: null, ok: false, ms: Date.now() - t0, error: (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message.slice(0, 80) }
    }
  }))
}

async function discover(body: Record<string, unknown>, actor: string) {
  let search: any
  if (UUID_RE.test(clean(body.search_id, 40))) {
    search = must(await admin.from('lead_searches').select('*').eq('id', clean(body.search_id, 40)).single(), 'search')
  } else {
    const industries = (Array.isArray(body.industries) ? body.industries : []).map(String).filter((k) => industryByKey(k)).slice(0, 12)
    if (!industries.length) throw new HttpError(400, 'Choose at least one industry.')
    const locality = clean(body.locality, 80) || null
    const city = clean(body.city, 80) || 'Pune'
    search = must(await admin.from('lead_searches').insert({
      name: clean(body.name, 120) || `${industries.map((k) => industryByKey(k)!.label).join(', ')} — ${locality ?? city}`,
      source: body.source === 'google_places' ? 'google_places' : 'osm', city, locality, radius_m: Math.round(Number(body.radius_m) || 1000), industries,
      lat: Number.isFinite(Number(body.lat)) && body.lat !== null && body.lat !== '' ? Number(body.lat) : null,
      lon: Number.isFinite(Number(body.lon)) && body.lon !== null && body.lon !== '' ? Number(body.lon) : null, created_by: actor,
    }).select('*').single(), 'save search')
  }
  if (search.lat == null || search.lon == null) {
    const loc = await geocode(search.locality ?? search.city, search.city)
    search.lat = loc.lat
    search.lon = loc.lon
    await admin.from('lead_searches').update({ lat: loc.lat, lon: loc.lon }).eq('id', search.id)
  }
  // Public Overpass servers refuse many cloud data-centre IPs (overpass-api.de answers 406), so the
  // portal can run the query from the administrator's own browser: step 1 returns the query, step 2
  // posts the elements back here for matching, merging and scoring. A server-side query stays as the fallback.
  const query = search.source === 'osm' ? overpassQuery(search.lat, search.lon, search.radius_m, search.industries) : null
  if (body.prepare_only === true) return { prepared: true, search_id: search.id, source: search.source, query, servers: OVERPASS }
  const prevRun = search.last_run_at
  try {
    let res: IngestResult, server = 'google_places'
    if (search.source === 'google_places') res = await placesSearch(search, actor)
    else {
      let elements: any[]
      if (Array.isArray(body.elements)) {
        if (body.elements.length > 5000) throw new HttpError(400, 'Too many results in one go — use a smaller radius.')
        elements = body.elements.filter((e: any) => e && ['node', 'way', 'relation'].includes(e.type) && Number.isFinite(Number(e.id)) && e.tags && typeof e.tags === 'object')
        server = `your browser → ${clean(body.server, 80) || 'OpenStreetMap'}`
      } else {
        const o = await overpass(query!)
        elements = o.elements
        server = o.server
      }
      res = await ingest(elements.map((e) => fromOsm(e, { city: search.city, locality: search.locality })), { searchId: search.id, actor })
    }
    let newSince = res.created
    if (prevRun) {
      const { count } = await admin.from('lead_search_hits').select('lead_id', { count: 'exact', head: true }).eq('search_id', search.id).gt('first_seen_at', prevRun)
      newSince = count ?? 0
    }
    await admin.from('lead_searches').update({ runs: (search.runs ?? 0) + 1, last_run_at: new Date().toISOString(), last_run_found: res.found, last_run_new: res.created, last_run_merged: res.updated, last_run_possible: res.possible, last_error: null }).eq('id', search.id)
    return { search_id: search.id, server, new_since_last_run: newSince, ...res, leadIds: undefined }
  } catch (e) {
    await admin.from('lead_searches').update({ last_error: (e as Error).message.slice(0, 300), last_run_at: new Date().toISOString() }).eq('id', search.id)
    throw e
  }
}

// ── Router ────────────────────────────────────────────────────────────────
Deno.serve(handler(async (req, body) => {
  const caller = await getCaller(req, admin)
  requireAdmin(caller)
  const actor = caller.profile.id
  switch (body.action) {
    case 'geocode':
      return json(await geocode(clean(body.name, 80), clean(body.city, 80) || 'Pune'))
    case 'overpass_status':
      return json({ servers: await overpassStatus() })
    case 'discover': {
      const r: any = await discover(body, actor)
      if (!r.prepared) await audit(admin, caller, 'leads:search', { search_id: r.search_id, found: r.found, created: r.created, updated: r.updated, server: r.server })
      return json(r)
    }
    case 'import': {
      const rows = parseCsv(clean(body.csv, 2_000_000))
      if (rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one row of data.')
      if (rows.length > 2001) throw new HttpError(400, 'Import up to 2,000 rows at a time.')
      const map: Partial<Record<CsvField, number>> = {}
      for (const f of CSV_FIELDS) { const v = (body.mapping as any)?.[f]; if (Number.isInteger(v) && v >= 0) map[f] = v }
      if (map.name === undefined) throw new HttpError(400, 'Choose which column holds the business name.')
      const cands = rows.slice(1).map((r) => fromCsvRow(r, map, { city: clean(body.city, 80) || 'Pune' }))
      if (body.dry_run === true) return json(await previewIngest(cands))
      const r = await ingest(cands, { actor })
      await audit(admin, caller, 'leads:import', { rows: cands.length, created: r.created, updated: r.updated, possible: r.possible, suppressed: r.suppressed })
      return json({ ...r, leadIds: undefined })
    }
    case 'add': {
      const name = clean(body.name, 200)
      if (!name) throw new HttpError(400, 'Business name is required.')
      const c: Candidate = {
        source: 'manual', source_ref: null, name, industry: industryByKey(clean(body.industry, 40))?.key ?? null, category: clean(body.category, 80) || null,
        city: clean(body.city, 80) || 'Pune', locality: clean(body.locality, 80) || null, address: clean(body.address, 300) || null, lat: null, lon: null,
        contacts: contactsFrom({ phones: [clean(body.phone, 60)], emails: [clean(body.email, 200)], urls: [clean(body.website, 300), clean(body.social, 300)] }),
        extra: { contact_person: clean(body.contact_person, 120) || null, notes: clean(body.notes, 2000) || null },
      }
      if (body.dry_run === true) return json(await previewIngest([c]))
      const r = await ingest([c], { actor })
      return json({ ...r, lead_id: r.leadIds[0] ?? null, leadIds: undefined })
    }
    case 'check_website': {
      const id = clean(body.lead_id, 40)
      if (!UUID_RE.test(id)) throw new HttpError(400, 'Missing lead.')
      return json(await checkWebsite(id))
    }
    case 'audit_queue': {
      const ids = (Array.isArray(body.lead_ids) ? body.lead_ids : []).map(String).filter((x) => UUID_RE.test(x)).slice(0, 200)
      const busy = must(await admin.from('lead_audits').select('lead_id').in('lead_id', ids).in('status', ['queued', 'running']), 'queue') as any[]
      const todo = ids.filter((id) => !busy.some((b) => b.lead_id === id))
      if (todo.length) must(await admin.from('lead_audits').insert(todo.map((lead_id) => ({ lead_id, created_by: actor }))), 'queue')
      return json({ queued: todo.length, already_queued: ids.length - todo.length })
    }
    case 'audit_next': {
      // Recover audits stuck in "running" (function timed out) after 5 minutes.
      await admin.from('lead_audits').update({ status: 'queued', started_at: null }).eq('status', 'running').lt('started_at', new Date(Date.now() - 5 * 60_000).toISOString())
      const settings = (await admin.rpc('svc_lead_settings')).data
      const limit = Math.min(Math.max(Number(body.limit) || 1, 1), 3)
      const processed: string[] = []
      for (let i = 0; i < limit; i++) {
        const { data: next } = await admin.from('lead_audits').select('id, lead_id').eq('status', 'queued').order('queued_at').limit(1).maybeSingle()
        if (!next) break
        const { data: claimed } = await admin.from('lead_audits').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', next.id).eq('status', 'queued').select('id').maybeSingle()
        if (!claimed) continue // another tab took it
        try { await runAudit(next, settings) } catch (e) {
          await admin.from('lead_audits').update({ status: 'failed', error: (e as Error).message.slice(0, 300), finished_at: new Date().toISOString() }).eq('id', next.id)
        }
        processed.push(next.lead_id)
      }
      const { count } = await admin.from('lead_audits').select('id', { count: 'exact', head: true }).eq('status', 'queued')
      return json({ processed: processed.length, remaining: count ?? 0 })
    }
    case 'rescore': {
      const id = clean(body.lead_id, 40)
      await rescore(UUID_RE.test(id) ? [id] : 'all')
      return json({ ok: true })
    }
    default:
      throw new HttpError(400, 'Unknown action.')
  }
}))
