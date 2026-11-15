// Back office: products & menu, inventory, customers, discounts, sales reports, POS/invoice settings.
import { useMemo, useState } from 'preact/hooks'
import { slugify } from '../../lib/markdown'
import { check, d, downloadCsv, dt, inr, mediaUrl, safeName, sb, upload } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Portal, Stat, useAction, useApp, useLoad, formData } from '../ui'

// ── Products ──────────────────────────────────────────────────────────────
export function Products() {
  return (
    <Portal title="Products & menu" need="business" module="orders" perm="products.manage">
      {(app) => <ProductsBody app={app} />}
    </Portal>
  )
}

function ProductsBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [edit, setEdit] = useState<any>(null)
  const [q, setQ] = useState('')
  const data = useLoad(async () => {
    const [cats, taxes, prods] = await Promise.all([
      sb().from('product_categories').select('*').eq('business_id', bizId).order('sort'),
      sb().from('tax_rates').select('*').eq('business_id', bizId).order('rate_pct'),
      sb().from('products').select('*, product_variants(*)').eq('business_id', bizId).order('sort').order('name'),
    ])
    return { cats: check(cats) as any[], taxes: check(taxes) as any[], prods: check(prods) as any[] }
  }, [bizId])
  const x = data.data
  const rows = (x?.prods ?? []).filter((p) => !q || `${p.name} ${p.product_variants.map((v: any) => `${v.sku ?? ''} ${v.barcode ?? ''}`).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  const ecommerce = app.biz?.modules.includes('ecommerce')
  const kitchen = app.biz?.modules.includes('kitchen_display')

  return (
    <>
      <PageHead title="Products & menu" sub="What you sell. Prices are checked by the server on every order.">
        <button class="btn btn-ink p-btn" onClick={() => setEdit({ product_variants: [{ name: 'Standard', price: '' }] })}>Add product</button>
      </PageHead>
      <ErrorNote error={data.error} />
      <div class="p-grid-2" style={{ marginBottom: '1rem' }}>
        <ListEditor title="Categories" rows={x?.cats ?? []} label={(c) => c.name} onAdd={(name) => run(async () => { check(await sb().from('product_categories').insert({ business_id: bizId, name, sort: (x?.cats.length ?? 0) * 10 })); await data.reload() }, 'Added')}
          onRemove={(c) => run(async () => { check(await sb().from('product_categories').delete().eq('id', c.id)); await data.reload() }, 'Removed')} placeholder="e.g. South Indian" busy={busy} />
        <ListEditor title="GST rates" rows={x?.taxes ?? []} label={(t) => `${t.name} (${t.rate_pct}%)`} placeholder="e.g. GST 5% = 5"
          onAdd={(v) => { const m = v.match(/^(.*?)(?:=|\s)\s*([\d.]+)\s*%?$/); if (!m) return app.toast('Type a name and rate, e.g. “GST 5% = 5”', 'bad'); run(async () => { check(await sb().from('tax_rates').insert({ business_id: bizId, name: m[1].trim() || `GST ${m[2]}%`, rate_pct: Number(m[2]) })); await data.reload() }, 'Added') }}
          onRemove={(t) => run(async () => { check(await sb().from('tax_rates').delete().eq('id', t.id)); await data.reload() }, 'Removed')} busy={busy}
          note="Set the rates that apply to your products. Tomorrow Web doesn’t hard-code GST rates — check with your accountant." />
      </div>
      <input class="p-input" placeholder="Search name, SKU or barcode" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ maxWidth: '320px', marginBottom: '1rem' }} />
      {rows.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th>Product</th><th>Variants & prices</th><th>Stock</th><th></th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.name}</strong> {!p.active && <Badge>hidden</Badge>} {p.online && <Badge tone="ai">online</Badge>} {p.fulfilment === 'printify' && <Badge tone="warn">Printify</Badge>}
                <div class="p-small p-muted">{[x!.cats.find((c) => c.id === p.category_id)?.name, x!.taxes.find((t) => t.id === p.tax_rate_id)?.name, p.station && `station: ${p.station}`].filter(Boolean).join(' · ')}</div></td>
              <td class="p-small">{p.product_variants.map((v: any) => <div key={v.id}>{v.name !== 'Standard' && `${v.name}: `}{inr(v.price)}{v.sku && <span class="p-muted"> · {v.sku}</span>}</div>)}</td>
              <td class="p-small">{p.product_variants.filter((v: any) => v.track_stock).map((v: any) => <div key={v.id} style={v.low_stock_at != null && v.stock <= v.low_stock_at ? { color: 'var(--danger)' } : undefined}>{v.name !== 'Standard' && `${v.name}: `}{v.stock}</div>)}{!p.product_variants.some((v: any) => v.track_stock) && <span class="p-muted">not tracked</span>}</td>
              <td><button class="btn btn-ghost p-btn" onClick={() => setEdit(p)}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : !data.loading && <Empty>No products yet.</Empty>}
      {edit && x && <ProductForm p={edit} cats={x.cats} taxes={x.taxes} bizId={bizId} ecommerce={!!ecommerce} kitchen={!!kitchen} printify={!!app.biz?.modules.includes('printify')} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); await data.reload() }} />}
    </>
  )
}

function ListEditor({ title, rows, label, onAdd, onRemove, placeholder, busy, note }: { title: string; rows: any[]; label: (r: any) => string; onAdd: (v: string) => void; onRemove: (r: any) => void; placeholder: string; busy: boolean; note?: string }) {
  return (
    <div class="p-card">
      <h3>{title}</h3>
      <div class="p-row" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>{rows.map((r) => <span class="p-badge" key={r.id}>{label(r)} <button class="p-link" aria-label={`Remove ${label(r)}`} disabled={busy} onClick={() => confirm(`Remove ${label(r)}?`) && onRemove(r)}>×</button></span>)}</div>
      <form class="p-row" style={{ marginTop: '0.5rem' }} onSubmit={(e) => { const form = e.currentTarget as HTMLFormElement; const f = formData(e); if (f.v.trim()) { onAdd(f.v.trim()); form.reset() } }}>
        <input class="p-input" name="v" placeholder={placeholder} style={{ flex: 1 }} /><button class="btn btn-ghost p-btn" disabled={busy}>Add</button>
      </form>
      {note && <p class="p-small p-muted" style={{ margin: '0.5rem 0 0' }}>{note}</p>}
    </div>
  )
}

function ProductForm({ p, cats, taxes, bizId, ecommerce, kitchen, printify, onClose, onSaved }: { p: any; cats: any[]; taxes: any[]; bizId: string; ecommerce: boolean; kitchen: boolean; printify: boolean; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  const [vars, setVars] = useState<any[]>(p.product_variants.map((v: any) => ({ ...v })))
  const [image, setImage] = useState<string | null>(p.image_path ?? null)
  const setV = (i: number, k: string, v: unknown) => setVars((xs) => xs.map((x, j) => (j === i ? { ...x, [k]: v } : x)))
  return (
    <Modal title={p.id ? `Edit ${p.name}` : 'Add product'} onClose={onClose}>
      <form class="p-form" onSubmit={(e) => {
        const f = formData(e)
        run(async () => {
          if (!vars.length) throw new Error('Add at least one variant.')
          const row = {
            business_id: bizId, name: f.name.trim(), description: f.description.trim() || null, category_id: f.category_id || null, tax_rate_id: f.tax_rate_id || null,
            hsn_sac: f.hsn_sac.trim() || null, kind: f.kind, station: f.station?.trim() || null, active: !!f.active, online: !!f.online, image_path: image,
            slug: f.online ? slugify(f.slug || f.name) : p.slug ?? null, fulfilment: f.fulfilment || 'own_stock',
          }
          const saved = p.id ? (check(await sb().from('products').update(row).eq('id', p.id).select('id').single()) as any) : (check(await sb().from('products').insert(row).select('id').single()) as any)
          for (const v of vars) {
            const vr = { product_id: saved.id, name: (v.name || 'Standard').trim(), price: Number(v.price), sku: v.sku?.trim() || null, barcode: v.barcode?.trim() || null,
              track_stock: !!v.track_stock, low_stock_at: v.low_stock_at === '' || v.low_stock_at == null ? null : Number(v.low_stock_at), active: v.active !== false, options: v.options ?? {} }
            if (!(vr.price >= 0) || v.price === '') throw new Error(`Set a price for “${vr.name}”.`)
            if (v._delete && v.id) check(await sb().from('product_variants').delete().eq('id', v.id))
            else if (v.id) check(await sb().from('product_variants').update(vr).eq('id', v.id))
            else if (!v._delete) check(await sb().from('product_variants').insert(vr))
          }
          await onSaved()
        }, 'Saved')
      }}>
        <div class="row2">
          <Field label="Name"><input name="name" required maxLength={160} defaultValue={p.name ?? ''} /></Field>
          <Field label="Category"><select name="category_id" defaultValue={p.category_id ?? ''}><option value="">—</option>{cats.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <div class="row2">
          <Field label="GST rate"><select name="tax_rate_id" defaultValue={p.tax_rate_id ?? ''}><option value="">No GST</option>{taxes.map((t) => <option value={t.id} key={t.id}>{t.name}</option>)}</select></Field>
          <Field label="HSN / SAC code (optional)"><input name="hsn_sac" pattern="[0-9]{4,8}" defaultValue={p.hsn_sac ?? ''} /></Field>
        </div>
        <div class="row2">
          <Field label="Type"><select name="kind" defaultValue={p.kind ?? 'good'}><option value="good">Product</option><option value="service">Service</option></select></Field>
          {kitchen && <Field label="Kitchen station" hint="e.g. kitchen, bar, dessert"><input name="station" maxLength={40} defaultValue={p.station ?? ''} /></Field>}
        </div>
        <Field label="Description"><textarea name="description" rows={2} maxLength={4000} defaultValue={p.description ?? ''} /></Field>
        <div class="p-row">
          {image && <img src={mediaUrl(image)} alt="" style={{ width: '64px', height: '64px', objectFit: 'cover', borderRadius: '8px' }} />}
          <label class="btn btn-ghost p-btn" style={{ cursor: 'pointer' }}>{image ? 'Replace photo' : 'Add photo'}
            <input type="file" hidden accept="image/jpeg,image/png,image/webp,image/avif" onChange={(e) => { const file = (e.target as HTMLInputElement).files?.[0]; if (file) run(async () => { if (file.size > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB.'); setImage(await upload('media', `${bizId}/products/${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`, file)) }, 'Uploaded') }} />
          </label>
        </div>
        <fieldset class="p-card"><legend class="p-small">Variants (sizes, colours, portions)</legend>
          <div class="p-stack" style={{ gap: '0.5rem' }}>
            {vars.map((v, i) => !v._delete && (
              <div key={i} class="variant-row">
                <input aria-label="Variant name" placeholder="Name (e.g. Black / M)" value={v.name} onInput={(e) => setV(i, 'name', (e.target as HTMLInputElement).value)} />
                <input aria-label="Price" type="number" min="0" step="0.01" placeholder="Price ₹" value={v.price} onInput={(e) => setV(i, 'price', (e.target as HTMLInputElement).value)} />
                <input aria-label="SKU" placeholder="SKU" value={v.sku ?? ''} onInput={(e) => setV(i, 'sku', (e.target as HTMLInputElement).value)} />
                <input aria-label="Barcode" placeholder="Barcode" value={v.barcode ?? ''} onInput={(e) => setV(i, 'barcode', (e.target as HTMLInputElement).value)} />
                <label class="p-check"><input type="checkbox" checked={!!v.track_stock} onChange={(e) => setV(i, 'track_stock', (e.target as HTMLInputElement).checked)} /> Track stock</label>
                {v.track_stock && <input aria-label="Low stock alert at" type="number" min="0" placeholder="Alert at" value={v.low_stock_at ?? ''} onInput={(e) => setV(i, 'low_stock_at', (e.target as HTMLInputElement).value)} />}
                <button type="button" class="p-link" onClick={() => setV(i, '_delete', true)} aria-label="Remove variant">Remove</button>
              </div>
            ))}
          </div>
          <button type="button" class="btn btn-ghost p-btn" style={{ marginTop: '0.5rem' }} onClick={() => setVars((xs) => [...xs, { name: '', price: '' }])}>Add variant</button>
          <p class="p-small p-muted">Stock quantities are changed under Inventory so every change is recorded.</p>
        </fieldset>
        {ecommerce && (
          <div class="row2">
            <label class="p-check"><input type="checkbox" name="online" defaultChecked={p.online} /> Sell in the online store</label>
            <Field label="Store address (slug)"><input name="slug" defaultValue={p.slug ?? ''} placeholder="auto from name" /></Field>
          </div>
        )}
        {printify && <Field label="Fulfilment"><select name="fulfilment" defaultValue={p.fulfilment ?? 'own_stock'}><option value="own_stock">Own stock</option><option value="printify">Printify (print on demand)</option></select></Field>}
        <label class="p-check"><input type="checkbox" name="active" defaultChecked={p.active ?? true} /> Available for sale</label>
        <div class="p-row">
          <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          {p.id && <button type="button" class="btn btn-ghost p-btn p-btn-danger" disabled={busy} onClick={() => confirm('Delete this product? Past orders keep their details.') && run(async () => { check(await sb().from('products').delete().eq('id', p.id)); await onSaved() }, 'Deleted')}>Delete</button>}
        </div>
      </form>
    </Modal>
  )
}

// ── Inventory ─────────────────────────────────────────────────────────────
export function Inventory() {
  return (
    <Portal title="Inventory" need="business" module="inventory" perm="inventory.manage">
      {(app) => <InventoryBody app={app} />}
    </Portal>
  )
}

function InventoryBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [adjust, setAdjust] = useState<any>(null)
  const [drift, setDrift] = useState<any[] | null>(null)
  const data = useLoad(async () => {
    const [vars, moves] = await Promise.all([
      sb().from('product_variants').select('id, name, sku, stock, track_stock, low_stock_at, products(name)').eq('business_id', bizId).order('stock'),
      sb().from('stock_movements').select('id, qty, reason, note, created_at, order_id, variant_id').eq('business_id', bizId).order('created_at', { ascending: false }).limit(100),
    ])
    return { vars: check(vars) as any[], moves: check(moves) as any[] }
  }, [bizId])
  const x = data.data
  const tracked = (x?.vars ?? []).filter((v) => v.track_stock)
  const low = tracked.filter((v) => v.low_stock_at != null && v.stock <= v.low_stock_at)
  const name = (v: any) => `${v.products?.name}${v.name !== 'Standard' ? ` — ${v.name}` : ''}`
  return (
    <>
      <PageHead title="Inventory" sub="Stock goes down with every sale and back up on cancellations and refunds.">
        <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => setDrift(check(await sb().rpc('check_stock_integrity', { p_business: bizId })) as any[]))}>Check stock records</button>
      </PageHead>
      {drift && (drift.length ? <div class="p-notice" data-tone="bad">Stock records don’t match for: {drift.map((r) => r.name).join(', ')}. Contact Tomorrow Web.</div> : <div class="p-notice" data-tone="ok">All stock counts match their history.</div>)}
      {low.length > 0 && <div class="p-notice" data-tone="warn" style={{ margin: '1rem 0' }}>Low stock: {low.map((v) => `${name(v)} (${v.stock})`).join(', ')}</div>}
      <ErrorNote error={data.error} />
      <div class="p-grid-2">
        <div class="p-card">
          <h2>Stock levels</h2>
          {(x?.vars ?? []).length ? (
            <div class="p-table-wrap"><table class="p-table">
              <thead><tr><th>Item</th><th class="num">In stock</th><th></th></tr></thead>
              <tbody>{x!.vars.map((v) => (
                <tr key={v.id}><td>{name(v)}{v.sku && <div class="p-small p-muted">{v.sku}</div>}</td>
                  <td class="num">{v.track_stock ? <span style={v.low_stock_at != null && v.stock <= v.low_stock_at ? { color: 'var(--danger)' } : undefined}>{v.stock}</span> : <span class="p-muted">—</span>}</td>
                  <td><button class="btn btn-ghost p-btn" onClick={() => setAdjust(v)}>{v.track_stock ? 'Adjust' : 'Start tracking'}</button></td></tr>
              ))}</tbody>
            </table></div>
          ) : <Empty>No products yet.</Empty>}
        </div>
        <div class="p-card">
          <h2>Recent movements</h2>
          {x?.moves.length ? <ul class="p-small" style={{ paddingLeft: '1rem' }}>{x.moves.map((m) => { const v = x.vars.find((y) => y.id === m.variant_id); return <li key={m.id}>{dt(m.created_at)} — {m.qty > 0 ? `+${m.qty}` : m.qty} {v ? name(v) : ''} <span class="p-muted">({m.reason}{m.note ? `: ${m.note}` : ''})</span></li> })}</ul> : <p class="p-muted">None yet.</p>}
        </div>
      </div>
      {adjust && (
        <Modal title={`Stock — ${name(adjust)}`} onClose={() => setAdjust(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const delta = f.mode === 'set' ? Number(f.qty) - (adjust.track_stock ? adjust.stock : 0) : Number(f.qty) * (f.mode === 'remove' ? -1 : 1)
            run(async () => { if (!delta) throw new Error('Nothing to change.'); check(await sb().rpc('adjust_stock', { p_variant: adjust.id, p_delta: delta, p_reason: f.reason, p_note: f.note || null })); setAdjust(null); await data.reload() }, 'Stock updated')
          }}>
            <p>Currently: <strong>{adjust.track_stock ? adjust.stock : 'not tracked'}</strong></p>
            <div class="row2">
              <Field label="Change"><select name="mode"><option value="add">Add</option><option value="remove">Remove</option><option value="set">Set to</option></select></Field>
              <Field label="Quantity"><input name="qty" type="number" min="0" step="1" required /></Field>
            </div>
            <Field label="Reason"><select name="reason"><option value="receive">Received delivery</option><option value="adjust">Count correction</option><option value="expired">Expired / damaged</option><option value="opening">Opening stock</option></select></Field>
            <Field label="Note"><input name="note" maxLength={300} /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}

// ── Customers ─────────────────────────────────────────────────────────────
export function Customers() {
  return (
    <Portal title="Customers" need="business" module="orders" perm="customers.view">
      {(app) => <CustomersBody bizId={app.bizId!} />}
    </Portal>
  )
}

function CustomersBody({ bizId }: { bizId: string }) {
  const [q, setQ] = useState('')
  const list = useLoad(async () => {
    const cs = check(await sb().from('customers').select('*').eq('business_id', bizId).order('created_at', { ascending: false }).limit(2000)) as any[]
    const os = check(await sb().from('orders').select('customer_id, total, created_at').eq('business_id', bizId).not('customer_id', 'is', null).in('payment_status', ['paid', 'partially_refunded']).limit(10000)) as any[]
    return cs.map((c) => { const mine = os.filter((o) => o.customer_id === c.id); return { ...c, orders: mine.length, spent: mine.reduce((a, o) => a + Number(o.total), 0), last: mine.map((o) => o.created_at).sort().pop() } })
  }, [bizId])
  const rows = (list.data ?? []).filter((c) => !q || `${c.name} ${c.phone} ${c.email}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <PageHead title="Customers" sub="Saved from orders when a phone number is given.">
        <button class="btn btn-ghost p-btn" disabled={!rows.length} onClick={() => downloadCsv('customers.csv', rows.map((c) => ({ name: c.name, phone: c.phone, email: c.email, orders: c.orders, spent: c.spent, last_order: c.last })))}>Export CSV</button>
      </PageHead>
      <input class="p-input" placeholder="Search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ maxWidth: '320px', marginBottom: '1rem' }} />
      {rows.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th>Customer</th><th>Phone</th><th class="num">Orders</th><th class="num">Spent</th><th>Last order</th></tr></thead>
          <tbody>{rows.map((c) => <tr key={c.id}><td>{c.name ?? '—'}<div class="p-small p-muted">{c.email}</div></td><td>{c.phone}</td><td class="num">{c.orders}</td><td class="num">{inr(c.spent)}</td><td class="p-small">{c.last ? d(c.last) : '—'}</td></tr>)}</tbody>
        </table></div>
      ) : !list.loading && <Empty>No customers yet.</Empty>}
    </>
  )
}

// ── Discounts ─────────────────────────────────────────────────────────────
export function Discounts() {
  return (
    <Portal title="Discounts" need="business" module="orders" perm="discounts.manage">
      {(app) => <DiscountsBody bizId={app.bizId!} />}
    </Portal>
  )
}

function DiscountsBody({ bizId }: { bizId: string }) {
  const { busy, run } = useAction()
  const [edit, setEdit] = useState<any>(null)
  const list = useLoad(async () => check(await sb().from('discounts').select('*').eq('business_id', bizId).order('created_at', { ascending: false })) as any[], [bizId])
  return (
    <>
      <PageHead title="Discounts" sub="Codes staff can apply at the till (and customers online). Changes are recorded in the audit log.">
        <button class="btn btn-ink p-btn" onClick={() => setEdit({})}>New code</button>
      </PageHead>
      {list.data?.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th>Code</th><th>Discount</th><th>Rules</th><th class="num">Used</th><th></th></tr></thead>
          <tbody>{list.data.map((c) => (
            <tr key={c.id}><td><code>{c.code}</code> {!c.active && <Badge>off</Badge>}</td><td>{c.kind === 'percent' ? `${c.value}%` : inr(c.value)}</td>
              <td class="p-small">{Number(c.min_subtotal) > 0 && `min ${inr(c.min_subtotal)} · `}{c.ends_at ? `until ${d(c.ends_at)}` : 'no end date'}{c.max_uses && ` · max ${c.max_uses}`}</td>
              <td class="num">{c.uses}</td><td><button class="btn btn-ghost p-btn" onClick={() => setEdit(c)}>Edit</button></td></tr>
          ))}</tbody>
        </table></div>
      ) : !list.loading && <Empty>No discount codes.</Empty>}
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.code}` : 'New discount code'} onClose={() => setEdit(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const row = { business_id: bizId, code: f.code.trim().toUpperCase(), kind: f.kind, value: Number(f.value), min_subtotal: Number(f.min_subtotal || 0), max_uses: f.max_uses ? Number(f.max_uses) : null, ends_at: f.ends_at ? new Date(`${f.ends_at}T23:59:59+05:30`).toISOString() : null, active: !!f.active }
            run(async () => {
              if (edit.id) { const { business_id, ...upd } = row; check(await sb().from('discounts').update(upd).eq('id', edit.id)) } else check(await sb().from('discounts').insert(row))
              setEdit(null); await list.reload()
            }, 'Saved')
          }}>
            <div class="row2">
              <Field label="Code"><input name="code" required pattern="[A-Za-z0-9_-]{2,30}" defaultValue={edit.code ?? ''} /></Field>
              <Field label="Type"><select name="kind" defaultValue={edit.kind ?? 'percent'}><option value="percent">Percent off</option><option value="amount">Amount off (₹)</option></select></Field>
            </div>
            <div class="row2">
              <Field label="Value"><input name="value" type="number" min="0.01" step="0.01" required defaultValue={edit.value ?? ''} /></Field>
              <Field label="Minimum order (₹)"><input name="min_subtotal" type="number" min="0" step="1" defaultValue={edit.min_subtotal ?? 0} /></Field>
            </div>
            <div class="row2">
              <Field label="Max uses (optional)"><input name="max_uses" type="number" min="1" defaultValue={edit.max_uses ?? ''} /></Field>
              <Field label="Ends on (optional)"><input name="ends_at" type="date" defaultValue={edit.ends_at ? edit.ends_at.slice(0, 10) : ''} /></Field>
            </div>
            <label class="p-check"><input type="checkbox" name="active" defaultChecked={edit.active ?? true} /> Active</label>
            <div class="p-row">
              <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
              {edit.id && <button type="button" class="btn btn-ghost p-btn p-btn-danger" disabled={busy} onClick={() => confirm('Delete this code?') && run(async () => { check(await sb().from('discounts').delete().eq('id', edit.id)); setEdit(null); await list.reload() }, 'Deleted')}>Delete</button>}
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

// ── Reports ───────────────────────────────────────────────────────────────
export function Reports() {
  return (
    <Portal title="Reports" need="business" module="orders" perm="reports.view">
      {(app) => <ReportsBody bizId={app.bizId!} />}
    </Portal>
  )
}

function ReportsBody({ bizId }: { bizId: string }) {
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)
  const [range, setRange] = useState({ from: today, to: today })
  const r = useLoad(async () => check(await sb().rpc('sales_report', { p_business: bizId, p_from: range.from, p_to: range.to })) as any, [bizId, range.from, range.to])
  const preset = (days: number) => setRange({ from: new Date(Date.now() + 5.5 * 3600_000 - days * 86400_000).toISOString().slice(0, 10), to: today })
  const x = r.data
  const max = useMemo(() => Math.max(1, ...((x?.by_day ?? []) as any[]).map((dd) => Number(dd.total))), [x])
  return (
    <>
      <PageHead title="Sales reports" sub="Paid orders only. Calculated live from your orders." />
      <div class="p-row" style={{ marginBottom: '1rem', flexWrap: 'wrap' }}>
        <button class="btn btn-ghost p-btn" onClick={() => preset(0)}>Today</button>
        <button class="btn btn-ghost p-btn" onClick={() => preset(6)}>Last 7 days</button>
        <button class="btn btn-ghost p-btn" onClick={() => preset(29)}>Last 30 days</button>
        <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: (e.target as HTMLInputElement).value })} aria-label="From" />
        <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: (e.target as HTMLInputElement).value })} aria-label="To" />
      </div>
      <ErrorNote error={r.error} />
      {x && (
        <>
          <div class="p-grid" style={{ marginBottom: '1rem' }}>
            <Stat n={inr(x.totals.gross)} label="Sales (incl. GST)" />
            <Stat n={x.totals.orders} label="Paid orders" />
            <Stat n={inr(x.totals.average)} label="Average order" />
            <Stat n={inr(x.totals.tax)} label="GST collected" />
            <Stat n={inr(x.totals.discounts)} label="Discounts given" />
            <Stat n={inr(x.refunds)} label="Refunds" />
            <Stat n={x.totals.cancelled} label="Cancelled orders" />
          </div>
          <div class="p-grid-2">
            <div class="p-card">
              <h2>By day</h2>
              {(x.by_day as any[]).length ? <div class="p-stack" style={{ gap: '0.4rem' }}>{(x.by_day as any[]).map((dd) => <div key={dd.day} class="crm-bar"><span class="p-small" style={{ width: '7rem' }}>{d(dd.day)}</span><span class="crm-bar-fill" style={{ width: `${(Number(dd.total) / max) * 100}%` }} /><span class="p-small">{inr(dd.total)} · {dd.orders}</span></div>)}</div> : <p class="p-muted">No sales.</p>}
            </div>
            <div class="p-card">
              <h2>Top items</h2>
              {(x.top_products as any[]).length ? <ol class="p-small">{(x.top_products as any[]).map((t, i) => <li key={i}>{t.name} — {t.qty} sold · {inr(t.total)}</li>)}</ol> : <p class="p-muted">No sales.</p>}
              <h3>Payment methods</h3>
              <ul class="p-small">{Object.entries(x.by_method).map(([k, v]) => <li key={k}>{k.toUpperCase()}: {inr(v as number)}</li>)}</ul>
            </div>
          </div>
        </>
      )}
    </>
  )
}

// ── POS & invoice settings (shown on the Business settings page) ──────────
export function CommerceSettings({ bizId }: { bizId: string }) {
  const { busy, run } = useAction()
  const s = useLoad(async () => (check(await sb().from('commerce_settings').select('*').eq('business_id', bizId).maybeSingle()) as any) ?? null, [bizId])
  if (s.loading) return null
  const v = s.data ?? {}
  return (
    <form class="p-card p-form" style={{ marginTop: '1rem' }} onSubmit={(e) => {
      const f = formData(e)
      const row = { legal_name: f.legal_name.trim() || null, address: f.address.trim() || null, gstin: f.gstin.trim().toUpperCase() || null, state_code: f.state_code.trim() || null, prices_include_tax: f.prices_include_tax === 'yes',
        invoice_prefix: f.invoice_prefix.trim() || 'INV-', upi_id: f.upi_id.trim() || null, upi_name: f.upi_name.trim() || null, receipt_footer: f.receipt_footer.trim() || null, unpaid_online_expiry_minutes: Number(f.expiry || 30) }
      run(async () => {
        if (s.data) check(await sb().from('commerce_settings').update(row).eq('business_id', bizId))
        else check(await sb().from('commerce_settings').insert({ business_id: bizId, ...row }))
        await s.reload()
      }, 'Saved')
    }}>
      <h2>POS & invoices</h2>
      <div class="row2">
        <Field label="Legal / registered name"><input name="legal_name" defaultValue={v.legal_name ?? ''} maxLength={200} /></Field>
        <Field label="GSTIN (optional)"><input name="gstin" pattern="[0-9]{2}[A-Za-z0-9]{13}" defaultValue={v.gstin ?? ''} /></Field>
      </div>
      <Field label="Address on invoices"><textarea name="address" rows={2} maxLength={500} defaultValue={v.address ?? ''} /></Field>
      <div class="row2">
        <Field label="State code" hint="e.g. 27 for Maharashtra — decides CGST+SGST vs IGST"><input name="state_code" pattern="[0-9]{2}" defaultValue={v.state_code ?? ''} /></Field>
        <Field label="Prices include GST?"><select name="prices_include_tax" defaultValue={v.prices_include_tax === false ? 'no' : 'yes'}><option value="yes">Yes (MRP-style)</option><option value="no">No, add GST on top</option></select></Field>
      </div>
      <div class="row2">
        <Field label="UPI ID for QR payments"><input name="upi_id" defaultValue={v.upi_id ?? ''} placeholder="yourshop@okicici" /></Field>
        <Field label="Name shown in UPI apps"><input name="upi_name" defaultValue={v.upi_name ?? ''} maxLength={60} /></Field>
      </div>
      <div class="row2">
        <Field label="Invoice number prefix"><input name="invoice_prefix" defaultValue={v.invoice_prefix ?? 'INV-'} maxLength={12} /></Field>
        <Field label="Unpaid online orders expire after (minutes)"><input name="expiry" type="number" min="5" max="1440" defaultValue={v.unpaid_online_expiry_minutes ?? 30} /></Field>
      </div>
      <Field label="Receipt footer"><input name="receipt_footer" maxLength={300} defaultValue={v.receipt_footer ?? ''} placeholder="Thank you! Visit again." /></Field>
      <p class="p-small p-muted">GST-aware, not certified GST-compliant software: no e-invoicing (IRN) or e-way bills. UPI payments are confirmed by your staff after checking that the money arrived.</p>
      <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
    </form>
  )
}
