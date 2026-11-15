// Sales CRM (administrator only): pipeline board, table, follow-ups, dashboard, and the CRM panel
// shown on each lead (stage, value, activity history, tasks, proposals, convert to client).
import { useMemo, useState } from 'preact/hooks'
import { industryByKey } from '../../../supabase/functions/_shared/leads'
import { OPEN_STAGES, pipelineStats, presetForIndustry, STAGES, stageLabel, toIcs } from '../crm'
import { ago, callFn, check, d, downloadCsv, dt, inr, sb } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, OneTimeSecret, PageHead, Portal, Stat, useAction, useApp, useLoad, formData } from '../ui'

const COLS = 'id, name, industry, locality, stage, estimated_value_inr, next_follow_up_at, last_contacted_at, primary_phone, primary_email, do_not_contact, score, converted_business_id, updated_at'
const ACT_LABEL: Record<string, string> = { call: 'Call', whatsapp: 'WhatsApp', email: 'Email', meeting: 'Meeting', note: 'Note', stage_change: 'Stage', proposal: 'Proposal' }

export function CrmHome() {
  return (
    <Portal title="Sales CRM" need="admin">
      {(app) => <CrmBody app={app} />}
    </Portal>
  )
}

function CrmBody({ app }: { app: ReturnType<typeof useApp> }) {
  const [tab, setTab] = useState('board')
  const [q, setQ] = useState('')
  const leads = useLoad(async () => check(await sb().from('leads').select(COLS).neq('stage', 'new').order('updated_at', { ascending: false }).limit(2000)) as any[])
  const newCount = useLoad(async () => (await sb().from('leads').select('id', { count: 'exact', head: true }).eq('stage', 'new')).count ?? 0)
  const rows = (leads.data ?? []).filter((l) => !q || `${l.name} ${l.locality} ${l.primary_phone}`.toLowerCase().includes(q.toLowerCase()))
  const { busy, run } = useAction()
  const move = (id: string, stage: string) => run(async () => {
    let lost_reason: string | null = null
    if (stage === 'lost') { lost_reason = prompt('Why was it lost? (optional)'); if (lost_reason === null) return }
    leads.setData((xs) => xs?.map((x) => (x.id === id ? { ...x, stage } : x)))
    check(await sb().from('leads').update({ stage, ...(stage === 'lost' ? { lost_reason: lost_reason || null } : {}) }).eq('id', id))
    await leads.reload()
  }, `Moved to ${stageLabel(stage)}`)

  return (
    <>
      <PageHead title="Sales CRM" sub={`Your pipeline. ${newCount.data ?? '…'} uncontacted leads wait in the Lead Finder — move one to “Researched” or log a contact to bring it here.`}>
        <a class="btn btn-ghost p-btn" href="/portal/admin/leads/">Lead Finder</a>
      </PageHead>
      <div class="p-tabs" role="tablist">
        {[['board', 'Board'], ['table', 'Table'], ['followups', 'Follow-ups'], ['dashboard', 'Dashboard']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <ErrorNote error={leads.error} />
      {(tab === 'board' || tab === 'table') && <input class="p-input" placeholder="Search" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ maxWidth: '320px', marginBottom: '1rem' }} />}
      {tab === 'board' && <Board rows={rows} busy={busy} move={move} />}
      {tab === 'table' && <Table rows={rows} />}
      {tab === 'followups' && <FollowUps />}
      {tab === 'dashboard' && <Dashboard />}
    </>
  )
}

function LeadCard({ l, move, busy }: { l: any; move: (id: string, s: string) => void; busy: boolean }) {
  const overdue = l.next_follow_up_at && new Date(l.next_follow_up_at) < new Date() && OPEN_STAGES.includes(l.stage)
  return (
    <div class="p-card crm-card" draggable onDragStart={(e) => e.dataTransfer?.setData('text/plain', l.id)}>
      <a href={`/portal/admin/leads/view/?id=${l.id}`}><strong>{l.name}</strong></a>
      <div class="p-small p-muted">{[industryByKey(l.industry)?.label, l.locality].filter(Boolean).join(' · ')}</div>
      <div class="p-row p-small" style={{ marginTop: '0.3rem' }}>
        {l.estimated_value_inr != null && <span>{inr(l.estimated_value_inr)}</span>}
        {l.next_follow_up_at && <Badge tone={overdue ? 'bad' : 'warn'}>{overdue ? 'overdue' : `follow up ${d(l.next_follow_up_at)}`}</Badge>}
        {l.do_not_contact && <Badge tone="bad">DNC</Badge>}
      </div>
      <label class="sr-only" for={`stage-${l.id}`}>Stage for {l.name}</label>
      <select id={`stage-${l.id}`} class="crm-stage" value={l.stage} disabled={busy} onChange={(e) => move(l.id, (e.target as HTMLSelectElement).value)}>
        {STAGES.map((s) => <option value={s.key} key={s.key}>{s.label}</option>)}
      </select>
    </div>
  )
}

function Board({ rows, move, busy }: { rows: any[]; move: (id: string, s: string) => void; busy: boolean }) {
  const [over, setOver] = useState<string | null>(null)
  if (!rows.length) return <Empty>No leads in the pipeline yet.</Empty>
  return (
    <div class="crm-board">
      {STAGES.filter((s) => s.key !== 'new').map((s) => {
        const items = rows.filter((r) => r.stage === s.key)
        const value = items.reduce((a, r) => a + (Number(r.estimated_value_inr) || 0), 0)
        return (
          <section key={s.key} class={`crm-col${over === s.key ? ' is-over' : ''}`} aria-label={s.label}
            onDragOver={(e) => { e.preventDefault(); setOver(s.key) }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer?.getData('text/plain'); if (id && rows.find((r) => r.id === id)?.stage !== s.key) move(id, s.key) }}>
            <header><strong>{s.label}</strong> <span class="p-muted p-small">{items.length}{value ? ` · ${inr(value)}` : ''}</span></header>
            <div class="p-stack" style={{ gap: '0.5rem' }}>{items.map((l) => <LeadCard key={l.id} l={l} move={move} busy={busy} />)}</div>
          </section>
        )
      })}
    </div>
  )
}

function Table({ rows }: { rows: any[] }) {
  return (
    <>
      <div class="p-row" style={{ marginBottom: '0.75rem' }}>
        <span class="p-spacer" />
        <button class="btn btn-ghost p-btn" disabled={!rows.length} onClick={() => downloadCsv(`pipeline-${new Date().toISOString().slice(0, 10)}.csv`, rows.map((r) => ({ name: r.name, stage: stageLabel(r.stage), value_inr: r.estimated_value_inr, locality: r.locality, phone: r.primary_phone, email: r.primary_email, last_contacted: r.last_contacted_at, next_follow_up: r.next_follow_up_at, do_not_contact: r.do_not_contact })))}>Export CSV</button>
      </div>
      {rows.length ? (
        <div class="p-table-wrap"><table class="p-table">
          <thead><tr><th>Business</th><th>Stage</th><th class="num">Value</th><th>Last contact</th><th>Next follow-up</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><a href={`/portal/admin/leads/view/?id=${r.id}`}>{r.name}</a><div class="p-small p-muted">{r.locality}</div></td>
              <td>{stageLabel(r.stage)}{r.converted_business_id && <> <Badge tone="ok">client</Badge></>}</td>
              <td class="num">{r.estimated_value_inr != null ? inr(r.estimated_value_inr) : '—'}</td>
              <td class="p-small">{r.last_contacted_at ? ago(r.last_contacted_at) : '—'}</td>
              <td class="p-small">{r.next_follow_up_at ? dt(r.next_follow_up_at) : '—'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty>Nothing here.</Empty>}
    </>
  )
}

function FollowUps() {
  const { busy, run } = useAction()
  const tasks = useLoad(async () => check(await sb().from('lead_tasks').select('id, title, due_at, lead_id, leads(name, stage, do_not_contact)').is('done_at', null).order('due_at').limit(500)) as any[])
  const now = Date.now()
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999)
  const groups = [
    ['Overdue', (t: any) => new Date(t.due_at).getTime() < now],
    ['Today', (t: any) => new Date(t.due_at).getTime() >= now && new Date(t.due_at) <= endToday],
    ['Upcoming', (t: any) => new Date(t.due_at) > endToday],
  ] as const
  async function notify() {
    if (!('Notification' in window)) return alert('This browser doesn’t support notifications.')
    const p = await Notification.requestPermission()
    if (p !== 'granted') return
    const due = (tasks.data ?? []).filter((t) => new Date(t.due_at) <= endToday)
    new Notification('Tomorrow Web follow-ups', { body: due.length ? `${due.length} follow-up(s) due today or overdue.` : 'Nothing due today.' })
  }
  return (
    <>
      <div class="p-row" style={{ marginBottom: '1rem' }}>
        <span class="p-spacer" />
        <button class="btn btn-ghost p-btn" onClick={notify}>Browser reminder</button>
        <button class="btn btn-ghost p-btn" disabled={!tasks.data?.length} onClick={() => {
          const ics = toIcs((tasks.data ?? []).map((t) => ({ id: t.id, title: t.title, due_at: t.due_at, lead_name: t.leads?.name, url: `${location.origin}/portal/admin/leads/view/?id=${t.lead_id}` })))
          const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' })); a.download = 'tomorrow-web-follow-ups.ics'; a.click()
        }}>Add to calendar (.ics)</button>
      </div>
      <ErrorNote error={tasks.error} />
      {tasks.data?.length ? groups.map(([label, test]) => {
        const items = tasks.data!.filter(test)
        return items.length ? (
          <div class="p-card" key={label} style={{ marginBottom: '1rem' }}>
            <h2>{label} ({items.length})</h2>
            <ul class="p-stack" style={{ listStyle: 'none', padding: 0, gap: '0.4rem' }}>
              {items.map((t) => (
                <li key={t.id} class="p-row">
                  <input type="checkbox" aria-label={`Done: ${t.title}`} disabled={busy} onChange={() => run(async () => { check(await sb().from('lead_tasks').update({ done_at: new Date().toISOString() }).eq('id', t.id)); await tasks.reload() }, 'Done')} />
                  <span><strong>{t.title}</strong> — <a href={`/portal/admin/leads/view/?id=${t.lead_id}`}>{t.leads?.name}</a> {t.leads?.do_not_contact && <Badge tone="bad">do not contact</Badge>}</span>
                  <span class="p-spacer" /><span class="p-small p-muted">{dt(t.due_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null
      }) : !tasks.loading && <Empty>No open follow-ups.</Empty>}
    </>
  )
}

function Dashboard() {
  const data = useLoad(async () => check(await sb().from('leads').select('stage, estimated_value_inr, next_follow_up_at, created_at').limit(20000)) as any[])
  const s = useMemo(() => pipelineStats(data.data ?? []), [data.data])
  if (data.loading) return <div class="p-loading">Loading…</div>
  const max = Math.max(1, ...s.funnel.map((f) => f.count))
  return (
    <>
      <div class="p-grid" style={{ marginBottom: '1rem' }}>
        <Stat n={s.total} label="Total leads" />
        <Stat n={s.byStage.new} label="New" />
        <Stat n={s.byStage.contacted} label="Contacted" />
        <Stat n={s.byStage.interested + s.byStage.meeting} label="Interested / meeting" />
        <Stat n={s.byStage.proposal_sent + s.byStage.negotiation} label="Proposals out" />
        <Stat n={s.byStage.won} label="Won" />
        <Stat n={s.byStage.lost} label="Lost" />
        <Stat n={inr(s.pipelineValue)} label="Open pipeline value" />
        <Stat n={inr(s.wonValue)} label="Won value" />
        <Stat n={s.winRate == null ? '—' : `${s.winRate}%`} label="Win rate (won ÷ decided)" />
        <Stat n={s.overdue} label="Overdue follow-ups" />
        <Stat n={s.dueToday} label="Due today" />
      </div>
      <div class="p-card">
        <h2>Conversion funnel</h2>
        <p class="p-small p-muted">Leads that reached each stage (lost leads excluded). Calculated live from your leads.</p>
        <div class="p-stack" style={{ gap: '0.5rem' }}>
          {s.funnel.map((f) => (
            <div key={f.stage} class="crm-bar"><span class="p-small" style={{ width: '9rem' }}>{f.label}</span><span class="crm-bar-fill" style={{ width: `${(f.count / max) * 100}%` }} /><span class="p-small">{f.count}</span></div>
          ))}
        </div>
      </div>
    </>
  )
}

// ── CRM panel on the lead page ────────────────────────────────────────────
export function CrmPanel({ lead, onChange }: { lead: any; onChange: () => Promise<unknown> }) {
  const app = useApp()
  const { busy, run } = useAction()
  const [proposal, setProposal] = useState<any>(null)
  const [converting, setConverting] = useState(false)
  const data = useLoad(async () => {
    const [acts, tasks, props] = await Promise.all([
      sb().from('lead_activities').select('*').eq('lead_id', lead.id).order('happened_at', { ascending: false }).limit(100),
      sb().from('lead_tasks').select('*').eq('lead_id', lead.id).order('due_at'),
      sb().from('proposals').select('*').eq('lead_id', lead.id).order('created_at', { ascending: false }),
    ])
    return { acts: check(acts) as any[], tasks: check(tasks) as any[], props: check(props) as any[] }
  }, [lead.id, lead.stage, lead.updated_at])
  const reload = async () => { await data.reload(); await onChange() }
  const x = data.data
  return (
    <div class="p-card">
      <div class="p-row">
        <h2 style={{ margin: 0 }}>Sales</h2>
        <span class="p-spacer" />
        {lead.converted_business_id ? <a class="btn btn-ghost p-btn" href={`/portal/admin/business/?id=${lead.converted_business_id}`}>Open client</a>
          : lead.stage === 'won' && <button class="btn btn-ink p-btn" onClick={() => setConverting(true)}>Create client account</button>}
      </div>
      <form class="p-form" style={{ marginTop: '0.6rem' }} onSubmit={(e) => {
        const f = formData(e)
        run(async () => {
          check(await sb().from('leads').update({ stage: f.stage, estimated_value_inr: f.value === '' ? null : Number(f.value), ...(f.stage === 'lost' ? { lost_reason: f.lost_reason || null } : {}) }).eq('id', lead.id))
          await reload()
        }, 'Saved')
      }}>
        <div class="row2">
          <Field label="Stage"><select name="stage" defaultValue={lead.stage} key={lead.stage}>{STAGES.map((s) => <option value={s.key} key={s.key}>{s.label}</option>)}</select></Field>
          <Field label="Estimated value (₹)"><input name="value" type="number" min="0" step="100" defaultValue={lead.estimated_value_inr ?? ''} /></Field>
        </div>
        <Field label="If lost — why?"><input name="lost_reason" maxLength={300} defaultValue={lead.lost_reason ?? ''} /></Field>
        <div class="p-small p-muted">Last contacted {lead.last_contacted_at ? ago(lead.last_contacted_at) : 'never'} · in this stage since {d(lead.stage_changed_at)}</div>
        <button class="btn btn-ghost p-btn" disabled={busy}>Save</button>
      </form>

      <h3 style={{ marginTop: '1rem' }}>Log contact</h3>
      {lead.do_not_contact ? <p class="p-small" style={{ color: 'var(--danger)' }}>This business asked not to be contacted. Only notes can be added.</p> : null}
      <form class="p-form" onSubmit={(e) => {
        const form = e.currentTarget as HTMLFormElement
        const f = formData(e)
        run(async () => {
          check(await sb().from('lead_activities').insert({ lead_id: lead.id, kind: f.kind, body: f.body.trim() || null, outcome: f.outcome.trim() || null, happened_at: f.when ? new Date(f.when).toISOString() : new Date().toISOString() }))
          if (f.follow_up) check(await sb().from('lead_tasks').insert({ lead_id: lead.id, title: f.follow_title.trim() || 'Follow up', due_at: new Date(f.follow_up).toISOString() }))
          form.reset()
          await reload()
        }, 'Logged')
      }}>
        <div class="row2">
          <Field label="Type"><select name="kind" defaultValue={lead.do_not_contact ? 'note' : 'call'}>{(lead.do_not_contact ? ['note'] : ['call', 'whatsapp', 'email', 'meeting', 'note']).map((k) => <option value={k} key={k}>{ACT_LABEL[k]}</option>)}</select></Field>
          <Field label="When"><input name="when" type="datetime-local" /></Field>
        </div>
        <Field label="What happened"><textarea name="body" rows={2} maxLength={4000} /></Field>
        <Field label="Outcome (short)"><input name="outcome" maxLength={200} placeholder="e.g. Call back next week" /></Field>
        <div class="row2">
          <Field label="Next follow-up"><input name="follow_up" type="datetime-local" /></Field>
          <Field label="Follow-up task"><input name="follow_title" maxLength={200} placeholder="Follow up" /></Field>
        </div>
        <div class="p-row">
          <button class="btn btn-ink p-btn" disabled={busy}>Log</button>
          {!lead.do_not_contact && lead.primary_phone && <a class="btn btn-ghost p-btn" href={`tel:${lead.primary_phone}`}>Call</a>}
          {!lead.do_not_contact && lead.primary_phone && /^\+91[6-9]/.test(lead.primary_phone) && <a class="btn btn-ghost p-btn" href={`https://wa.me/${lead.primary_phone.replace(/\D/g, '')}`} target="_blank" rel="noopener">WhatsApp</a>}
        </div>
      </form>

      <h3 style={{ marginTop: '1rem' }}>Follow-ups</h3>
      {x?.tasks.length ? (
        <ul class="p-stack" style={{ listStyle: 'none', padding: 0, gap: '0.3rem' }}>
          {x.tasks.map((t) => (
            <li key={t.id} class="p-row p-small">
              <input type="checkbox" checked={!!t.done_at} aria-label={`Done: ${t.title}`} disabled={busy} onChange={(e) => run(async () => { check(await sb().from('lead_tasks').update({ done_at: (e.target as HTMLInputElement).checked ? new Date().toISOString() : null }).eq('id', t.id)); await reload() })} />
              <span style={t.done_at ? { textDecoration: 'line-through', opacity: 0.6 } : undefined}>{t.title}</span>
              <span class="p-spacer" /><span class="p-muted">{dt(t.due_at)}</span>
            </li>
          ))}
        </ul>
      ) : <p class="p-small p-muted">None.</p>}

      <div class="p-row" style={{ marginTop: '1rem' }}><h3 style={{ margin: 0 }}>Proposals</h3><span class="p-spacer" /><button class="btn btn-ghost p-btn" onClick={() => setProposal({})}>New proposal</button></div>
      {x?.props.length ? (
        <ul class="p-stack" style={{ listStyle: 'none', padding: 0, gap: '0.4rem' }}>
          {x.props.map((p) => (
            <li key={p.id} class="p-row p-small">
              <strong>{p.title}</strong> {inr(p.amount_inr)} <Badge tone={p.status === 'accepted' ? 'ok' : p.status === 'rejected' ? 'bad' : p.status === 'sent' ? 'ai' : undefined}>{p.status}</Badge>
              <span class="p-spacer" />
              {p.status === 'draft' && <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().from('proposals').update({ status: 'sent' }).eq('id', p.id)); await reload() }, 'Marked sent')}>Mark sent</button>}
              {p.status === 'sent' && <>
                <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().from('proposals').update({ status: 'accepted' }).eq('id', p.id)); await reload() }, 'Accepted — lead won')}>Accepted</button>
                <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => { check(await sb().from('proposals').update({ status: 'rejected' }).eq('id', p.id)); await reload() }, 'Marked rejected')}>Rejected</button>
              </>}
              <button class="btn btn-ghost p-btn" onClick={() => setProposal(p)}>Edit</button>
            </li>
          ))}
        </ul>
      ) : <p class="p-small p-muted">None.</p>}

      <h3 style={{ marginTop: '1rem' }}>History</h3>
      {x?.acts.length ? (
        <ol class="p-small" style={{ paddingLeft: '1.1rem' }}>
          {x.acts.map((a) => (
            <li key={a.id} style={{ marginBottom: '0.35rem' }}>
              <Badge>{ACT_LABEL[a.kind]}</Badge> {dt(a.happened_at)} {a.outcome && <strong>{a.outcome}</strong>}
              {a.body && <div style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>}
              {a.kind === 'note' && <button class="p-link p-small" disabled={busy} onClick={() => confirm('Delete this note?') && run(async () => { check(await sb().from('lead_activities').delete().eq('id', a.id)); await reload() })}>delete</button>}
            </li>
          ))}
        </ol>
      ) : <p class="p-small p-muted">No activity yet.</p>}

      {proposal && (
        <Modal title={proposal.id ? 'Edit proposal' : 'New proposal'} onClose={() => setProposal(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const row = { lead_id: lead.id, title: f.title.trim(), amount_inr: Number(f.amount), notes: f.notes.trim() || null, status: f.status }
            run(async () => {
              if (proposal.id) check(await sb().from('proposals').update(row).eq('id', proposal.id))
              else check(await sb().from('proposals').insert(row))
              setProposal(null)
              await reload()
            }, 'Proposal saved')
          }}>
            <Field label="Title"><input name="title" required maxLength={200} defaultValue={proposal.title ?? `Website for ${lead.name}`} /></Field>
            <div class="row2">
              <Field label="Amount (₹)"><input name="amount" type="number" min="0" step="100" required defaultValue={proposal.amount_inr ?? lead.estimated_value_inr ?? ''} /></Field>
              <Field label="Status"><select name="status" defaultValue={proposal.status ?? 'draft'}><option value="draft">Draft</option><option value="sent">Sent</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select></Field>
            </div>
            <Field label="Notes / scope"><textarea name="notes" rows={4} maxLength={4000} defaultValue={proposal.notes ?? ''} /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
      {converting && <ConvertModal lead={lead} onClose={() => setConverting(false)} onDone={reload} toast={app.toast} />}
    </div>
  )
}

function ConvertModal({ lead, onClose, onDone }: { lead: any; onClose: () => void; onDone: () => Promise<unknown>; toast: any }) {
  const { busy, run } = useAction()
  const [secret, setSecret] = useState<{ label: string; value: string; id: string } | null>(null)
  const presets = useLoad(async () => check(await sb().from('module_presets').select('key, name').order('sort')) as any[])
  return (
    <Modal title={`Create client account — ${lead.name}`} onClose={onClose}>
      {secret ? (
        <div class="p-stack">
          <OneTimeSecret label={secret.label} value={secret.value} />
          <a class="btn btn-ink p-btn" href={`/portal/admin/business/?id=${secret.id}`}>Open the new client</a>
        </div>
      ) : (
        <form class="p-form" onSubmit={(e) => {
          const f = formData(e)
          run(async () => {
            const r = await callFn('admin-users', {
              action: 'create_client', email: f.email, full_name: f.full_name, phone: f.phone,
              business: { name: f.business, industry: industryByKey(lead.industry)?.label ?? lead.category ?? null, preset: f.preset, city: lead.city ?? 'Pune', locality: lead.locality, site_url: lead.website_state === 'live' ? lead.website_url : undefined },
            })
            check(await sb().from('leads').update({ converted_business_id: r.business_id, stage: 'won' }).eq('id', lead.id))
            setSecret({ label: `Temporary password for ${f.email}`, value: r.temp_password, id: r.business_id })
            await onDone()
          }, 'Client created')
        }}>
          <div class="row2">
            <Field label="Client name"><input name="full_name" required defaultValue={lead.contact_person ?? ''} /></Field>
            <Field label="Client email (their login)"><input name="email" type="email" required defaultValue={lead.primary_email ?? ''} /></Field>
          </div>
          <div class="row2">
            <Field label="Phone"><input name="phone" defaultValue={lead.primary_phone ?? ''} /></Field>
            <Field label="Business name"><input name="business" required defaultValue={lead.name} /></Field>
          </div>
          <Field label="Modules" hint="Suggested from the industry; change anytime.">
            <select name="preset" defaultValue={presetForIndustry(lead.industry)}>{(presets.data ?? []).map((p) => <option value={p.key} key={p.key}>{p.name}</option>)}</select>
          </Field>
          <button class="btn btn-ink p-btn" disabled={busy}>Create client account</button>
        </form>
      )}
    </Modal>
  )
}
