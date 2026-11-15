// POS screen, live orders board, order detail and receipts/invoices.
// All money and stock changes go through database functions (create_order, record_payment,
// confirm_upi_payment, order_transition, issue_refund) — the browser never writes totals.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import QRCode from 'qrcode'
import { cartEstimate, changeDue, newIdempotencyKey, receiptText, upiLink, type CartLine } from '../pos'
import { check, d, downloadCsv, dt, inr, qs, sb } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Portal, useAction, useApp, useLoad, formData } from '../ui'

export const ORDER_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'bad' | 'ai' }> = {
  pending_payment: { label: 'Awaiting payment', tone: 'warn' }, new: { label: 'New', tone: 'ai' }, accepted: { label: 'Accepted', tone: 'ai' },
  processing: { label: 'Preparing', tone: 'ai' }, ready: { label: 'Ready', tone: 'ok' }, completed: { label: 'Completed', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'bad' }, refunded: { label: 'Refunded', tone: 'bad' }, payment_failed: { label: 'Payment failed', tone: 'bad' }, failed: { label: 'Failed', tone: 'bad' },
}
export const PAY_STATUS: Record<string, string> = { pending: 'Unpaid', paid: 'Paid', failed: 'Failed', expired: 'Expired', refunded: 'Refunded', partially_refunded: 'Part refunded' }
const CHANNEL: Record<string, string> = { pos: 'Counter', online: 'Online', table: 'Table', takeaway: 'Takeaway', delivery: 'Delivery' }
const NEXT_ACTION: Record<string, [string, string][]> = {
  new: [['accepted', 'Accept'], ['ready', 'Mark ready']], accepted: [['processing', 'Start preparing'], ['ready', 'Mark ready']],
  processing: [['ready', 'Mark ready']], ready: [['completed', 'Complete']],
}
const device = () => { try { return (localStorage.getItem('tw-device') ?? (localStorage.setItem('tw-device', `device-${Math.random().toString(36).slice(2, 6)}`), localStorage.getItem('tw-device')))! } catch { return 'browser' } }

/** Turns a database error into a short message; "Already accepted by…" conflicts are passed through. */
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^.*?ERROR:\s*/, '')

function useCatalogue(bizId: string) {
  return useLoad(async () => {
    const [cats, prods, vars, settings] = await Promise.all([
      sb().from('product_categories').select('id, name, sort').eq('business_id', bizId).eq('active', true).order('sort'),
      sb().from('products').select('id, name, category_id, station, tax_rate_id, tax_rates(rate_pct), image_path, sort, active').eq('business_id', bizId).eq('active', true).order('sort').order('name'),
      sb().from('product_variants').select('id, product_id, name, price, sku, barcode, track_stock, stock, low_stock_at, active, sort').eq('business_id', bizId).eq('active', true).order('sort'),
      sb().from('commerce_settings').select('*').eq('business_id', bizId).maybeSingle(),
    ])
    return { cats: check(cats) as any[], prods: check(prods) as any[], vars: check(vars) as any[], settings: (check(settings) as any) ?? { prices_include_tax: true } }
  }, [bizId])
}

// ── POS screen ────────────────────────────────────────────────────────────
export function PosScreen() {
  return (
    <Portal title="Point of sale" need="business" module="pos" perm="pos.sell">
      {(app) => <PosBody app={app} />}
    </Portal>
  )
}

function PosBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const cat = useCatalogue(bizId)
  const [cart, setCart] = useState<CartLine[]>([])
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [channel, setChannel] = useState('pos')
  const [table, setTable] = useState('')
  const [customer, setCustomer] = useState({ name: '', phone: '' })
  const [code, setCode] = useState('')
  const [order, setOrder] = useState<any>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const keyRef = useRef<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const data = cat.data
  const tableMode = app.biz?.modules.includes('restaurant')

  const items = useMemo(() => {
    if (!data) return []
    return data.vars.map((v) => {
      const p = data.prods.find((x) => x.id === v.product_id)
      return p ? { ...v, product: p, label: v.name === 'Standard' ? p.name : `${p.name} · ${v.name}`, rate: Number(p.tax_rates?.rate_pct ?? 0) } : null
    }).filter(Boolean).filter((i: any) => (!category || i.product.category_id === category) && (!q || `${i.label} ${i.sku ?? ''} ${i.barcode ?? ''}`.toLowerCase().includes(q.toLowerCase()))) as any[]
  }, [data, q, category])

  const add = (i: any) => {
    keyRef.current = null
    setCart((c) => {
      const ex = c.find((l) => l.variant_id === i.id)
      if (i.track_stock && (ex?.qty ?? 0) + 1 > i.stock) { app.toast(`Only ${i.stock} left of ${i.label}`, 'bad'); return c }
      return ex ? c.map((l) => (l.variant_id === i.id ? { ...l, qty: l.qty + 1 } : l)) : [...c, { variant_id: i.id, name: i.label, price: Number(i.price), qty: 1, rate: i.rate }]
    })
  }
  const setQty = (id: string, qty: number) => { keyRef.current = null; setCart((c) => (qty <= 0 ? c.filter((l) => l.variant_id !== id) : c.map((l) => (l.variant_id === id ? { ...l, qty } : l)))) }
  const est = cartEstimate(cart, { includeTax: !!data?.settings.prices_include_tax })

  // Barcode scanners type the code and press Enter.
  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !data) return
    const hit = data.vars.find((v) => v.barcode === q.trim() || v.sku === q.trim())
    if (hit) { add(items.find((i) => i.id === hit.id) ?? { ...hit, label: hit.name, rate: 0 }); setQ('') }
  }

  async function charge(payLater = false) {
    if (!cart.length) return
    setBusy(true); setError('')
    keyRef.current ??= newIdempotencyKey() // reused on retry so a double tap can't create two orders
    const { data: o, error: err } = await sb().rpc('create_order', {
      p_business: bizId, p_items: cart.map((l) => ({ variant_id: l.variant_id, qty: l.qty })), p_idempotency_key: keyRef.current,
      p_channel: channel, p_customer: customer.phone ? { name: customer.name, phone: customer.phone.replace(/[^\d+]/g, '') } : {},
      p_discount_code: code || null, p_table: table || null, p_device: device(),
    })
    setBusy(false)
    if (err) return setError(errMsg(err.message))
    if (payLater) { app.toast(`Order #${o.number} sent`); reset(); return }
    setOrder(o)
  }
  const reset = () => { setCart([]); setOrder(null); setCustomer({ name: '', phone: '' }); setCode(''); setTable(''); keyRef.current = null; cat.reload(); searchRef.current?.focus() }

  if (cat.loading && !data) return <div class="p-loading">Loading…</div>
  if (cat.error) return <ErrorNote error={cat.error} />
  if (!data!.vars.length) return <><PageHead title="Point of sale" /><Empty>No products yet. Add your menu or products under “Products & menu”.</Empty></>

  return (
    <div class="pos">
      <section class="pos-catalog" aria-label="Products">
        <div class="p-row" style={{ marginBottom: '0.6rem' }}>
          <input ref={searchRef} class="p-input" placeholder="Search or scan barcode" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} onKeyDown={onSearchKey} autoFocus style={{ flex: 1 }} aria-label="Search products or scan a barcode" />
        </div>
        <div class="p-tabs" role="tablist" style={{ marginBottom: '0.6rem' }}>
          <button role="tab" aria-selected={!category} onClick={() => setCategory('')}>All</button>
          {data!.cats.map((c) => <button key={c.id} role="tab" aria-selected={category === c.id} onClick={() => setCategory(c.id)}>{c.name}</button>)}
        </div>
        <div class="pos-grid">
          {items.map((i) => {
            const out = i.track_stock && i.stock <= 0
            return (
              <button key={i.id} class="pos-item" disabled={out} onClick={() => add(i)}>
                <span class="pos-item-name">{i.label}</span>
                <span class="pos-item-price">{inr(i.price)}</span>
                {i.track_stock && <span class={`p-small ${i.stock <= (i.low_stock_at ?? 0) ? 'pos-low' : 'p-muted'}`}>{out ? 'Sold out' : `${i.stock} left`}</span>}
              </button>
            )
          })}
        </div>
      </section>

      <section class="pos-cart p-card" aria-label="Current sale">
        <div class="p-row">
          <h2 style={{ margin: 0 }}>Sale</h2><span class="p-spacer" />
          <select value={channel} onChange={(e) => setChannel((e.target as HTMLSelectElement).value)} aria-label="Order type">
            <option value="pos">Counter</option><option value="takeaway">Takeaway</option>{tableMode && <option value="table">Table</option>}<option value="delivery">Delivery</option>
          </select>
        </div>
        {channel === 'table' && <input class="p-input" placeholder="Table (e.g. T4)" value={table} onInput={(e) => setTable((e.target as HTMLInputElement).value)} style={{ marginTop: '0.5rem' }} />}
        {cart.length ? (
          <ul class="pos-lines">
            {cart.map((l) => (
              <li key={l.variant_id}>
                <span class="pos-line-name">{l.name}</span>
                <span class="pos-qty">
                  <button aria-label={`One less ${l.name}`} onClick={() => setQty(l.variant_id, l.qty - 1)}>−</button>
                  <span aria-live="polite">{l.qty}</span>
                  <button aria-label={`One more ${l.name}`} onClick={() => setQty(l.variant_id, l.qty + 1)}>+</button>
                </span>
                <span class="num">{inr(l.price * l.qty)}</span>
              </li>
            ))}
          </ul>
        ) : <p class="p-muted" style={{ margin: '1.5rem 0' }}>Tap products to add them.</p>}
        <details class="p-small"><summary>Customer & discount</summary>
          <div class="p-form" style={{ marginTop: '0.5rem' }}>
            <div class="row2">
              <input class="p-input" placeholder="Customer phone" inputMode="tel" value={customer.phone} onInput={(e) => setCustomer({ ...customer, phone: (e.target as HTMLInputElement).value })} />
              <input class="p-input" placeholder="Name" value={customer.name} onInput={(e) => setCustomer({ ...customer, name: (e.target as HTMLInputElement).value })} />
            </div>
            <input class="p-input" placeholder="Discount code" value={code} onInput={(e) => { keyRef.current = null; setCode((e.target as HTMLInputElement).value.toUpperCase()) }} />
          </div>
        </details>
        <dl class="pos-totals">
          <div><dt>Subtotal</dt><dd>{inr(est.subtotal)}</dd></div>
          <div><dt>GST {data!.settings.prices_include_tax ? '(included)' : ''}</dt><dd>{inr(est.tax)}</dd></div>
          {code && <div><dt>Discount</dt><dd class="p-muted">applied at checkout</dd></div>}
          <div class="pos-total"><dt>Total</dt><dd>{inr(est.total)}</dd></div>
        </dl>
        {error && <div class="p-notice" data-tone="bad" role="alert">{error}</div>}
        <div class="p-row">
          <button class="btn btn-ghost p-btn" disabled={!cart.length || busy} onClick={() => setCart([])}>Clear</button>
          {(channel === 'table' || channel === 'takeaway') && <button class="btn btn-ghost p-btn" disabled={!cart.length || busy} onClick={() => charge(true)}>Send (pay later)</button>}
          <span class="p-spacer" />
          <button class="btn btn-ink p-btn pos-charge" disabled={!cart.length || busy} onClick={() => charge(false)}>{busy ? 'Working…' : `Charge ${inr(est.total)}`}</button>
        </div>
        <p class="p-small p-muted" style={{ margin: '0.5rem 0 0' }}>GST-aware, not certified GST-compliant software.</p>
      </section>

      {order && <PaymentModal order={order} settings={data!.settings} business={app.biz!.business_name} onDone={reset} onClose={() => setOrder(null)} />}
    </div>
  )
}

export function PaymentModal({ order, settings, business, onDone, onClose }: { order: any; settings: any; business: string; onDone: () => void; onClose: () => void }) {
  const app = useApp()
  const [o, setO] = useState(order)
  const [method, setMethod] = useState<'cash' | 'upi' | 'card_manual'>('cash')
  const [tendered, setTendered] = useState('')
  const [pending, setPending] = useState<any>(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const keys = useRef<Record<string, string>>({})
  const paid = o.payment_status === 'paid'
  const total = Number(o.total)
  const link = settings.upi_id ? upiLink({ vpa: settings.upi_id, name: settings.upi_name || business, amount: total, note: `Order ${o.number}`, ref: `ORD${o.number}` }) : ''
  useEffect(() => { if (method === 'upi' && link) QRCode.toString(link, { type: 'svg', margin: 1, color: { dark: '#050505', light: '#ffffff' } }).then(setSvg) }, [method, link])

  const refresh = async () => setO(check(await sb().from('orders').select('*').eq('id', o.id).single()))
  async function pay() {
    setBusy(true); setError('')
    keys.current[method] ??= newIdempotencyKey()
    const { data, error: err } = await sb().rpc('record_payment', { p_order: o.id, p_method: method, p_amount: total, p_idempotency_key: keys.current[method], p_cash_tendered: method === 'cash' && tendered ? Number(tendered) : null, p_device: device() })
    setBusy(false)
    if (err) return setError(errMsg(err.message))
    if (data.status === 'pending') setPending(data)
    await refresh()
  }
  async function confirmUpi(utr: string) {
    setBusy(true); setError('')
    const { error: err } = await sb().rpc('confirm_upi_payment', { p_payment: pending.id, p_utr: utr || null, p_device: device() })
    setBusy(false)
    if (err) return setError(errMsg(err.message))
    setPending(null); await refresh()
  }
  async function notReceived() {
    const { error: err } = await sb().rpc('fail_payment', { p_payment: pending.id, p_reason: 'Customer’s UPI payment not received' })
    if (err) return setError(errMsg(err.message))
    setPending(null); delete keys.current.upi
    app.toast('Marked as not received. Try again or use another method.', 'bad')
  }

  return (
    <Modal title={`Order #${o.number} — ${inr(total)}`} onClose={paid ? onDone : onClose}>
      {paid ? (
        <div class="p-stack">
          <div class="p-notice" data-tone="ok"><strong>Paid.</strong> {method === 'cash' && tendered && Number(tendered) > total && <>Give change: <strong>{inr(changeDue(total, Number(tendered)) ?? 0)}</strong></>}</div>
          <div class="p-row">
            <a class="btn btn-ghost p-btn" href={`/portal/orders/receipt/?id=${o.id}&size=58`} target="_blank">Receipt 58 mm</a>
            <a class="btn btn-ghost p-btn" href={`/portal/orders/receipt/?id=${o.id}&size=80`} target="_blank">Receipt 80 mm</a>
            <a class="btn btn-ghost p-btn" href={`/portal/orders/receipt/?id=${o.id}&size=a4`} target="_blank">A4 invoice</a>
          </div>
          <button class="btn btn-ink p-btn" onClick={onDone} autoFocus>New sale</button>
        </div>
      ) : pending ? (
        <form class="p-form" onSubmit={(e) => { const f = formData(e); confirmUpi(f.utr) }}>
          {svg ? <div class="upi-qr" dangerouslySetInnerHTML={{ __html: svg }} /> : <p>Ask the customer to pay {inr(total)} to your UPI ID.</p>}
          <p class="p-small">Customer scans and pays <strong>{inr(total)}</strong>. Check your UPI app or bank SMS, then confirm. <strong>Only confirm after you see the money arrive.</strong></p>
          <Field label="UPI reference / UTR (optional)"><input name="utr" maxLength={40} inputMode="numeric" /></Field>
          {error && <div class="p-notice" data-tone="bad" role="alert">{error}</div>}
          <div class="p-row">
            <button type="button" class="btn btn-ghost p-btn" disabled={busy} onClick={notReceived}>Not received</button>
            <span class="p-spacer" />
            <button class="btn btn-ink p-btn" disabled={busy}>I received {inr(total)}</button>
          </div>
        </form>
      ) : (
        <div class="p-stack">
          <div class="p-tabs" role="tablist">
            {([['cash', 'Cash'], ['upi', 'UPI QR'], ['card_manual', 'Card (machine)']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={method === k} onClick={() => setMethod(k)}>{l}</button>)}
          </div>
          {method === 'cash' && (
            <Field label="Cash received">
              <input type="number" inputMode="decimal" min={total} step="1" placeholder={String(total)} value={tendered} onInput={(e) => setTendered((e.target as HTMLInputElement).value)} autoFocus />
            </Field>
          )}
          {method === 'cash' && tendered && <p>Change: <strong>{changeDue(total, Number(tendered)) == null ? 'not enough' : inr(changeDue(total, Number(tendered))!)}</strong></p>}
          {method === 'upi' && !settings.upi_id && <p class="p-small p-notice" data-tone="warn">Add your UPI ID in Business settings → POS & invoices to show a QR code with the amount.</p>}
          {method === 'card_manual' && <p class="p-small p-muted">Take the payment on your card machine, then record it here.</p>}
          {error && <div class="p-notice" data-tone="bad" role="alert">{error}</div>}
          <div class="p-row">
            <button class="btn btn-ghost p-btn" onClick={onClose} disabled={busy}>Pay later</button>
            <span class="p-spacer" />
            <button class="btn btn-ink p-btn" disabled={busy || (method === 'cash' && !!tendered && Number(tendered) < total)} onClick={pay}>{method === 'upi' ? 'Show QR' : `Record ${inr(total)}`}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Orders board (live) ───────────────────────────────────────────────────
export function OrdersBoard() {
  return (
    <Portal title="Orders" need="business" module="orders" perm="orders.view">
      {(app) => <OrdersBody app={app} />}
    </Portal>
  )
}

function beep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = 880; o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.25, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6)
    o.start(); o.stop(ctx.currentTime + 0.6)
  } catch { /* audio blocked until the user interacts */ }
}

export function useLiveOrders(bizId: string, onNew?: (o: any) => void) {
  const [orders, setOrders] = useState<any[] | null>(null)
  const [connected, setConnected] = useState(false)
  const load = async () => {
    await sb().rpc('expire_unpaid_orders', { p_business: bizId })
    const since = new Date(Date.now() - 36 * 3600_000).toISOString()
    setOrders(check(await sb().from('orders').select('*, order_items(*)').eq('business_id', bizId).or(`created_at.gte.${since},status.in.(new,accepted,processing,ready,pending_payment,payment_failed)`).order('created_at', { ascending: false }).limit(200)) as any[])
  }
  useEffect(() => {
    load()
    const ch = sb().channel(`orders-${bizId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `business_id=eq.${bizId}` }, (payload: any) => {
        if (payload.eventType === 'INSERT') onNew?.(payload.new)
        load()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `business_id=eq.${bizId}` }, () => load())
      .subscribe((s: string) => setConnected(s === 'SUBSCRIBED'))
    const poll = setInterval(load, 60_000) // safety net if the live connection drops
    return () => { sb().removeChannel(ch); clearInterval(poll) }
  }, [bizId])
  return { orders, setOrders, reload: load, connected }
}

function OrdersBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const [tab, setTab] = useState<'live' | 'history' | 'attention'>('live')
  const [unseen, setUnseen] = useState(0)
  const prefs = useLoad(async () => (check(await sb().from('member_prefs').select('*').eq('business_id', bizId).eq('user_id', app.ctx.profile.id).maybeSingle()) as any) ?? { channels: ['pos', 'online', 'table', 'takeaway', 'delivery'], sound: true }, [bizId])
  const live = useLiveOrders(bizId, (o) => {
    const p = prefs.data
    if (p && !p.channels.includes(o.channel)) return
    if (p?.sound !== false) beep()
    navigator.vibrate?.([200, 100, 200])
    setUnseen((n) => n + 1)
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(`New order #${o.number}`, { body: `${CHANNEL[o.channel]} · ${inr(o.total)}` })
  })
  useEffect(() => { document.title = unseen ? `(${unseen}) Orders — Tomorrow Web portal` : 'Orders — Tomorrow Web portal' }, [unseen])
  useEffect(() => { const f = () => !document.hidden && setUnseen(0); document.addEventListener('visibilitychange', f); window.addEventListener('pointerdown', f); return () => { document.removeEventListener('visibilitychange', f); window.removeEventListener('pointerdown', f) } }, [])
  const canUpdate = app.isAdmin || app.biz!.role === 'owner' || app.biz!.permissions.includes('orders.update')

  return (
    <>
      <PageHead title="Orders" sub={<>{live.connected ? <Badge tone="ok">live</Badge> : <Badge tone="warn">reconnecting…</Badge>} New orders appear here instantly with a sound.</>}>
        <OrderPrefs bizId={bizId} prefs={prefs.data} onSaved={prefs.reload} />
      </PageHead>
      <div class="p-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'live'} onClick={() => setTab('live')}>Live</button>
        <button role="tab" aria-selected={tab === 'attention'} onClick={() => setTab('attention')}>Needs attention</button>
        <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>History</button>
      </div>
      {tab === 'live' && <LiveBoard orders={live.orders} reload={live.reload} canUpdate={canUpdate} channels={prefs.data?.channels} />}
      {tab === 'attention' && <Attention bizId={bizId} />}
      {tab === 'history' && <History bizId={bizId} />}
    </>
  )
}

function OrderPrefs({ bizId, prefs, onSaved }: { bizId: string; prefs: any; onSaved: () => Promise<unknown> }) {
  const app = useApp()
  const [open, setOpen] = useState(false)
  const { busy, run } = useAction()
  return (
    <>
      <button class="btn btn-ghost p-btn" onClick={() => setOpen(true)}>Alerts</button>
      {open && (
        <Modal title="Order alerts on this account" onClose={() => setOpen(false)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            run(async () => {
              check(await sb().from('member_prefs').upsert({ business_id: bizId, user_id: app.ctx.profile.id, sound: !!f.sound, channels: Object.keys(CHANNEL).filter((c) => f[`ch_${c}`]) }))
              if (f.notify && 'Notification' in window) await Notification.requestPermission()
              setOpen(false); await onSaved()
            }, 'Saved')
          }}>
            <label class="p-check"><input type="checkbox" name="sound" defaultChecked={prefs?.sound !== false} /> Play a sound for new orders</label>
            <label class="p-check"><input type="checkbox" name="notify" /> Also show a browser notification when this tab is in the background</label>
            <fieldset class="p-card"><legend class="p-small">Alert me for</legend>
              {Object.entries(CHANNEL).map(([k, l]) => <label class="p-check" key={k}><input type="checkbox" name={`ch_${k}`} defaultChecked={prefs?.channels?.includes(k) ?? true} /> {l}</label>)}
            </fieldset>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}

export async function transition(o: any, to: string, toast: (m: string, t?: 'ok' | 'bad') => void, reason?: string) {
  const { error } = await sb().rpc('order_transition', { p_order: o.id, p_expected_version: o.version, p_to: to, p_reason: reason ?? null, p_device: device() })
  if (error) { toast(errMsg(error.message), 'bad'); return false }
  return true
}

function LiveBoard({ orders, reload, canUpdate, channels }: { orders: any[] | null; reload: () => Promise<void>; canUpdate: boolean; channels?: string[] }) {
  const app = useApp()
  const { busy, run } = useAction()
  if (!orders) return <div class="p-loading">Loading…</div>
  const cols: [string, string[]][] = [['New', ['new', 'pending_payment']], ['Accepted / preparing', ['accepted', 'processing']], ['Ready', ['ready']]]
  const shown = orders.filter((o) => !channels || channels.includes(o.channel))
  return (
    <div class="crm-board">
      {cols.map(([label, sts]) => {
        const list = shown.filter((o) => sts.includes(o.status)).sort((a, b) => a.created_at.localeCompare(b.created_at))
        return (
          <section class="crm-col" key={label} aria-label={label}>
            <header><strong>{label}</strong> <span class="p-small p-muted">{list.length}</span></header>
            <div class="p-stack" style={{ gap: '0.5rem' }}>
              {list.map((o) => (
                <div class="p-card crm-card" key={o.id}>
                  <div class="p-row"><a href={`/portal/orders/view/?id=${o.id}`}><strong>#{o.number}</strong></a><Badge>{CHANNEL[o.channel]}{o.table_label ? ` ${o.table_label}` : ''}</Badge><span class="p-spacer" /><span class="p-small p-muted">{new Date(o.created_at).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</span></div>
                  <ul class="p-small" style={{ margin: '0.4rem 0', paddingLeft: '1rem' }}>{o.order_items.map((i: any) => <li key={i.id}>{i.qty} × {i.product_name}{i.variant_name && i.variant_name !== 'Standard' ? ` (${i.variant_name})` : ''}{i.notes && <em> — {i.notes}</em>}</li>)}</ul>
                  <div class="p-row p-small"><span>{inr(o.total)}</span><Badge tone={o.payment_status === 'paid' ? 'ok' : 'warn'}>{PAY_STATUS[o.payment_status]}</Badge>{o.customer_name && <span class="p-muted">{o.customer_name}</span>}</div>
                  {canUpdate && o.status !== 'pending_payment' && (
                    <div class="p-row" style={{ marginTop: '0.4rem' }}>
                      {(NEXT_ACTION[o.status] ?? []).map(([to, l]) => (
                        <button key={to} class="btn btn-ghost p-btn" disabled={busy || (to === 'completed' && o.payment_status !== 'paid' && o.channel !== 'online')} title={to === 'completed' && o.payment_status !== 'paid' ? 'Take payment first' : undefined}
                          onClick={() => run(async () => { await transition(o, to, app.toast); await reload() })}>{l}</button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
}

function Attention({ bizId }: { bizId: string }) {
  const list = useLoad(async () => {
    const [unpaid, failed, refundDue] = await Promise.all([
      sb().from('payments').select('id, amount, created_at, order_id, orders(number)').eq('business_id', bizId).eq('status', 'pending').eq('method', 'upi').order('created_at'),
      sb().from('orders').select('id, number, status, failure_reason, total, created_at').eq('business_id', bizId).in('status', ['payment_failed', 'failed']).gte('created_at', new Date(Date.now() - 7 * 86400_000).toISOString()).order('created_at', { ascending: false }),
      sb().from('orders').select('id, number, total, cancel_reason, payment_status').eq('business_id', bizId).eq('status', 'cancelled').eq('payment_status', 'paid'),
    ])
    return { unpaid: check(unpaid) as any[], failed: check(failed) as any[], refundDue: check(refundDue) as any[] }
  }, [bizId])
  const x = list.data
  if (!x) return <div class="p-loading">Loading…</div>
  if (!x.unpaid.length && !x.failed.length && !x.refundDue.length) return <Empty>Nothing needs attention.</Empty>
  return (
    <div class="p-stack">
      {x.unpaid.length > 0 && <div class="p-card"><h2>UPI payments waiting for confirmation</h2><ul>{x.unpaid.map((p) => <li key={p.id}><a href={`/portal/orders/view/?id=${p.order_id}`}>Order #{p.orders?.number}</a> — {inr(p.amount)} since {dt(p.created_at)}</li>)}</ul></div>}
      {x.refundDue.length > 0 && <div class="p-card"><h2>Cancelled but paid — refund due</h2><ul>{x.refundDue.map((o) => <li key={o.id}><a href={`/portal/orders/view/?id=${o.id}`}>Order #{o.number}</a> — {inr(o.total)} ({o.cancel_reason})</li>)}</ul></div>}
      {x.failed.length > 0 && <div class="p-card"><h2>Failed orders (last 7 days)</h2><ul>{x.failed.map((o) => <li key={o.id}><a href={`/portal/orders/view/?id=${o.id}`}>Order #{o.number}</a> — {o.failure_reason ?? ORDER_STATUS[o.status].label}</li>)}</ul></div>}
    </div>
  )
}

function History({ bizId }: { bizId: string }) {
  const today = new Date().toISOString().slice(0, 10)
  const [f, setF] = useState({ from: new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10), to: today, status: '', channel: '', q: '' })
  const list = useLoad(async () => {
    let q = sb().from('orders').select('id, number, channel, status, payment_status, total, customer_name, customer_phone, created_at, created_by, invoice_no').eq('business_id', bizId)
      .gte('created_at', `${f.from}T00:00:00+05:30`).lte('created_at', `${f.to}T23:59:59+05:30`).order('created_at', { ascending: false }).limit(1000)
    if (f.status) q = q.eq('status', f.status)
    if (f.channel) q = q.eq('channel', f.channel)
    if (f.q) q = /^\d+$/.test(f.q) ? q.or(`number.eq.${f.q},customer_phone.ilike.%${f.q}%`) : q.ilike('customer_name', `%${f.q.replace(/[%,()]/g, ' ')}%`)
    return check(await q) as any[]
  }, [JSON.stringify(f)])
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }))
  return (
    <>
      <div class="p-row" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        <input type="date" value={f.from} onChange={(e) => set('from', (e.target as HTMLInputElement).value)} aria-label="From" />
        <input type="date" value={f.to} onChange={(e) => set('to', (e.target as HTMLInputElement).value)} aria-label="To" />
        <select value={f.status} onChange={(e) => set('status', (e.target as HTMLSelectElement).value)} aria-label="Status"><option value="">Any status</option>{Object.entries(ORDER_STATUS).map(([k, v]) => <option value={k} key={k}>{v.label}</option>)}</select>
        <select value={f.channel} onChange={(e) => set('channel', (e.target as HTMLSelectElement).value)} aria-label="Channel"><option value="">Any channel</option>{Object.entries(CHANNEL).map(([k, v]) => <option value={k} key={k}>{v}</option>)}</select>
        <input class="p-input" placeholder="Order no., phone or name" value={f.q} onInput={(e) => set('q', (e.target as HTMLInputElement).value)} style={{ maxWidth: '220px' }} />
        <span class="p-spacer" />
        <button class="btn btn-ghost p-btn" disabled={!list.data?.length} onClick={() => downloadCsv(`orders-${f.from}-${f.to}.csv`, list.data!.map((o) => ({ number: o.number, date: o.created_at, channel: o.channel, status: o.status, payment: o.payment_status, total: o.total, customer: o.customer_name, phone: o.customer_phone, invoice: o.invoice_no })))}>Export CSV</button>
      </div>
      <ErrorNote error={list.error} />
      {list.data?.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th>#</th><th>When</th><th>Type</th><th>Status</th><th>Payment</th><th class="num">Total</th><th>Customer</th></tr></thead>
          <tbody>{list.data.map((o) => (
            <tr key={o.id}>
              <td><a href={`/portal/orders/view/?id=${o.id}`}>{o.number}</a></td><td class="p-small">{dt(o.created_at)}</td><td>{CHANNEL[o.channel]}</td>
              <td><Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge></td><td class="p-small">{PAY_STATUS[o.payment_status]}</td>
              <td class="num">{inr(o.total)}</td><td class="p-small">{o.customer_name ?? '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : !list.loading && <Empty>No orders in this period.</Empty>}
    </>
  )
}

// ── Order detail ──────────────────────────────────────────────────────────
export function OrderView() {
  return (
    <Portal title="Order" need="business" module="orders">
      {(app) => <OrderBody app={app} id={qs('id') ?? ''} />}
    </Portal>
  )
}

function OrderBody({ app, id }: { app: ReturnType<typeof useApp>; id: string }) {
  const { busy, run } = useAction()
  const [paying, setPaying] = useState(false)
  const [refunding, setRefunding] = useState(false)
  const data = useLoad(async () => {
    const [o, ev, pay, ref, s] = await Promise.all([
      sb().from('orders').select('*, order_items(*)').eq('id', id).maybeSingle(),
      sb().from('order_events').select('*').eq('order_id', id).order('id'),
      sb().from('payments').select('*').eq('order_id', id).order('created_at'),
      sb().from('refunds').select('*').eq('order_id', id).order('created_at'),
      sb().from('commerce_settings').select('*').eq('business_id', app.bizId!).maybeSingle(),
    ])
    const order = check(o) as any
    if (!order) throw new Error('Order not found.')
    return { o: order, events: (ev.data ?? []) as any[], payments: (pay.data ?? []) as any[], refunds: (ref.data ?? []) as any[], settings: (s.data as any) ?? {} }
  }, [id])
  if (data.loading && !data.data) return <div class="p-loading">Loading…</div>
  if (data.error) return <ErrorNote error={data.error} />
  const { o, events, payments, refunds, settings } = data.data!
  const perm = (p: string) => app.isAdmin || app.biz!.role === 'owner' || app.biz!.permissions.includes(p)
  const pendingUpi = payments.find((p) => p.method === 'upi' && p.status === 'pending')
  const open = !['completed', 'cancelled', 'refunded', 'failed'].includes(o.status)

  return (
    <>
      <PageHead title={`Order #${o.number}`} sub={<>{dt(o.created_at)} · {CHANNEL[o.channel]}{o.table_label && ` ${o.table_label}`} · <Badge tone={ORDER_STATUS[o.status].tone}>{ORDER_STATUS[o.status].label}</Badge> <Badge tone={o.payment_status === 'paid' ? 'ok' : 'warn'}>{PAY_STATUS[o.payment_status]}</Badge></>}>
        <a class="btn btn-ghost p-btn" href="/portal/orders/">All orders</a>
      </PageHead>
      <div class="p-grid-2">
        <div class="p-stack">
          <div class="p-card">
            <h2>Items</h2>
            <div class="p-table-wrap"><table class="p-table">
              <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">GST</th><th class="num">Total</th></tr></thead>
              <tbody>{o.order_items.map((i: any) => <tr key={i.id}><td>{i.product_name}{i.variant_name !== 'Standard' && i.variant_name ? ` (${i.variant_name})` : ''}{i.notes && <div class="p-small p-muted">{i.notes}</div>}</td><td class="num">{i.qty}</td><td class="num">{inr(i.unit_price)}</td><td class="num">{i.tax_rate_pct}%</td><td class="num">{inr(i.line_total)}</td></tr>)}</tbody>
            </table></div>
            <dl class="pos-totals">
              <div><dt>Subtotal</dt><dd>{inr(o.subtotal)}</dd></div>
              {Number(o.discount_total) > 0 && <div><dt>Discount {o.discount_code}</dt><dd>−{inr(o.discount_total)}</dd></div>}
              <div><dt>GST{settings.prices_include_tax ? ' (included)' : ''}</dt><dd>{inr(o.tax_total)}</dd></div>
              {Number(o.shipping_total) > 0 && <div><dt>Shipping</dt><dd>{inr(o.shipping_total)}</dd></div>}
              <div class="pos-total"><dt>Total</dt><dd>{inr(o.total)}</dd></div>
            </dl>
            {(o.customer_name || o.customer_phone) && <p class="p-small">Customer: {o.customer_name} {o.customer_phone && <a href={`tel:${o.customer_phone}`}>{o.customer_phone}</a>}</p>}
            {o.notes && <p class="p-small">Note: {o.notes}</p>}
            {o.failure_reason && <div class="p-notice" data-tone="bad">{o.failure_reason}</div>}
          </div>
          <div class="p-card">
            <h2>Payments</h2>
            {payments.length ? <ul class="p-small">{payments.map((p) => <li key={p.id}>{p.method.toUpperCase()} {inr(p.amount)} — <strong>{p.status}</strong>{p.upi_ref && ` · UTR ${p.upi_ref}`}{p.change_due > 0 && ` · change ${inr(p.change_due)}`}{p.failure_reason && ` · ${p.failure_reason}`}{p.confirmed_at && ` · confirmed ${dt(p.confirmed_at)}`}</li>)}</ul> : <p class="p-small p-muted">No payments yet.</p>}
            {refunds.length > 0 && <ul class="p-small">{refunds.map((r) => <li key={r.id}>Refund {inr(r.amount)} — {r.reason} ({dt(r.created_at)}){r.restocked && ' · restocked'}</li>)}</ul>}
            <div class="p-row">
              {o.payment_status !== 'paid' && open && o.channel !== 'online' && (perm('pos.sell') || perm('orders.update')) && <button class="btn btn-ink p-btn" onClick={() => setPaying(true)}>{pendingUpi ? 'Confirm UPI payment' : 'Take payment'}</button>}
              {['paid', 'partially_refunded'].includes(o.payment_status) && perm('refunds.issue') && <button class="btn btn-ghost p-btn" onClick={() => setRefunding(true)}>Refund</button>}
              {o.invoice_no && <span class="p-small p-muted">Invoice {o.invoice_no}</span>}
            </div>
          </div>
        </div>
        <div class="p-stack">
          <div class="p-card p-form">
            <h2>Actions</h2>
            <div class="p-row">
              {perm('orders.update') && (NEXT_ACTION[o.status] ?? []).map(([to, l]) => <button key={to} class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { await transition(o, to, app.toast); await data.reload() })}>{l}</button>)}
              {perm('orders.update') && open && <button class="btn btn-ghost p-btn p-btn-danger" disabled={busy} onClick={() => { const r = prompt('Reason for cancelling (kept in the order history):'); if (r) run(async () => { if (await transition(o, 'cancelled', app.toast, r)) app.toast('Cancelled — stock returned'); await data.reload() }) }}>Cancel order</button>}
            </div>
            <div class="p-row">
              <a class="btn btn-ghost p-btn" href={`/portal/orders/receipt/?id=${o.id}&size=58`} target="_blank">Receipt 58 mm</a>
              <a class="btn btn-ghost p-btn" href={`/portal/orders/receipt/?id=${o.id}&size=80`} target="_blank">80 mm</a>
              <a class="btn btn-ghost p-btn" href={`/portal/orders/receipt/?id=${o.id}&size=a4`} target="_blank">A4 invoice</a>
            </div>
            {perm('orders.update') && (
              <form class="p-row" onSubmit={(e) => { const form = e.currentTarget as HTMLFormElement; const f = formData(e); run(async () => { check(await sb().rpc('add_order_note', { p_order: o.id, p_note: f.note })); form.reset(); await data.reload() }) }}>
                <input class="p-input" name="note" placeholder="Add a note to the history" required maxLength={300} style={{ flex: 1 }} /><button class="btn btn-ghost p-btn" disabled={busy}>Add</button>
              </form>
            )}
          </div>
          <div class="p-card">
            <h2>History</h2>
            <ol class="p-small" style={{ paddingLeft: '1.1rem' }}>{events.map((e) => <li key={e.id} style={{ marginBottom: '0.3rem' }}>{dt(e.at)} — <strong>{e.kind === 'status' || e.kind === 'created' ? ORDER_STATUS[e.to_status]?.label ?? e.to_status : `${e.kind}: ${e.to_status ?? ''}`}</strong> {e.actor_name && `by ${e.actor_name}`}{e.device && <span class="p-muted"> ({e.device})</span>}{e.reason && <div class="p-muted">{e.reason}</div>}</li>)}</ol>
          </div>
        </div>
      </div>
      {paying && <PaymentModal order={o} settings={settings} business={app.biz!.business_name} onDone={() => { setPaying(false); data.reload() }} onClose={() => { setPaying(false); data.reload() }} />}
      {refunding && (
        <Modal title={`Refund order #${o.number}`} onClose={() => setRefunding(false)}>
          <RefundForm order={o} paid={payments.filter((p) => p.status === 'paid').reduce((a, p) => a + Number(p.amount), 0) - refunds.reduce((a, r) => a + Number(r.amount), 0)} onDone={() => { setRefunding(false); data.reload() }} />
        </Modal>
      )}
    </>
  )
}

function RefundForm({ order, paid, onDone }: { order: any; paid: number; onDone: () => void }) {
  const { busy, run } = useAction()
  const key = useRef(newIdempotencyKey())
  return (
    <form class="p-form" onSubmit={(e) => {
      const f = formData(e)
      run(async () => { check(await sb().rpc('issue_refund', { p_order: order.id, p_amount: Number(f.amount), p_reason: f.reason, p_restock: !!f.restock, p_idempotency_key: key.current })); onDone() }, 'Refund recorded')
    }}>
      <Field label={`Amount (up to ${inr(paid)})`}><input name="amount" type="number" min="0.01" max={paid} step="0.01" defaultValue={String(paid)} required /></Field>
      <Field label="Reason"><input name="reason" required minLength={2} maxLength={300} /></Field>
      <label class="p-check"><input type="checkbox" name="restock" /> Put the items back in stock</label>
      <p class="p-small p-muted">This records the refund. Return the money to the customer by the same method (cash or UPI). Online (Razorpay) refunds are made in the Razorpay dashboard.</p>
      <button class="btn btn-ink p-btn" disabled={busy}>Record refund</button>
    </form>
  )
}

// ── Receipt / invoice ─────────────────────────────────────────────────────
export function Receipt() {
  return (
    <Portal title="Receipt" need="business" module="orders">
      {(app) => <ReceiptBody app={app} id={qs('id') ?? ''} size={qs('size') ?? '58'} />}
    </Portal>
  )
}

function ReceiptBody({ app, id, size }: { app: ReturnType<typeof useApp>; id: string; size: string }) {
  const data = useLoad(async () => {
    const o = check(await sb().from('orders').select('*, order_items(*)').eq('id', id).single()) as any
    const p = check(await sb().from('payments').select('method, amount').eq('order_id', id).eq('status', 'paid')) as any[]
    const s = (check(await sb().from('commerce_settings').select('*').eq('business_id', o.business_id).maybeSingle()) as any) ?? {}
    return { o, p, s }
  }, [id])
  useEffect(() => { if (data.data) setTimeout(() => print(), 400) }, [!!data.data])
  if (!data.data) return data.error ? <ErrorNote error={data.error} /> : <div class="p-loading">Loading…</div>
  const { o, p, s } = data.data
  const name = s.legal_name || app.biz?.business_name || ''
  if (size === 'a4') {
    return (
      <div class="print-area invoice">
        <div class="p-row"><div><h1 style={{ margin: 0 }}>{o.invoice_no ? 'Tax invoice' : 'Order summary'}</h1><p class="p-small">{o.invoice_no ? `Invoice ${o.invoice_no} · ${d(o.invoiced_at)}` : 'Not yet paid — invoice is issued on payment'}</p></div><span class="p-spacer" />
          <div style={{ textAlign: 'right' }}><strong>{name}</strong>{s.address && <div class="p-small">{s.address}</div>}{s.gstin && <div class="p-small">GSTIN {s.gstin}</div>}</div></div>
        <p class="p-small">Order #{o.number} · {dt(o.created_at)}{o.customer_name && ` · Bill to: ${o.customer_name}`}{o.customer_phone && ` (${o.customer_phone})`}{o.place_of_supply && ` · Place of supply: ${o.place_of_supply}`}</p>
        <table class="p-table">
          <thead><tr><th>Item</th><th>HSN/SAC</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST %</th><th class="num">Amount</th></tr></thead>
          <tbody>{o.order_items.map((i: any) => <tr key={i.id}><td>{i.product_name}{i.variant_name !== 'Standard' && i.variant_name ? ` (${i.variant_name})` : ''}</td><td>{i.hsn_sac ?? '—'}</td><td class="num">{i.qty}</td><td class="num">{inr(i.unit_price)}</td><td class="num">{i.tax_rate_pct}</td><td class="num">{inr(i.line_total)}</td></tr>)}</tbody>
        </table>
        <dl class="pos-totals" style={{ maxWidth: '22rem', marginLeft: 'auto' }}>
          <div><dt>Subtotal</dt><dd>{inr(o.subtotal)}</dd></div>
          {Number(o.discount_total) > 0 && <div><dt>Discount</dt><dd>−{inr(o.discount_total)}</dd></div>}
          {(o.tax_breakdown as any[]).map((t, i) => <div key={i}><dt>{t.igst != null ? `IGST ${t.rate}%` : `CGST ${t.rate / 2}% + SGST ${t.rate / 2}%`}</dt><dd>{t.igst != null ? inr(t.igst) : `${inr(t.cgst)} + ${inr(t.sgst)}`}</dd></div>)}
          {!(o.tax_breakdown as any[]).length && <div><dt>GST</dt><dd>{inr(o.tax_total)}</dd></div>}
          <div class="pos-total"><dt>Total</dt><dd>{inr(o.total)}</dd></div>
        </dl>
        <p class="p-small">Paid: {p.map((x) => `${x.method.toUpperCase()} ${inr(x.amount)}`).join(', ') || 'unpaid'}. {s.prices_include_tax ? 'Prices include GST.' : ''}</p>
        {s.receipt_footer && <p class="p-small">{s.receipt_footer}</p>}
        <p class="p-small p-muted">Generated by GST-aware software (not certified; no e-invoice IRN).</p>
        <button class="btn btn-ink p-btn no-print" onClick={() => print()}>Print</button>
      </div>
    )
  }
  const txt = receiptText({ business: name, number: o.number, created_at: o.created_at, items: o.order_items.map((i: any) => ({ name: i.product_name + (i.variant_name && i.variant_name !== 'Standard' ? ` ${i.variant_name}` : ''), qty: i.qty, line_total: Number(i.line_total) })), subtotal: Number(o.subtotal), discount_total: Number(o.discount_total), tax_total: Number(o.tax_total), total: Number(o.total), payments: p.map((x) => ({ method: x.method, amount: Number(x.amount) })), footer: s.receipt_footer }, size === '80' ? 48 : 32)
  return (
    <div class="print-area">
      <pre class={`thermal thermal-${size}`}>{txt}</pre>
      <button class="btn btn-ink p-btn no-print" onClick={() => print()}>Print</button>
    </div>
  )
}
