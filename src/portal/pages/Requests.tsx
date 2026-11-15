// Change requests: client list + new request, admin queue, and the shared request detail page.
import { useEffect, useState } from 'preact/hooks'
import QRCode from 'qrcode'
import { pricing } from '../../config/site'
import { check, d, dt, inr, notifyAdmin, qs, safeName, sb, upload, bytes } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Portal, useAction, useApp, useLoad, formData } from '../ui'

export const CR_STATUS: Record<string, { label: string; tone?: 'ok' | 'warn' | 'bad' | 'ai' }> = {
  submitted: { label: 'Submitted', tone: 'warn' },
  quoted: { label: 'Quote sent', tone: 'ai' },
  approved: { label: 'Approved', tone: 'ok' },
  in_progress: { label: 'In progress', tone: 'ai' },
  done: { label: 'Done', tone: 'ok' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
}
const PAYMENT: Record<string, string> = { unpaid: 'Unpaid', paid: 'Paid', waived: 'Free', not_applicable: 'No charge' }
// Mirrors the database's allowed status transitions (private.cr_before_update).
const NEXT: Record<string, string[]> = {
  submitted: ['quoted', 'in_progress', 'cancelled'],
  quoted: ['approved', 'submitted', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  in_progress: ['done', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['submitted'],
}
const ref = (n: number) => `CR-${n}`
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={CR_STATUS[s]?.tone}>{CR_STATUS[s]?.label ?? s}</Badge>

// ── Client: list + new request ────────────────────────────────────────────
export function Requests() {
  return (
    <Portal title="Change requests" need="business" module="change_requests" perm="settings.manage">
      {(app) => <RequestsBody app={app} />}
    </Portal>
  )
}

function RequestsBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const [creating, setCreating] = useState(false)
  const list = useLoad(async () => check(await sb().from('change_requests')
    .select('id, number, title, status, price_inr, payment_status, priority, created_at, updated_at')
    .eq('business_id', bizId).order('created_at', { ascending: false })) as any[], [bizId])
  return (
    <>
      <PageHead title="Change requests" sub={`Ask for any change to your website. Changes after delivery are usually ₹${pricing.changeFee} each — you’ll always see the price and approve it before work starts.`}>
        <button class="btn btn-ink p-btn" onClick={() => setCreating(true)}>New request</button>
      </PageHead>
      <ErrorNote error={list.error} />
      {list.data?.length ? (
        <div class="p-table-wrap">
          <table class="p-table">
            <thead><tr><th>Ref</th><th>Request</th><th>Status</th><th>Price</th><th>Payment</th><th>Updated</th></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/portal/requests/view/?id=${r.id}`}>{ref(r.number)}</a></td>
                  <td><a href={`/portal/requests/view/?id=${r.id}`}>{r.title}</a>{r.priority === 'urgent' && <> <Badge tone="bad">urgent</Badge></>}</td>
                  <td><StatusBadge s={r.status} /></td>
                  <td class="num">{r.price_inr == null ? '—' : inr(r.price_inr)}</td>
                  <td>{r.price_inr == null ? '—' : PAYMENT[r.payment_status]}</td>
                  <td>{d(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !list.loading && <Empty>No requests yet. Use “New request” to ask for a change.</Empty>}
      {creating && <NewRequest app={app} onClose={() => setCreating(false)} onDone={(id) => { location.href = `/portal/requests/view/?id=${id}` }} />}
    </>
  )
}

function NewRequest({ app, onClose, onDone }: { app: ReturnType<typeof useApp>; onClose: () => void; onDone: (id: string) => void }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const sites = useLoad(async () => check(await sb().from('sites').select('id, name, url').eq('business_id', bizId)) as any[], [bizId])
  return (
    <Modal title="New change request" onClose={onClose}>
      <form class="p-form" onSubmit={(e) => {
        const form = e.currentTarget as HTMLFormElement
        const f = formData(e)
        const files = Array.from((form.elements.namedItem('files') as HTMLInputElement).files ?? [])
        run(async () => {
          if (files.some((x) => x.size > 10 * 1024 * 1024)) throw new Error('Each file must be under 10 MB.')
          const row = check(await sb().from('change_requests').insert({
            business_id: bizId, site_id: f.site_id || null, title: f.title.trim(), description: f.description.trim(), priority: f.priority,
          }).select('id, number').single()) as any
          for (const file of files) {
            const path = `${bizId}/${row.id}/${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`
            await upload('attachments', path, file)
            check(await sb().from('change_request_attachments').insert({ request_id: row.id, path, name: file.name.slice(0, 200), size_bytes: file.size, mime: file.type || null }))
          }
          notifyAdmin({ kind: 'New change request', business: app.biz?.business_name ?? '', title: `${ref(row.number)}: ${f.title}`, link: `${location.origin}/portal/requests/view/?id=${row.id}`, by: app.ctx.profile.email })
          onDone(row.id)
        }, 'Request sent')
      }}>
        <Field label="What should change?"><input name="title" required minLength={3} maxLength={160} placeholder="e.g. Update the lunch menu prices" /></Field>
        <Field label="Details" hint="Be specific: which page, what it says now, what it should say. Screenshots help.">
          <textarea name="description" rows={6} maxLength={8000} />
        </Field>
        <div class="row2">
          <Field label="Priority">
            <select name="priority" defaultValue="normal"><option value="low">Whenever convenient</option><option value="normal">Normal</option><option value="urgent">Urgent</option></select>
          </Field>
          {(sites.data?.length ?? 0) > 1 && (
            <Field label="Website"><select name="site_id">{sites.data!.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}</select></Field>
          )}
        </div>
        <Field label="Attachments (optional)" hint="Images, PDF, Word, Excel or ZIP. Up to 10 MB each.">
          <input name="files" type="file" multiple accept="image/*,.pdf,.txt,.docx,.xlsx,.zip" />
        </Field>
        <button class="btn btn-ink p-btn" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
      </form>
    </Modal>
  )
}

// ── Admin: all requests ───────────────────────────────────────────────────
export function AdminRequests() {
  return (
    <Portal title="Change requests" need="admin">
      {() => <AdminRequestsBody />}
    </Portal>
  )
}

function AdminRequestsBody() {
  const [filter, setFilter] = useState<string>('open')
  const list = useLoad(async () => {
    let q = sb().from('change_requests').select('id, number, title, status, price_inr, payment_status, priority, created_at, updated_at, businesses(name)').order('updated_at', { ascending: false }).limit(300)
    if (filter === 'open') q = q.in('status', ['submitted', 'quoted', 'approved', 'in_progress'])
    else if (filter === 'unpaid') q = q.eq('status', 'done').eq('payment_status', 'unpaid').gt('price_inr', 0)
    else if (filter !== 'all') q = q.eq('status', filter)
    return check(await q) as any[]
  }, [filter])
  const counts = useLoad(async () => {
    const rows = check(await sb().from('change_requests').select('status, payment_status, price_inr')) as any[]
    return {
      needsQuote: rows.filter((r) => r.status === 'submitted').length,
      approved: rows.filter((r) => r.status === 'approved').length,
      unpaid: rows.filter((r) => r.status === 'done' && r.payment_status === 'unpaid' && Number(r.price_inr) > 0).length,
    }
  })
  return (
    <>
      <PageHead title="Change requests" sub="Every client’s requests. Quote, track and record UPI payments." />
      <div class="p-grid" style={{ marginBottom: '1rem' }}>
        <button class="p-card p-stat p-stat-btn" onClick={() => setFilter('submitted')}><span class="p-stat-n">{counts.data?.needsQuote ?? '…'}</span><span class="p-stat-l">Need a quote</span></button>
        <button class="p-card p-stat p-stat-btn" onClick={() => setFilter('approved')}><span class="p-stat-n">{counts.data?.approved ?? '…'}</span><span class="p-stat-l">Approved, not started</span></button>
        <button class="p-card p-stat p-stat-btn" onClick={() => setFilter('unpaid')}><span class="p-stat-n">{counts.data?.unpaid ?? '…'}</span><span class="p-stat-l">Done, unpaid</span></button>
      </div>
      <div class="p-tabs" role="tablist">
        {[['open', 'Open'], ['submitted', 'Submitted'], ['quoted', 'Quoted'], ['approved', 'Approved'], ['in_progress', 'In progress'], ['done', 'Done'], ['unpaid', 'Unpaid'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <ErrorNote error={list.error} />
      {list.data?.length ? (
        <div class="p-table-wrap">
          <table class="p-table">
            <thead><tr><th>Ref</th><th>Business</th><th>Request</th><th>Status</th><th>Price</th><th>Payment</th><th>Updated</th></tr></thead>
            <tbody>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/portal/requests/view/?id=${r.id}`}>{ref(r.number)}</a></td>
                  <td>{r.businesses?.name}</td>
                  <td><a href={`/portal/requests/view/?id=${r.id}`}>{r.title}</a>{r.priority === 'urgent' && <> <Badge tone="bad">urgent</Badge></>}</td>
                  <td><StatusBadge s={r.status} /></td>
                  <td class="num">{r.price_inr == null ? '—' : inr(r.price_inr)}</td>
                  <td>{r.price_inr == null ? '—' : PAYMENT[r.payment_status]}</td>
                  <td>{d(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !list.loading && <Empty>Nothing here.</Empty>}
    </>
  )
}

// ── Detail (client and admin) ─────────────────────────────────────────────
export function RequestView() {
  return (
    <Portal title="Change request">
      {(app) => <RequestBody app={app} id={qs('id') ?? ''} />}
    </Portal>
  )
}

function RequestBody({ app, id }: { app: ReturnType<typeof useApp>; id: string }) {
  const { busy, run } = useAction()
  const isAdmin = app.isAdmin
  const data = useLoad(async () => {
    const [r, ev, cm, at] = await Promise.all([
      sb().from('change_requests').select('*, businesses(name), sites(name, url)').eq('id', id).maybeSingle(),
      sb().from('change_request_events').select('*').eq('request_id', id).order('id'),
      sb().from('change_request_comments').select('*').eq('request_id', id).order('created_at'),
      sb().from('change_request_attachments').select('*').eq('request_id', id).order('created_at'),
    ])
    const req = check(r) as any
    if (!req) throw new Error('This request doesn’t exist or you can’t see it.')
    const comments = check(cm) as any[]
    const events = check(ev) as any[]
    const ids = [...new Set([...comments.map((c) => c.author_id), ...events.map((e) => e.actor_id), req.created_by].filter(Boolean))]
    const people = ids.length ? (check(await sb().from('profiles').select('id, full_name, email, role').in('id', ids)) as any[]) : []
    return { req, events, comments, attachments: check(at) as any[], people: new Map(people.map((p) => [p.id, p])) }
  }, [id])

  if (data.loading && !data.data) return <div class="p-loading">Loading…</div>
  if (data.error) return <ErrorNote error={data.error} />
  const { req, events, comments, attachments, people } = data.data!
  const who = (uid: string | null) => {
    const p = uid ? people.get(uid) : null
    return p ? (p.role === 'admin' ? 'Tomorrow Web' : p.full_name || p.email) : 'Someone'
  }

  async function act(action: 'approve' | 'cancel') {
    const reason = action === 'cancel' ? prompt('Why are you cancelling? (optional)') ?? '' : null
    if (action === 'cancel' && reason === null) return
    await run(async () => {
      check(await sb().rpc('change_request_action', { p_id: id, p_action: action, p_reason: reason }))
      if (action === 'approve') notifyAdmin({ kind: 'Quote approved', business: req.businesses?.name ?? '', title: `${ref(req.number)}: ${req.title}`, link: location.href, by: app.ctx.profile.email })
      await data.reload()
    }, action === 'approve' ? 'Quote approved — thank you!' : 'Request cancelled')
  }

  return (
    <>
      <PageHead title={`${ref(req.number)} · ${req.title}`} sub={<>{isAdmin && <>{req.businesses?.name} · </>}Requested {dt(req.created_at)} by {who(req.created_by)} · <StatusBadge s={req.status} /></>}>
        <a class="btn btn-ghost p-btn" href={isAdmin ? '/portal/admin/requests/' : '/portal/requests/'}>All requests</a>
      </PageHead>

      <div class="p-grid-2">
        <div class="p-stack">
          <div class="p-card">
            <h2>Details</h2>
            {req.sites?.name && <p class="p-small p-muted">Website: {req.sites.name}</p>}
            <p style={{ whiteSpace: 'pre-wrap' }}>{req.description || <span class="p-muted">No details given.</span>}</p>
            <Attachments req={req} attachments={attachments} onChange={data.reload} />
          </div>
          {req.ai_spec && (
            <div class="p-card">
              <h2>Specification <Badge tone="ai">AI-generated · review before use</Badge></h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{req.ai_spec}</p>
            </div>
          )}
          <Comments id={id} comments={comments} who={who} isAdmin={isAdmin} closed={req.status === 'cancelled'} onChange={data.reload} />
        </div>

        <div class="p-stack">
          <div class="p-card">
            <h2>Quote & payment</h2>
            {req.price_inr == null ? (
              <p class="p-muted">Tomorrow Web will review this and send a price before starting.</p>
            ) : (
              <>
                <p style={{ fontSize: '1.6rem', margin: '0.2rem 0' }}>{Number(req.price_inr) === 0 ? 'Free' : inr(req.price_inr)}</p>
                {req.quote_note && <p class="p-small" style={{ whiteSpace: 'pre-wrap' }}>{req.quote_note}</p>}
                <p class="p-small p-muted">Payment: {PAYMENT[req.payment_status]}{req.upi_ref && ` · UPI ref ${req.upi_ref}`}</p>
              </>
            )}
            {!isAdmin && req.status === 'quoted' && (
              <div class="p-row" style={{ marginTop: '0.75rem' }}>
                <button class="btn btn-ink p-btn" disabled={busy} onClick={() => act('approve')}>Approve quote</button>
                <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => act('cancel')}>Cancel request</button>
              </div>
            )}
            {!isAdmin && req.status === 'submitted' && (
              <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => act('cancel')} style={{ marginTop: '0.75rem' }}>Cancel request</button>
            )}
            {!isAdmin && ['approved', 'in_progress', 'done'].includes(req.status) && req.payment_status === 'unpaid' && Number(req.price_inr) > 0 && (
              <UpiPay amount={Number(req.price_inr)} note={ref(req.number)} />
            )}
          </div>
          {isAdmin && <AdminControls req={req} onSaved={data.reload} />}
          <div class="p-card">
            <h2>History</h2>
            <ol class="p-small" style={{ paddingLeft: '1.1rem', margin: 0 }}>
              {events.map((e) => (
                <li key={e.id} style={{ marginBottom: '0.3rem' }}>
                  {dt(e.at)} — {e.kind === 'status' ? <>status → <strong>{CR_STATUS[e.to_value]?.label ?? e.to_value}</strong></>
                    : e.kind === 'price' ? <>price → <strong>{e.to_value == null ? 'none' : inr(e.to_value)}</strong></>
                    : <>payment → <strong>{PAYMENT[e.to_value] ?? e.to_value}</strong>{e.note && ` (ref ${e.note})`}</>}
                  {' '}<span class="p-muted">by {who(e.actor_id)}</span>{e.kind === 'status' && e.note && <div class="p-muted">Reason: {e.note}</div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </>
  )
}

function UpiPay({ amount, note }: { amount: number; note: string }) {
  const [svg, setSvg] = useState('')
  const link = pricing.upiId ? `upi://pay?pa=${encodeURIComponent(pricing.upiId)}&pn=${encodeURIComponent('Tomorrow Web')}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}` : ''
  useEffect(() => { if (link) QRCode.toString(link, { type: 'svg', margin: 1, color: { dark: '#050505', light: '#ffffff' } }).then(setSvg) }, [link])
  if (!link) return <p class="p-small p-muted" style={{ marginTop: '0.75rem' }}>Pay by UPI when the work is done — Tomorrow Web will share the UPI details and mark it paid once received.</p>
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <p class="p-small">Pay {inr(amount)} by UPI (scan, or tap on your phone). We’ll mark it paid once we see it — please mention <strong>{note}</strong>.</p>
      <div style={{ width: '180px', background: '#fff', padding: '8px', borderRadius: '12px' }} dangerouslySetInnerHTML={{ __html: svg }} />
      <a class="btn btn-ghost p-btn" href={link} style={{ marginTop: '0.5rem' }}>Open UPI app</a>
    </div>
  )
}

function AdminControls({ req, onSaved }: { req: any; onSaved: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  return (
    <form class="p-card p-form" onSubmit={(e) => {
      const f = formData(e)
      const patch: Record<string, unknown> = {
        price_inr: f.price_inr === '' ? null : Number(f.price_inr),
        quote_note: f.quote_note.trim() || null,
        payment_status: f.payment_status,
        upi_ref: f.upi_ref.trim() || null,
      }
      if (f.status !== req.status) patch.status = f.status
      if (f.status === 'cancelled' && f.status !== req.status) patch.cancel_reason = f.cancel_reason?.trim() || null
      run(async () => { check(await sb().from('change_requests').update(patch).eq('id', req.id)); await onSaved() }, 'Saved')
    }}>
      <h2>Tomorrow Web controls</h2>
      <div class="row2">
        <Field label="Price (₹)" hint={`Usual: ₹${pricing.changeFee}. 0 = free.`}><input name="price_inr" type="number" min="0" step="1" defaultValue={req.price_inr ?? ''} /></Field>
        <Field label="Status">
          <select name="status" defaultValue={req.status}>
            <option value={req.status}>{CR_STATUS[req.status].label} (current)</option>
            {NEXT[req.status].map((s) => <option value={s} key={s}>→ {CR_STATUS[s].label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Note with the quote (client sees this)"><textarea name="quote_note" rows={2} maxLength={2000} defaultValue={req.quote_note ?? ''} /></Field>
      <Field label="Cancellation reason (if cancelling)"><input name="cancel_reason" maxLength={500} /></Field>
      <div class="row2">
        <Field label="Payment">
          <select name="payment_status" defaultValue={req.payment_status}>
            {Object.entries(PAYMENT).map(([k, v]) => <option value={k} key={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="UPI reference (UTR)"><input name="upi_ref" maxLength={60} defaultValue={req.upi_ref ?? ''} /></Field>
      </div>
      <p class="p-small p-muted">Only mark “Paid” after you see the money arrive. Changes are recorded in the history and audit log.</p>
      <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
    </form>
  )
}

function Comments({ id, comments, who, isAdmin, closed, onChange }: { id: string; comments: any[]; who: (u: string | null) => string; isAdmin: boolean; closed: boolean; onChange: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  return (
    <div class="p-card">
      <h2>Conversation</h2>
      {comments.length ? (
        <div class="p-stack" style={{ gap: '0.6rem' }}>
          {comments.map((c) => (
            <div key={c.id} class="p-card" style={c.internal ? { borderColor: 'rgba(240,210,107,.45)' } : undefined}>
              <div class="p-small p-muted">{who(c.author_id)} · {dt(c.created_at)} {c.internal && <Badge tone="warn">internal note</Badge>}</div>
              <p style={{ whiteSpace: 'pre-wrap', margin: '0.3rem 0 0' }}>{c.body}</p>
            </div>
          ))}
        </div>
      ) : <p class="p-muted">No messages yet.</p>}
      {!closed && (
        <form class="p-form" style={{ marginTop: '0.75rem' }} onSubmit={(e) => {
          const form = e.currentTarget as HTMLFormElement
          const f = formData(e)
          run(async () => {
            check(await sb().from('change_request_comments').insert({ request_id: id, body: f.body.trim(), internal: isAdmin && !!f.internal }))
            form.reset()
            await onChange()
          }, 'Sent')
        }}>
          <Field label="Add a message"><textarea name="body" rows={3} required maxLength={4000} /></Field>
          <div class="p-row">
            {isAdmin && <label class="p-check"><input type="checkbox" name="internal" /> Internal note (client can’t see)</label>}
            <span class="p-spacer" />
            <button class="btn btn-ink p-btn" disabled={busy}>Send</button>
          </div>
        </form>
      )}
    </div>
  )
}

function Attachments({ req, attachments, onChange }: { req: any; attachments: any[]; onChange: () => Promise<unknown> }) {
  const { busy, run } = useAction()
  async function open(a: any) {
    const { data, error } = await sb().storage.from('attachments').createSignedUrl(a.path, 300)
    if (error || !data) return alert('Couldn’t open that file.')
    window.open(data.signedUrl, '_blank', 'noopener')
  }
  return (
    <div style={{ marginTop: '1rem' }}>
      <h3 class="p-small">Attachments</h3>
      {attachments.length ? (
        <ul class="p-small" style={{ paddingLeft: '1rem' }}>
          {attachments.map((a) => <li key={a.id}><button type="button" class="p-link" onClick={() => open(a)}>{a.name}</button> <span class="p-muted">{bytes(a.size_bytes)}</span></li>)}
        </ul>
      ) : <p class="p-small p-muted">None.</p>}
      {req.status !== 'cancelled' && (
        <label class="btn btn-ghost p-btn" style={{ cursor: 'pointer' }}>
          {busy ? 'Uploading…' : 'Add file'}
          <input type="file" hidden accept="image/*,.pdf,.txt,.docx,.xlsx,.zip" disabled={busy} onChange={(e) => {
            const input = e.target as HTMLInputElement
            const file = input.files?.[0]
            if (!file) return
            run(async () => {
              if (file.size > 10 * 1024 * 1024) throw new Error('Files must be under 10 MB.')
              const path = `${req.business_id}/${req.id}/${crypto.randomUUID().slice(0, 8)}-${safeName(file.name)}`
              await upload('attachments', path, file)
              check(await sb().from('change_request_attachments').insert({ request_id: req.id, path, name: file.name.slice(0, 200), size_bytes: file.size, mime: file.type || null }))
              input.value = ''
              await onChange()
            }, 'File added')
          }} />
        </label>
      )}
    </div>
  )
}
