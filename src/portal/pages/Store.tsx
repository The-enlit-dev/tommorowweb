// Online store settings (shipping, Razorpay per business) and Printify fulfilment for brands.
import { useState } from 'preact/hooks'
import { SUPABASE_URL } from '../../lib/supabase-config.js'
import { callFn, check, d, dt, inr, sb } from '../lib'
import { Badge, CopyBox, Empty, ErrorNote, Field, Modal, PageHead, Portal, useAction, useApp, useLoad, formData } from '../ui'

export function Store() {
  return (
    <Portal title="Online store" need="business" module="ecommerce" perm="settings.manage">
      {(app) => <StoreBody app={app} />}
    </Portal>
  )
}

function StoreBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const data = useLoad(async () => {
    const [st, sites] = await Promise.all([
      sb().from('store_settings').select('*').eq('business_id', bizId).maybeSingle(),
      sb().from('sites').select('id, name, url, public_key, allowed_origins').eq('business_id', bizId),
    ])
    return { st: (check(st) as any) ?? null, sites: check(sites) as any[] }
  }, [bizId])
  if (!data.data) return data.error ? <ErrorNote error={data.error} /> : <div class="p-loading">Loading…</div>
  const { st, sites } = data.data
  const s = st ?? {}
  const hasRazorpay = app.biz?.modules.includes('razorpay')
  const webhook = `${SUPABASE_URL}/functions/v1/razorpay-webhook?b=${bizId}`
  const save = (patch: Record<string, unknown>) => run(async () => {
    if (st) check(await sb().from('store_settings').update(patch).eq('business_id', bizId))
    else check(await sb().from('store_settings').insert({ business_id: bizId, ...patch }))
    await data.reload()
  }, 'Saved')

  return (
    <>
      <PageHead title="Online store" sub={s.enabled ? <Badge tone="ok">open</Badge> : <Badge>closed</Badge>} />
      <div class="p-grid-2">
        <form class="p-card p-form" onSubmit={(e) => {
          const f = formData(e)
          save({ enabled: !!f.enabled, store_name: f.store_name.trim() || null, shipping_flat: Number(f.shipping_flat || 0), free_shipping_above: f.free_shipping_above === '' ? null : Number(f.free_shipping_above), contact_email: f.contact_email.trim() || null, policies: f.policies.trim() || null, manual_upi: !!f.manual_upi })
        }}>
          <h2>Store</h2>
          <label class="p-check"><input type="checkbox" name="enabled" defaultChecked={s.enabled} /> Store is open</label>
          <Field label="Store name"><input name="store_name" maxLength={120} defaultValue={s.store_name ?? app.biz?.business_name} /></Field>
          <div class="row2">
            <Field label="Flat shipping (₹)"><input name="shipping_flat" type="number" min="0" step="1" defaultValue={s.shipping_flat ?? 0} /></Field>
            <Field label="Free shipping above (₹)" hint="Leave empty for never"><input name="free_shipping_above" type="number" min="0" step="1" defaultValue={s.free_shipping_above ?? ''} /></Field>
          </div>
          <Field label="Contact email for customers"><input name="contact_email" type="email" defaultValue={s.contact_email ?? ''} /></Field>
          <Field label="Shipping, returns and exchange policy"><textarea name="policies" rows={4} maxLength={4000} defaultValue={s.policies ?? ''} /></Field>
          <label class="p-check"><input type="checkbox" name="manual_upi" defaultChecked={s.manual_upi ?? true} /> Offer “pay by UPI” (you confirm each payment by hand) when online payment isn’t used</label>
          <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          <p class="p-small p-muted">Products appear in the store when “Sell in the online store” is ticked on the product.</p>
        </form>

        <div class="p-stack">
          {hasRazorpay ? (
            <div class="p-card p-form">
              <h2>Razorpay (online payments)</h2>
              <p class="p-small">Uses <strong>your own Razorpay account</strong>. Razorpay charges a fee per payment. Start with <strong>test mode</strong> keys; switch to live keys only after a test order works.</p>
              <p class="p-small">Status: {s.razorpay_enabled ? <Badge tone="ok">on · {s.razorpay_mode} mode</Badge> : <Badge>off</Badge>} {s.razorpay_key_id && <code class="p-small">{s.razorpay_key_id}</code>}</p>
              <form class="p-form" onSubmit={(e) => {
                const f = formData(e)
                run(async () => {
                  check(await sb().rpc('set_razorpay_keys', { p_business: bizId, p_key_id: f.key_id.trim(), p_key_secret: f.key_secret || null, p_webhook_secret: f.webhook_secret || null }))
                  await data.reload()
                }, 'Razorpay keys saved securely')
              }}>
                <Field label="Key ID" hint="Razorpay Dashboard → Account & Settings → API keys"><input name="key_id" defaultValue={s.razorpay_key_id ?? ''} placeholder="rzp_test_…" pattern="rzp_(test|live)_[A-Za-z0-9]{6,32}" /></Field>
                <Field label="Key secret" hint={s.razorpay_secret_id ? 'Saved (hidden). Type to replace.' : 'Stored encrypted in Supabase Vault; never shown again.'}><input name="key_secret" type="password" autoComplete="off" /></Field>
                <Field label="Webhook secret" hint={s.razorpay_webhook_secret_id ? 'Saved (hidden). Type to replace.' : 'Choose any long random text and use the same in Razorpay.'}><input name="webhook_secret" type="password" autoComplete="off" /></Field>
                <button class="btn btn-ghost p-btn" disabled={busy}>Save keys</button>
              </form>
              <details><summary class="p-small">Webhook setup (required)</summary>
                <p class="p-small">In Razorpay → Webhooks → Add: URL below, the same secret, events <code>payment.captured</code>, <code>order.paid</code>, <code>payment.failed</code>. Turn on automatic capture. Orders are marked paid only when this verified webhook arrives.</p>
                <CopyBox value={webhook} />
              </details>
              <label class="p-check"><input type="checkbox" checked={!!s.razorpay_enabled} disabled={busy || !s.razorpay_secret_id || !s.razorpay_webhook_secret_id} onChange={(e) => save({ razorpay_enabled: (e.target as HTMLInputElement).checked })} /> Take online payments with Razorpay</label>
            </div>
          ) : <div class="p-card"><h2>Online payments</h2><p class="p-small">Razorpay isn’t switched on for this business. Ask Tomorrow Web to enable it (you’ll need your own Razorpay account).</p></div>}

          <div class="p-card">
            <h2>Add the store to your website</h2>
            {sites.length ? sites.map((x) => (
              <div key={x.id} class="p-stack" style={{ gap: '0.4rem' }}>
                <p class="p-small">{x.name}: site key <code>{x.public_key}</code> · allowed: {x.allowed_origins.join(', ') || x.url || 'not set'}</p>
                <p class="p-small p-muted">Tomorrow Web installs the store pages (kit/store) on your site. Customers track orders at <code>{location.origin}/track/</code>.</p>
              </div>
            )) : <p class="p-small p-muted">No website linked yet.</p>}
          </div>
        </div>
      </div>
    </>
  )
}

// ── Printify ──────────────────────────────────────────────────────────────
export function Fulfilment() {
  return (
    <Portal title="Printify" need="business" module="printify" perm="settings.manage">
      {(app) => <FulfilmentBody app={app} />}
    </Portal>
  )
}

const F_STATUS: Record<string, 'ok' | 'warn' | 'bad' | 'ai' | undefined> = { pending: 'warn', submitted: 'ai', in_production: 'ai', shipped: 'ok', delivered: 'ok', failed: 'bad', on_hold: 'warn', cancelled: 'bad' }

function FulfilmentBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [shops, setShops] = useState<any[] | null>(null)
  const [token, setToken] = useState('')
  const [browse, setBrowse] = useState<any>(null)
  const data = useLoad(async () => {
    const [st, f, charges] = await Promise.all([
      sb().from('store_settings').select('printify_shop_id, printify_connected_at').eq('business_id', bizId).maybeSingle(),
      sb().from('fulfilment_orders').select('*, orders(number, total, created_at)').eq('business_id', bizId).order('created_at', { ascending: false }).limit(200),
      sb().from('order_charges').select('order_id, kind, amount, currency').eq('business_id', bizId),
    ])
    return { st: (st.data as any) ?? {}, f: check(f) as any[], charges: (charges.data ?? []) as any[] }
  }, [bizId])
  const x = data.data
  const connected = !!x?.st?.printify_connected_at
  const attention = (x?.f ?? []).filter((r) => ['failed', 'on_hold'].includes(r.status) || (r.status === 'pending'))
  const connect = (shop_id?: string) => run(async () => {
    const r = await callFn('printify', { action: 'connect', business_id: bizId, token, shop_id })
    if (r.choose_shop) { setShops(r.choose_shop); return }
    setShops(null); setToken(''); await data.reload()
    app.toast(`Connected to ${r.shop.title}`)
  })

  return (
    <>
      <PageHead title="Printify fulfilment" sub="Print-on-demand through your own Printify account. Only products marked “Printify” are sent; everything else ships from your stock." />
      {!x ? <div class="p-loading">Loading…</div> : !connected ? (
        <div class="p-card p-form" style={{ maxWidth: '40rem' }}>
          <h2>Connect your Printify account</h2>
          <p class="p-small">Printify → My account → Connections → generate a <strong>Personal access token</strong> with orders, products, shops and webhooks permissions. The token is stored encrypted (Supabase Vault). Printify charges you for production, shipping and any Printify plan — these appear on each order.</p>
          <Field label="Printify API token"><input type="password" autoComplete="off" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} /></Field>
          {shops ? (
            <div class="p-stack"><p class="p-small">Choose the shop to use:</p>{shops.map((s) => <button key={s.id} class="btn btn-ghost p-btn" disabled={busy} onClick={() => connect(s.id)}>{s.title} ({s.channel})</button>)}</div>
          ) : <button class="btn btn-ink p-btn" disabled={busy || token.length < 20} onClick={() => connect()}>Connect</button>}
        </div>
      ) : (
        <>
          <div class="p-row" style={{ marginBottom: '1rem' }}>
            <Badge tone="ok">connected</Badge><span class="p-small p-muted">since {d(x.st.printify_connected_at)} · shop {x.st.printify_shop_id}</span>
            <span class="p-spacer" />
            <button class="btn btn-ghost p-btn" onClick={() => setBrowse({ page: 1 })}>Import products</button>
            <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => confirm('Disconnect Printify? Orders already sent are not affected.') && run(async () => { await callFn('printify', { action: 'disconnect', business_id: bizId }); await data.reload() }, 'Disconnected')}>Disconnect</button>
          </div>
          {attention.length > 0 && (
            <div class="p-card" style={{ marginBottom: '1rem' }}>
              <h2>Needs attention</h2>
              <ul>{attention.map((r) => <li key={r.id}>Order #{r.orders?.number} — <Badge tone={F_STATUS[r.status]}>{r.status}</Badge> {r.error && <span class="p-small">{r.error}</span>} <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { const res = await callFn('printify', { action: 'submit', business_id: bizId, order_id: r.order_id }); await data.reload(); if (res.error) throw new Error(res.error) }, 'Sent to Printify')}>Retry</button></li>)}</ul>
            </div>
          )}
          {x.f.length ? (
            <div class="p-table-wrap"><table class="p-table">
              <thead><tr><th>Order</th><th>Status</th><th>Tracking</th><th class="num">Order total</th><th>Printify costs</th><th class="num">Your margin*</th><th></th></tr></thead>
              <tbody>{x.f.map((r) => {
                const ch = x.charges.filter((c) => c.order_id === r.order_id)
                const inrCosts = ch.filter((c) => c.currency === 'INR').reduce((a, c) => a + Number(c.amount), 0)
                const other = ch.filter((c) => c.currency !== 'INR')
                return (
                  <tr key={r.id}>
                    <td><a href={`/portal/orders/view/?id=${r.order_id}`}>#{r.orders?.number}</a><div class="p-small p-muted">{dt(r.created_at)}</div></td>
                    <td><Badge tone={F_STATUS[r.status]}>{r.status.replace('_', ' ')}</Badge></td>
                    <td class="p-small">{r.tracking_url ? <a href={r.tracking_url} target="_blank" rel="noopener">{r.carrier ?? 'Track'} {r.tracking_number}</a> : '—'}</td>
                    <td class="num">{inr(r.orders?.total)}</td>
                    <td class="p-small">{ch.map((c, i) => <div key={i}>{c.kind.replace('printify_', '').replace('_', ' ')}: {c.currency === 'INR' ? inr(c.amount) : `${c.amount} ${c.currency}`}</div>)}</td>
                    <td class="num">{other.length ? <span class="p-small p-muted">costs in {other[0].currency}</span> : inr(Number(r.orders?.total ?? 0) - inrCosts)}</td>
                    <td>{r.external_id && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { await callFn('printify', { action: 'refresh', business_id: bizId, order_id: r.order_id }); await data.reload() }, 'Updated')}>Refresh</button>}</td>
                  </tr>
                )
              })}</tbody>
            </table></div>
          ) : <Empty>No Printify orders yet. Paid orders with Printify products are sent automatically.</Empty>}
          <p class="p-small p-muted" style={{ marginTop: '0.75rem' }}>*Order total minus Printify production/shipping and payment-gateway fees recorded for the order. Tomorrow Web’s own fees are never included here. Printify usually reports costs in USD; convert before comparing.</p>
        </>
      )}
      {browse && <ImportModal bizId={bizId} onClose={() => setBrowse(null)} />}
    </>
  )
}

function ImportModal({ bizId, onClose }: { bizId: string; onClose: () => void }) {
  const [page, setPage] = useState(1)
  const { busy, run } = useAction()
  const list = useLoad(async () => await callFn('printify', { action: 'products', business_id: bizId, page }), [page])
  return (
    <Modal title="Import from Printify" onClose={onClose}>
      <ErrorNote error={list.error} />
      {list.loading ? <div class="p-loading">Loading…</div> : (
        <div class="p-stack">
          {(list.data?.products ?? []).map((p: any) => (
            <div key={p.id} class="p-row">
              {p.image && <img src={p.image} alt="" width="48" height="48" style={{ borderRadius: '8px', objectFit: 'cover' }} />}
              <span>{p.title} <span class="p-small p-muted">{p.variants} variants</span></span>
              <span class="p-spacer" />
              <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { const r = await callFn('printify', { action: 'import', business_id: bizId, product_id: p.id }); alert(`${r.variants_created} variant(s) added. ${r.note}`); await list.reload() })}>{p.imported ? 'Sync again' : 'Import'}</button>
            </div>
          ))}
          <div class="p-row"><button class="btn btn-ghost p-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span class="p-spacer" /><button class="btn btn-ghost p-btn" disabled={page >= (list.data?.last_page ?? 1)} onClick={() => setPage(page + 1)}>Next</button></div>
        </div>
      )}
    </Modal>
  )
}

/** Fulfilment, tracking and charge breakdown block for the order page. */
export function OrderFulfilment({ order }: { order: any }) {
  const data = useLoad(async () => {
    const [f, c, t] = await Promise.all([
      sb().from('fulfilment_orders').select('*').eq('order_id', order.id),
      sb().from('order_charges').select('*').eq('order_id', order.id),
      sb().from('order_tracking').select('*').eq('order_id', order.id).order('at'),
    ])
    return { f: (f.data ?? []) as any[], c: (c.data ?? []) as any[], t: (t.data ?? []) as any[] }
  }, [order.id, order.version])
  if (order.channel !== 'online' || !data.data) return null
  const { f, c } = data.data
  const track = `${location.origin}/track/?t=${order.tracking_token}`
  return (
    <div class="p-card">
      <h2>Delivery</h2>
      {order.shipping_address && <p class="p-small">{[order.shipping_address.name, order.shipping_address.line1, order.shipping_address.line2, order.shipping_address.city, order.shipping_address.state, order.shipping_address.pin].filter(Boolean).join(', ')} · {order.shipping_address.phone}</p>}
      <p class="p-small">Customer tracking link:</p>
      <CopyBox value={track} />
      {f.map((x) => <p class="p-small" key={x.id}>Printify: <Badge tone={F_STATUS[x.status]}>{x.status}</Badge> {x.tracking_url && <a href={x.tracking_url} target="_blank" rel="noopener">{x.carrier} {x.tracking_number}</a>} {x.error && <span style={{ color: 'var(--danger)' }}>{x.error}</span>}</p>)}
      {c.length > 0 && (
        <>
          <h3>Charges (paid to others)</h3>
          <ul class="p-small">{c.map((x) => <li key={x.id}>{x.kind.replace(/_/g, ' ')}: {x.currency === 'INR' ? inr(x.amount) : `${x.amount} ${x.currency}`} <span class="p-muted">({x.source.split(':')[0]})</span></li>)}</ul>
        </>
      )}
    </div>
  )
}
