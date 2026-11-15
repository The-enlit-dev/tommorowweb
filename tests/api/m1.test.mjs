// M1 API tests: change requests (with real Storage attachments), CMS publishing, blog, isolation.
// Run: TW_QA_EMAIL=... TW_QA_PASSWORD=... node --test tests/api/m1.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, fn, makeClient, signIn } from './helpers.mjs'

const QA_EMAIL = process.env.TW_QA_EMAIL
const QA_PASSWORD = process.env.TW_QA_PASSWORD
if (!QA_EMAIL || !QA_PASSWORD) throw new Error('Set TW_QA_EMAIL and TW_QA_PASSWORD')

const s = {}
const png = () => new Blob([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], { type: 'image/png' })

test('setup: admin + two tutor clients with websites', async () => {
  s.admin = await signIn(QA_EMAIL, QA_PASSWORD)
  s.a = await makeClient(s.admin, { preset: 'tutor', name: 'QA Tutor A', siteUrl: 'https://tutor-a.example.com' })
  s.b = await makeClient(s.admin, { preset: 'tutor', name: 'QA Tutor B', siteUrl: 'https://tutor-b.example.com' })
  const { data: site } = await s.a.owner.from('sites').select('id, public_key').single()
  s.siteA = site
  assert.ok(site.public_key)
})

test('client creates a change request; price fields are ignored/refused', async () => {
  const { data, error } = await s.a.owner.from('change_requests').insert({ business_id: s.a.biz, title: 'Update timetable', description: 'New batch at 6pm' }).select('*').single()
  assert.ifError(error)
  assert.equal(data.status, 'submitted')
  s.req = data
  const bad = await s.a.owner.from('change_requests').insert({ business_id: s.a.biz, title: 'Free?', price_inr: 0 })
  assert.ok(bad.error, 'price column must be refused')
})

test('attachment upload follows storage rules', async () => {
  const path = `${s.a.biz}/${s.req.id}/shot.png`
  const up = await s.a.owner.storage.from('attachments').upload(path, png(), { contentType: 'image/png' })
  assert.ifError(up.error)
  const row = await s.a.owner.from('change_request_attachments').insert({ request_id: s.req.id, path, name: 'shot.png', size_bytes: 68, mime: 'image/png' })
  assert.ifError(row.error)
  // Other business cannot upload into A's folder, nor read A's file.
  const evil = await s.b.owner.storage.from('attachments').upload(`${s.a.biz}/${s.req.id}/evil.png`, png(), { contentType: 'image/png' })
  assert.ok(evil.error, 'cross-tenant upload must fail')
  const peek = await s.b.owner.storage.from('attachments').createSignedUrl(path, 60)
  assert.ok(peek.error || !peek.data?.signedUrl, 'cross-tenant read must fail')
  const own = await s.a.owner.storage.from('attachments').createSignedUrl(path, 60)
  assert.ifError(own.error)
  const got = await fetch(own.data.signedUrl)
  assert.equal(got.status, 200)
  // Anonymous can't read private attachments.
  const anon = await client().storage.from('attachments').createSignedUrl(path, 60)
  assert.ok(anon.error)
})

test('admin quotes, client approves, history recorded', async () => {
  const q = await s.admin.from('change_requests').update({ price_inr: 400, status: 'quoted' }).eq('id', s.req.id).select('status').single()
  assert.ifError(q.error)
  assert.equal(q.data.status, 'quoted')
  const b = await s.b.owner.rpc('change_request_action', { p_id: s.req.id, p_action: 'approve' })
  assert.ok(b.error, 'other business cannot approve')
  const a = await s.a.owner.rpc('change_request_action', { p_id: s.req.id, p_action: 'approve' })
  assert.ifError(a.error)
  assert.equal(a.data.status, 'approved')
  const { data: ev } = await s.a.owner.from('change_request_events').select('kind, to_value').eq('request_id', s.req.id).order('id')
  assert.deepEqual(ev.map((e) => `${e.kind}:${e.to_value}`), ['status:submitted', 'status:quoted', 'price:400.00', 'status:approved'])
})

test('internal notes stay internal', async () => {
  await s.admin.from('change_request_comments').insert({ request_id: s.req.id, body: 'internal estimate 30m', internal: true })
  await s.a.owner.from('change_request_comments').insert({ request_id: s.req.id, body: 'Thanks!' })
  const { data } = await s.a.owner.from('change_request_comments').select('body, internal').eq('request_id', s.req.id)
  assert.deepEqual(data.map((c) => c.body), ['Thanks!'])
})

test('CMS: admin defines a block, client edits, publishes through site-publish', async () => {
  const ins = await s.admin.from('content_blocks').insert({ site_id: s.siteA.id, key: 'hero.title', label: 'Hero title', kind: 'text', max_length: 80 })
  assert.ifError(ins.error)
  const upd = await s.a.owner.from('content_blocks').update({ draft: { text: 'Maths tuition in Baner' } }).eq('site_id', s.siteA.id).eq('key', 'hero.title')
  assert.ifError(upd.error)
  const before = await client().rpc('site_content', { p_key: s.siteA.public_key })
  assert.deepEqual(before.data, {})
  const denied = await fn(s.b.owner, 'site-publish', { site_id: s.siteA.id })
  assert.equal(denied.status, 403)
  const r = await fn(s.a.owner, 'site-publish', { site_id: s.siteA.id, scope: 'content' })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.equal(r.data.published, 1)
  assert.equal(r.data.build, 'not_configured')
  const after = await client().rpc('site_content', { p_key: s.siteA.public_key })
  assert.equal(after.data['hero.title'].text, 'Maths tuition in Baner')
})

test('deploy hook is stored in Vault and used by site-publish', async () => {
  const bad = await s.a.owner.rpc('set_site_build_hook', { p_site: s.siteA.id, p_url: 'https://example.com/hook' })
  assert.ok(bad.error)
  // A syntactically valid Netlify hook id that does not exist: Netlify answers 404, which we report.
  const ok = await s.a.owner.rpc('set_site_build_hook', { p_site: s.siteA.id, p_url: 'https://api.netlify.com/build_hooks/000000000000000000000000' })
  assert.ifError(ok.error)
  const { data: site } = await s.a.owner.from('sites').select('build_hook_secret_id').eq('id', s.siteA.id).single()
  assert.ok(site.build_hook_secret_id)
  const leak = await s.a.owner.rpc('svc_site_build_hook', { p_site: s.siteA.id })
  assert.ok(leak.error, 'hook URL must not be readable by clients')
  const r = await fn(s.a.owner, 'site-publish', { site_id: s.siteA.id, scope: 'build' })
  assert.equal(r.status, 200)
  assert.match(r.data.build, /^failed|^triggered/)
  const again = await fn(s.a.owner, 'site-publish', { site_id: s.siteA.id, scope: 'build' })
  assert.equal(again.data.build, 'rate_limited')
  await s.a.owner.rpc('set_site_build_hook', { p_site: s.siteA.id, p_url: '' })
})

test('blog: draft hidden, published visible; media upload rules', async () => {
  const cover = `${s.a.biz}/blog/cover.png`
  const up = await s.a.owner.storage.from('media').upload(cover, png(), { contentType: 'image/png' })
  assert.ifError(up.error)
  const pdf = await s.a.owner.storage.from('media').upload(`${s.a.biz}/blog/x.pdf`, new Blob(['%PDF-1.4'], { type: 'application/pdf' }), { contentType: 'application/pdf' })
  assert.ok(pdf.error, 'non-images refused in media bucket')
  const cross = await s.b.owner.storage.from('media').upload(`${s.a.biz}/blog/evil.png`, png(), { contentType: 'image/png' })
  assert.ok(cross.error, 'cannot upload into another business folder')
  const p = await s.a.owner.from('posts').insert({ site_id: s.siteA.id, slug: 'exam-tips', title: 'Exam tips', body_md: '## Sleep\n\nWell.', cover_path: cover }).select('id').single()
  assert.ifError(p.error)
  assert.equal((await client().rpc('site_posts', { p_key: s.siteA.public_key })).data.length, 0)
  await s.a.owner.from('posts').update({ status: 'published' }).eq('id', p.data.id)
  const list = (await client().rpc('site_posts', { p_key: s.siteA.public_key })).data
  assert.equal(list.length, 1)
  assert.equal(list[0].body_md, undefined)
  const one = (await client().rpc('site_posts', { p_key: s.siteA.public_key, p_slug: 'exam-tips' })).data
  assert.equal(one[0].body_md, '## Sleep\n\nWell.')
  const img = await fetch(`${process.env.SUPABASE_URL ?? 'https://rijxesngcmhpxhoptsck.supabase.co'}/storage/v1/object/public/media/${cover}`)
  assert.equal(img.status, 200)
  // Other business can't see or edit A's posts.
  const { data: seen } = await s.b.owner.from('posts').select('id')
  assert.equal(seen.length, 0)
})
