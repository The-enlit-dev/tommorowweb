// M5 live tests: owner sets up a menu, employee rings up a sale through the real API with a retry
// (idempotent), UPI must be confirmed by staff, cash change, refunds by owner only, isolation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fn, makeClient, qaEmail, signIn, strongPassword } from './helpers.mjs'

const s = {}
test('setup restaurant with menu and an employee', async () => {
  s.admin = await signIn(process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  s.c = await makeClient(s.admin, { preset: 'restaurant', name: 'QA POS Café' })
  const o = s.c.owner
  const tax = (await o.from('tax_rates').insert({ business_id: s.c.biz, name: 'GST 5%', rate_pct: 5 }).select('id').single()).data
  const p = (await o.from('products').insert({ business_id: s.c.biz, name: 'Idli', tax_rate_id: tax.id, station: 'kitchen' }).select('id').single()).data
  s.idli = (await o.from('product_variants').insert({ product_id: p.id, price: 60, track_stock: true }).select('id').single()).data.id
  assert.ifError((await o.rpc('adjust_stock', { p_variant: s.idli, p_delta: 10, p_reason: 'opening' })).error)
  // Insert or update, as the portal does (an upsert would need UPDATE on business_id, which is not granted).
  const cs = (await o.from('commerce_settings').select('business_id').eq('business_id', s.c.biz).maybeSingle()).data
  const row = { upi_id: 'qacafe@okicici', state_code: '27' }
  assert.ifError((cs ? await o.from('commerce_settings').update(row).eq('business_id', s.c.biz) : await o.from('commerce_settings').insert({ business_id: s.c.biz, ...row })).error)
  const email = qaEmail('waiter')
  const r = await fn(o, 'business-members', { action: 'create_member', business_id: s.c.biz, email, full_name: 'QA Waiter' })
  s.emp = await signIn(email, r.data.temp_password, strongPassword())
})

test('employee sale: retry returns same order; UPI needs staff confirmation', async () => {
  const args = { p_business: s.c.biz, p_items: [{ variant_id: s.idli, qty: 3 }], p_idempotency_key: `qa-${Date.now()}-retry`, p_channel: 'takeaway' }
  const a = await s.emp.rpc('create_order', args)
  const b = await s.emp.rpc('create_order', args)
  assert.ifError(a.error)
  assert.equal(a.data.id, b.data.id)
  assert.equal(Number(a.data.total), 180)
  const pay = await s.emp.rpc('record_payment', { p_order: a.data.id, p_method: 'upi', p_amount: 180, p_idempotency_key: `qa-pay-${Date.now()}` })
  assert.equal(pay.data.status, 'pending')
  const hack = await s.emp.from('payments').update({ status: 'paid' }).eq('id', pay.data.id).select()
  assert.ok(hack.error || !hack.data?.length, 'direct update must not work')
  const ok = await s.emp.rpc('confirm_upi_payment', { p_payment: pay.data.id, p_utr: '123456789012' })
  assert.ifError(ok.error)
  const o = (await s.emp.from('orders').select('payment_status, invoice_no').eq('id', a.data.id).single()).data
  assert.equal(o.payment_status, 'paid')
  assert.match(o.invoice_no, /^INV-\d{5}$/)
  s.order = a.data.id
})

test('refunds need permission; owner can refund and restock', async () => {
  assert.ok((await s.emp.rpc('issue_refund', { p_order: s.order, p_amount: 60, p_reason: 'cold', p_restock: true, p_idempotency_key: `qa-r-${Date.now()}` })).error)
  const r = await s.c.owner.rpc('issue_refund', { p_order: s.order, p_amount: 60, p_reason: 'cold', p_restock: true, p_idempotency_key: `qa-r2-${Date.now()}` })
  assert.ifError(r.error)
  const v = (await s.c.owner.from('product_variants').select('stock').eq('id', s.idli).single()).data
  assert.equal(v.stock, 10, 'all 3 restocked with the refund')
})

test('other businesses see nothing', async () => {
  const other = (await makeClient(s.admin, { preset: 'restaurant', name: 'QA POS Other' })).owner
  assert.equal((await other.from('orders').select('id')).data.length, 0)
  assert.ok((await other.rpc('create_order', { p_business: s.c.biz, p_items: [{ variant_id: s.idli, qty: 1 }], p_idempotency_key: `qa-x-${Date.now()}` })).error)
})
