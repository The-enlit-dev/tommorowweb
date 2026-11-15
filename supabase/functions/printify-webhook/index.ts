// Printify webhooks (verify_jwt: false). URL: …/functions/v1/printify-webhook?b=<business_id>
// Verified with the brand's webhook secret, de-duplicated by event id, then the order's status,
// shipments and costs are refreshed from the Printify API.
import { serviceClient, UUID_RE } from '../_shared/util.ts'
import { verifyPrintifyWebhook } from '../_shared/commerce.ts'
import { refreshPrintifyOrder } from '../_shared/printify.ts'

const admin = serviceClient()
const reply = (status: number, msg: string) => new Response(JSON.stringify({ status: msg }), { status, headers: { 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, 'POST only')
  const biz = new URL(req.url).searchParams.get('b') ?? ''
  if (!UUID_RE.test(biz)) return reply(400, 'missing business')
  const raw = await req.text()
  const { data: secrets } = await admin.rpc('svc_store_secrets', { p_business: biz })
  if (!secrets?.printify_webhook_secret || !(await verifyPrintifyWebhook(raw, req.headers.get('x-pfy-signature'), secrets.printify_webhook_secret))) {
    await admin.from('audit_logs').insert({ action: 'webhook:rejected', business_id: biz, entity: 'printify', details: { reason: 'invalid signature' } })
    return reply(401, 'invalid signature')
  }
  let ev: any
  try { ev = JSON.parse(raw) } catch { return reply(400, 'bad json') }
  const eventId = String(ev.id ?? `${ev.type}:${ev.resource?.id}:${ev.created_at}`)
  const { error: dup } = await admin.from('webhook_events').insert({ provider: 'printify', event_id: eventId, business_id: biz })
  if (dup) return reply(200, 'duplicate ignored')
  let outcome = 'ignored'
  if (String(ev.type ?? '').startsWith('order:') && ev.resource?.id) {
    try {
      const r = await refreshPrintifyOrder(admin, biz, String(ev.resource.id))
      outcome = r ? `status ${r.status}` : 'order not ours'
    } catch (e) {
      outcome = `refresh failed: ${(e as Error).message}`.slice(0, 300)
    }
  }
  await admin.from('webhook_events').update({ outcome }).eq('provider', 'printify').eq('event_id', eventId)
  return reply(200, outcome)
})
