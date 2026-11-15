// Lead Finder core: industries → OpenStreetMap tags, source mapping (OSM, Google Places, CSV),
// normalisation and duplicate keys, matching, and the transparent opportunity score.
// Pure TypeScript (no Deno/npm imports) so Node unit tests and the Edge Function share it.

// ── Industries ────────────────────────────────────────────────────────────
export interface Industry {
  key: string
  label: string
  /** OSM tag filters: [key, values]. A place matches if any filter matches. */
  osm: [string, string[]][]
  /** Industries Tomorrow Web builds for (adds "industry fit" points). */
  fit: boolean
  /** Text Search phrase for Google Places. */
  places: string
}

export const INDUSTRIES: Industry[] = [
  { key: 'restaurant', label: 'Restaurants', osm: [['amenity', ['restaurant', 'fast_food', 'food_court']]], fit: true, places: 'restaurant' },
  { key: 'cafe', label: 'Cafés & bakeries', osm: [['amenity', ['cafe', 'ice_cream']], ['shop', ['bakery', 'confectionery', 'pastry']]], fit: true, places: 'cafe' },
  { key: 'salon', label: 'Salons & beauty', osm: [['shop', ['hairdresser', 'beauty', 'cosmetics', 'massage']], ['amenity', ['spa']]], fit: true, places: 'beauty salon' },
  { key: 'clothing', label: 'Clothing & boutiques', osm: [['shop', ['clothes', 'boutique', 'fashion', 'shoes', 'tailor', 'fabric']]], fit: true, places: 'clothing store' },
  { key: 'fitness', label: 'Gyms & fitness', osm: [['leisure', ['fitness_centre', 'sports_centre', 'dance', 'swimming_pool']], ['sport', ['yoga']]], fit: true, places: 'gym' },
  { key: 'education', label: 'Tutors & coaching', osm: [['amenity', ['language_school', 'music_school', 'driving_school', 'prep_school', 'training', 'dancing_school']], ['office', ['educational_institution', 'tutoring']]], fit: true, places: 'coaching classes' },
  { key: 'health', label: 'Clinics & dentists', osm: [['amenity', ['clinic', 'dentist', 'doctors', 'veterinary']], ['healthcare', ['physiotherapist', 'optometrist', 'psychotherapist']]], fit: true, places: 'clinic' },
  { key: 'hotel', label: 'Hotels & stays', osm: [['tourism', ['hotel', 'guest_house', 'hostel', 'apartment']]], fit: true, places: 'hotel' },
  { key: 'retail', label: 'Other shops', osm: [['shop', ['jewelry', 'florist', 'gift', 'optician', 'furniture', 'electronics', 'mobile_phone', 'books', 'stationery', 'pet', 'sports', 'toys', 'interior_decoration', 'houseware']]], fit: false, places: 'shop' },
  { key: 'services', label: 'Local services', osm: [['shop', ['car_repair', 'laundry', 'dry_cleaning', 'photo', 'travel_agency', 'copyshop']], ['office', ['estate_agent', 'architect', 'lawyer', 'accountant', 'insurance', 'travel_agent']]], fit: false, places: 'services' },
]
export const industryByKey = (k: string) => INDUSTRIES.find((i) => i.key === k)

/** Pune & Pimpri-Chinchwad first; any locality or city can be typed in the portal. */
export const PUNE_LOCALITIES = [
  'Aundh', 'Baner', 'Balewadi', 'Pashan', 'Wakad', 'Hinjawadi', 'Pimple Saudagar', 'Pimple Nilakh', 'Kothrud', 'Karve Nagar',
  'Erandwane', 'Deccan Gymkhana', 'Shivajinagar', 'Model Colony', 'Viman Nagar', 'Kalyani Nagar', 'Koregaon Park', 'Kharadi',
  'Wagholi', 'Hadapsar', 'Magarpatta', 'Wanowrie', 'Kondhwa', 'NIBM Road', 'Camp', 'Sadashiv Peth', 'Narayan Peth', 'Sinhagad Road',
  'Warje', 'Bavdhan', 'Sus', 'Baner-Balewadi', 'Ravet', 'Akurdi', 'Nigdi', 'Pimpri', 'Chinchwad', 'Bhosari', 'Moshi', 'Chakan',
  'Undri', 'Katraj', 'Bibwewadi', 'Dhanori', 'Vishrantwadi', 'Yerawada', 'Kalyani Nagar', 'Mundhwa', 'Pimple Gurav', 'Sangvi',
].filter((v, i, a) => a.indexOf(v) === i)

// ── Overpass ──────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/[\\"]/g, '\\$&')

export function overpassQuery(lat: number, lon: number, radiusM: number, industryKeys: string[], limit = 300): string {
  const r = Math.max(100, Math.min(Math.round(radiusM), 5000))
  const parts: string[] = []
  for (const ind of INDUSTRIES.filter((i) => industryKeys.includes(i.key))) {
    for (const [k, vals] of ind.osm) {
      parts.push(`nwr["${esc(k)}"~"^(${vals.map(esc).join('|')})$"]["name"](around:${r},${lat.toFixed(6)},${lon.toFixed(6)});`)
    }
  }
  if (!parts.length) throw new Error('Choose at least one industry')
  return `[out:json][timeout:25];(${parts.join('')});out center tags ${limit};`
}

/** Which industry an OSM tag set belongs to (first match in INDUSTRIES order). */
export function industryOfTags(tags: Record<string, string>): string | null {
  for (const ind of INDUSTRIES) {
    for (const [k, vals] of ind.osm) {
      const v = tags[k]
      if (v && v.split(';').some((x) => vals.includes(x.trim()))) return ind.key
    }
  }
  return null
}

// ── Normalisation ─────────────────────────────────────────────────────────
/**
 * Indian phone numbers → E.164 (+91XXXXXXXXXX). Handles +91 / 91 / 0 prefixes, spaces, dashes,
 * brackets. Toll-free 1800/1860 numbers are kept as "tf:<digits>". Returns null if not a valid number.
 */
export function normalizePhoneIN(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = String(raw).replace(/[^\d+]/g, '')
  if (!d) return null
  if (d.startsWith('+')) {
    if (!d.startsWith('+91')) return /^\+\d{8,15}$/.test(d) ? d : null // foreign number, keep as-is
    d = d.slice(3)
  } else if (d.startsWith('0091')) d = d.slice(4)
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  if (/^(1800|1860)\d{6,7}$/.test(d)) return `tf:${d}`
  if (/^0(1800|1860)\d{6,7}$/.test(d)) return `tf:${d.slice(1)}`
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (!/^[2-9]\d{9}$/.test(d)) return null
  return `+91${d}`
}

export function splitPhones(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out = String(raw).split(/[;,/]|\s{2,}|\bor\b/i).map(normalizePhoneIN).filter((x): x is string => !!x)
  return [...new Set(out)]
}

export const isMobileIN = (e164: string) => /^\+91[6-9]\d{9}$/.test(e164)

/** Hosts that are social profiles, marketplaces or directories — not the business's own website. */
const SOCIAL_HOSTS = [
  'facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'youtube.com', 'youtu.be', 'wa.me', 'whatsapp.com',
  'linktr.ee', 'google.com', 'goo.gl', 'g.page', 'maps.app.goo.gl', 'zomato.com', 'swiggy.com', 'justdial.com', 'magicpin.in', 'eazydiner.com',
  'tripadvisor.com', 'tripadvisor.in', 'booking.com', 'makemytrip.com', 'goibibo.com', 'practo.com', 'urbancompany.com', 'sulekha.com',
  'indiamart.com', 'dineout.co.in', 'pinterest.com', 'tiktok.com', 'threads.net', 'telegram.me', 't.me', 'bit.ly', 'wix.com', 'wordpress.com',
]

export function hostOf(url: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`)
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null
    return u.hostname.toLowerCase().replace(/^www\d?\./, '').replace(/\.$/, '')
  } catch {
    return null
  }
}

/** Registrable-ish domain: last two labels, or three for known two-part suffixes (co.in, org.in…). */
export function siteDomain(host: string): string {
  const parts = host.split('.')
  const two = ['co.in', 'org.in', 'net.in', 'gen.in', 'firm.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in', 'co.uk', 'com.au']
  return parts.length > 2 && two.includes(parts.slice(-2).join('.')) ? parts.slice(-3).join('.') : parts.slice(-2).join('.')
}

export function isSocialHost(host: string) {
  return SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`))
}

export type UrlKind = { kind: 'website' | 'social'; url: string; domain: string }
export function classifyUrl(raw: string | null | undefined): UrlKind | null {
  if (!raw) return null
  const host = hostOf(raw)
  if (!host) return null
  const url = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`
  return isSocialHost(host) ? { kind: 'social', url, domain: siteDomain(host) } : { kind: 'website', url, domain: host }
}

/** host/path key for social profile links, e.g. instagram.com/cafe_x */
export function socialKey(url: string): string {
  const u = new URL(url)
  return `${u.hostname.toLowerCase().replace(/^(www|m)\./, '')}${u.pathname.replace(/\/+$/, '').toLowerCase()}`
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  const e = String(raw ?? '').trim().toLowerCase().replace(/^mailto:/, '')
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null
}

const STOP = new Set(['the', 'and', 'pvt', 'private', 'ltd', 'limited', 'llp', 'co', 'company', 'india', 'pune', 'shop', 'store', 'a', 'of', 'by', 'n'])
export function nameKey(name: string): string {
  return (name ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9ऀ-ॿ]+/g, ' ')
    .split(' ').filter((t) => t && !STOP.has(t)).join(' ').trim()
}

const GENERIC = new Set(['restaurant', 'restro', 'cafe', 'coffee', 'hotel', 'salon', 'studio', 'bakery', 'bakers', 'kitchen', 'bar', 'clinic',
  'centre', 'center', 'academy', 'classes', 'gym', 'fitness', 'boutique', 'collection', 'fashion', 'foods', 'food', 'family', 'beauty', 'spa', 'house'])

function bigrams(s: string) {
  const t = s.replace(/\s+/g, '')
  const out = new Map<string, number>()
  for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) ?? 0) + 1)
  return out
}
/** 0..1 similarity of two names (Dice on character bigrams, or token containment). */
export function nameSimilarity(a: string, b: string): number {
  const ka = nameKey(a), kb = nameKey(b)
  if (!ka || !kb) return 0
  if (ka === kb) return 1
  const A = bigrams(ka), B = bigrams(kb)
  let inter = 0, sa = 0, sb = 0
  for (const v of A.values()) sa += v
  for (const v of B.values()) sb += v
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0)
  const dice = sa + sb ? (2 * inter) / (sa + sb) : 0
  const ta = new Set(ka.split(' ')), tb = new Set(kb.split(' '))
  const small = ta.size <= tb.size ? ta : tb, big = small === ta ? tb : ta
  // "Vaishali" vs "Vaishali Restaurant": all distinctive words of the shorter name appear in the longer.
  const distinctive = [...small].filter((t) => !GENERIC.has(t))
  const contained = distinctive.length && distinctive.every((t) => big.has(t)) && distinctive.join('').length >= 5
    ? (distinctive.length >= 2 ? 0.9 : 0.85) : 0
  return Math.max(dice, contained)
}

export function distanceM(a: { lat?: number | null; lon?: number | null }, b: { lat?: number | null; lon?: number | null }): number | null {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return null
  const R = 6371000, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

// ── Candidates from sources ──────────────────────────────────────────────
export interface ContactInput {
  kind: 'phone' | 'email' | 'website' | 'social' | 'whatsapp'
  value: string
  value_norm: string
}
export interface Candidate {
  source: 'osm' | 'google_places' | 'csv' | 'manual'
  source_ref: string | null
  name: string
  industry: string | null
  category: string | null
  city: string | null
  locality: string | null
  address: string | null
  lat: number | null
  lon: number | null
  contacts: ContactInput[]
  extra?: Record<string, unknown>
}

export function contactsFrom(input: { phones?: (string | null | undefined)[]; emails?: (string | null | undefined)[]; urls?: (string | null | undefined)[] }): ContactInput[] {
  const out: ContactInput[] = []
  const add = (c: ContactInput) => { if (!out.some((x) => x.kind === c.kind && x.value_norm === c.value_norm)) out.push(c) }
  for (const raw of input.phones ?? []) for (const p of splitPhones(raw)) add({ kind: 'phone', value: p, value_norm: p })
  for (const raw of input.emails ?? []) for (const part of String(raw ?? '').split(/[;,\s]+/)) { const e = normalizeEmail(part); if (e) add({ kind: 'email', value: e, value_norm: e }) }
  for (const raw of input.urls ?? []) {
    for (const part of String(raw ?? '').split(/[;\s]+/)) {
      const c = classifyUrl(part)
      if (!c) continue
      if (c.kind === 'website') add({ kind: 'website', value: c.url, value_norm: c.domain })
      else if (/wa\.me|whatsapp/.test(c.url)) { const p = normalizePhoneIN(c.url.replace(/\D/g, '').slice(-12)); if (p) add({ kind: 'whatsapp', value: p, value_norm: p }) }
      else add({ kind: 'social', value: c.url, value_norm: socialKey(c.url) })
    }
  }
  return out
}

export function fromOsm(el: any, fallback: { city?: string | null; locality?: string | null } = {}): Candidate | null {
  const t: Record<string, string> = el?.tags ?? {}
  const name = (t.name ?? t['name:en'] ?? '').trim()
  if (!name) return null
  const lat = typeof el.lat === 'number' ? el.lat : el.center?.lat ?? null
  const lon = typeof el.lon === 'number' ? el.lon : el.center?.lon ?? null
  const industry = industryOfTags(t)
  const addr = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'] ?? t['addr:neighbourhood'], t['addr:city'], t['addr:postcode']].filter(Boolean).join(', ')
  return {
    source: 'osm',
    source_ref: `${el.type}/${el.id}`,
    name,
    industry,
    category: t.cuisine ? `${t.amenity ?? t.shop ?? ''} · ${t.cuisine}`.replace(/^ · /, '') : (t.amenity ?? t.shop ?? t.leisure ?? t.tourism ?? t.office ?? t.healthcare ?? null),
    city: t['addr:city'] ?? fallback.city ?? null,
    locality: t['addr:suburb'] ?? t['addr:neighbourhood'] ?? fallback.locality ?? null,
    address: addr || null,
    lat, lon,
    contacts: contactsFrom({
      phones: [t.phone, t['contact:phone'], t.mobile, t['contact:mobile'], t['phone:mobile']],
      emails: [t.email, t['contact:email']],
      urls: [t.website, t['contact:website'], t.url, t['contact:facebook'], t['contact:instagram'], t.facebook, t.instagram, t['contact:whatsapp'] ? `https://wa.me/${t['contact:whatsapp'].replace(/\D/g, '')}` : null],
    }),
    extra: { opening_hours: t.opening_hours ?? null },
  }
}

export function fromPlace(p: any, fallback: { city?: string | null; locality?: string | null; industry?: string | null } = {}): Candidate | null {
  const name = p?.displayName?.text?.trim()
  if (!name || !p.id) return null
  return {
    source: 'google_places',
    source_ref: p.id,
    name,
    industry: fallback.industry ?? null,
    category: p.primaryTypeDisplayName?.text ?? p.primaryType ?? null,
    city: fallback.city ?? null,
    locality: fallback.locality ?? null,
    address: p.formattedAddress ?? null,
    lat: p.location?.latitude ?? null,
    lon: p.location?.longitude ?? null,
    contacts: contactsFrom({ phones: [p.internationalPhoneNumber ?? p.nationalPhoneNumber], urls: [p.websiteUri] }),
    extra: { business_status: p.businessStatus ?? null },
  }
}

// ── CSV ───────────────────────────────────────────────────────────────────
/** RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM). Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = [], cell = '', q = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false }
      else cell += c
    } else if (c === '"' && cell === '') q = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some((x) => x.trim() !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim() !== '')) rows.push(row)
  return rows
}

export const CSV_FIELDS = ['name', 'industry', 'city', 'locality', 'address', 'phone', 'email', 'website', 'contact_person', 'notes', 'social'] as const
export type CsvField = (typeof CSV_FIELDS)[number]

/** Guesses which column holds which field from header names. */
export function guessMapping(headers: string[]): Partial<Record<CsvField, number>> {
  const pats: Record<CsvField, RegExp> = {
    name: /^(business|company|shop|store)?\s*name$|^business$|^company$/i,
    industry: /industry|category|type|sector/i,
    city: /^city|town/i,
    locality: /locality|area|suburb|neighbou?rhood/i,
    address: /address|street/i,
    phone: /phone|mobile|contact\s*no|tel/i,
    email: /e-?mail/i,
    website: /website|url|site|web/i,
    contact_person: /contact\s*(person|name)|owner|person/i,
    notes: /note|comment|remark/i,
    social: /instagram|facebook|social/i,
  }
  const out: Partial<Record<CsvField, number>> = {}
  headers.forEach((h, i) => {
    for (const f of CSV_FIELDS) if (out[f] === undefined && pats[f].test(h.trim())) { out[f] = i; break }
  })
  return out
}

export function fromCsvRow(cells: string[], map: Partial<Record<CsvField, number>>, defaults: { city?: string | null } = {}): Candidate | null {
  const get = (f: CsvField) => (map[f] === undefined ? '' : (cells[map[f]!] ?? '').trim())
  const name = get('name')
  if (!name) return null
  const ind = get('industry').toLowerCase()
  const industry = INDUSTRIES.find((i) => i.key === ind || i.label.toLowerCase().includes(ind) || (ind && ind.includes(i.key)))?.key ?? null
  return {
    source: 'csv', source_ref: null, name: name.slice(0, 200), industry, category: get('industry') || null,
    city: get('city') || defaults.city || null, locality: get('locality') || null, address: get('address') || null, lat: null, lon: null,
    contacts: contactsFrom({ phones: [get('phone')], emails: [get('email')], urls: [get('website'), get('social')] }),
    extra: { contact_person: get('contact_person') || null, notes: get('notes') || null },
  }
}

// ── Matching ──────────────────────────────────────────────────────────────
export interface ExistingLead {
  id: string
  name: string
  locality: string | null
  lat: number | null
  lon: number | null
  osm_ref: string | null
  place_ref: string | null
  domains: string[]
  phones: string[]
}
export type Match =
  | { type: 'same'; id: string; reason: 'source_id' | 'website' | 'phone' | 'name_location' }
  | { type: 'possible'; id: string; reason: 'similar_name_nearby'; similarity: number }
  | { type: 'new' }

const locKey = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '')

export function matchCandidate(c: Candidate, existing: ExistingLead[]): Match {
  const ref = c.source_ref
  if (ref) {
    const hit = existing.find((e) => (c.source === 'osm' ? e.osm_ref === ref : c.source === 'google_places' ? e.place_ref === ref : false))
    if (hit) return { type: 'same', id: hit.id, reason: 'source_id' }
  }
  const domains = c.contacts.filter((x) => x.kind === 'website').map((x) => x.value_norm)
  if (domains.length) {
    const hit = existing.find((e) => e.domains.some((d) => domains.includes(d)))
    if (hit) return { type: 'same', id: hit.id, reason: 'website' }
  }
  const phones = c.contacts.filter((x) => x.kind === 'phone' || x.kind === 'whatsapp').map((x) => x.value_norm)
  if (phones.length) {
    const hit = existing.find((e) => e.phones.some((p) => phones.includes(p)))
    if (hit) return { type: 'same', id: hit.id, reason: 'phone' }
  }
  let best: { id: string; sim: number; near: boolean } | null = null
  for (const e of existing) {
    const d = distanceM(c, e)
    const sameLoc = !!c.locality && locKey(c.locality) === locKey(e.locality)
    const near = (d !== null && d <= 250) || (d === null && sameLoc)
    const nearish = (d !== null && d <= 600) || sameLoc
    if (!nearish) continue
    const sim = nameSimilarity(c.name, e.name)
    if (sim < 0.7) continue
    if (!best || sim > best.sim) best = { id: e.id, sim, near }
  }
  if (best && best.sim >= 0.9 && best.near) return { type: 'same', id: best.id, reason: 'name_location' }
  if (best) return { type: 'possible', id: best.id, reason: 'similar_name_nearby', similarity: Math.round(best.sim * 100) / 100 }
  return { type: 'new' }
}

// ── Opportunity score ─────────────────────────────────────────────────────
export type WebsiteState = 'none_listed' | 'unverified' | 'broken' | 'live' | 'redirects_elsewhere'
export interface ScoreInput {
  website_state: WebsiteState
  industry: string | null
  has_phone: boolean
  has_email: boolean
  findings: { code: string; source: string }[]
  pagespeed_performance?: number | null
}
export interface ScoreReason { points: number; text: string }

export const SCORE_DISCLAIMER = 'An estimate of how much a new or improved website could help — not a sign that the business wants one.'

export function scoreLead(i: ScoreInput): { score: number; reasons: ScoreReason[] } {
  const r: ScoreReason[] = []
  const has = (code: string) => i.findings.some((f) => f.code === code && f.source !== 'ai')
  switch (i.website_state) {
    case 'none_listed': r.push({ points: 35, text: 'No website listed in any source we checked' }); break
    case 'broken': r.push({ points: 30, text: 'Website is listed but broken (error page)' }); break
    case 'redirects_elsewhere': r.push({ points: 15, text: 'Website address redirects to another site' }); break
    case 'unverified': r.push({ points: 5, text: 'Website listed but could not be checked yet' }); break
    case 'live': {
      if (has('no_https')) r.push({ points: 10, text: 'No secure (https) connection' })
      if (has('no_viewport')) r.push({ points: 15, text: 'Not set up for mobile screens' })
      if (i.pagespeed_performance != null && i.pagespeed_performance < 50) r.push({ points: 15, text: `Slow on mobile (PageSpeed ${i.pagespeed_performance}/100)` })
      else if (has('slow_response')) r.push({ points: 8, text: 'Slow server response' })
      if (has('no_contact_path')) r.push({ points: 10, text: 'No phone, email, WhatsApp or form on the homepage' })
      if (has('outdated_copyright')) r.push({ points: 6, text: 'Copyright year looks outdated' })
      if (has('broken_links')) r.push({ points: 6, text: 'Broken internal links' })
      if (has('missing_title') || has('missing_description')) r.push({ points: 4, text: 'Missing basic search (SEO) tags' })
      if (has('heavy_page')) r.push({ points: 4, text: 'Very heavy homepage' })
      break
    }
  }
  const ind = i.industry ? industryByKey(i.industry) : null
  if (ind?.fit) r.push({ points: 10, text: `Industry we build for (${ind.label})` })
  if (i.has_phone || i.has_email) r.push({ points: 10, text: 'Public contact details available' })
  else r.push({ points: -10, text: 'No public phone or email found yet' })
  const score = Math.max(0, Math.min(100, r.reduce((a, x) => a + x.points, 0)))
  return { score, reasons: r }
}
