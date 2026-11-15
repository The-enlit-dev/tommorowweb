import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyUrl, contactsFrom, distanceM, fromCsvRow, fromOsm, fromPlace, guessMapping, industryOfTags, matchCandidate, nameKey, nameSimilarity,
  normalizeEmail, normalizePhoneIN, overpassQuery, parseCsv, scoreLead, splitPhones, type Candidate, type ExistingLead,
} from '../../supabase/functions/_shared/leads.ts'
import { analyzeHtml, findingsFor, isAllowed, parsePageSpeed, parseRobots, websiteState } from '../../supabase/functions/_shared/audit.ts'

test('Indian phone normalisation', () => {
  for (const [raw, want] of [
    ['+91 98220 12345', '+919822012345'], ['098220-12345', '+919822012345'], ['9822012345', '+919822012345'], ['919822012345', '+919822012345'],
    ['0091 98220 12345', '+919822012345'], ['020 2567 8901', '+912025678901'], ['(020) 25678901', '+912025678901'], ['+91-20-2567-8901', '+912025678901'],
    ['1800 266 1234', 'tf:18002661234'], ['12345', null], ['0000000000', null], ['', null], ['+44 20 7946 0958', '+442079460958'],
  ] as const) assert.equal(normalizePhoneIN(raw), want, raw)
  assert.deepEqual(splitPhones('+91 98220 12345; 020 2567 8901, 98220 12345'), ['+919822012345', '+912025678901'])
})

test('URLs: own websites vs social/directories; emails', () => {
  assert.deepEqual(classifyUrl('www.CafeX.in/menu'), { kind: 'website', url: 'https://www.CafeX.in/menu', domain: 'cafex.in' })
  assert.equal(classifyUrl('https://instagram.com/cafex')!.kind, 'social')
  assert.equal(classifyUrl('https://www.zomato.com/pune/cafe-x')!.kind, 'social')
  assert.equal(classifyUrl('https://m.facebook.com/cafex')!.kind, 'social')
  assert.equal(classifyUrl('not a url'), null)
  assert.equal(normalizeEmail('mailto:Hello@CafeX.in'), 'hello@cafex.in')
  assert.equal(normalizeEmail('bad@'), null)
  const c = contactsFrom({ phones: ['9822012345'], urls: ['https://wa.me/919822012345', 'https://instagram.com/CafeX/', 'cafex.in'] })
  assert.deepEqual(c.map((x) => `${x.kind}:${x.value_norm}`), ['phone:+919822012345', 'whatsapp:+919822012345', 'social:instagram.com/cafex', 'website:cafex.in'])
})

test('names: keys and similarity', () => {
  assert.equal(nameKey('The Café & Bakery Pvt. Ltd.'), 'cafe bakery')
  assert.equal(nameSimilarity('Cafe Goodluck', 'Café Good Luck'), 1)
  assert.ok(nameSimilarity('Vaishali Restaurant', 'Vaishali') >= 0.7)
  assert.ok(nameSimilarity('Blue Tokai Coffee', 'Starbucks') < 0.4)
  assert.equal(distanceM({ lat: 18.5596, lon: 73.7799 }, { lat: 18.5596, lon: 73.7799 }), 0)
  assert.ok(Math.abs(distanceM({ lat: 18.5596, lon: 73.7799 }, { lat: 18.5642, lon: 73.7769 })! - 600) < 50)
})

test('Overpass query and OSM mapping', () => {
  const q = overpassQuery(18.5596, 73.7799, 800, ['cafe', 'salon'])
  assert.match(q, /^\[out:json\]\[timeout:25\];\(/)
  assert.match(q, /nwr\["amenity"~"\^\(cafe\|ice_cream\)\$"\]\["name"\]\(around:800,18\.559600,73\.779900\);/)
  assert.match(q, /"shop"~"\^\(hairdresser\|beauty\|cosmetics\|massage\)\$"/)
  assert.throws(() => overpassQuery(1, 1, 500, []))
  assert.equal(industryOfTags({ amenity: 'cafe' }), 'cafe')
  assert.equal(industryOfTags({ shop: 'clothes;shoes' }), 'clothing')
  const c = fromOsm({ type: 'way', id: 42, center: { lat: 18.56, lon: 73.78 }, tags: { name: 'Café X', amenity: 'cafe', cuisine: 'coffee_shop', 'contact:phone': '+91 98220 12345', website: 'https://cafex.in', 'addr:suburb': 'Baner' } }, { city: 'Pune' })!
  assert.equal(c.source_ref, 'way/42')
  assert.equal(c.lat, 18.56)
  assert.equal(c.industry, 'cafe')
  assert.equal(c.locality, 'Baner')
  assert.equal(c.city, 'Pune')
  assert.deepEqual(c.contacts.map((x) => x.kind), ['phone', 'website'])
  assert.equal(fromOsm({ type: 'node', id: 1, tags: { amenity: 'cafe' } }), null, 'unnamed places skipped')
})

test('Google Places mapping', () => {
  const c = fromPlace({ id: 'ChIJabc', displayName: { text: 'Salon Y' }, formattedAddress: 'Baner, Pune', location: { latitude: 18.5, longitude: 73.8 }, nationalPhoneNumber: '098220 12345', websiteUri: 'http://salony.com/' }, { industry: 'salon' })!
  assert.equal(c.source, 'google_places')
  assert.equal(c.source_ref, 'ChIJabc')
  assert.deepEqual(c.contacts.map((x) => x.value_norm), ['+919822012345', 'salony.com'])
})

test('CSV parsing and mapping', () => {
  const rows = parseCsv('﻿Business Name,Phone,Website,Area,Notes\r\n"Café, X",98220 12345,cafex.in,Baner,"said ""call later"""\nEmpty,,,,\n\n')
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[1], ['Café, X', '98220 12345', 'cafex.in', 'Baner', 'said "call later"'])
  const map = guessMapping(rows[0])
  assert.deepEqual(map, { name: 0, phone: 1, website: 2, locality: 3, notes: 4 })
  const c = fromCsvRow(rows[1], map, { city: 'Pune' })!
  assert.equal(c.name, 'Café, X')
  assert.equal(c.city, 'Pune')
  assert.equal(c.contacts.length, 2)
  assert.equal(fromCsvRow(['', '1'], map), null)
})

test('duplicate matching across sources', () => {
  const existing: ExistingLead[] = [
    { id: 'A', name: 'Café X', locality: 'Baner', lat: 18.56, lon: 73.78, osm_ref: 'way/42', place_ref: null, domains: ['cafex.in'], phones: ['+919822012345'] },
    { id: 'B', name: 'Hair Studio Nine', locality: 'Aundh', lat: 18.558, lon: 73.807, osm_ref: null, place_ref: null, domains: [], phones: [] },
  ]
  const base: Candidate = { source: 'csv', source_ref: null, name: 'Something', industry: null, category: null, city: 'Pune', locality: null, address: null, lat: null, lon: null, contacts: [] }
  assert.deepEqual(matchCandidate({ ...base, source: 'osm', source_ref: 'way/42' }, existing), { type: 'same', id: 'A', reason: 'source_id' })
  assert.deepEqual(matchCandidate({ ...base, contacts: [{ kind: 'website', value: 'https://www.cafex.in', value_norm: 'cafex.in' }] }, existing), { type: 'same', id: 'A', reason: 'website' })
  assert.deepEqual(matchCandidate({ ...base, contacts: [{ kind: 'phone', value: '+919822012345', value_norm: '+919822012345' }] }, existing), { type: 'same', id: 'A', reason: 'phone' })
  assert.deepEqual(matchCandidate({ ...base, name: 'Hair Studio 9', locality: 'Aundh' }, existing).type, 'possible')
  assert.deepEqual(matchCandidate({ ...base, name: 'Hair Studio Nine', lat: 18.5581, lon: 73.8071 }, existing), { type: 'same', id: 'B', reason: 'name_location' })
  assert.deepEqual(matchCandidate({ ...base, name: 'Hair Studio Nine', locality: 'Kothrud', lat: 18.50, lon: 73.81 }, existing), { type: 'new' }, 'same name far away is a different business')
  // No coordinates: an identical name in the same locality merges; a near-identical one is only flagged.
  const noGeo = [{ id: 'P', name: 'Pizza Point', locality: 'Wakad', lat: null, lon: null, osm_ref: null, place_ref: null, domains: [], phones: [] }]
  assert.deepEqual(matchCandidate({ ...base, name: 'Pizza Point', locality: 'Wakad', lat: null, lon: null }, noGeo), { type: 'same', id: 'P', reason: 'name_location' })
  assert.equal(matchCandidate({ ...base, name: 'Pizza Pointe', locality: 'Wakad', lat: null, lon: null }, noGeo).type, 'possible')
})

test('opportunity score is transparent and bounded', () => {
  const none = scoreLead({ website_state: 'none_listed', industry: 'cafe', has_phone: true, has_email: false, findings: [] })
  assert.equal(none.score, 55)
  assert.deepEqual(none.reasons.map((r) => r.points), [35, 10, 10])
  const live = scoreLead({ website_state: 'live', industry: 'retail', has_phone: false, has_email: false, findings: [{ code: 'no_viewport', source: 'check' }, { code: 'no_https', source: 'check' }, { code: 'no_viewport', source: 'ai' }], pagespeed_performance: 32 })
  assert.equal(live.score, 30) // 15 + 10 + 15 - 10
  assert.ok(live.reasons.some((r) => /PageSpeed 32/.test(r.text)))
  const good = scoreLead({ website_state: 'live', industry: null, has_phone: false, has_email: false, findings: [] })
  assert.equal(good.score, 0)
})

test('robots.txt rules (RFC 9309 longest match, specific agent first)', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: BadBot\nDisallow: /\n# comment\nUser-agent: TomorrowWebAudit\nUser-agent: Other\nDisallow: /no-audit$\nDisallow: /*.pdf$')
  assert.equal(isAllowed(r, '/'), true)
  assert.equal(isAllowed(r, '/no-audit'), false)
  assert.equal(isAllowed(r, '/no-audit/more'), true)
  assert.equal(isAllowed(r, '/files/a.pdf'), false)
  assert.equal(isAllowed(r, '/private'), true, 'specific group replaces * group')
  const star = parseRobots('User-agent: *\nDisallow: /private\nAllow: /private/ok\nDisallow:')
  assert.equal(isAllowed(star, '/private/x'), false)
  assert.equal(isAllowed(star, '/private/ok/1'), true)
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /'), '/'), false)
  assert.equal(isAllowed(parseRobots(''), '/anything'), true)
})

const PAGE = `<!doctype html><html lang="en"><head><title>Café X</title>
<meta name="description" content="Coffee in Baner"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://cafex.in/"><script>var a = "<a href='/fake'>";</script></head>
<body><nav><a href="/menu">Menu</a> <a href="/menu#top">Menu</a> <a href="https://instagram.com/cafex">IG</a></nav>
<h1>Café X</h1><img src="/a.jpg" alt="Latte"><img src="http://cdn.cafex.in/b.jpg"><a href="tel:+919822012345">Call</a>
<!-- <a href="/hidden">x</a> --><footer>© 2019 Café X</footer></body></html>`

test('HTML analysis', () => {
  const a = analyzeHtml(PAGE, 'https://cafex.in/')
  assert.equal(a.title, 'Café X')
  assert.equal(a.description, 'Coffee in Baner')
  assert.equal(a.viewport, true)
  assert.equal(a.lang, 'en')
  assert.equal(a.canonical, 'https://cafex.in/')
  assert.equal(a.h1Count, 1)
  assert.deepEqual([a.images, a.imagesWithoutAlt], [2, 1])
  assert.deepEqual(a.internalLinks, ['https://cafex.in/menu'], 'dedupes fragments, ignores scripts/comments')
  assert.equal(a.externalLinks, 1)
  assert.deepEqual(a.tel, ['+919822012345'])
  assert.equal(a.hasNav, true)
  assert.deepEqual(a.mixedContent, ['http://cdn.cafex.in/b.jpg'])
  assert.equal(a.copyrightYear, 2019)
})

test('findings from checks and PageSpeed', () => {
  const a = analyzeHtml('<html><head><title>X</title></head><body><p>Hello</p></body></html>', 'http://x.in/')
  const f = findingsFor(a, { requestedUrl: 'http://x.in', finalUrl: 'http://x.in/', status: 200, redirects: [], ms: 7000, bytes: 1000 }, {
    brokenLinks: [{ url: 'http://x.in/old', status: 404 }], checkedLinks: 5, year: 2026,
    pagespeed: parsePageSpeed({ lighthouseResult: { categories: { performance: { score: 0.31 }, seo: { score: 0.7 }, accessibility: { score: 0.95 }, 'best-practices': { score: 1 } }, audits: { 'largest-contentful-paint': { numericValue: 6400 }, 'cumulative-layout-shift': { numericValue: 0.21 } } } }),
  })
  const codes = f.map((x) => x.code)
  for (const c of ['no_https', 'slow_response', 'no_viewport', 'title_length', 'missing_description', 'no_h1', 'no_contact_path', 'no_nav', 'broken_links', 'ps_slow', 'ps_seo']) assert.ok(codes.includes(c), c)
  assert.equal(f.find((x) => x.code === 'ps_slow')!.source, 'pagespeed')
  assert.match(f.find((x) => x.code === 'ps_slow')!.evidence, /LCP 6\.4 s, CLS 0\.21/)
  assert.ok(!codes.includes('ps_accessibility'))
  assert.equal(parsePageSpeed({}), null)
})

test('website state classification never confuses "unreachable" with "no website"', () => {
  assert.equal(websiteState({ error: 'dns' }), 'unverified')
  assert.equal(websiteState({ error: 'robots', status: 200 }), 'unverified')
  assert.equal(websiteState({ status: 404 }), 'broken')
  assert.equal(websiteState({ status: 503 }), 'broken')
  assert.equal(websiteState({ status: 200, requestedHost: 'cafex.in', finalHost: 'www.cafex.in' }), 'live')
  assert.equal(websiteState({ status: 200, requestedHost: 'cafex.in', finalHost: 'facebook.com' }), 'redirects_elsewhere')
})

test('ingest plan: updates matches, catches repeats within a batch, skips suppressed', async () => {
  const { planIngest, suppressionKeys } = await import('../../supabase/functions/_shared/leads.ts')
  const existing: ExistingLead[] = [{ id: 'A', name: 'Café X', locality: 'Baner', lat: 18.56, lon: 73.78, osm_ref: 'way/42', place_ref: null, domains: [], phones: [] }]
  const mk = (name: string, extra: Partial<Candidate> = {}): Candidate => ({ source: 'csv', source_ref: null, name, industry: null, category: null, city: 'Pune', locality: 'Baner', address: null, lat: null, lon: null, contacts: [], ...extra })
  const phone = (p: string) => [{ kind: 'phone' as const, value: p, value_norm: p }]
  const steps = planIngest([
    mk('Cafe X', { source: 'osm', source_ref: 'way/42', contacts: phone('+919822012345') }),
    mk('Pizza Point', { contacts: phone('+919800000001') }),
    mk('Pizza Point Baner', { contacts: phone('+919800000001') }),
    mk('Gone Salon', { contacts: phone('+919800000002') }),
    null,
    mk('Brand New Bakery', { locality: 'Aundh' }),
  ], existing, (c) => suppressionKeys(c).includes('phone:+919800000002'))
  assert.deepEqual(steps.map((s) => [s.action, s.leadId ?? s.tempId ?? null, s.reason ?? null]), [
    ['update', 'A', 'source_id'],
    ['create', 'new:0', null],
    ['update', 'new:0', 'phone'],
    ['skip_suppressed', null, 'deleted on request'],
    ['skip_invalid', null, 'missing name'],
    ['create', 'new:1', null],
  ])
  assert.deepEqual(suppressionKeys(mk('x', { source: 'osm', source_ref: 'Node/1', contacts: [{ kind: 'website', value: 'https://A.in', value_norm: 'a.in' }] })), ['domain:a.in', 'osm:node/1'])
})
