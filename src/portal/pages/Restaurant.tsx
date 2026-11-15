// Restaurant / services configurations: kitchen display, tables, appointments.
import { useEffect, useMemo, useState } from 'preact/hooks'
import { check, dt, inr, qs, sb } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Portal, useAction, useApp, useLoad, formData } from '../ui'
import { useLiveOrders } from './Pos'

// ── Kitchen display ───────────────────────────────────────────────────────
export function Kitchen() {
  return (
    <Portal title="Kitchen display" need="business" module="kitchen_display" perm="orders.view">
      {(app) => <KitchenBody app={app} />}
    </Portal>
  )
}

const KDS_NEXT: Record<string, string> = { queued: 'Start', preparing: 'Ready', ready: 'Served' }
const age = (iso: string, now: number) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000))

function KitchenBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const [station, setStation] = useState(() => { try { return localStorage.getItem('tw-kds-station') ?? '' } catch { return '' } })
  const [now, setNow] = useState(Date.now())
  const [sound, setSound] = useState(true)
  const [full, setFull] = useState(false)
  const { busy, run } = useAction()
  const live = useLiveOrders(bizId, () => { if (sound) chime(); navigator.vibrate?.(150) })
  const canBump = app.isAdmin || app.biz!.role === 'owner' || app.biz!.permissions.includes('orders.update')

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])
  useEffect(() => { try { localStorage.setItem('tw-kds-station', station) } catch { /* ignore */ } }, [station])
  // Keep the tablet screen awake while the kitchen display is open.
  useEffect(() => {
    let lock: any = null
    const req = async () => { try { lock = await (navigator as any).wakeLock?.request('screen') } catch { /* unsupported */ } }
    req()
    const vis = () => document.visibilityState === 'visible' && req()
    document.addEventListener('visibilitychange', vis)
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release?.() }
  }, [])

  const stations = useMemo(() => [...new Set((live.orders ?? []).flatMap((o) => o.order_items.map((i: any) => i.station ?? '')).filter(Boolean))].sort(), [live.orders])
  const tickets = (live.orders ?? [])
    .filter((o) => ['new', 'accepted', 'processing', 'ready'].includes(o.status))
    .map((o) => ({ ...o, items: o.order_items.filter((i: any) => (!station || (i.station ?? '') === station) && i.kds_status !== 'served') }))
    .filter((o) => o.items.length)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const col = (st: readonly string[]) => tickets.filter((t) => t.items.some((i: any) => st.includes(i.kds_status)))

  return (
    <div class={`kds${full ? ' kds-full' : ''}`}>
      <div class="p-row kds-bar">
        <h1 style={{ margin: 0, fontSize: '1.3rem' }}>Kitchen</h1>
        {live.connected ? <Badge tone="ok">live</Badge> : <Badge tone="warn">reconnecting…</Badge>}
        <select value={station} onChange={(e) => setStation((e.target as HTMLSelectElement).value)} aria-label="Station">
          <option value="">All stations</option>{stations.map((s) => <option key={s}>{s}</option>)}
        </select>
        <span class="p-spacer" />
        <label class="p-check"><input type="checkbox" checked={sound} onChange={(e) => setSound((e.target as HTMLInputElement).checked)} /> Sound</label>
        {canBump && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().rpc('kds_recall', { p_business: bizId, p_station: station || null })); await live.reload() }, 'Recalled last bump')}>↶ Recall</button>}
        <button class="btn btn-ghost p-btn" onClick={() => { setFull(!full); if (!full) document.documentElement.requestFullscreen?.().catch(() => {}); else document.exitFullscreen?.().catch(() => {}) }}>{full ? 'Exit full screen' : 'Full screen'}</button>
      </div>
      {!live.orders ? <div class="p-loading">Loading…</div> : !tickets.length ? <Empty>No open tickets. New orders appear here instantly.</Empty> : (
        <div class="kds-cols">
          {([['New', ['queued']], ['Preparing', ['preparing']], ['Ready', ['ready']]] as [string, string[]][]).map(([label, sts]) => (
            <section key={label} class="kds-col" aria-label={label}>
              <h2>{label} <span class="p-muted">{col(sts).length}</span></h2>
              {col(sts).map((t) => {
                const mins = age(t.created_at, now)
                return (
                  <article key={t.id} class={`kds-ticket ${mins >= 20 ? 'is-late' : mins >= 10 ? 'is-warn' : ''}`}>
                    <header class="p-row">
                      <strong>#{t.number}</strong>
                      <span>{t.channel === 'table' ? `Table ${t.table_label ?? ''}` : t.channel === 'takeaway' ? 'Takeaway' : t.channel === 'online' ? 'Online' : t.channel === 'delivery' ? 'Delivery' : 'Counter'}</span>
                      <span class="p-spacer" /><span class="kds-age">{mins} min</span>
                    </header>
                    <ul>
                      {t.items.filter((i: any) => sts.includes(i.kds_status)).map((i: any) => (
                        <li key={i.id}>
                          <button class="kds-item" disabled={!canBump || busy} onClick={() => run(async () => { check(await sb().rpc('kds_bump', { p_item: i.id })); await live.reload() })} title={canBump ? `${KDS_NEXT[i.kds_status]} — tap` : undefined}>
                            <span class="kds-qty">{i.qty}×</span> {i.product_name}{i.variant_name && i.variant_name !== 'Standard' ? ` (${i.variant_name})` : ''}
                            {i.notes && <em class="kds-note">{i.notes}</em>}
                            {!station && i.station && <span class="p-small p-muted"> · {i.station}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                    {canBump && sts[0] !== 'ready' && (
                      <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().rpc('kds_bump_order', { p_order: t.id, p_to: sts[0] === 'queued' ? 'preparing' : 'ready', p_station: station || null })); await live.reload() })}>
                        {sts[0] === 'queued' ? 'Start all' : 'All ready'}
                      </button>
                    )}
                    {canBump && sts[0] === 'ready' && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().rpc('kds_bump_order', { p_order: t.id, p_to: 'served', p_station: station || null })); await live.reload() })}>Served</button>}
                  </article>
                )
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function chime() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    ;[660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain()
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination)
      const t = ctx.currentTime + i * 0.18
      g.gain.setValueAtTime(0.25, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
      o.start(t); o.stop(t + 0.35)
    })
  } catch { /* audio blocked */ }
}

// ── Tables ────────────────────────────────────────────────────────────────
export function Tables() {
  return (
    <Portal title="Tables" need="business" module="restaurant" perm="orders.view">
      {(app) => <TablesBody app={app} />}
    </Portal>
  )
}

function TablesBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [editing, setEditing] = useState(false)
  const tables = useLoad(async () => check(await sb().from('restaurant_tables').select('*').eq('business_id', bizId).eq('active', true).order('sort').order('label')) as any[], [bizId])
  const live = useLiveOrders(bizId)
  const canManage = app.isAdmin || app.biz!.role === 'owner' || app.biz!.permissions.includes('products.manage')
  const openFor = (label: string) => (live.orders ?? []).filter((o) => o.channel === 'table' && o.table_label === label && !['completed', 'cancelled', 'refunded', 'failed'].includes(o.status))
  return (
    <>
      <PageHead title="Tables" sub="Tap a table to see its open orders or start a new one.">
        {canManage && <button class="btn btn-ghost p-btn" onClick={() => setEditing(true)}>Set up tables</button>}
      </PageHead>
      {tables.data?.length ? (
        <div class="tables-grid">
          {tables.data.map((t) => {
            const open = openFor(t.label)
            const due = open.reduce((a, o) => a + (o.payment_status === 'paid' ? 0 : Number(o.total)), 0)
            return (
              <div key={t.id} class={`p-card table-card ${open.length ? 'is-busy' : ''}`}>
                <div class="p-row"><strong style={{ fontSize: '1.4rem' }}>{t.label}</strong><span class="p-spacer" />{t.seats && <span class="p-small p-muted">{t.seats} seats</span>}</div>
                {open.length ? (
                  <>
                    <ul class="p-small" style={{ paddingLeft: '1rem', margin: '0.4rem 0' }}>{open.map((o) => <li key={o.id}><a href={`/portal/orders/view/?id=${o.id}`}>#{o.number}</a> · {o.status} · {o.payment_status === 'paid' ? 'paid' : inr(o.total)}</li>)}</ul>
                    {due > 0 && <p class="p-small">To pay: <strong>{inr(due)}</strong></p>}
                  </>
                ) : <p class="p-small p-muted">Free</p>}
                <a class="btn btn-ghost p-btn" href={`/portal/pos/?table=${encodeURIComponent(t.label)}`}>New order</a>
              </div>
            )
          })}
        </div>
      ) : !tables.loading && <Empty>No tables yet.{canManage && ' Use “Set up tables”.'}</Empty>}
      {editing && (
        <Modal title="Tables" onClose={() => setEditing(false)}>
          <ul class="p-stack" style={{ listStyle: 'none', padding: 0, gap: '0.3rem' }}>
            {(tables.data ?? []).map((t) => <li key={t.id} class="p-row">{t.label} {t.seats && <span class="p-muted p-small">{t.seats} seats</span>}<span class="p-spacer" /><button class="p-link" disabled={busy} onClick={() => run(async () => { check(await sb().from('restaurant_tables').update({ active: false }).eq('id', t.id)); await tables.reload() })}>Remove</button></li>)}
          </ul>
          <form class="p-form" onSubmit={(e) => {
            const form = e.currentTarget as HTMLFormElement
            const f = formData(e)
            const labels = f.labels.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
            run(async () => {
              for (const label of labels) check(await sb().from('restaurant_tables').upsert({ business_id: bizId, label, seats: f.seats ? Number(f.seats) : null, active: true }, { onConflict: 'business_id,label' }))
              form.reset(); await tables.reload()
            }, 'Tables saved')
          }}>
            <Field label="Add tables" hint="Comma separated, e.g. T1, T2, T3, Patio 1"><input name="labels" required /></Field>
            <Field label="Seats (optional)"><input name="seats" type="number" min="1" max="50" /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Add</button>
          </form>
        </Modal>
      )}
    </>
  )
}

// ── Appointments ──────────────────────────────────────────────────────────
export function Appointments() {
  return (
    <Portal title="Appointments" need="business" module="appointments" perm="orders.view">
      {(app) => <AppointmentsBody app={app} />}
    </Portal>
  )
}

const APPT: Record<string, { label: string; tone?: 'ok' | 'warn' | 'bad' | 'ai' }> = {
  booked: { label: 'Booked', tone: 'ai' }, confirmed: { label: 'Confirmed', tone: 'ok' }, in_progress: { label: 'In progress', tone: 'ai' },
  done: { label: 'Done', tone: 'ok' }, cancelled: { label: 'Cancelled', tone: 'bad' }, no_show: { label: 'No-show', tone: 'bad' },
}
const istDate = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10)

function AppointmentsBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [day, setDay] = useState(qs('day') ?? istDate(new Date()))
  const [edit, setEdit] = useState<any>(null)
  const data = useLoad(async () => {
    const [ap, services, staff] = await Promise.all([
      sb().from('appointments').select('*').eq('business_id', bizId).gte('starts_at', `${day}T00:00:00+05:30`).lte('starts_at', `${day}T23:59:59+05:30`).order('starts_at'),
      sb().from('products').select('id, name, duration_min, product_variants(price)').eq('business_id', bizId).eq('kind', 'service').eq('active', true).order('name'),
      sb().from('business_members').select('user_id, role, profiles(full_name, email)').eq('business_id', bizId).eq('active', true),
    ])
    return { ap: check(ap) as any[], services: check(services) as any[], staff: (staff.data ?? []) as any[] }
  }, [bizId, day])
  useEffect(() => {
    const ch = sb().channel(`appts-${bizId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'appointments', filter: `business_id=eq.${bizId}` }, () => data.reload()).subscribe()
    return () => { sb().removeChannel(ch) }
  }, [bizId, day])
  const canEdit = app.isAdmin || app.biz!.role === 'owner' || app.biz!.permissions.includes('orders.update')
  const x = data.data
  const staffName = (id: string | null) => { const s = x?.staff.find((m) => m.user_id === id); return s ? s.profiles?.full_name || s.profiles?.email : 'Anyone' }
  const shift = (n: number) => { const d = new Date(`${day}T12:00:00+05:30`); d.setDate(d.getDate() + n); setDay(istDate(d)) }
  const setStatus = (a: any, status: string) => run(async () => { check(await sb().from('appointments').update({ status }).eq('id', a.id).eq('version', a.version)); await data.reload() }, APPT[status].label)

  return (
    <>
      <PageHead title="Appointments" sub="Services, bookings and who’s doing them. Double-booking a staff member is blocked.">
        {canEdit && <button class="btn btn-ink p-btn" onClick={() => setEdit({})}>New appointment</button>}
      </PageHead>
      <div class="p-row" style={{ marginBottom: '1rem' }}>
        <button class="btn btn-ghost p-btn" onClick={() => shift(-1)} aria-label="Previous day">←</button>
        <input type="date" value={day} onChange={(e) => setDay((e.target as HTMLInputElement).value)} aria-label="Day" />
        <button class="btn btn-ghost p-btn" onClick={() => shift(1)} aria-label="Next day">→</button>
        <button class="btn btn-ghost p-btn" onClick={() => setDay(istDate(new Date()))}>Today</button>
      </div>
      <ErrorNote error={data.error} />
      {x && !x.services.length && <div class="p-notice" style={{ marginBottom: '1rem' }}>Add your services (with durations) under Products & menu → type “Service”.</div>}
      {x?.ap.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th>Time</th><th>Customer</th><th>Service</th><th>With</th><th>Status</th><th></th></tr></thead>
          <tbody>{x.ap.map((a) => (
            <tr key={a.id}>
              <td style={{ whiteSpace: 'nowrap' }}>{new Date(a.starts_at).toLocaleTimeString('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' })} – {new Date(a.ends_at).toLocaleTimeString('en-IN', { timeStyle: 'short', timeZone: 'Asia/Kolkata' })}</td>
              <td>{a.customer_name}{a.customer_phone && <div class="p-small"><a href={`tel:${a.customer_phone}`}>{a.customer_phone}</a></div>}</td>
              <td>{a.service_name}{a.price != null && <div class="p-small p-muted">{inr(a.price)}</div>}</td>
              <td class="p-small">{staffName(a.staff_id)}</td>
              <td><Badge tone={APPT[a.status].tone}>{APPT[a.status].label}</Badge></td>
              <td>{canEdit && (
                <div class="p-row">
                  {a.status === 'booked' && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => setStatus(a, 'confirmed')}>Confirm</button>}
                  {['booked', 'confirmed'].includes(a.status) && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => setStatus(a, 'in_progress')}>Start</button>}
                  {a.status === 'in_progress' && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => setStatus(a, 'done')}>Done</button>}
                  {['booked', 'confirmed'].includes(a.status) && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => setStatus(a, 'no_show')}>No-show</button>}
                  {!['done', 'cancelled'].includes(a.status) && <button class="btn btn-ghost p-btn" onClick={() => setEdit(a)}>Edit</button>}
                </div>
              )}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : !data.loading && <Empty>No appointments on this day.</Empty>}
      {edit && x && (
        <Modal title={edit.id ? 'Edit appointment' : 'New appointment'} onClose={() => setEdit(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const svc = x.services.find((s) => s.id === f.service_id)
            const starts = new Date(`${f.date}T${f.time}:00+05:30`)
            const mins = Number(f.duration || svc?.duration_min || 30)
            const row: Record<string, unknown> = {
              business_id: bizId, service_id: svc?.id ?? null, service_name: svc?.name ?? f.service_name, staff_id: f.staff_id || null, customer_name: f.customer_name.trim(),
              customer_phone: f.customer_phone.replace(/[^\d+]/g, '') || null, starts_at: starts.toISOString(), ends_at: new Date(starts.getTime() + mins * 60000).toISOString(),
              notes: f.notes.trim() || null, price: f.price ? Number(f.price) : svc?.product_variants?.[0]?.price ?? null,
            }
            if (f.status) row.status = f.status
            run(async () => {
              if (edit.id) check(await sb().from('appointments').update(row).eq('id', edit.id).eq('version', edit.version))
              else check(await sb().from('appointments').insert(row))
              setEdit(null); await data.reload()
            }, 'Saved')
          }}>
            <div class="row2">
              <Field label="Customer"><input name="customer_name" required maxLength={120} defaultValue={edit.customer_name ?? ''} /></Field>
              <Field label="Phone"><input name="customer_phone" inputMode="tel" defaultValue={edit.customer_phone ?? ''} /></Field>
            </div>
            <div class="row2">
              <Field label="Service">
                <select name="service_id" defaultValue={edit.service_id ?? ''}><option value="">Other…</option>{x.services.map((s) => <option value={s.id} key={s.id}>{s.name}{s.duration_min ? ` (${s.duration_min} min)` : ''}</option>)}</select>
              </Field>
              <Field label="Or describe"><input name="service_name" defaultValue={edit.service_id ? '' : edit.service_name ?? ''} /></Field>
            </div>
            <div class="row2">
              <Field label="Date"><input name="date" type="date" required defaultValue={edit.starts_at ? istDate(new Date(edit.starts_at)) : day} /></Field>
              <Field label="Time"><input name="time" type="time" required step="300" defaultValue={edit.starts_at ? new Date(edit.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '10:00'} /></Field>
            </div>
            <div class="row2">
              <Field label="Duration (minutes)" hint="Blank = the service’s duration"><input name="duration" type="number" min="5" max="720" step="5" defaultValue={edit.starts_at ? String(Math.round((new Date(edit.ends_at).getTime() - new Date(edit.starts_at).getTime()) / 60000)) : ''} /></Field>
              <Field label="With"><select name="staff_id" defaultValue={edit.staff_id ?? ''}><option value="">Anyone</option>{x.staff.map((m) => <option value={m.user_id} key={m.user_id}>{m.profiles?.full_name || m.profiles?.email}</option>)}</select></Field>
            </div>
            <div class="row2">
              <Field label="Price (₹, optional)"><input name="price" type="number" min="0" step="1" defaultValue={edit.price ?? ''} /></Field>
              {edit.id && <Field label="Status"><select name="status" defaultValue={edit.status}>{Object.entries(APPT).map(([k, v]) => <option value={k} key={k}>{v.label}</option>)}</select></Field>}
            </div>
            <Field label="Notes"><textarea name="notes" rows={2} maxLength={1000} defaultValue={edit.notes ?? ''} /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
      <p class="p-small p-muted" style={{ marginTop: '1rem' }}>Updated {dt(new Date().toISOString())}. Changes from other devices appear automatically.</p>
    </>
  )
}
