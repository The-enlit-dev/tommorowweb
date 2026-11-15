import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cartEstimate, changeDue, receiptText, upiLink } from '../../src/portal/pos.ts'

test('cart preview matches the server maths (inclusive GST, % discount)', () => {
  // Same basket as the SQL test: 2 × ₹110 + 1 × ₹42 at 5% GST, WELCOME10 → server: 262 / 26.2 / 11.23 / 235.8
  const e = cartEstimate([{ variant_id: 'a', name: 'Dosa', price: 110, qty: 2, rate: 5 }, { variant_id: 'b', name: 'Coffee', price: 42, qty: 1, rate: 5 }], { includeTax: true, discount: { kind: 'percent', value: 10 } })
  assert.deepEqual(e, { subtotal: 262, discount: 26.2, tax: 11.23, total: 235.8 })
})

test('exclusive tax and fixed discounts', () => {
  const e = cartEstimate([{ variant_id: 'a', name: 'Kurta', price: 999, qty: 1, rate: 12 }], { includeTax: false, discount: { kind: 'amount', value: 100 } })
  assert.deepEqual(e, { subtotal: 999, discount: 100, tax: 107.88, total: 1006.88 })
  assert.equal(cartEstimate([{ variant_id: 'a', name: 'x', price: 50, qty: 1, rate: 0 }], { includeTax: true, discount: { kind: 'amount', value: 500 } }).total, 0)
})

test('UPI link and change', () => {
  const l = upiLink({ vpa: 'cafe@okicici', name: 'Café X', amount: 235.8, note: 'Order 12', ref: 'ORD12' })
  assert.equal(l, 'upi://pay?pa=cafe%40okicici&pn=Caf%C3%A9%20X&am=235.80&cu=INR&tn=Order%2012&tr=ORD12')
  assert.equal(changeDue(84, 100), 16)
  assert.equal(changeDue(84, 50), null)
})

test('thermal receipt fits the paper width', () => {
  const t = receiptText({ business: 'Café X', number: 12, created_at: '2026-11-15T08:00:00Z', items: [{ name: 'Masala Dosa with extra chutney', qty: 2, line_total: 220 }], subtotal: 220, discount_total: 0, tax_total: 10.48, total: 220, payments: [{ method: 'upi', amount: 220 }], footer: 'Thank you!' }, 32)
  assert.ok(t.split('\n').every((l) => [...l].length <= 32), t)
  assert.match(t, /TOTAL\s+₹220\.00/)
  assert.match(t, /Paid \(UPI\)/)
})
