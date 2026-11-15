// Website audit core: robots.txt rules, HTML analysis, PageSpeed parsing and findings.
// Pure TypeScript (regex-based, no DOM) so it runs in Edge Functions and Node unit tests.

export const AUDIT_UA = 'TomorrowWebAudit/1.0 (+website check by Tomorrow Web; respects robots.txt)'
export const AUDIT_UA_TOKEN = 'tomorrowwebaudit'

// ── robots.txt ────────────────────────────────────────────────────────────
interface Rule { allow: boolean; path: string }
export interface Robots { groups: { agents: string[]; rules: Rule[] }[] }

export function parseRobots(txt: string): Robots {
  const groups: Robots['groups'] = []
  let cur: Robots['groups'][number] | null = null
  let lastWasAgent = false
  for (const raw of (txt ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase(), val = m[2].trim()
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur) }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
    } else {
      lastWasAgent = false
      if (!cur) continue
      if (key === 'allow' || key === 'disallow') {
        if (key === 'disallow' && val === '') continue // "Disallow:" = allow all
        cur.rules.push({ allow: key === 'allow', path: val })
      }
    }
  }
  return { groups }
}

function ruleMatch(pattern: string, path: string): number {
  // Returns match length (specificity) or -1. Supports * and $ as in RFC 9309.
  const anchored = pattern.endsWith('$')
  const src = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  const re = new RegExp(`^${src}${anchored ? '$' : ''}`)
  return re.test(path) ? pattern.length : -1
}

export function isAllowed(robots: Robots, path: string, uaToken = AUDIT_UA_TOKEN): boolean {
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a.replace(/\/.*$/, ''))))
  const groups = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'))
  let best: { len: number; allow: boolean } | null = null
  for (const g of groups) {
    for (const r of g.rules) {
      const len = ruleMatch(r.path, path)
      if (len < 0) continue
      if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow }
    }
  }
  return best ? best.allow : true
}

// ── HTML analysis ─────────────────────────────────────────────────────────
export interface HtmlAnalysis {
  title: string | null
  description: string | null
  viewport: boolean
  lang: string | null
  canonical: string | null
  h1Count: number
  images: number
  imagesWithoutAlt: number
  internalLinks: string[]
  externalLinks: number
  tel: string[]
  mailto: string[]
  whatsapp: boolean
  forms: number
  hasNav: boolean
  mixedContent: string[]
  copyrightYear: number | null
  generator: string | null
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? '') : null
}
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? []

function metaContent(html: string, key: string, by: 'name' | 'property' = 'name') {
  for (const t of tags(html, 'meta')) if ((attr(t, by) ?? '').toLowerCase() === key) return attr(t, 'content')
  return null
}

export function analyzeHtml(rawHtml: string, pageUrl: string): HtmlAnalysis {
  // Ignore scripts, styles and comments for text/link analysis.
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[\s\S]*?<\/script>/gi, (m) => (/\bsrc=/.test(m.slice(0, 300)) ? m.slice(0, m.indexOf('>') + 1) : '')).replace(/<style\b[\s\S]*?<\/style>/gi, '')
  const base = new URL(pageUrl)
  const titleM = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)
  const links = tags(html, 'a').map((t) => attr(t, 'href')).filter((h): h is string => !!h)
  const internal = new Set<string>()
  let external = 0
  for (const h of links) {
    if (/^(mailto:|tel:|javascript:|#|data:|sms:)/i.test(h)) continue
    try {
      const u = new URL(h, base)
      if (!/^https?:$/.test(u.protocol)) continue
      u.hash = ''
      if (u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '')) internal.add(u.href)
      else external++
    } catch { /* ignore bad links */ }
  }
  const imgs = tags(html, 'img')
  const text = decode(html.replace(/<[^>]+>/g, ' '))
  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]))
  const mixed = base.protocol === 'https:'
    ? [...new Set([...tags(html, 'img'), ...tags(html, 'script'), ...tags(html, 'iframe'), ...tags(html, 'source'), ...(html.match(/<link\b[^>]*rel=["']?stylesheet[^>]*>/gi) ?? [])]
        .map((t) => attr(t, 'src') ?? attr(t, 'href'))
        .filter((u): u is string => !!u && /^http:\/\//i.test(u)))].slice(0, 10)
    : []
  return {
    title: titleM ? decode(titleM[1]) || null : null,
    description: metaContent(html, 'description') ?? metaContent(html, 'og:description', 'property'),
    viewport: !!metaContent(html, 'viewport') && /width\s*=\s*device-width/i.test(metaContent(html, 'viewport') ?? ''),
    lang: (html.match(/<html\b[^>]*\slang\s*=\s*["']?([a-zA-Z-]+)/i) ?? [])[1] ?? null,
    canonical: (tags(html, 'link').find((t) => (attr(t, 'rel') ?? '').toLowerCase() === 'canonical') && attr(tags(html, 'link').find((t) => (attr(t, 'rel') ?? '').toLowerCase() === 'canonical')!, 'href')) || null,
    h1Count: tags(html, 'h1').length,
    images: imgs.length,
    imagesWithoutAlt: imgs.filter((t) => attr(t, 'alt') === null).length,
    internalLinks: [...internal],
    externalLinks: external,
    tel: [...new Set(links.filter((h) => /^tel:/i.test(h)).map((h) => h.slice(4).trim()))],
    mailto: [...new Set(links.filter((h) => /^mailto:/i.test(h)).map((h) => h.slice(7).split('?')[0].trim()))],
    whatsapp: links.some((h) => /wa\.me\/|api\.whatsapp\.com|whatsapp:\/\//i.test(h)),
    forms: tags(html, 'form').length,
    hasNav: /<nav\b/i.test(html) || /role=["']navigation["']/i.test(html),
    mixedContent: mixed,
    copyrightYear: years.length ? Math.max(...years) : null,
    generator: metaContent(html, 'generator'),
  }
}

// ── PageSpeed ─────────────────────────────────────────────────────────────
export interface PageSpeed { performance: number | null; accessibility: number | null; seo: number | null; best_practices: number | null; lcp_ms: number | null; cls: number | null }

export function parsePageSpeed(json: any): PageSpeed | null {
  const cats = json?.lighthouseResult?.categories
  if (!cats) return null
  const pct = (c: any) => (typeof c?.score === 'number' ? Math.round(c.score * 100) : null)
  const audits = json.lighthouseResult.audits ?? {}
  return {
    performance: pct(cats.performance), accessibility: pct(cats.accessibility), seo: pct(cats.seo), best_practices: pct(cats['best-practices']),
    lcp_ms: typeof audits['largest-contentful-paint']?.numericValue === 'number' ? Math.round(audits['largest-contentful-paint'].numericValue) : null,
    cls: typeof audits['cumulative-layout-shift']?.numericValue === 'number' ? Math.round(audits['cumulative-layout-shift'].numericValue * 1000) / 1000 : null,
  }
}

// ── Findings ──────────────────────────────────────────────────────────────
export interface Finding { source: 'check' | 'pagespeed' | 'ai'; code: string; severity: 'high' | 'medium' | 'low' | 'info'; title: string; evidence: string }

export interface FetchInfo {
  requestedUrl: string
  finalUrl: string
  status: number
  redirects: string[]
  ms: number
  bytes: number
}

export function findingsFor(a: HtmlAnalysis, f: FetchInfo, opts: { brokenLinks?: { url: string; status: number | string }[]; checkedLinks?: number; pagespeed?: PageSpeed | null; year?: number } = {}): Finding[] {
  const out: Finding[] = []
  const add = (code: string, severity: Finding['severity'], title: string, evidence: string, source: Finding['source'] = 'check') => out.push({ source, code, severity, title, evidence })
  const year = opts.year ?? new Date().getFullYear()
  if (!f.finalUrl.startsWith('https://')) add('no_https', 'high', 'No secure https connection', `Final address: ${f.finalUrl}`)
  if (f.redirects.length > 2) add('redirect_chain', 'low', 'Long redirect chain', f.redirects.join(' → '))
  if (f.ms > 3000) add('slow_response', f.ms > 6000 ? 'high' : 'medium', 'Slow server response', `Homepage took ${(f.ms / 1000).toFixed(1)} s to load (HTML only)`)
  if (f.bytes > 1_500_000) add('heavy_page', 'medium', 'Very heavy homepage HTML', `${Math.round(f.bytes / 1024)} KB of HTML`)
  if (!a.viewport) add('no_viewport', 'high', 'Not set up for mobile screens', 'No <meta name="viewport" content="width=device-width"> tag')
  if (!a.title) add('missing_title', 'medium', 'Missing page title', 'No <title> tag')
  else if (a.title.length < 10 || a.title.length > 70) add('title_length', 'low', 'Page title length is off', `“${a.title}” (${a.title.length} characters; 10–70 is typical)`)
  if (!a.description) add('missing_description', 'medium', 'Missing meta description', 'No <meta name="description"> tag')
  if (a.h1Count === 0) add('no_h1', 'low', 'No main heading (H1)', 'No <h1> on the homepage')
  else if (a.h1Count > 1) add('multiple_h1', 'info', 'Several main headings (H1)', `${a.h1Count} <h1> tags`)
  if (!a.canonical) add('no_canonical', 'info', 'No canonical tag', 'No <link rel="canonical">')
  if (a.images > 0 && a.imagesWithoutAlt > 0) add('img_alt', a.imagesWithoutAlt / a.images > 0.5 ? 'medium' : 'low', 'Images without descriptions', `${a.imagesWithoutAlt} of ${a.images} images have no alt text`)
  if (!a.tel.length && !a.mailto.length && !a.whatsapp && !a.forms) add('no_contact_path', 'high', 'No way to contact from the homepage', 'No tap-to-call, email, WhatsApp link or form found')
  else if (!a.tel.length && !a.whatsapp) add('no_tap_to_call', 'low', 'No tap-to-call or WhatsApp link', 'Mobile visitors can’t call or message in one tap')
  if (!a.hasNav) add('no_nav', 'low', 'No clear navigation menu', 'No <nav> element found')
  if (a.mixedContent.length) add('mixed_content', 'medium', 'Insecure (http) files on a secure page', a.mixedContent.slice(0, 3).join(', '))
  if (a.copyrightYear && a.copyrightYear <= year - 2) add('outdated_copyright', 'low', 'Copyright year looks outdated', `© ${a.copyrightYear}`)
  if (opts.brokenLinks?.length) add('broken_links', opts.brokenLinks.length > 2 ? 'medium' : 'low', 'Broken internal links', `${opts.brokenLinks.length} of ${opts.checkedLinks ?? '?'} checked: ${opts.brokenLinks.slice(0, 3).map((b) => `${b.url} (${b.status})`).join(', ')}`)
  const ps = opts.pagespeed
  if (ps) {
    if (ps.performance != null) add(ps.performance < 50 ? 'ps_slow' : ps.performance < 90 ? 'ps_average' : 'ps_fast', ps.performance < 50 ? 'high' : ps.performance < 90 ? 'medium' : 'info', `Mobile performance ${ps.performance}/100`, `Google PageSpeed (mobile). LCP ${ps.lcp_ms != null ? (ps.lcp_ms / 1000).toFixed(1) + ' s' : 'n/a'}, CLS ${ps.cls ?? 'n/a'}`, 'pagespeed')
    if (ps.seo != null && ps.seo < 80) add('ps_seo', 'medium', `Search (SEO) score ${ps.seo}/100`, 'Google PageSpeed (mobile)', 'pagespeed')
    if (ps.accessibility != null && ps.accessibility < 80) add('ps_accessibility', 'medium', `Accessibility score ${ps.accessibility}/100`, 'Google PageSpeed (mobile)', 'pagespeed')
  }
  return out
}

/** Classifies a website check into the Lead Finder website states. */
export function websiteState(r: { error?: 'dns' | 'timeout' | 'tls' | 'network' | 'robots' | null; status?: number; requestedHost?: string; finalHost?: string }): 'live' | 'broken' | 'redirects_elsewhere' | 'unverified' {
  if (r.error) return 'unverified' // couldn't confirm — never treated as "no website"
  if (!r.status) return 'unverified'
  if (r.status >= 400) return 'broken'
  const base = (h?: string) => (h ?? '').replace(/^www\./, '').split('.').slice(-2).join('.')
  if (r.requestedHost && r.finalHost && base(r.requestedHost) !== base(r.finalHost)) return 'redirects_elsewhere'
  return 'live'
}
