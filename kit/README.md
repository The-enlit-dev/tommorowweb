# Client-site kit

Files to copy into a client's Astro website so it can use the Tomorrow Web platform.

| File | What it does |
| --- | --- |
| `cms.ts` | Reads published content blocks and blog posts at build time (`site_content`, `site_posts`). |

## Setup (CMS + blog)

1. In the portal, admin → client → **Websites**: add the site (URL, allowed origins). Note its **site key**.
2. Switch on the **Content editing** (and **Blog**) modules for the business.
3. In the portal → Website content, add content blocks (admin only): e.g. `hero.title` (text),
   `about.body` (rich text), `hero.image` (image), `cta` (link).
4. Copy `kit/cms.ts` to the client site as `src/lib/cms.ts` and set `PUBLIC_TW_SITE_KEY` in the
   site's Netlify environment variables (or paste the key into the file — it is not secret).
5. Use it in pages: `const c = await cms.content()` then `cms.text(c, 'hero.title', 'Default text')`.
   Always pass a fallback so the page still reads well before anything is published.
6. Create a Netlify **build hook** for the client site and paste it in portal → Website content →
   Automatic publishing. Publishing then rebuilds the site automatically (stored in Vault).

Only published content is ever returned; drafts never leave the portal.
