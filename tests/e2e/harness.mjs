// Shared browser-test harness: built site via `astro preview`, Playwright Chromium through the proxy.
import { createRequire } from 'node:module'
import { execSync, spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
let pw
try { pw = require('playwright') } catch { pw = require(`${execSync('npm root -g').toString().trim()}/playwright`) }

export const PORT = 4329
export const BASE = `http://localhost:${PORT}`
let server, browser

export async function start() {
  try { execSync('npx astro preview stop', { stdio: 'ignore' }) } catch {}
  server = spawn('npx', ['astro', 'preview', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined
  browser = await pw.chromium.launch({ proxy })
}

export async function stop() {
  await browser?.close()
  server?.kill()
  try { execSync('npx astro preview stop', { stdio: 'ignore' }) } catch {}
}

export async function page(viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.error('pageerror', e.message))
  p.on('dialog', (d) => d.accept())
  return p
}

export async function login(p, email, password) {
  await p.goto(`${BASE}/portal/login/`)
  await p.fill('input[name=email]', email)
  await p.fill('input[name=password]', password)
  await p.click('button[type=submit]')
  await p.waitForURL(`${BASE}/portal/`)
}

export const phone = { width: 390, height: 844 }
