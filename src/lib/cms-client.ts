// Build-time reader for published CMS content and blog posts (Tomorrow Web's own site).
// Uses the public read-only RPCs; never fails the build — if Supabase is unreachable,
// pages render without posts and a warning is printed.
import { SUPABASE_KEY, SUPABASE_URL } from './supabase-config.js'

/** Public key of Tomorrow Web's own site record (not a secret). */
export const TW_SITE_KEY = 'tw-site-7f3c9a2e5b1d'

export interface Post {
  slug: string
  title: string
  excerpt?: string
  body_md?: string
  cover_path?: string
  cover_alt?: string
  tags: string[]
  seo_title?: string
  seo_description?: string
  published_at: string
  updated_at: string
}

async function rpc<T>(fn: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
    return (await res.json()) as T
  } catch (e) {
    console.warn(`[cms] ${fn} unavailable, building without it: ${(e as Error).message}`)
    return fallback
  }
}

let postsCache: Promise<Post[]> | null = null
/** All published posts with bodies (one request per build). */
export function getPosts(key = TW_SITE_KEY): Promise<Post[]> {
  if (key !== TW_SITE_KEY) return rpc<Post[]>('site_posts', { p_key: key, p_limit: 0 }, [])
  postsCache ??= rpc<Post[]>('site_posts', { p_key: key, p_limit: 0 }, [])
  return postsCache
}

export function getContent(key = TW_SITE_KEY): Promise<Record<string, any>> {
  return rpc<Record<string, any>>('site_content', { p_key: key }, {})
}

export const mediaUrl = (path?: string | null) =>
  path ? `${SUPABASE_URL}/storage/v1/object/public/media/${path.split('/').map(encodeURIComponent).join('/')}` : ''
