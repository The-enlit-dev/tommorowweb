// Browser end-to-end test of the M0 portal against the built site (astro preview) and the real
// Supabase project. Run: TW_QA_EMAIL=… TW_QA_PASSWORD=… node --test tests/e2e/portal.e2e.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { qaEmail, strongPassword } from '../api/helpers.mjs'

// Playwright is pre-installed globally in CI images; resolve it from the global root if not local.
const require = createRequire(import.meta.url)
let pw
try { pw = require('playwright') } catch { pw = require(`${execSync('npm root -g').toString().trim()}/playwright`) }
const { chromium } = pw

const PORT = 4329
const BASE = `http://localhost:${PORT}`
let server, browser

before(async () => {
  server = spawn('npx', ['astro', 'preview', '--port', String(PORT)], { stdio: 'ignore' })
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) break } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost' } : undefined
  browser = await chromium.launch({ proxy, args: ['--ignore-certificate-errors-spki-list'] })
})
// Astro 7's preview command runs as a background server; stop it explicitly.
after(async () => { await browser?.close(); server?.kill(); try { execSync('npx astro preview stop', { stdio: 'ignore' }) } catch {} })

async function page(viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.error('pageerror', e.message))
  return p
}

async function login(p, email, password) {
  await p.goto(`${BASE}/portal/login/`)
  await p.fill('input[name=email]', email)
  await p.fill('input[name=password]', password)
  await p.click('button[type=submit]')
}

test('portal pages are noindexed and protected', async () => {
  const p = await page()
  await p.goto(`${BASE}/portal/admin/`)
  await p.waitForURL(/\/portal\/login\/\?next=/)
  assert.equal(await p.getAttribute('meta[name=robots]', 'content'), 'noindex, nofollow')
  const robots = await (await fetch(`${BASE}/robots.txt`)).text()
  assert.match(robots, /Disallow: \/portal\//)
  await p.context().close()
})

test('wrong password shows a clear error', async () => {
  const p = await page()
  await login(p, process.env.TW_QA_EMAIL, 'definitely-wrong-1')
  await p.getByText('That email and password don’t match.').waitFor()
  await p.context().close()
})

test('admin creates a client; client sets password, sees modules, adds staff', async () => {
  const admin = await page()
  await login(admin, process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  await admin.waitForURL(`${BASE}/portal/`)
  await admin.goto(`${BASE}/portal/admin/`)
  await admin.getByRole('heading', { name: 'Admin overview' }).waitFor()
  await admin.getByText('Client businesses').waitFor()

  await admin.goto(`${BASE}/portal/admin/clients/`)
  await admin.getByRole('button', { name: 'New client' }).click()
  const email = qaEmail('e2e-owner')
  const bizName = `QA E2E Café ${Date.now().toString(36)}`
  await admin.fill('input[name=full_name]', 'E2E Owner')
  await admin.fill('input[name=email]', email)
  await admin.fill('input[name=business]', bizName)
  await admin.selectOption('select[name=preset]', 'restaurant')
  await admin.getByRole('button', { name: 'Create client account' }).click()
  const secret = admin.locator('code.p-secret')
  await secret.waitFor({ timeout: 20000 })
  const temp = (await secret.textContent()).trim()
  assert.match(temp, /^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/)
  await admin.locator('.p-table').getByText(bizName).waitFor()
  await admin.context().close()

  const owner = await page({ width: 390, height: 844 })
  await login(owner, email, temp)
  await owner.waitForURL(`${BASE}/portal/password/`)
  const pw = strongPassword()
  await owner.fill('input[name=password]', pw)
  await owner.fill('input[name=confirm]', pw)
  await owner.click('button[type=submit]')
  await owner.waitForURL(`${BASE}/portal/`)
  await owner.getByRole('heading', { name: /Hello, E2E/ }).waitFor()
  // Restaurant preset modules appear as dashboard cards; admin items never do.
  await owner.locator('.p-main').getByText('Point of sale').waitFor()
  assert.equal(await owner.locator('a[href="/portal/admin/"]').count(), 0)
  // Admin pages are refused for clients.
  await owner.goto(`${BASE}/portal/admin/clients/`)
  await owner.locator('.p-notice').first().waitFor()
  assert.equal(await owner.getByRole('button', { name: 'New client' }).count(), 0)

  await owner.goto(`${BASE}/portal/team/`)
  await owner.getByRole('button', { name: 'Add staff member' }).click()
  await owner.fill('.p-modal input[name=full_name]', 'E2E Waiter')
  await owner.fill('.p-modal input[name=email]', qaEmail('e2e-waiter'))
  await owner.getByRole('button', { name: 'Create account' }).click()
  await owner.locator('code.p-secret').waitFor({ timeout: 20000 })
  await owner.getByText('E2E Waiter').waitFor()
  await owner.context().close()
})
