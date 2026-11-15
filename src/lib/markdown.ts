// Markdown → safe HTML for blog posts and rich-text content blocks.
// Used at build time (public blog), in the portal preview and in kit/cms.ts.
// Everything passes through a strict allow-list: no scripts, styles, iframes or event handlers.
import { Marked } from 'marked'
import sanitizeHtml from 'sanitize-html'

const marked = new Marked({ gfm: true, breaks: false, async: false })

export const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [
    'h2', 'h3', 'h4', 'p', 'br', 'hr', 'strong', 'em', 'del', 'blockquote', 'code', 'pre',
    'ul', 'ol', 'li', 'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'rel', 'target'],
    img: ['src', 'alt', 'title', 'width', 'height', 'loading'],
    th: ['align'], td: ['align'], code: ['class'],
  },
  allowedSchemes: ['https', 'http', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['https'] },
  allowProtocolRelative: false,
  // Headings inside a post start at h2 (the page title is the h1).
  transformTags: {
    h1: 'h2',
    a: (tagName, attribs) => {
      const external = /^https?:\/\//i.test(attribs.href ?? '')
      return { tagName, attribs: external ? { ...attribs, rel: 'noopener noreferrer nofollow', target: '_blank' } : attribs }
    },
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
  },
  allowedClasses: { code: [/^language-[a-z0-9+-]+$/] },
  // Images whose src was removed (non-https) are dropped entirely.
  exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
}

export function renderMarkdown(md: string): string {
  const html = marked.parse(md ?? '') as string
  return sanitizeHtml(html, SANITIZE)
}

/** Plain-text excerpt (for meta descriptions and RSS). */
export function plainText(md: string, max = 160): string {
  const text = sanitizeHtml(marked.parse(md ?? '') as string, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** URL-safe slug, matching the database rule ^[a-z0-9]+(-[a-z0-9]+)*$. */
export function slugify(s: string): string {
  return (s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

export const readingMinutes = (md: string) => Math.max(1, Math.round((md ?? '').split(/\s+/).filter(Boolean).length / 200))
