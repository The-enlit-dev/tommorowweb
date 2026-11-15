import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mapPrintifyStatus, printifyOrderPayload, safeEqual, shippingFor, toPaise, validateAddress, verifyPrintifyWebhook, verifyRazorpayCheckout, verifyRazorpayWebhook } from '../../supabase/functions/_shared/commerce.ts'

// Expected signatures computed independently with Node's crypto (not our Web Crypto code).
const hmac = (secret: string, msg: string) => createHmac('sha256', secret).update(msg).digest('hex')

test('Razorpay webhook signature', async () => {
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 159800 } } } })
  const sig = hmac('whsec_abc', body)
  assert.equal(await verifyRazorpayWebhook(body, sig, 'whsec_abc'), true)
  assert.equal(await verifyRazorpayWebhook(body, sig.toUpperCase(), 'whsec_abc'), true)
  assert.equal(await verifyRazorpayWebhook(body + ' ', sig, 'whsec_abc'), false, 'tampered body')
  assert.equal(await verifyRazorpayWebhook(body, sig, 'other'), false, 'wrong secret')
  assert.equal(await verifyRazorpayWebhook(body, null, 'whsec_abc'), false)
  assert.equal(await verifyRazorpayWebhook(body, sig, ''), false)
})

test('Razorpay checkout signature', async () => {
  const sig = hmac('key_secret', 'order_9|pay_9')
  assert.equal(await verifyRazorpayCheckout('order_9', 'pay_9', sig, 'key_secret'), true)
  assert.equal(await verifyRazorpayCheckout('order_9', 'pay_8', sig, 'key_secret'), false)
})

test('Printify webhook signature', async () => {
  const body = '{"id":"evt-1","type":"order:shipment:created"}'
  const sig = `sha256=${hmac('pfy_secret', body)}`
  assert.equal(await verifyPrintifyWebhook(body, sig, 'pfy_secret'), true)
  assert.equal(await verifyPrintifyWebhook(body, sig.replace(/.$/, '0'), 'pfy_secret'), sig.endsWith('0'))
  assert.equal(await verifyPrintifyWebhook(body, 'sha256=00', 'pfy_secret'), false)
})

test('shipping, paise, constant-time compare', () => {
  assert.equal(shippingFor(1598, { shipping_flat: 60, free_shipping_above: 1500 }), 0)
  assert.equal(shippingFor(799, { shipping_flat: 60, free_shipping_above: 1500 }), 60)
  assert.equal(shippingFor(799, { shipping_flat: '49.00', free_shipping_above: null }), 49)
  assert.equal(toPaise('1598.50'), 159850)
  assert.equal(toPaise(0.1 + 0.2), 30)
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'ab'), false)
})

test('address validation and Printify payload', () => {
  assert.throws(() => validateAddress({ name: 'A' }), /Please fill in: phone, line1, city, state, pin/)
  assert.throws(() => validateAddress({ name: 'A', phone: '9800000000', line1: 'x', city: 'Pune', state: 'MH', pin: '01100' }), /PIN/)
  const a = validateAddress({ name: 'Asha  Rao', phone: '+91 98000 00009', line1: '12 MG Road', city: 'Pune', state: 'Maharashtra', pin: '411001', email: 'a@x.in' })
  assert.equal(a.phone, '+919800000009')
  const p = printifyOrderPayload('9f1c-uuid', 42, [{ printify_product_id: 'p1', printify_variant_id: 12345, qty: 2 }], a)
  assert.equal(p.external_id, '9f1c-uuid')
  assert.deepEqual(p.line_items, [{ product_id: 'p1', variant_id: 12345, quantity: 2 }])
  assert.deepEqual([p.address_to.first_name, p.address_to.last_name, p.address_to.zip, p.address_to.country], ['Asha', 'Rao', '411001', 'IN'])
  assert.equal(mapPrintifyStatus('in-production'), 'in_production')
  assert.equal(mapPrintifyStatus('fulfilled'), 'shipped')
  assert.equal(mapPrintifyStatus('canceled'), 'cancelled')
  assert.equal(mapPrintifyStatus('has-issues'), 'failed')
})
