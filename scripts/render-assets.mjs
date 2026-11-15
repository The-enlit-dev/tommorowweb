/**
 * Renders the social-sharing image (public/og.png), the favicon (public/favicon.svg)
 * and app icons from the vector logo in src/components/logo-paths.ts.
 * Requires Playwright with Chromium:  node scripts/render-assets.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const pub = path.join(root, 'public')
const src = readFileSync(path.join(root, 'src/components/logo-paths.ts'), 'utf8')
const logo = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1))
const font = pathToFileURL(path.join(root, 'node_modules/@fontsource-variable/doto/files/doto-latin-full-normal.woff2')).href
const mono = pathToFileURL(path.join(root, 'node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2')).href

const svg = (k, attrs = '') =>
  `<svg viewBox="0 0 ${logo[k].w} ${logo[k].h}" ${attrs} fill="currentColor"><path fill-rule="evenodd" d="${logo[k].d}"/></svg>`

// "tw" monogram: the t of "tommorow" and the w of "web", sharing a baseline.
const t = logo.t
const w = logo.w
const gap = 10
const mw = t.w + gap + w.w
const mh = Math.max(t.h, w.h)
const monogram = (size, pad, radius) => {
  const s = (size - pad * 2) / mw
  const ox = pad
  const oy = (size - mh * s) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#050505"/>
  <g fill="#ffffff" transform="translate(${ox.toFixed(2)} ${oy.toFixed(2)}) scale(${s.toFixed(5)})">
    <path fill-rule="evenodd" d="${t.d}" transform="translate(0 ${mh - t.h})"/>
    <path fill-rule="evenodd" d="${w.d}" transform="translate(${t.w + gap} ${mh - w.h})"/>
  </g>
</svg>`
}
writeFileSync(path.join(pub, 'favicon.svg'), monogram(64, 7, 14))

const { chromium } = createRequire(import.meta.url)('playwright')
const browser = await chromium.launch()

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } })
const ogHtml = `<!doctype html><html><head><style>
@font-face{font-family:Doto;src:url(${font}) format('woff2');font-weight:100 900}
@font-face{font-family:Mono;src:url(${mono}) format('woff2')}
html,body{margin:0}
body{width:1200px;height:630px;background:#050505;color:#fff;position:relative;overflow:hidden;font-family:Mono,monospace}
.dots{position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,.22) 1.4px,transparent 1.8px);background-size:34px 34px;
  -webkit-mask-image:radial-gradient(ellipse 90% 90% at 50% 45%,#000 30%,transparent 100%)}
.glow{position:absolute;inset:0;background:radial-gradient(ellipse 50% 60% at 82% 70%,rgba(255,255,255,.12),transparent 70%)}
.orb{position:absolute;right:-70px;bottom:-150px;width:470px;height:470px;border-radius:50%;
  background:radial-gradient(circle at 32% 26%,#fff 0%,#d4d4d4 9%,#8a8a8a 30%,#2a2a2a 58%,#0a0a0a 78%,#000 100%);
  box-shadow:inset -40px -50px 90px rgba(0,0,0,.85),0 0 120px rgba(255,255,255,.12)}
.ring{position:absolute;right:-180px;bottom:-60px;width:690px;height:290px;border:1px solid rgba(255,255,255,.25);border-radius:50%;transform:rotate(-12deg)}
.logo{position:absolute;left:76px;top:92px;width:600px}
.logo svg{width:100%;height:auto;display:block}
.tag{position:absolute;left:78px;top:385px;font-family:Doto;font-weight:900;font-variation-settings:'ROND' 100;font-size:48px;line-height:1.15;
  background:linear-gradient(105deg,#9a9a9a,#fff 30%,#a0a0a0 55%,#fff 80%);-webkit-background-clip:text;color:transparent}
.foot{position:absolute;left:78px;right:78px;bottom:46px;display:flex;justify-content:space-between;font-size:17px;letter-spacing:.08em;text-transform:uppercase;color:#a8a8a8}
</style></head><body>
<div class="dots"></div><div class="glow"></div><div class="ring"></div><div class="orb"></div>
<div class="logo">${svg('stack')}</div>
<div class="tag">Today’s business.<br />Tomorrow’s website.</div>
<div class="foot"><span>Web design &amp; development studio</span></div>
</body></html>`
// Load from a file so the local fonts are allowed to load.
const ogFile = path.join(tmpdir(), `tw-og-${process.pid}.html`)
writeFileSync(ogFile, ogHtml)
await og.goto(pathToFileURL(ogFile).href)
await og.evaluate(() => document.fonts.ready)
await og.waitForTimeout(200)
await og.screenshot({ path: path.join(pub, 'og.png') })
rmSync(ogFile)

for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  const pad = Math.round(size * (size <= 32 ? 0.1 : 0.16))
  await page.setContent(`<style>html,body{margin:0;background:#050505}svg{display:block;width:${size}px;height:${size}px}</style>${monogram(size, pad, size <= 32 ? 6 : 0)}`)
  await page.screenshot({ path: path.join(pub, name) })
  await page.close()
}

await browser.close()
console.log('Rendered og.png, favicon.svg and icons into public/')
