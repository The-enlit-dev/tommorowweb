// Public store checkout for client websites (verify_jwt: false).
//   catalog   — published products (same as the store_catalog RPC)
//   checkout  — validates the cart server-side, creates the order (create_order recalculates
//               prices, discounts, tax and stock), adds shipping, and starts a Razorpay order if
//               the store uses Razorpay. The order is marked paid ONLY by the verified webhook.
//   status    — order status by tracking token (for the "payment received?" poll)
//   find      — order number + phone → tracking link (rate limited)
import { clean, handler, HttpError, json, serviceClient } from '../_shared/util.ts'
import { shippingFor, toPaise, validateAddress } from '../_shared/commerce.ts'

const admin = serviceClient()
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)

async function site(req: Request, key: string) {
  const { data: s } = await admin.from('sites').select('id, business_id, url, allowed_origins').eq('public_key', key).maybeSingle()
  if (!s) throw new HttpError(404, 'Unknown store.')
  const origin = req.headers.get('Origin') ?? ''
  const allowed: string[] = s.allowed_origins?.length ? s.allowed_origins : s.url ? [new URL(s.url).origin] : []
  if (!allowed.includes(origin)) throw new HttpError(403, 'This website is not allowed to use this store.')
  const { data: st } = await admin.from('store_settings').select('*').eq('business_id', s.business_id).maybeSingle()
  const { data: mod } = await admin.from('business_modules').select('enabled').eq('business_id', s.business_id).eq('module_key', 'ecommerce').maybeSingle()
  if (!st?.enabled || !mod?.enabled) throw new HttpError(404, 'This store is not open.')
  return { site: s, settings: st }
}

async function limited(key: string, max: number, ttl: number) {
  const { data } = await admin.rpc('svc_ai_hit', { p_key: key, p_ttl_seconds: ttl })
  return (data ?? 0) > max
}
const ipOf = (req: Request) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'

Deno.serve(handler(async (req, body) => {
  const key = clean(body.site_key, 80)
  switch (body.action) {
    case 'catalog': {
      await site(req, key)
      const { data } = await admin.rpc('store_catalog', { p_key: key })
      return json(data)
    }
    case 'status': {
      const { data } = await admin.rpc('store_track', { p_token: clean(body.token, 40) })
      if (!data) throw new HttpError(404, 'Order not found.')
      return json(data)
    }
    case 'find': {
      const { site: s } = await site(req, key)
      if (await limited(`find:${await sha(ipOf(req))}`, 10, 3600)) throw new HttpError(429, 'Too many attempts. Try again later.')
      const phone = clean(body.phone, 20).replace(/[^\d]/g, '').slice(-10)
      const { data: o } = await admin.from('orders').select('tracking_token, customer_phone').eq('business_id', s.business_id).eq('channel', 'online').eq('number', Number(body.number) || -1).maybeSingle()
      if (!o || !phone || (o.customer_phone ?? '').replace(/[^\d]/g, '').slice(-10) !== phone) throw new HttpError(404, 'No order matches that number and phone.')
      return json({ token: o.tracking_token })
    }
    case 'checkout': {
      const { site: s, settings: st } = await site(req, key)
      if (await limited(`checkout:${s.id}:${await sha(ipOf(req))}`, 15, 3600)) throw new HttpError(429, 'Too many checkout attempts. Try again later.')
      const idem = clean(body.idempotency_key, 100)
      if (idem.length < 16) throw new HttpError(400, 'Missing checkout id.')
      const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50).map((i: any) => ({ variant_id: clean(i?.variant_id, 40), qty: Math.max(1, Math.min(99, Math.floor(Number(i?.qty) || 1))) }))
      if (!items.length) throw new HttpError(400, 'Your cart is empty.')
      let address
      try { address = validateAddress({ ...(body.address as object), name: (body.address as any)?.name ?? (body.customer as any)?.name, phone: (body.address as any)?.phone ?? (body.customer as any)?.phone, email: (body.customer as any)?.email }) } catch (e) { throw new HttpError(400, (e as Error).message) }
      await admin.rpc('expire_unpaid_orders', { p_business: s.business_id })

      // Shipping depends on the discounted subtotal: estimate with server prices, then create_order verifies everything.
      const { data: vars } = await admin.from('product_variants').select('id, price, business_id').in('id', items.map((i) => i.variant_id))
      let sub = items.reduce((a, i) => a + Number(vars?.find((v) => v.id === i.variant_id && v.business_id === s.business_id)?.price ?? 0) * i.qty, 0)
      const code = clean(body.discount_code, 30).toUpperCase()
      if (code) {
        const { data: d } = await admin.from('discounts').select('kind, value').eq('business_id', s.business_id).eq('code', code).eq('active', true).maybeSingle()
        if (d) sub -= Math.min(sub, d.kind === 'percent' ? (sub * Number(d.value)) / 100 : Number(d.value))
      }
      const shipping = shippingFor(sub, st)
      const { data: order, error } = await admin.rpc('create_order', {
        p_business: s.business_id, p_items: items, p_idempotency_key: `web:${idem}`, p_channel: 'online',
        p_customer: { name: address.name, phone: address.phone, email: address.email ?? null }, p_discount_code: code || null,
        p_notes: clean(body.notes, 500) || null, p_device: 'website', p_shipping: shipping, p_shipping_address: address,
      })
      if (error) throw new HttpError(409, error.message)
      const out: Record<string, unknown> = { order_number: order.number, total: order.total, shipping_total: order.shipping_total, tracking_token: order.tracking_token, status: order.status }

      if (st.razorpay_enabled && order.status === 'pending_payment') {
        const { data: existing } = await admin.from('payments').select('gateway_order_id, status').eq('order_id', order.id).eq('method', 'razorpay').eq('status', 'pending').maybeSingle()
        let rzpOrderId = existing?.gateway_order_id
        const { data: secrets } = await admin.rpc('svc_store_secrets', { p_business: s.business_id })
        if (!rzpOrderId) {
          const res = await fetch('https://api.razorpay.com/v1/orders', {
            method: 'POST', signal: AbortSignal.timeout(20_000),
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${btoa(`${secrets.razorpay_key_id}:${secrets.razorpay_secret}`)}` },
            body: JSON.stringify({ amount: toPaise(order.total), currency: 'INR', receipt: `ORD-${order.number}`, notes: { order_id: order.id, business_id: s.business_id } }),
          })
          const r = await res.json().catch(() => ({}))
          if (!res.ok || !r.id) throw new HttpError(502, `Payment provider error: ${r?.error?.description ?? res.status}. Your order is saved — try paying again.`)
          rzpOrderId = r.id
          await admin.from('payments').insert({ business_id: s.business_id, order_id: order.id, method: 'razorpay', amount: order.total, status: 'pending', idempotency_key: `rzp:${order.id}:${rzpOrderId}`, gateway_order_id: rzpOrderId })
        }
        out.razorpay = { key_id: secrets.razorpay_key_id, order_id: rzpOrderId, amount: toPaise(order.total), currency: 'INR', name: st.store_name ?? 'Store', prefill: { name: address.name, email: address.email ?? '', contact: address.phone } }
      } else if (st.manual_upi && order.status === 'pending_payment') {
        const { data: cs } = await admin.from('commerce_settings').select('upi_id, upi_name, unpaid_online_expiry_minutes').eq('business_id', s.business_id).maybeSingle()
        out.manual_upi = cs?.upi_id ? { vpa: cs.upi_id, name: cs.upi_name ?? st.store_name, amount: order.total, note: `Order ${order.number}`, expires_in_minutes: cs.unpaid_online_expiry_minutes } : null
      }
      return json(out)
    }
    default:
      throw new HttpError(400, 'Unknown action.')
  }
}))
