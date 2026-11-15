// Live check of the OpenStreetMap discovery path (Nominatim geocoding + Overpass search) using the
// same shared code as the Edge Function. Run: node --test tests/live/osm.test.ts  (needs internet)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromOsm, overpassQuery, planIngest, suppressionKeys } from '../../supabase/functions/_shared/leads.ts'

const UA = 'TomorrowWebLeadFinder/1.0 (lead research tool)'

test('Baner, Pune: geocode, search cafés/restaurants, map and plan', async () => {
  const g = await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q: 'Baner, Pune, India', format: 'jsonv2', limit: '1', countrycodes: 'in' }), { headers: { 'User-Agent': UA } })
  assert.equal(g.status, 200)
  const [place] = await g.json()
  const lat = Number(place.lat), lon = Number(place.lon)
  assert.ok(lat > 18.5 && lat < 18.6 && lon > 73.7 && lon < 73.85, `Baner at ${lat},${lon}`)
  const q = overpassQuery(lat, lon, 800, ['cafe', 'restaurant'])
  const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) })
  assert.equal(r.status, 200, await r.clone().text().then((t) => t.slice(0, 200)))
  const els = (await r.json()).elements as any[]
  const cands = els.map((e) => fromOsm(e, { city: 'Pune', locality: 'Baner' })).filter(Boolean)
  console.log(`found ${els.length} OSM places, ${cands.length} named; with phone: ${cands.filter((c) => c!.contacts.some((x) => x.kind === 'phone')).length}, with website: ${cands.filter((c) => c!.contacts.some((x) => x.kind === 'website')).length}`)
  console.log('sample:', cands.slice(0, 3).map((c) => `${c!.name} [${c!.industry}] ${c!.source_ref}`).join(' | '))
  assert.ok(cands.length >= 5, 'expected several cafés/restaurants in 800 m of Baner')
  assert.ok(cands.every((c) => c!.lat && c!.lon && c!.source_ref && c!.industry))
  const plan = planIngest(cands, [], () => false)
  const again = planIngest(cands, plan.filter((s) => s.action === 'create').map((s) => ({ id: s.tempId!, name: s.candidate.name, locality: s.candidate.locality, lat: s.candidate.lat, lon: s.candidate.lon, osm_ref: s.candidate.source_ref, place_ref: null, domains: [], phones: [] })), () => false)
  assert.ok(again.every((s) => s.action === 'update'), 're-running the same search creates no duplicates')
  assert.ok(suppressionKeys(cands[0]!).some((k) => k.startsWith('osm:')))
})
