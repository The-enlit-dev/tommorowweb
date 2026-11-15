// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'
import preact from '@astrojs/preact'

/**
 * Canonical URLs, the sitemap and social-preview images need the site's
 * absolute address. Netlify sets `URL` during builds; set SITE_URL to
 * override it (e.g. once a custom domain is connected).
 */
const site = (process.env.SITE_URL || process.env.URL || 'http://localhost:4321').replace(/\/$/, '')

export default defineConfig({
  site,
  trailingSlash: 'always',
  integrations: [
    // Preact powers the private portal only (/portal/**); public pages ship no framework JS.
    preact(),
    sitemap({
      filter: (page) => !/\/(thanks|404|track)\/?$/.test(page) && !page.includes('/portal/'),
    }),
  ],
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
  // Inlining the (small) CSS removes render-blocking requests on first load.
  build: { inlineStylesheets: 'always' },
})
