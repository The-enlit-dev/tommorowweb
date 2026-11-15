// Store, Razorpay and Printify helpers shared by Edge Functions and unit tests (Web Crypto only).

export function shippingFor(subtotalAfterDiscount: number, s: { shipping_flat: number | string; free_shipping_above?: number | string | null }) {
  const flat = Number(s.shipping_flat ?? 0) || 0
  const free = s.free_shipping_above == null || s.free_shipping_above === '' ? null : Number(s.free_shipping_above)
  return free != null && subtotalAfterDiscount >= free ? 0 : flat
}

export const toPaise = (inr: number | string) => Math.round(Number(inr) * 100)

const enc = new TextEncoder()
async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))), (b) => b.toString(16).padStart(2, '0')).join('')
}
/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Razorpay webhook: X-Razorpay-Signature = hex HMAC-SHA256(raw body, webhook secret). */
export async function verifyRazorpayWebhook(rawBody: string, signature: string | null, secret: string) {
  if (!signature || !secret) return false
  return safeEqual(await hmacHex(secret, rawBody), signature.trim().toLowerCase())
}

/** Razorpay Checkout handler response: hex HMAC-SHA256(order_id + "|" + payment_id, key secret). */
export async function verifyRazorpayCheckout(orderId: string, paymentId: string, signature: string, keySecret: string) {
  return safeEqual(await hmacHex(keySecret, `${orderId}|${paymentId}`), String(signature ?? '').toLowerCase())
}

/** Printify webhook: X-Pfy-Signature = "sha256=" + hex HMAC-SHA256(raw body, webhook secret). */
export async function verifyPrintifyWebhook(rawBody: string, signature: string | null, secret: string) {
  if (!signature || !secret) return false
  const sig = signature.trim().toLowerCase().replace(/^sha256=/, '')
  return safeEqual(await hmacHex(secret, rawBody), sig)
}

export interface ShippingAddress { name: string; phone: string; email?: string; line1: string; line2?: string; city: string; state: string; pin: string; country?: string }

export function validateAddress(a: any): ShippingAddress {
  const s = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
  const out: ShippingAddress = { name: s(a?.name), phone: s(a?.phone, 20).replace(/[^\d+]/g, ''), email: s(a?.email, 200) || undefined, line1: s(a?.line1, 200), line2: s(a?.line2, 200) || undefined, city: s(a?.city, 80), state: s(a?.state, 80), pin: s(a?.pin, 10), country: (s(a?.country, 2) || 'IN').toUpperCase() }
  const missing = (['name', 'phone', 'line1', 'city', 'state', 'pin'] as const).filter((k) => !out[k])
  if (missing.length) throw new Error(`Please fill in: ${missing.join(', ')}`)
  if (out.country === 'IN' && !/^[1-9][0-9]{5}$/.test(out.pin)) throw new Error('Enter a valid 6-digit PIN code')
  if (!/^\+?[0-9]{10,13}$/.test(out.phone)) throw new Error('Enter a valid phone number')
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new Error('Enter a valid email')
  return out
}

/** Printify order payload. external_id = our order id so Printify itself rejects duplicates. */
export function printifyOrderPayload(orderId: string, orderNumber: number, lines: { printify_product_id: string; printify_variant_id: number; qty: number }[], a: ShippingAddress) {
  const [first, ...rest] = a.name.split(/\s+/)
  return {
    external_id: orderId,
    label: `Order ${orderNumber}`,
    line_items: lines.map((l) => ({ product_id: l.printify_product_id, variant_id: l.printify_variant_id, quantity: l.qty })),
    shipping_method: 1,
    send_shipping_notification: false,
    address_to: { first_name: first, last_name: rest.join(' ') || '-', email: a.email ?? '', phone: a.phone, country: a.country ?? 'IN', region: a.state, address1: a.line1, address2: a.line2 ?? '', city: a.city, zip: a.pin },
  }
}

/** Printify order/shipment status → our fulfilment status. */
export function mapPrintifyStatus(s: string | undefined): 'pending' | 'submitted' | 'in_production' | 'shipped' | 'delivered' | 'failed' | 'on_hold' | 'cancelled' {
  switch ((s ?? '').toLowerCase()) {
    case 'pending': case 'on-hold': case 'on_hold': return 'on_hold'
    case 'sending-to-production': case 'sending_to_production': return 'submitted'
    case 'in-production': case 'in_production': return 'in_production'
    case 'fulfilled': case 'partially-fulfilled': case 'shipped': return 'shipped'
    case 'delivered': return 'delivered'
    case 'canceled': case 'cancelled': return 'cancelled'
    case 'has-issues': case 'failed': return 'failed'
    default: return 'submitted'
  }
}
