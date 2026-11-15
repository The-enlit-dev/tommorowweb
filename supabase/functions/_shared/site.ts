// Website fetching for Lead Finder checks and audits: robots.txt-aware, manual redirect tracing,
// size-capped body reads, error classification and internal link checks.
// Uses only fetch/URL/TextDecoder so it runs in Edge Functions and Node tests.
import { AUDIT_UA, isAllowed, parseRobots, websiteState } from './audit.ts'
import type { WebsiteState } from './leads.ts'

export type FetchErr = 'dns' | 'timeout' | 'tls' | 'network' | 'robots'
export interface SiteFetch { error: FetchErr | null; note?: string; status?: number; finalUrl: string; redirects: string[]; ms: number; bytes: number; html: string; contentType?: string }

export const robotsCache = new Map<string, ReturnType<typeof parseRobots> | null>()
export async function robotsFor(origin: string) {
  if (robotsCache.has(origin)) return robotsCache.get(origin)!
  let robots = null
  try {
    const r = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': AUDIT_UA }, signal: AbortSignal.timeout(8000), redirect: 'follow' })
    if (r.ok && (r.headers.get('content-type') ?? '').includes('text')) robots = parseRobots((await r.text()).slice(0, 200_000))
  } catch { /* no robots.txt → allowed */ }
  robotsCache.set(origin, robots)
  return robots
}
export const errKind = (e: unknown): FetchErr => {
  const m = String((e as Error)?.message ?? e).toLowerCase()
  if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' || m.includes('timed out')) return 'timeout'
  if (m.includes('dns') || m.includes('lookup') || m.includes('name or service') || m.includes('no address')) return 'dns'
  if (m.includes('certificate') || m.includes('tls') || m.includes('ssl')) return 'tls'
  return 'network'
}

export async function fetchSite(url: string, maxBytes = 2_000_000): Promise<SiteFetch> {
  const t0 = Date.now()
  let current = /^https?:\/\//i.test(url) ? url : `https://${url}`
  const redirects: string[] = []
  const robots = await robotsFor(new URL(current).origin)
  if (robots && !isAllowed(robots, new URL(current).pathname || '/')) {
    return { error: 'robots', note: 'robots.txt asks automated tools not to check this page', finalUrl: current, redirects, ms: 0, bytes: 0, html: '' }
  }
  try {
    for (let hop = 0; hop < 6; hop++) {
      const r = await fetch(current, { headers: { 'User-Agent': AUDIT_UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        await r.body?.cancel()
        const next = new URL(r.headers.get('location')!, current).href
        redirects.push(next)
        current = next
        continue
      }
      let html = '', bytes = 0
      const ct = r.headers.get('content-type') ?? ''
      if (r.body && /html|xml|text/.test(ct || 'text/html')) {
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        while (bytes < maxBytes) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          html += dec.decode(value, { stream: true })
        }
        await reader.cancel().catch(() => {})
        if (html.length > maxBytes) html = html.slice(0, maxBytes)
      } else await r.body?.cancel()
      return { error: null, status: r.status, finalUrl: current, redirects, ms: Date.now() - t0, bytes, html, contentType: ct }
    }
    return { error: 'network', note: 'Too many redirects', finalUrl: current, redirects, ms: Date.now() - t0, bytes: 0, html: '' }
  } catch (e) {
    // http:// fallback when https fails at the TLS level (many small-business sites still lack https).
    if (current.startsWith('https://') && redirects.length === 0 && ['tls', 'network'].includes(errKind(e))) {
      const alt = await fetchSite(current.replace(/^https:/, 'http:'), maxBytes).catch(() => null)
      if (alt && !alt.error) return alt
    }
    return { error: errKind(e), note: String((e as Error).message ?? e).slice(0, 200), finalUrl: current, redirects, ms: Date.now() - t0, bytes: 0, html: '' }
  }
}

export function stateOf(f: SiteFetch, requested: string): WebsiteState {
  return websiteState({ error: f.error, status: f.status, requestedHost: new URL(/^https?:/.test(requested) ? requested : `https://${requested}`).hostname, finalHost: f.finalUrl ? new URL(f.finalUrl).hostname : undefined })
}
export const NOTES: Record<FetchErr, string> = {
  dns: 'Domain did not resolve (DNS) — could be expired or mistyped; not confirmed as “no website”.',
  timeout: 'Site did not answer in time.',
  tls: 'Secure connection failed (certificate problem).',
  network: 'Could not connect.',
  robots: 'robots.txt asks automated tools not to check this site, so it was not checked.',
}

export async function checkLinks(urls: string[]) {
  const sample = urls.slice(0, 25)
  const broken: { url: string; status: number | string }[] = []
  let i = 0
  const worker = async () => {
    while (i < sample.length) {
      const u = sample[i++]
      try {
        const robots = await robotsFor(new URL(u).origin)
        if (robots && !isAllowed(robots, new URL(u).pathname)) continue
        let r = await fetch(u, { method: 'HEAD', headers: { 'User-Agent': AUDIT_UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) })
        if (r.status === 405 || r.status === 403 || r.status === 501) r = await fetch(u, { headers: { 'User-Agent': AUDIT_UA }, redirect: 'follow', signal: AbortSignal.timeout(8000) })
        await r.body?.cancel()
        if (r.status >= 400) broken.push({ url: u, status: r.status })
      } catch (e) {
        broken.push({ url: u, status: errKind(e) })
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()])
  return { broken, checked: sample.length }
}

