// Printify for a clothing brand (verify_jwt: true; owner/admin with settings.manage and the
// printify module). Each brand connects ITS OWN Printify account; the token lives in Vault.
//   connect {business_id, token, shop_id?}   save token, pick shop, register webhooks
//   disconnect {business_id}
//   products {business_id}                   list the shop's products
//   import {business_id, product_id}         create/refresh our product + variants + mappings
//   submit {business_id, order_id}           (re)send a paid order — idempotent
//   refresh {business_id, order_id}          pull latest status/tracking/costs
import { audit, clean, getCaller, handler, HttpError, json, serviceClient, UUID_RE } from '../_shared/util.ts'
import { pfy, refreshPrintifyOrder, submitPrintifyOrder } from '../_shared/printify.ts'

const admin = serviceClient()
const TOPICS = ['order:updated', 'order:sent-to-production', 'order:shipment:created', 'order:shipment:delivered']

Deno.serve(handler(async (req, body) => {
  const caller = await getCaller(req, admin)
  const biz = clean(body.business_id, 40)
  if (!UUID_RE.test(biz)) throw new HttpError(400, 'Missing business.')
  const isAdmin = caller.profile.role === 'admin'
  if (!isAdmin) {
    const { data: mod } = await admin.from('business_modules').select('enabled').eq('business_id', biz).eq('module_key', 'printify').maybeSingle()
    const { data: m } = await admin.from('business_members').select('role, permissions, active').eq('business_id', biz).eq('user_id', caller.profile.id).maybeSingle()
    if (!mod?.enabled || !m?.active || !(m.role === 'owner' || (m.permissions ?? []).includes('settings.manage'))) throw new HttpError(403, 'You don’t have permission to manage Printify for this store.')
  }
  const { data: secrets } = await admin.rpc('svc_store_secrets', { p_business: biz })
  const token = secrets?.printify_token as string | undefined
  const shop = secrets?.printify_shop_id as string | undefined

  switch (body.action) {
    case 'connect': {
      const t = clean(body.token, 2000)
      if (t.length < 20) throw new HttpError(400, 'Paste the Printify API token.')
      const shops = (await pfy(t, '/shops.json')) as any[]
      const wanted = clean(body.shop_id, 20)
      const chosen = wanted ? shops.find((x) => String(x.id) === wanted) : shops.length === 1 ? shops[0] : null
      if (!chosen) return json({ choose_shop: shops.map((x) => ({ id: String(x.id), title: x.title, channel: x.sales_channel })) })
      const secret = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('')
      await admin.rpc('svc_set_printify', { p_business: biz, p_token: t, p_shop_id: String(chosen.id), p_webhook_secret: secret })
      const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/printify-webhook?b=${biz}`
      const hooks: string[] = []
      for (const topic of TOPICS) {
        try { await pfy(t, `/shops/${chosen.id}/webhooks.json`, { method: 'POST', body: JSON.stringify({ topic, url, secret }) }); hooks.push(topic) } catch (e) { hooks.push(`${topic} (failed: ${(e as Error).message})`) }
      }
      await audit(admin, caller, 'store:printify_connect', { shop: chosen.title, webhooks: hooks }, { business_id: biz, entity: 'store_settings', entity_id: biz })
      return json({ connected: true, shop: { id: String(chosen.id), title: chosen.title }, webhooks: hooks })
    }
    case 'disconnect': {
      if (token && shop) {
        try {
          const hooks = (await pfy(token, `/shops/${shop}/webhooks.json`)) as any[]
          for (const h of hooks.filter((h) => String(h.url).includes(`printify-webhook?b=${biz}`))) await pfy(token, `/shops/${shop}/webhooks/${h.id}.json`, { method: 'DELETE' }).catch(() => {})
        } catch { /* token may be revoked already */ }
      }
      await admin.rpc('svc_set_printify', { p_business: biz, p_token: '', p_shop_id: '', p_webhook_secret: '' })
      await audit(admin, caller, 'store:printify_disconnect', {}, { business_id: biz, entity: 'store_settings', entity_id: biz })
      return json({ connected: false })
    }
    case 'products': {
      if (!token || !shop) throw new HttpError(400, 'Connect Printify first.')
      const page = Math.max(1, Number(body.page) || 1)
      const r = await pfy(token, `/shops/${shop}/products.json?limit=20&page=${page}`)
      const { data: mapped } = await admin.from('printify_mappings').select('printify_product_id').eq('business_id', biz)
      return json({ page, last_page: r.last_page, products: (r.data ?? []).map((p: any) => ({ id: p.id, title: p.title, image: p.images?.[0]?.src ?? null, variants: (p.variants ?? []).filter((v: any) => v.is_enabled).length, imported: mapped?.some((m) => m.printify_product_id === p.id) ?? false })) })
    }
    case 'import': {
      if (!token || !shop) throw new HttpError(400, 'Connect Printify first.')
      const pid = clean(body.product_id, 40)
      const p = await pfy(token, `/shops/${shop}/products/${pid}.json`)
      const optionNames = new Map<number, { name: string; type: string }>()
      for (const o of p.options ?? []) for (const v of o.values ?? []) optionNames.set(v.id, { name: v.title, type: o.name })
      const { data: existing } = await admin.from('printify_mappings').select('variant_id, printify_variant_id, product_variants(product_id)').eq('business_id', biz).eq('printify_product_id', pid)
      let productId = (existing?.[0] as any)?.product_variants?.product_id as string | undefined
      const desc = String(p.description ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000)
      if (!productId) {
        const { data: np, error } = await admin.from('products').insert({ business_id: biz, name: String(p.title).slice(0, 160), description: desc, fulfilment: 'printify', online: true, active: false, kind: 'good' }).select('id').single()
        if (error) throw new HttpError(400, error.message)
        productId = np.id
      }
      let created = 0
      for (const v of (p.variants ?? []).filter((v: any) => v.is_enabled)) {
        const opts = (v.options ?? []).map((id: number) => optionNames.get(id)).filter(Boolean)
        const name = opts.map((o: any) => o.name).join(' / ') || v.title
        const options = Object.fromEntries(opts.map((o: any) => [String(o.type).toLowerCase(), o.name]))
        const map = existing?.find((m) => Number(m.printify_variant_id) === v.id)
        if (map) { await admin.from('printify_mappings').update({ cost_cents: v.cost ?? null, synced_at: new Date().toISOString() }).eq('variant_id', map.variant_id); continue }
        const { data: nv, error } = await admin.from('product_variants').insert({ product_id: productId, name: String(name).slice(0, 120), options, price: Math.round(Number(v.price ?? 0)) / 100, sku: v.sku ? String(v.sku).slice(0, 64) : null, track_stock: false }).select('id').single()
        if (error) continue
        await admin.from('printify_mappings').insert({ variant_id: nv.id, business_id: biz, printify_product_id: pid, printify_variant_id: v.id, cost_cents: v.cost ?? null })
        created++
      }
      await audit(admin, caller, 'store:printify_import', { printify_product: pid, title: p.title, variants_created: created }, { business_id: biz, entity: 'products', entity_id: productId })
      return json({ product_id: productId, variants_created: created, note: 'Imported as hidden. Check prices (Printify retail price used as a starting point), then make it available.' })
    }
    case 'submit': {
      const oid = clean(body.order_id, 40)
      const { data: o } = await admin.from('orders').select('business_id').eq('id', oid).maybeSingle()
      if (o?.business_id !== biz) throw new HttpError(404, 'Order not found.')
      const r = await submitPrintifyOrder(admin, oid, { retry: true })
      await audit(admin, caller, 'store:printify_submit', r as Record<string, unknown>, { business_id: biz, entity: 'orders', entity_id: oid })
      return json(r)
    }
    case 'refresh': {
      const oid = clean(body.order_id, 40)
      const { data: f } = await admin.from('fulfilment_orders').select('external_id').eq('business_id', biz).eq('order_id', oid).maybeSingle()
      if (!f?.external_id) throw new HttpError(404, 'Not sent to Printify yet.')
      return json(await refreshPrintifyOrder(admin, biz, f.external_id))
    }
    default:
      throw new HttpError(400, 'Unknown action.')
  }
}))
