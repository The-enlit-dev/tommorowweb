// Razorpay webhooks (verify_jwt: false). URL: …/functions/v1/razorpay-webhook?b=<business_id>
// The signature is verified with that business's webhook secret (Vault) before anything happens;
// events are de-duplicated by Razorpay's event id. This is the only way an online payment is
// marked paid. Paid orders with Printify items are then sent to Printify (once).
import { serviceClient, UUID_RE } from '../_shared/util.ts'
import { verifyRazorpayWebhook } from '../_shared/commerce.ts'
import { submitPrintifyOrder } from '../_shared/printify.ts'

const admin = serviceClient()
const reply = (status: number, msg: string) => new Response(JSON.stringify({ status: msg }), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, 'POST only')
  const biz = new URL(req.url).searchParams.get('b') ?? ''
  if (!UUID_RE.test(biz)) return reply(400, 'missing business')
  const raw = await req.text()
  const { data: secrets } = await admin.rpc('svc_store_secrets', { p_business: biz })
  if (!secrets?.razorpay_webhook_secret || !(await verifyRazorpayWebhook(raw, req.headers.get('x-razorpay-signature'), secrets.razorpay_webhook_secret))) {
    console.warn('razorpay webhook: bad signature', biz)
    await admin.from('audit_logs').insert({ action: 'webhook:rejected', business_id: biz, entity: 'razorpay', details: { reason: 'invalid signature' } })
    return reply(401, 'invalid signature')
  }
  let ev: any
  try { ev = JSON.parse(raw) } catch { return reply(400, 'bad json') }
  const eventId = req.headers.get('x-razorpay-event-id') ?? `${ev.event}:${ev.payload?.payment?.entity?.id ?? ev.payload?.order?.entity?.id ?? ev.created_at}`
  const { error: dup } = await admin.from('webhook_events').insert({ provider: 'razorpay', event_id: eventId, business_id: biz })
  if (dup) return reply(200, 'duplicate ignored')

  const pay = ev.payload?.payment?.entity
  const gatewayOrderId = pay?.order_id ?? ev.payload?.order?.entity?.id
  let outcome = 'ignored'
  if ((ev.event === 'payment.captured' || ev.event === 'order.paid') && gatewayOrderId && pay?.id) {
    const fee = typeof pay.fee === 'number' ? pay.fee / 100 : null
    const { data } = await admin.rpc('svc_gateway_paid', { p_gateway_order_id: gatewayOrderId, p_gateway_payment_id: pay.id, p_fee_inr: fee })
    outcome = data?.ok ? (data.already ? 'already paid' : 'paid') : `not matched: ${data?.reason ?? ''}`
    if (data?.ok && data.order_id) {
      const r = await submitPrintifyOrder(admin, data.order_id)
      if ('error' in r) outcome += `; printify: ${r.error}`
    }
  } else if (ev.event === 'payment.failed' && gatewayOrderId) {
    const { data } = await admin.rpc('svc_gateway_failed', { p_gateway_order_id: gatewayOrderId, p_reason: pay?.error_description ?? 'Payment failed' })
    outcome = data?.ok ? 'failed recorded' : 'not matched'
  }
  await admin.from('webhook_events').update({ outcome }).eq('provider', 'razorpay').eq('event_id', eventId)
  return reply(200, outcome)
})
