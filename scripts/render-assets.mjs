/**
 * Renders the social-sharing image and app icons into /public.
 * Requires Playwright with Chromium:  node scripts/render-assets.mjs
 * Edit scripts/og.html or scripts/icon.html, then run this again.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const pub = path.join(here, '..', 'public')
// Uses a local or globally installed Playwright (CommonJS resolution honours NODE_PATH).
const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch()

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await og.goto('file://' + path.join(here, 'og.html'))
await og.evaluate(() => document.fonts.ready)
await og.screenshot({ path: path.join(pub, 'og.png') })

for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.goto('file://' + path.join(here, 'icon.html'))
  await page.screenshot({ path: path.join(pub, name), omitBackground: true })
  await page.close()
}

await browser.close()
console.log('Rendered og.png and icons into public/')
