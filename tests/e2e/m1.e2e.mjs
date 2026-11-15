// M1 browser tests: change request round trip, CMS edit + publish, blog post, on desktop and phone.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeClient, signIn, strongPassword, client } from '../api/helpers.mjs'
import { BASE, login, page, phone, start, stop } from './harness.mjs'

const s = {}
before(async () => {
  await start()
  s.admin = await signIn(process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  const pw = strongPassword()
  s.c = await makeClient(s.admin, { preset: 'tutor', name: 'QA E2E Tutor', siteUrl: 'https://e2e-tutor.example.com' })
  const { data: site } = await s.c.owner.from('sites').select('id, public_key').single()
  s.site = site
  await s.admin.from('content_blocks').insert({ site_id: site.id, key: 'hero.title', label: 'Hero title', kind: 'text', max_length: 80 })
  // Give the owner a known password for the browser.
  await s.c.owner.auth.updateUser({ password: pw })
  s.ownerPw = pw
})
after(stop)

test('client files a change request (phone), admin quotes, client approves', async () => {
  const o = await page(phone)
  await login(o, s.c.email, s.ownerPw)
  await o.goto(`${BASE}/portal/requests/`)
  await o.getByRole('button', { name: 'New request' }).click()
  await o.fill('.p-modal input[name=title]', 'Add the Saturday batch')
  await o.fill('.p-modal textarea[name=description]', 'Saturday 10am, Class 9 maths.')
  await o.getByRole('button', { name: 'Send request' }).click()
  await o.waitForURL(/\/portal\/requests\/view\/\?id=/)
  s.reqUrl = o.url()
  await o.getByText('Tomorrow Web will review this and send a price').waitFor()

  const a = await page()
  await login(a, process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  await a.goto(s.reqUrl)
  await a.getByRole('heading', { name: 'Tomorrow Web controls' }).waitFor()
  await a.fill('input[name=price_inr]', '400')
  await a.selectOption('select[name=status]', 'quoted')
  await a.fill('textarea[name=quote_note]', 'One small edit.')
  await a.getByRole('button', { name: 'Save', exact: true }).click()
  await a.getByText('Saved').first().waitFor()
  await a.context().close()

  await o.reload()
  await o.getByText('One small edit.').waitFor()
  await o.getByRole('button', { name: 'Approve quote' }).click()
  await o.getByText('Quote approved').waitFor()
  await o.locator('.p-badge', { hasText: 'Approved' }).first().waitFor()
  await o.fill('textarea[name=body]', 'Thanks, please go ahead.')
  await o.getByRole('button', { name: 'Send', exact: true }).click()
  await o.getByText('Thanks, please go ahead.').waitFor()
  await o.context().close()
})

test('client edits website text and publishes it', async () => {
  const o = await page()
  await login(o, s.c.email, s.ownerPw)
  await o.goto(`${BASE}/portal/content/`)
  const input = o.getByLabel('Hero title')
  await input.fill('Maths that makes sense')
  await o.getByRole('button', { name: 'Save draft' }).click()
  await o.getByText('Draft saved').waitFor()
  await o.getByRole('button', { name: /Publish 1 change/ }).click()
  await o.getByText(/hasn’t connected automatic publishing|rebuilding/).waitFor()
  const { data } = await client().rpc('site_content', { p_key: s.site.public_key })
  assert.equal(data['hero.title'].text, 'Maths that makes sense')
  await o.context().close()
})

test('client writes and publishes a blog post', async () => {
  const o = await page()
  await login(o, s.c.email, s.ownerPw)
  await o.goto(`${BASE}/portal/blog/`)
  await o.getByRole('link', { name: 'New post' }).click()
  await o.getByLabel('Title', { exact: true }).fill('Five revision habits')
  assert.equal(await o.getByLabel('Web address').inputValue(), 'five-revision-habits')
  await o.getByLabel('Post', { exact: true }).fill('## One\n\nSleep **well**.')
  await o.getByRole('tab', { name: 'Preview' }).click()
  await o.locator('.p-prose strong', { hasText: 'well' }).waitFor()
  await o.getByRole('button', { name: 'Publish' }).click()
  await o.locator('.p-badge', { hasText: 'Published' }).waitFor()
  const { data } = await client().rpc('site_posts', { p_key: s.site.public_key, p_slug: 'five-revision-habits' })
  assert.equal(data[0].title, 'Five revision habits')
  await o.context().close()
})
