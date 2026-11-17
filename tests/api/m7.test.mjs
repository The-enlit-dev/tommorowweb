// M7 live tests (after the pending SQL is applied): store catalogue, checkout through the real
// store-checkout function with origin checks and idempotency, manual-UPI flow, tracking page data,
// webhook signature rejection. Razorpay/Printify calls need the brand's own test keys.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, makeClient, signIn, url, key } from './helpers.mjs'

const ORIGIN = 'https://qa-brand.example.com'
const s = {}
const store = async (body, origin = ORIGIN) => {
  const r = await fetch(`${url}/functions/v1/store-checkout`, { method: 'POST', headers: { apikey: key, 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ site_key: s.site.public_key, ...body }) })
  return { status: r.status, data: await r.json() }
}

test('setup clothing brand with an online product and UPI', async () => {
  s.admin = await signIn(process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  s.c = await makeClient(s.admin, { preset: 'clothing', name: 'QA Brand', siteUrl: ORIGIN })
  const o = s.c.owner
  s.site = (await o.from('sites').select('public_key').single()).data
  const p = (await o.from('products').insert({ business_id: s.c.biz, name: 'QA Tee', online: true, slug: 'qa-tee' }).select('id').single()).data
  s.tee = (await o.from('product_variants').insert({ product_id: p.id, name: 'Black / M', price: 799, track_stock: true }).select('id').single()).data.id
  await o.rpc('adjust_stock', { p_variant: s.tee, p_delta: 3, p_reason: 'opening' })
  // Same as the portal's settings page: insert or update (an upsert would need UPDATE on business_id, which is not granted).
  const cs = (await o.from('commerce_settings').select('business_id').eq('business_id', s.c.biz).maybeSingle()).data
  assert.ifError((cs ? await o.from('commerce_settings').update({ upi_id: 'qabrand@okicici' }).eq('business_id', s.c.biz) : await o.from('commerce_settings').insert({ business_id: s.c.biz, upi_id: 'qabrand@okicici' })).error)
  assert.ifError((await o.from('store_settings').insert({ business_id: s.c.biz, enabled: true, shipping_flat: 60, free_shipping_above: 1500 })).error)
})

test('catalogue is public; checkout only from allowed origins', async () => {
  const cat = await client().rpc('store_catalog', { p_key: s.site.public_key })
  assert.equal(cat.data.products[0].variants[0].price, 799)
  assert.equal((await store({ action: 'checkout' }, 'https://evil.example.com')).status, 403)
})

test('checkout: server totals with shipping, idempotent retry, stock reserved, manual UPI details', async () => {
  const body = { action: 'checkout', idempotency_key: `qa-${Date.now()}-checkout-1`, items: [{ variant_id: s.tee, qty: 1 }], address: { name: 'Asha Rao', phone: '9800000009', line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pin: '411001' } }
  const a = await store(body)
  assert.equal(a.status, 200, JSON.stringify(a.data))
  assert.equal(Number(a.data.total), 859)
  assert.equal(a.data.manual_upi.vpa, 'qabrand@okicici')
  const b = await store(body)
  assert.equal(b.data.order_number, a.data.order_number)
  const t = await store({ action: 'status', token: a.data.tracking_token })
  assert.equal(t.data.status, 'pending_payment')
  assert.ok(!JSON.stringify(t.data).includes('MG Road'))
  const v = (await s.c.owner.from('product_variants').select('stock').eq('id', s.tee).single()).data
  assert.equal(v.stock, 2)
})

test('webhooks with a bad signature are rejected', async () => {
  const r = await fetch(`${url}/functions/v1/razorpay-webhook?b=${s.c.biz}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' }, body: '{"event":"payment.captured"}' })
  assert.equal(r.status, 401)
  const p = await fetch(`${url}/functions/v1/printify-webhook?b=${s.c.biz}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pfy-signature': 'sha256=00' }, body: '{}' })
  assert.equal(p.status, 401)
})
