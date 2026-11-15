import type { APIRoute } from 'astro'
import { business } from '../config/site'
import { getPosts } from '../lib/cms-client'
import { plainText } from '../lib/markdown'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const GET: APIRoute = async ({ site }) => {
  const base = site?.href ?? 'http://localhost:4321/'
  const posts = await getPosts()
  const items = posts
    .map((p) => {
      const url = new URL(`/blog/${p.slug}/`, base).href
      return `<item><title>${esc(p.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><pubDate>${new Date(p.published_at).toUTCString()}</pubDate><description>${esc(p.excerpt || plainText(p.body_md ?? '', 300))}</description></item>`
    })
    .join('')
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(business.name)} — Blog</title><link>${new URL('/blog/', base).href}</link><description>${esc(business.description)}</description><language>en-IN</language>${items}</channel></rss>`
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } })
}
