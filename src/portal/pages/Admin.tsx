// Administrator pages: overview, clients & businesses, business detail, audit log, infrastructure.
import { useState } from 'preact/hooks'
import { ago, bytes, callFn, check, d, dt, qs, sb, setCurrentBusiness } from '../lib'
import { CHECKED_ON, dependencies } from '../dependencies'
import { Badge, Empty, ErrorNote, Field, Modal, OneTimeSecret, PageHead, Portal, Stat, useAction, useApp, useLoad, formData } from '../ui'

const FREE_DB = 500 * 1024 * 1024
const FREE_STORAGE = 1024 * 1024 * 1024

export function AdminOverview() {
  return (
    <Portal title="Admin" need="admin">
      {() => <OverviewBody />}
    </Portal>
  )
}

function OverviewBody() {
  const stats = useLoad(async () => {
    const [biz, logs, usage] = await Promise.all([
      sb().from('businesses').select('id', { count: 'exact', head: true }),
      sb().from('audit_logs').select('at, action, actor_email').order('at', { ascending: false }).limit(8),
      sb().rpc('admin_usage'),
    ])
    return { businesses: biz.count ?? 0, logs: check(logs) as any[], usage: check(usage) as any }
  })
  const u = stats.data?.usage
  return (
    <>
      <PageHead title="Admin overview" sub="Live figures from the database." />
      <ErrorNote error={stats.error} />
      <div class="p-grid">
        <Stat n={stats.data?.businesses ?? '…'} label="Client businesses" />
        <Stat n={u?.auth_users ?? '…'} label="Accounts" />
        <Stat n={u ? bytes(u.database_bytes) : '…'} label="Database size" />
        <Stat n={u ? bytes(u.storage_bytes) : '…'} label="File storage" />
      </div>
      <StatusWarnings usage={u} />
      <FollowUpsDue />
      <div class="p-card" style={{ marginTop: '1rem' }}>
        <h2>Recent activity</h2>
        {stats.data?.logs.length ? (
          <ul class="p-small" style={{ paddingLeft: '1rem' }}>
            {stats.data.logs.map((l, i) => <li key={i}>{dt(l.at)} — <strong>{l.action}</strong> {l.actor_email && `by ${l.actor_email}`}</li>)}
          </ul>
        ) : <p class="p-muted">No activity yet.</p>}
        <a href="/portal/admin/audit/">Full audit log →</a>
      </div>
    </>
  )
}

/** CRM follow-ups due today/overdue. Silent if the CRM isn't set up yet. */
function FollowUpsDue() {
  const due = useLoad(async () => {
    const end = new Date(); end.setHours(23, 59, 59, 999)
    const r = await sb().from('lead_tasks').select('id, due_at').is('done_at', null).lte('due_at', end.toISOString())
    if (r.error) return null
    const now = Date.now()
    return { overdue: r.data.filter((t) => new Date(t.due_at).getTime() < now).length, today: r.data.filter((t) => new Date(t.due_at).getTime() >= now).length }
  })
  if (!due.data || (!due.data.overdue && !due.data.today)) return null
  return (
    <div class="p-notice" data-tone={due.data.overdue ? 'warn' : undefined} style={{ marginTop: '1rem' }}>
      <span>Sales follow-ups: <strong>{due.data.overdue} overdue</strong>, {due.data.today} due later today. <a href="/portal/admin/crm/">Open the CRM →</a></span>
    </div>
  )
}

function StatusWarnings({ usage }: { usage: any }) {
  if (!usage) return null
  const warn: string[] = []
  const ka = usage.status?.keepalive?.last_ok_at
  const bk = usage.status?.backup?.last_ok_at
  const days = (s?: string) => (s ? (Date.now() - new Date(s).getTime()) / 86400000 : Infinity)
  if (days(ka) > 3) warn.push(`Keep-alive last succeeded ${ago(ka)}. Free Supabase projects pause after about 7 days without activity.`)
  if (days(bk) > 2) warn.push(`Last successful backup: ${ago(bk)}. Check the GitHub backup workflow and download a copy off-site monthly.`)
  if (usage.database_bytes > FREE_DB * 0.8) warn.push('Database is above 80% of the free limit.')
  if (usage.storage_bytes > FREE_STORAGE * 0.8) warn.push('File storage is above 80% of the free limit.')
  if (!warn.length) return null
  return (
    <div class="p-stack" style={{ marginTop: '1rem' }}>
      {warn.map((w) => <div class="p-notice" data-tone="warn" key={w}>{w}</div>)}
    </div>
  )
}

export function Clients() {
  return (
    <Portal title="Clients" need="admin">
      {(app) => <ClientsBody app={app} />}
    </Portal>
  )
}

function ClientsBody({ app }: { app: ReturnType<typeof useApp> }) {
  const { busy, run } = useAction()
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [q, setQ] = useState('')
  const list = useLoad(async () => {
    const biz = check(await sb().from('businesses').select('id, name, industry, preset, city, locality, created_at, business_modules(module_key, enabled), business_members(role, user_id)').order('created_at', { ascending: false })) as any[]
    const ownerIds = biz.flatMap((b) => b.business_members.filter((m: any) => m.role === 'owner').map((m: any) => m.user_id))
    const profiles = ownerIds.length ? (check(await sb().from('profiles').select('id, full_name, email, disabled').in('id', ownerIds)) as any[]) : []
    const byId = new Map(profiles.map((p) => [p.id, p]))
    return biz.map((b) => ({ ...b, owners: b.business_members.filter((m: any) => m.role === 'owner').map((m: any) => byId.get(m.user_id)).filter(Boolean) }))
  })
  const presets = useLoad(async () => check(await sb().from('module_presets').select('key, name').order('sort')) as any[])
  const rows = (list.data ?? []).filter((b: any) => !q || `${b.name} ${b.city} ${b.owners.map((o: any) => o.email).join(' ')}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <>
      <PageHead title="Clients & businesses" sub="Create client accounts, switch modules on and manage logins.">
        <button class="btn btn-ink p-btn" onClick={() => setCreating(true)}>New client</button>
      </PageHead>
      {secret && <div style={{ marginBottom: '1rem' }}><OneTimeSecret {...secret} /></div>}
      <ErrorNote error={list.error} />
      <input class="p-input" placeholder="Search businesses, cities or emails" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ marginBottom: '1rem', maxWidth: '420px' }} />
      {rows.length ? (
        <div class="p-table-wrap">
          <table class="p-table">
            <thead><tr><th>Business</th><th>Owner</th><th>Preset</th><th>Modules</th><th>Created</th><th></th></tr></thead>
            <tbody>
              {rows.map((b: any) => (
                <tr key={b.id}>
                  <td><strong>{b.name}</strong><div class="p-small p-muted">{[b.industry, b.locality, b.city].filter(Boolean).join(' · ')}</div></td>
                  <td class="p-small">{b.owners.map((o: any) => <div key={o.id}>{o.full_name} <span class="p-muted">{o.email}</span> {o.disabled && <Badge tone="bad">disabled</Badge>}</div>)}</td>
                  <td>{b.preset ?? '—'}</td>
                  <td class="num">{b.business_modules.filter((m: any) => m.enabled).length}</td>
                  <td>{d(b.created_at)}</td>
                  <td>
                    <div class="p-row">
                      <a class="btn btn-ghost p-btn" href={`/portal/admin/business/?id=${b.id}`}>Manage</a>
                      <button class="btn btn-ghost p-btn" onClick={() => { setCurrentBusiness(b.id); location.href = '/portal/' }}>Open dashboard</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !list.loading && <Empty>No clients yet. Create the first one with “New client”.</Empty>}

      {creating && (
        <Modal title="New client" onClose={() => setCreating(false)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            run(async () => {
              const r = await callFn('admin-users', {
                action: 'create_client', email: f.email, full_name: f.full_name, phone: f.phone,
                business: { name: f.business, industry: f.industry, preset: f.preset, city: f.city, locality: f.locality, site_url: f.site_url },
              })
              setCreating(false)
              setSecret({ label: `Temporary password for ${f.email}`, value: r.temp_password })
              await list.reload()
              await app.reload()
            }, 'Client created')
          }}>
            <div class="row2">
              <Field label="Client name"><input name="full_name" required maxLength={120} /></Field>
              <Field label="Client email (their login)"><input name="email" type="email" required /></Field>
            </div>
            <div class="row2">
              <Field label="Phone / WhatsApp"><input name="phone" maxLength={30} /></Field>
              <Field label="Business name"><input name="business" required maxLength={160} /></Field>
            </div>
            <div class="row2">
              <Field label="Industry"><input name="industry" maxLength={80} placeholder="e.g. Café" /></Field>
              <Field label="Starting modules (preset)" hint="You can change modules later.">
                <select name="preset" defaultValue="website_only">
                  {(presets.data ?? []).map((p: any) => <option value={p.key} key={p.key}>{p.name}</option>)}
                </select>
              </Field>
            </div>
            <div class="row2">
              <Field label="City"><input name="city" defaultValue="Pune" maxLength={80} /></Field>
              <Field label="Locality"><input name="locality" maxLength={80} /></Field>
            </div>
            <Field label="Website URL (optional)"><input name="site_url" type="url" placeholder="https://" /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Create client account</button>
          </form>
        </Modal>
      )}
    </>
  )
}

export function BusinessDetail() {
  return (
    <Portal title="Business" need="admin">
      {(app) => <BusinessBody app={app} id={qs('id') ?? ''} />}
    </Portal>
  )
}

function BusinessBody({ app, id }: { app: ReturnType<typeof useApp>; id: string }) {
  const { busy, run } = useAction()
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [addingOwner, setAddingOwner] = useState(false)
  const [siteForm, setSiteForm] = useState<any>(null)
  const data = useLoad(async () => {
    const [b, mods, bm, members, sites, presets] = await Promise.all([
      sb().from('businesses').select('*').eq('id', id).single(),
      sb().from('modules').select('*').order('sort'),
      sb().from('business_modules').select('module_key, enabled').eq('business_id', id),
      sb().from('business_members').select('user_id, role, permissions, active').eq('business_id', id),
      sb().from('sites').select('*').eq('business_id', id),
      sb().from('module_presets').select('key, name, modules').order('sort'),
    ])
    const mem = check(members) as any[]
    const profiles = mem.length ? (check(await sb().from('profiles').select('id, full_name, email, disabled, must_change_password').in('id', mem.map((m) => m.user_id))) as any[]) : []
    const byId = new Map(profiles.map((p) => [p.id, p]))
    return {
      biz: check(b) as any,
      modules: check(mods) as any[],
      enabled: new Set((check(bm) as any[]).filter((x) => x.enabled).map((x) => x.module_key)),
      members: mem.map((m) => ({ ...m, profile: byId.get(m.user_id) })),
      sites: check(sites) as any[],
      presets: check(presets) as any[],
    }
  }, [id])

  if (data.loading && !data.data) return <div class="p-loading">Loading…</div>
  if (data.error) return <ErrorNote error={data.error} />
  const x = data.data!

  async function toggle(key: string, on: boolean) {
    await run(async () => {
      check(await sb().from('business_modules').upsert({ business_id: id, module_key: key, enabled: on, updated_by: app.ctx.profile.id }, { onConflict: 'business_id,module_key' }))
      await data.reload()
    }, on ? 'Module switched on' : 'Module switched off')
  }

  const missingDeps = (m: any) => (m.requires as string[]).filter((r) => !x.enabled.has(r))

  return (
    <>
      <PageHead title={x.biz.name} sub={[x.biz.industry, x.biz.locality, x.biz.city].filter(Boolean).join(' · ')}>
        <button class="btn btn-ghost p-btn" onClick={() => { setCurrentBusiness(id); location.href = '/portal/' }}>Open their dashboard</button>
      </PageHead>
      {secret && <div style={{ marginBottom: '1rem' }}><OneTimeSecret {...secret} /></div>}

      <div class="p-card" style={{ marginBottom: '1rem' }}>
        <div class="p-row">
          <h2 style={{ margin: 0 }}>Modules</h2>
          <span class="p-spacer" />
          <label class="p-field" style={{ maxWidth: '260px' }}>
            <span class="sr-only">Apply preset</span>
            <select onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value
              if (v) run(async () => { await callFn('admin-users', { action: 'apply_preset', business_id: id, preset: v }); await data.reload() }, 'Preset applied (adds modules; nothing is removed)')
            }}>
              <option value="">Apply a preset…</option>
              {x.presets.map((p) => <option value={p.key} key={p.key}>{p.name}</option>)}
            </select>
          </label>
        </div>
        <p class="p-small p-muted">The client only sees switched-on modules. Modules marked “external” need a third-party account and may involve their charges.</p>
        <div class="p-grid">
          {x.modules.map((m) => {
            const on = x.enabled.has(m.key)
            const missing = missingDeps(m)
            return (
              <label class="p-card" key={m.key} style={{ display: 'grid', gap: '0.35rem', alignContent: 'start' }}>
                <span class="p-row">
                  <input type="checkbox" checked={on} disabled={busy} onChange={(e) => toggle(m.key, (e.target as HTMLInputElement).checked)} />
                  <strong>{m.name}</strong>
                  {m.external_dependency && <Badge tone="warn">external</Badge>}
                </span>
                <span class="p-small p-muted">{m.description}</span>
                {m.dependency_note && <span class="p-small" style={{ color: '#f0d26b' }}>{m.dependency_note}</span>}
                {on && missing.length > 0 && <span class="p-small" style={{ color: 'var(--danger)' }}>Also needs: {missing.join(', ')}</span>}
              </label>
            )
          })}
        </div>
      </div>

      <div class="p-stack">
        <div class="p-card">
          <div class="p-row"><h2 style={{ margin: 0 }}>People</h2><span class="p-spacer" /><button class="btn btn-ghost p-btn" onClick={() => setAddingOwner(true)}>Add owner</button></div>
          <div class="p-table-wrap" style={{ marginTop: '0.75rem' }}>
            <table class="p-table">
              <thead><tr><th>Person</th><th>Role</th><th></th></tr></thead>
              <tbody>
                {x.members.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.profile?.full_name}<div class="p-small p-muted">{m.profile?.email}</div>
                      {m.profile?.must_change_password && <Badge tone="warn">temp password</Badge>} {m.profile?.disabled && <Badge tone="bad">disabled</Badge>} {!m.active && <Badge>inactive</Badge>}
                    </td>
                    <td>{m.role}</td>
                    <td>
                      <div class="p-row">
                        <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => {
                          const r = await callFn('admin-users', { action: 'reset_password', user_id: m.user_id })
                          setSecret({ label: `New temporary password for ${m.profile?.email}`, value: r.temp_password })
                          await data.reload()
                        }, 'Password reset')}>Reset password</button>
                        <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => {
                          await callFn('admin-users', { action: 'set_disabled', user_id: m.user_id, disabled: !m.profile?.disabled })
                          await data.reload()
                        }, m.profile?.disabled ? 'Account enabled' : 'Account disabled')}>{m.profile?.disabled ? 'Enable' : 'Disable'}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div class="p-card">
          <div class="p-row"><h2 style={{ margin: 0 }}>Websites</h2><span class="p-spacer" /><button class="btn btn-ghost p-btn" onClick={() => setSiteForm({})}>Add website</button></div>
          {x.sites.length ? (
            <div class="p-stack" style={{ marginTop: '0.75rem' }}>
              {x.sites.map((s) => (
                <div key={s.id} class="p-card">
                  <strong>{s.name}</strong> {s.url && <a href={s.url} target="_blank" rel="noopener" class="p-small">{s.url}</a>}
                  <div class="p-small p-muted">Site key (for the AI widget and CMS): <code>{s.public_key}</code></div>
                  <div class="p-small p-muted">Allowed origins: {s.allowed_origins.join(', ') || 'none set'}</div>
                  <button class="btn btn-ghost p-btn" onClick={() => setSiteForm(s)} style={{ marginTop: '0.5rem' }}>Edit</button>
                </div>
              ))}
            </div>
          ) : <p class="p-muted">No websites yet.</p>}
        </div>
      </div>

      {addingOwner && (
        <Modal title="Add owner" onClose={() => setAddingOwner(false)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            run(async () => {
              const r = await callFn('admin-users', { action: 'add_owner', business_id: id, email: f.email, full_name: f.full_name, phone: f.phone })
              setAddingOwner(false)
              if (r.temp_password) setSecret({ label: `Temporary password for ${f.email}`, value: r.temp_password })
              await data.reload()
            }, 'Owner added')
          }}>
            <Field label="Name"><input name="full_name" required /></Field>
            <Field label="Email" hint="If they already have an account, it’s linked instead."><input name="email" type="email" required /></Field>
            <Field label="Phone"><input name="phone" /></Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Add owner</button>
          </form>
        </Modal>
      )}

      {siteForm && (
        <Modal title={siteForm.id ? 'Edit website' : 'Add website'} onClose={() => setSiteForm(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const row = {
              business_id: id, name: f.name.trim(), url: f.url.trim() || null, repo: f.repo.trim() || null,
              allowed_origins: f.allowed_origins.split(/[\s,]+/).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
            }
            run(async () => {
              if (siteForm.id) check(await sb().from('sites').update(row).eq('id', siteForm.id))
              else check(await sb().from('sites').insert(row))
              setSiteForm(null)
              await data.reload()
            }, 'Website saved')
          }}>
            <Field label="Name"><input name="name" defaultValue={siteForm.name ?? x.biz.name} required /></Field>
            <Field label="URL"><input name="url" type="url" defaultValue={siteForm.url ?? ''} placeholder="https://" /></Field>
            <Field label="GitHub repo (optional)"><input name="repo" defaultValue={siteForm.repo ?? ''} placeholder="owner/repo" /></Field>
            <Field label="Allowed origins" hint="Websites allowed to use the AI widget and store checkout, e.g. https://example.com (comma separated).">
              <input name="allowed_origins" defaultValue={(siteForm.allowed_origins ?? []).join(', ')} />
            </Field>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}

export function Audit() {
  return (
    <Portal title="Audit log" need="admin">
      {() => <AuditBody />}
    </Portal>
  )
}

function AuditBody() {
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const PER = 50
  const logs = useLoad(async () => {
    let q = sb().from('audit_logs').select('*').order('at', { ascending: false }).range(page * PER, page * PER + PER - 1)
    if (filter) q = q.ilike('action', `%${filter}%`)
    return check(await q) as any[]
  }, [filter, page])
  return (
    <>
      <PageHead title="Audit log" sub="Every important administrative and security action. Entries can’t be edited or deleted." />
      <input class="p-input" placeholder="Filter by action (e.g. create_client, update:business_modules)" value={filter} onInput={(e) => { setPage(0); setFilter((e.target as HTMLInputElement).value) }} style={{ marginBottom: '1rem', maxWidth: '460px' }} />
      <ErrorNote error={logs.error} />
      <div class="p-table-wrap">
        <table class="p-table">
          <thead><tr><th>When</th><th>Action</th><th>By</th><th>Details</th></tr></thead>
          <tbody>
            {(logs.data ?? []).map((l) => (
              <tr key={l.id}>
                <td style={{ whiteSpace: 'nowrap' }}>{dt(l.at)}</td>
                <td><code>{l.action}</code></td>
                <td class="p-small">{l.actor_email ?? 'system'}</td>
                <td class="p-small"><details><summary>View</summary><pre style={{ whiteSpace: 'pre-wrap', maxWidth: '60ch' }}>{JSON.stringify(l.details, null, 2)}</pre></details></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="p-row" style={{ marginTop: '1rem' }}>
        <button class="btn btn-ghost p-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</button>
        <button class="btn btn-ghost p-btn" disabled={(logs.data ?? []).length < PER} onClick={() => setPage(page + 1)}>Older</button>
      </div>
    </>
  )
}

export function Infrastructure() {
  return (
    <Portal title="Infrastructure" need="admin">
      {() => <InfraBody />}
    </Portal>
  )
}

function InfraBody() {
  const usage = useLoad(async () => check(await sb().rpc('admin_usage')) as any)
  const u = usage.data
  const pct = (a: number, b: number) => `${Math.min(100, Math.round((a / b) * 100))}%`
  return (
    <>
      <PageHead title="Infrastructure & costs" sub="What the platform depends on, what’s free, and what could ever cost money." />
      <ErrorNote error={usage.error} />
      <div class="p-grid">
        <Stat n={u ? `${bytes(u.database_bytes)} · ${pct(u.database_bytes, FREE_DB)}` : '…'} label="Database of ≈500 MB free" />
        <Stat n={u ? `${bytes(u.storage_bytes)} · ${pct(u.storage_bytes, FREE_STORAGE)}` : '…'} label="File storage of ≈1 GB free" />
        <Stat n={u ? ago(u.status?.keepalive?.last_ok_at) : '…'} label="Last keep-alive" />
        <Stat n={u ? ago(u.status?.backup?.last_ok_at) : '…'} label="Last verified backup" />
      </div>
      <StatusWarnings usage={u} />
      <div class="p-notice" style={{ margin: '1rem 0' }}>
        Nothing here is switched on or paid for automatically. Integrations that need billing, a payment provider or another company’s account are off until you set them up. Free limits are as published on {CHECKED_ON} and can change — follow the links to check.
      </div>
      <div class="p-table-wrap">
        <table class="p-table">
          <thead><tr><th>Service</th><th>Used for</th><th>Needs</th><th>Free limits</th><th>Could it cost money?</th><th>If unavailable</th></tr></thead>
          <tbody>
            {dependencies.map((x) => (
              <tr key={x.service}>
                <td><a href={x.link} target="_blank" rel="noopener">{x.service}</a> {x.required ? <Badge tone="ok">required</Badge> : <Badge>optional</Badge>}</td>
                <td class="p-small">{x.usedFor}</td>
                <td class="p-small">{x.needs}</td>
                <td class="p-small">{x.freeLimits}</td>
                <td class="p-small">{x.paidRisk}</td>
                <td class="p-small">{x.ifUnavailable}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
