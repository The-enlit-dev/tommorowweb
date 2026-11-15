// Printify API calls (per-brand token from Vault) and idempotent order submission.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { mapPrintifyStatus, printifyOrderPayload, validateAddress } from './commerce.ts'

export const PRINTIFY = 'https://api.printify.com/v1'

export async function pfy(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${PRINTIFY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'TomorrowWeb/1.0', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(25_000),
  })
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = body?.message ?? body?.errors?.reason ?? body?.error ?? text.slice(0, 200)
    throw new Error(`Printify ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`)
  }
  return body
}

/**
 * Sends a paid order's Printify items to Printify exactly once. The fulfilment row is unique per
 * (order, provider) and is claimed atomically, so parallel webhooks or retries can't double-submit;
 * Printify's external_id (our order id) is a second guard.
 */
export async function submitPrintifyOrder(admin: SupabaseClient, orderId: string, opts: { retry?: boolean } = {}) {
  const { data: o } = await admin.from('orders').select('id, business_id, number, payment_status, shipping_address, customer_name, customer_phone, customer_email').eq('id', orderId).single()
  if (!o || o.payment_status !== 'paid') return { skipped: 'not paid' }
  const { data: items } = await admin.from('order_items').select('variant_id, qty').eq('order_id', orderId).eq('fulfilment', 'printify')
  if (!items?.length) return { skipped: 'no Printify items' }
  const { data: maps } = await admin.from('printify_mappings').select('*').in('variant_id', items.map((i) => i.variant_id))
  const { data: secrets } = await admin.rpc('svc_store_secrets', { p_business: o.business_id })
  await admin.from('fulfilment_orders').upsert({ business_id: o.business_id, order_id: orderId, provider: 'printify' }, { onConflict: 'order_id,provider', ignoreDuplicates: true })

  // Claim: only one caller moves pending/failed (or a stale unsent claim) → submitted.
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString()
  let claim = admin.from('fulfilment_orders').update({ status: 'submitted', error: null }).eq('order_id', orderId).eq('provider', 'printify').is('external_id', null)
  claim = opts.retry ? claim.or(`status.in.(pending,failed,on_hold),and(status.eq.submitted,updated_at.lt.${staleBefore})`) : claim.in('status', ['pending'])
  const { data: claimed } = await claim.select('id, attempts')
  if (!claimed?.length) return { skipped: 'already submitted' }
  const row = claimed[0]
  const fail = async (msg: string) => {
    await admin.from('fulfilment_orders').update({ status: 'failed', error: msg.slice(0, 1000), attempts: (row.attempts ?? 0) + 1 }).eq('id', row.id)
    return { error: msg }
  }
  try {
    if (!secrets?.printify_token || !secrets?.printify_shop_id) return await fail('Printify is not connected for this store.')
    const missing = items.filter((i) => !maps?.some((m) => m.variant_id === i.variant_id))
    if (missing.length) return await fail('Some items are not linked to Printify products. Re-import them in the portal.')
    const addr = validateAddress({ ...(o.shipping_address ?? {}), name: o.shipping_address?.name ?? o.customer_name, phone: o.shipping_address?.phone ?? o.customer_phone, email: o.shipping_address?.email ?? o.customer_email })
    const lines = items.map((i) => { const m = maps!.find((x) => x.variant_id === i.variant_id)!; return { printify_product_id: m.printify_product_id, printify_variant_id: Number(m.printify_variant_id), qty: i.qty } })
    const created = await pfy(secrets.printify_token, `/shops/${secrets.printify_shop_id}/orders.json`, { method: 'POST', body: JSON.stringify(printifyOrderPayload(o.id, o.number, lines, addr)) })
    const pid = String(created?.id ?? '')
    if (!pid) return await fail('Printify did not return an order id.')
    await admin.from('fulfilment_orders').update({ external_id: pid, attempts: (row.attempts ?? 0) + 1 }).eq('id', row.id)
    await pfy(secrets.printify_token, `/shops/${secrets.printify_shop_id}/orders/${pid}/send_to_production.json`, { method: 'POST' }).catch(async (e) => {
      await admin.from('fulfilment_orders').update({ status: 'on_hold', error: `Created in Printify but not sent to production: ${(e as Error).message}`.slice(0, 1000) }).eq('id', row.id)
    })
    await refreshPrintifyOrder(admin, o.business_id, pid)
    return { ok: true, printify_order_id: pid }
  } catch (e) {
    return await fail((e as Error).message)
  }
}

/** Pulls status, shipments and costs for one Printify order into our records. */
export async function refreshPrintifyOrder(admin: SupabaseClient, businessId: string, printifyOrderId: string) {
  const { data: secrets } = await admin.rpc('svc_store_secrets', { p_business: businessId })
  const { data: f } = await admin.from('fulfilment_orders').select('*').eq('business_id', businessId).eq('provider', 'printify').eq('external_id', printifyOrderId).maybeSingle()
  if (!f || !secrets?.printify_token) return null
  const po = await pfy(secrets.printify_token, `/shops/${secrets.printify_shop_id}/orders/${printifyOrderId}.json`)
  const ship = (po?.shipments ?? [])[0]
  const status = ship?.delivered_at ? 'delivered' : ship ? 'shipped' : mapPrintifyStatus(po?.status)
  const cents = (n: unknown) => (typeof n === 'number' ? Math.round(n) / 100 : null)
  const patch = {
    status, carrier: ship?.carrier ?? f.carrier, tracking_number: ship?.number ?? f.tracking_number, tracking_url: ship?.url ?? f.tracking_url,
    production_cost: cents(po?.total_price) ?? f.production_cost, shipping_cost: cents(po?.total_shipping) ?? f.shipping_cost, currency: po?.currency ?? f.currency ?? 'USD',
  }
  await admin.from('fulfilment_orders').update(patch).eq('id', f.id)
  for (const [kind, amount] of [['printify_production', patch.production_cost], ['printify_shipping', patch.shipping_cost]] as const) {
    if (amount != null) await admin.from('order_charges').upsert({ business_id: businessId, order_id: f.order_id, kind, amount, currency: patch.currency, source: `printify:${printifyOrderId}` }, { onConflict: 'order_id,kind,source' })
  }
  if (status !== f.status) {
    const msg = { submitted: 'Sent to the print partner', in_production: 'Being printed', shipped: `Shipped${patch.carrier ? ` with ${patch.carrier}` : ''}`, delivered: 'Delivered', on_hold: 'On hold at the print partner', failed: 'Problem with production — the store will contact you', cancelled: 'Fulfilment cancelled', pending: 'Waiting to be sent' }[status]
    await admin.from('order_tracking').insert({ order_id: f.order_id, business_id: businessId, status, message: msg, tracking_url: patch.tracking_url })
  }
  return patch
}
