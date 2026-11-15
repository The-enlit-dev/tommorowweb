// M3 live tests: real OpenStreetMap search for one Pune locality through the `leads` Edge Function,
// re-run without duplicates, manual + CSV duplicate handling, website check + audit, merge,
// do-not-contact, delete-on-request suppression, and clients locked out.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fn, makeClient, signIn } from './helpers.mjs'

const s = { leads: [] }
after(async () => {
  // Remove what this test created (QA searches and leads tagged in notes).
  if (s.search) await s.admin.from('lead_searches').delete().eq('id', s.search)
  await s.admin.from('leads').delete().like('name', 'QA %')
  // Real OpenStreetMap places imported by this run (created by the QA admin since the run began).
  if (s.qaUser) await s.admin.from('leads').delete().eq('created_by', s.qaUser).gte('created_at', s.startedAt)
})

test('setup', async () => {
  s.startedAt = new Date().toISOString()
  s.admin = await signIn(process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  s.qaUser = (await s.admin.auth.getUser()).data.user.id
  s.client = (await makeClient(s.admin, { name: 'QA M3 Client' })).owner
})

test('clients cannot use the Lead Finder', async () => {
  assert.equal((await fn(s.client, 'leads', { action: 'discover', locality: 'Baner', industries: ['cafe'] })).status, 403)
  const { data } = await s.client.from('leads').select('id')
  assert.equal(data.length, 0)
})

const OSM_FIXTURE = [
  { type: 'node', id: -9001, lat: 18.5591, lon: 73.7869, tags: { amenity: 'cafe', name: 'QA OSM Cafe One', website: 'https://example.com' } },
  { type: 'node', id: -9002, lat: 18.5602, lon: 73.7881, tags: { amenity: 'cafe', name: 'QA OSM Brew House' } },
  { type: 'way', id: -9003, center: { lat: 18.5579, lon: 73.7851 }, tags: { amenity: 'restaurant', name: 'QA OSM Thali Corner', cuisine: 'indian' } },
  { type: 'node', id: -9004, lat: 18.5615, lon: 73.7902, tags: { amenity: 'restaurant', name: 'QA OSM Biryani Point' } },
  { type: 'node', id: -9005, lat: 18.5568, lon: 73.7893, tags: { shop: 'bakery', name: 'QA OSM Bakes' } },
  { type: 'node', id: -9006, lat: 18.5623, lon: 73.7844, tags: { amenity: 'fast_food', name: 'QA OSM Vada Pav Stall' } },
]

// Same two-step flow as the portal: the function prepares the query, the client (here: this test
// runner, in the portal: the admin's browser) asks OpenStreetMap, and the function merges the results.
async function overpassClient(query, servers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const url of servers) {
      try {
        const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(45_000) })
        if (res.ok) { const j = await res.json(); if (Array.isArray(j.elements)) return { elements: j.elements, server: new URL(url).hostname } }
      } catch { /* next */ }
    }
  }
  return null
}
async function discover(payload) {
  const prep = await fn(s.admin, 'leads', { action: 'discover', ...payload, prepare_only: true })
  if (prep.status !== 200) return prep
  assert.ok(prep.data.query.includes('around:'), 'query prepared')
  // A re-run must use the same source as the first run (the sandbox's reach to Overpass is intermittent).
  let got = s.osmServer === 'qa-fixture' ? null : await overpassClient(prep.data.query, prep.data.servers)
  if (!got && s.osmServer && s.osmServer !== 'qa-fixture') assert.fail('OpenStreetMap became unreachable between runs')
  if (!got) {
    // This runner can't reach OpenStreetMap (sandbox proxies often can't); the function's merge path is
    // still exercised with a small labelled fixture in Overpass's own format.
    console.log('Overpass unreachable from this runner — using the QA fixture')
    got = { elements: OSM_FIXTURE, server: 'qa-fixture' }
  }
  s.osmServer = got.server
  return await fn(s.admin, 'leads', { action: 'discover', search_id: prep.data.search_id, elements: got.elements, server: got.server })
}

test('real OpenStreetMap search: Baner cafés & restaurants (800 m)', async () => {
  const r = await discover({ locality: 'Baner', city: 'Pune', radius_m: 800, industries: ['cafe', 'restaurant'], name: 'QA Baner food' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  console.log('search:', JSON.stringify(r.data))
  s.search = r.data.search_id
  assert.ok(r.data.found >= 5, 'several places expected')
  const { data: hits } = await s.admin.from('lead_search_hits').select('lead_id').eq('search_id', s.search)
  assert.ok(hits.length >= 5)
  const { data: leads } = await s.admin.from('leads').select('id, osm_ref, sources, website_state, score, lat').in('id', hits.map((h) => h.lead_id))
  assert.ok(leads.every((l) => l.osm_ref && l.sources.includes('osm') && l.lat && l.score != null))
  assert.ok(leads.every((l) => ['none_listed', 'unverified'].includes(l.website_state)), 'websites start unverified/none_listed until checked')
  s.withSite = leads.find((l) => l.website_state === 'unverified')?.id
  const { data: loc } = await s.admin.from('lead_localities').select('lat, lon').ilike('name', 'Baner').single()
  assert.ok(loc.lat > 18.5 && loc.lat < 18.6, 'locality geocode cached')
})

test('re-running the saved search creates no duplicates', async () => {
  const r = await discover({ search_id: s.search })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.created, 0)
  assert.equal(r.data.new_since_last_run, 0)
  assert.ok(r.data.updated >= 5)
})

test('manual lead + CSV import: preview, merge by phone, flag similar names, skip repeats', async () => {
  // Fresh numbers each run: "delete on request" suppressions are permanent, so reused test numbers would be skipped.
  const n = () => String(Math.floor(10_000_000 + Math.random() * 89_999_999))
  s.p1 = `98${n()}`; s.p2 = `97${n()}`; s.dom = `qa-pizzapoint-${n()}.example`
  const add = await fn(s.admin, 'leads', { action: 'add', name: 'QA Pizza Point', locality: 'Wakad', phone: `+91 ${s.p1}`, website: s.dom })
  assert.equal(add.status, 200, JSON.stringify(add.data))
  s.pizza = add.data.lead_id
  const csv = `Business Name,Phone,Area\nQA Pizza Point Wakad,${s.p1},Wakad\nQA Pizza Pointe,,Wakad\nQA Fresh Bakes,${s.p2},Aundh\nQA Fresh Bakes,${s.p2},Aundh\n`
  const mapping = { name: 0, phone: 1, locality: 2 }
  const pre = await fn(s.admin, 'leads', { action: 'import', csv, mapping, dry_run: true })
  assert.equal(pre.status, 200, JSON.stringify(pre.data))
  assert.deepEqual(pre.data.preview.map((p) => [p.action, p.reason, !!p.possible]), [['update', 'phone', false], ['create', 'similar_name_nearby', true], ['create', null, false], ['update', 'phone', false]])
  const done = await fn(s.admin, 'leads', { action: 'import', csv, mapping })
  assert.deepEqual([done.data.created, done.data.updated, done.data.possible], [2, 2, 1])
  const { data: dup } = await s.admin.from('lead_duplicates').select('id, lead_id, other_id').eq('other_id', s.pizza).eq('status', 'open')
  assert.equal(dup.length, 1)
  s.dup = dup[0]
})

test('website check (real fetch from the Edge Function) and audit', async () => {
  if (!s.withSite) return console.log('no OSM lead with a website in this area; skipped')
  const c = await fn(s.admin, 'leads', { action: 'check_website', lead_id: s.withSite })
  assert.equal(c.status, 200, JSON.stringify(c.data))
  assert.ok(['live', 'broken', 'redirects_elsewhere', 'unverified'].includes(c.data.state))
  console.log('website check:', JSON.stringify(c.data))
  await fn(s.admin, 'leads', { action: 'audit_queue', lead_ids: [s.withSite] })
  const a = await fn(s.admin, 'leads', { action: 'audit_next', limit: 1 })
  assert.equal(a.status, 200, JSON.stringify(a.data))
  const { data: audit } = await s.admin.from('lead_audits').select('status, http_status, error, pagespeed').eq('lead_id', s.withSite).order('queued_at', { ascending: false }).limit(1).single()
  console.log('audit:', JSON.stringify({ ...audit, pagespeed: audit.pagespeed && { performance: audit.pagespeed.performance, error: audit.pagespeed.error } }))
  assert.ok(['done', 'skipped'].includes(audit.status))
})

test('merge, do-not-contact, delete on request keeps it out of future imports', async () => {
  const m = await s.admin.rpc('merge_leads', { p_keep: s.pizza, p_drop: s.dup.lead_id })
  assert.ifError(m.error)
  await s.admin.from('leads').update({ do_not_contact: true, dnc_reason: 'QA test' }).eq('id', s.pizza)
  const del = await s.admin.rpc('delete_lead_on_request', { p_lead: s.pizza, p_reason: 'QA test' })
  assert.ifError(del.error)
  assert.ok(del.data >= 2)
  const again = await fn(s.admin, 'leads', { action: 'import', csv: `Name,Phone\nQA Pizza Point,${s.p1}\n`, mapping: { name: 0, phone: 1 }, dry_run: true })
  assert.equal(again.data.preview[0].action, 'skip_suppressed')
})
