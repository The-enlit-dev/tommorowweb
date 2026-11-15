// Website fetching against a real local HTTP server: redirects, robots.txt, errors, size caps, links.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { checkLinks, fetchSite, robotsCache, stateOf } from '../../supabase/functions/_shared/site.ts'
import { analyzeHtml, findingsFor } from '../../supabase/functions/_shared/audit.ts'

let a: Server, b: Server, A = '', B = ''
const uas: string[] = []
before(async () => {
  a = createServer((req, res) => {
    uas.push(String(req.headers['user-agent']))
    const html = (body: string) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body) }
    switch (req.url) {
      case '/robots.txt': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('User-agent: *\nDisallow: /private\n')
      case '/': return html(`<html><head><title>Shop</title><meta name="viewport" content="width=device-width"></head><body><nav><a href="/ok">ok</a><a href="/missing">x</a><a href="/private/a">p</a></nav><a href="tel:+919822012345">call</a><h1>Shop</h1></body></html>`)
      case '/ok': return html('<p>fine</p>')
      case '/hop1': res.writeHead(301, { location: '/hop2' }); return res.end()
      case '/hop2': res.writeHead(302, { location: '/' }); return res.end()
      case '/away': res.writeHead(301, { location: `${B}/landing` }); return res.end()
      case '/gone': res.writeHead(500, { 'content-type': 'text/html' }); return res.end('<h1>Error</h1>')
      case '/big': res.writeHead(200, { 'content-type': 'text/html' }); return res.end('x'.repeat(50_000))
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end()
      default: res.writeHead(404, { 'content-type': 'text/html' }); return res.end('not found')
    }
  })
  b = createServer((req, res) => { res.writeHead(req.url === '/robots.txt' ? 404 : 200, { 'content-type': 'text/html' }); res.end('<p>other site</p>') })
  await new Promise<void>((r) => a.listen(0, '127.0.0.1', r))
  await new Promise<void>((r) => b.listen(0, 'localhost', r))
  A = `http://127.0.0.1:${(a.address() as any).port}`
  B = `http://localhost:${(b.address() as any).port}`
  robotsCache.clear()
})
after(() => { a.close(); b.close() })

test('live page: status, timing, identifies itself', async () => {
  const f = await fetchSite(`${A}/`)
  assert.equal(f.error, null)
  assert.equal(f.status, 200)
  assert.match(f.html, /<title>Shop<\/title>/)
  assert.equal(stateOf(f, `${A}/`), 'live')
  assert.ok(uas.every((u) => u.startsWith('TomorrowWebAudit/1.0')))
})

test('redirect chain is traced', async () => {
  const f = await fetchSite(`${A}/hop1`)
  assert.equal(f.status, 200)
  assert.deepEqual(f.redirects, [`${A}/hop2`, `${A}/`])
  assert.equal(stateOf(f, `${A}/hop1`), 'live')
})

test('redirect to another domain → redirects_elsewhere', async () => {
  const f = await fetchSite(`${A}/away`)
  assert.equal(f.finalUrl, `${B}/landing`)
  assert.equal(stateOf(f, `${A}/away`), 'redirects_elsewhere')
})

test('error responses → broken; robots.txt disallow → not fetched (unverified)', async () => {
  assert.equal(stateOf(await fetchSite(`${A}/gone`), `${A}/gone`), 'broken')
  assert.equal(stateOf(await fetchSite(`${A}/nope`), `${A}/nope`), 'broken')
  const blocked = await fetchSite(`${A}/private/page`)
  assert.equal(blocked.error, 'robots')
  assert.equal(blocked.status, undefined)
  assert.equal(stateOf(blocked, `${A}/private/page`), 'unverified')
})

test('unreachable host → unverified (never "no website"); redirect loops stop', async () => {
  const dead = await fetchSite('http://127.0.0.1:1/')
  assert.ok(dead.error)
  assert.equal(stateOf(dead, 'http://127.0.0.1:1/'), 'unverified')
  const loop = await fetchSite(`${A}/loop`)
  assert.equal(loop.error, 'network')
  assert.equal(loop.note, 'Too many redirects')
})

test('body is capped', async () => {
  const f = await fetchSite(`${A}/big`, 10_000)
  assert.ok(f.bytes >= 10_000, 'reports bytes read')
  assert.equal(f.html.length, 10_000, 'HTML kept is capped')
})

test('link check finds broken links and skips robots-disallowed ones; full audit findings', async () => {
  const f = await fetchSite(`${A}/`)
  const an = analyzeHtml(f.html, f.finalUrl)
  assert.deepEqual(an.internalLinks.sort(), [`${A}/missing`, `${A}/ok`, `${A}/private/a`].sort())
  const links = await checkLinks(an.internalLinks)
  assert.deepEqual(links.broken, [{ url: `${A}/missing`, status: 404 }])
  const findings = findingsFor(an, { requestedUrl: `${A}/`, finalUrl: f.finalUrl, status: 200, redirects: [], ms: f.ms, bytes: f.bytes }, { brokenLinks: links.broken, checkedLinks: links.checked })
  const codes = findings.map((x) => x.code)
  assert.ok(codes.includes('no_https') && codes.includes('broken_links') && codes.includes('missing_description'))
  assert.ok(!codes.includes('no_contact_path') && !codes.includes('no_viewport'))
})
