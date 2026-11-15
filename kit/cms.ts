// Tomorrow Web CMS kit — copy this file into a client's Astro site (e.g. src/lib/cms.ts).
// Reads PUBLISHED content and blog posts at build time from the Tomorrow Web platform.
// Needs: the site's public key (portal → Website content → For developers). No secrets.
//
//   import { cms } from '../lib/cms'
//   const c = await cms.content()            // { 'hero.title': { kind: 'text', text: '…' }, … }
//   cms.text(c, 'hero.title', 'Fallback')    // string
//   const posts = await cms.posts()          // published posts, newest first (with bodies)
//
// Rendering Markdown safely: `npm i marked sanitize-html`, then use renderMarkdown() from
// Tomorrow Web's src/lib/markdown.ts (copy it alongside this file).
// If the platform is unreachable the functions return empty data, so builds never fail.

const SUPABASE_URL = 'https://rijxesngcmhpxhoptsck.supabase.co'
const SUPABASE_KEY = 'sb_publishable_z9ilwxZjkoAOQB4p6GljiQ_iRRJK7y1' // public, read-only via RLS
const SITE_KEY = import.meta.env.PUBLIC_TW_SITE_KEY ?? 'PASTE-SITE-KEY'

export interface Block { kind: 'text' | 'richtext' | 'image' | 'link'; text?: string; md?: string; path?: string; alt?: string; href?: string; label?: string }
export interface Post { slug: string; title: string; excerpt?: string; body_md?: string; cover_path?: string; cover_alt?: string; tags: string[]; seo_title?: string; seo_description?: string; published_at: string; updated_at: string }

async function rpc<T>(fn: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' }, body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    })
    if (!r.ok) throw new Error(String(r.status))
    return (await r.json()) as T
  } catch (e) {
    console.warn(`[cms] ${fn} unavailable: ${(e as Error).message}`)
    return fallback
  }
}

let contentCache: Promise<Record<string, Block>> | null = null
let postsCache: Promise<Post[]> | null = null

export const cms = {
  content: () => (contentCache ??= rpc<Record<string, Block>>('site_content', { p_key: SITE_KEY }, {})),
  posts: () => (postsCache ??= rpc<Post[]>('site_posts', { p_key: SITE_KEY, p_limit: 0 }, [])),
  text: (c: Record<string, Block>, key: string, fallback = '') => c[key]?.text ?? c[key]?.md ?? fallback,
  link: (c: Record<string, Block>, key: string, fallback = { href: '#', label: '' }) => (c[key]?.href ? { href: c[key].href!, label: c[key].label ?? '' } : fallback),
  image: (c: Record<string, Block>, key: string) => (c[key]?.path ? { src: cms.mediaUrl(c[key].path!), alt: c[key].alt ?? '' } : null),
  mediaUrl: (path: string) => `${SUPABASE_URL}/storage/v1/object/public/media/${path.split('/').map(encodeURIComponent).join('/')}`,
}
