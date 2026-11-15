// Dashboard, account, team and business settings.
import { useState } from 'preact/hooks'
import { businessNav } from '../nav'
import { callFn, check, d, sb } from '../lib'
import { Badge, Empty, ErrorNote, Field, Modal, OneTimeSecret, PageHead, Portal, useAction, useApp, useLoad, formData } from '../ui'

export function Dashboard() {
  return (
    <Portal title="Dashboard">
      {(app) => {
        const { ctx, biz, isAdmin } = app
        const name = ctx.profile.full_name?.split(' ')[0] || 'there'
        const items = biz
          ? businessNav.filter((n) => {
              if (n.ownerOnly) return biz.role === 'owner'
              if (n.module && !biz.modules.includes(n.module)) return false
              if (n.perm && !(biz.role === 'owner' || biz.permissions.includes(n.perm))) return false
              return true
            })
          : []
        return (
          <>
            <PageHead title={`Hello, ${name}`} sub={biz ? `You’re working in ${biz.business_name}.` : isAdmin ? 'Tomorrow Web administrator' : ''} />
            {isAdmin && (
              <div class="p-notice" style={{ marginBottom: '1rem' }}>
                <span>Administrator tools are in the menu under “Tomorrow Web”. <a href="/portal/admin/">Open the admin overview →</a></span>
              </div>
            )}
            {biz ? (
              <div class="p-grid">
                {items.map((n) => (
                  <a class="p-card" href={n.href} key={n.href} style={{ textDecoration: 'none' }}>
                    <h3>{n.label}</h3>
                    <span class="p-muted p-small">Open →</span>
                  </a>
                ))}
              </div>
            ) : (
              !isAdmin && <Empty>Your account isn’t linked to a business yet. Tomorrow Web will set this up for you.</Empty>
            )}
          </>
        )
      }}
    </Portal>
  )
}

export function Account() {
  return (
    <Portal title="Account">
      {(app) => <AccountBody app={app} />}
    </Portal>
  )
}

function AccountBody({ app }: { app: ReturnType<typeof useApp> }) {
  const { busy, run } = useAction()
  const p = app.ctx.profile
  return (
    <>
      <PageHead title="Your account" sub={p.email} />
      <div class="p-grid-2">
        <form class="p-card p-form" onSubmit={(e) => {
          const f = formData(e)
          run(async () => {
            check(await sb().from('profiles').update({ full_name: f.full_name.trim(), phone: f.phone.trim() || null }).eq('id', p.id))
            await app.reload()
          }, 'Saved')
        }}>
          <h2>Profile</h2>
          <Field label="Name"><input name="full_name" defaultValue={p.full_name} required maxLength={120} /></Field>
          <Field label="Phone / WhatsApp"><input name="phone" defaultValue={p.phone ?? ''} maxLength={30} /></Field>
          <div><button class="btn btn-ink p-btn" disabled={busy}>Save</button></div>
        </form>
        <div class="p-card">
          <h2>Password</h2>
          <p class="p-muted">Change the password you use to sign in.</p>
          <a class="btn btn-ghost p-btn" href="/portal/password/">Change password</a>
        </div>
      </div>
    </>
  )
}

const PERM_LABELS: Record<string, string> = {
  'orders.view': 'See orders',
  'orders.update': 'Update orders',
  'pos.sell': 'Use the POS',
  'products.manage': 'Manage products',
  'inventory.manage': 'Manage inventory',
  'customers.view': 'See customer list',
  'discounts.manage': 'Manage discounts',
  'reports.view': 'See sales reports',
  'refunds.issue': 'Issue refunds',
  'settings.manage': 'Business settings & website',
}

export function Team() {
  return (
    <Portal title="Team" need="business">
      {(app) => (app.biz!.role === 'owner' ? <TeamBody app={app} /> : <div class="p-notice" data-tone="warn">Only the business owner manages the team.</div>)}
    </Portal>
  )
}

function TeamBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const [adding, setAdding] = useState(false)
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null)
  const [editing, setEditing] = useState<any>(null)
  const team = useLoad(async () => {
    const members = check(await sb().from('business_members').select('user_id, role, permissions, active, created_at').eq('business_id', bizId).order('created_at'))
    const ids = (members as any[]).map((m) => m.user_id)
    const profiles = ids.length ? check(await sb().from('profiles').select('id, full_name, email, phone').in('id', ids)) : []
    const byId = new Map((profiles as any[]).map((p) => [p.id, p]))
    return (members as any[]).map((m) => ({ ...m, profile: byId.get(m.user_id) }))
  }, [bizId])

  return (
    <>
      <PageHead title="Team" sub="Staff accounts for your business. Each person signs in with their own email.">
        <button class="btn btn-ink p-btn" onClick={() => setAdding(true)}>Add staff member</button>
      </PageHead>
      {secret && <div style={{ marginBottom: '1rem' }}><OneTimeSecret {...secret} /></div>}
      <ErrorNote error={team.error} />
      <div class="p-table-wrap">
        <table class="p-table">
          <thead><tr><th>Name</th><th>Role</th><th>Can</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {(team.data ?? []).map((m: any) => (
              <tr key={m.user_id}>
                <td>{m.profile?.full_name || '—'}<div class="p-small p-muted">{m.profile?.email}</div></td>
                <td>{m.role}</td>
                <td class="p-small">{m.role === 'owner' ? 'Everything' : m.permissions.map((p: string) => PERM_LABELS[p] ?? p).join(', ') || '—'}</td>
                <td>{m.active ? <Badge tone="ok">Active</Badge> : <Badge>Deactivated</Badge>}</td>
                <td>
                  {m.role !== 'owner' && m.user_id !== app.ctx.profile.id && (
                    <div class="p-row">
                      <button class="btn btn-ghost p-btn" onClick={() => setEditing(m)}>Permissions</button>
                      <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => {
                        const r = await callFn('business-members', { action: 'reset_member_password', business_id: bizId, user_id: m.user_id })
                        setSecret({ label: `New temporary password for ${m.profile?.email}`, value: r.temp_password })
                      }, 'Password reset')}>Reset password</button>
                      <button class="btn btn-ghost p-btn" disabled={busy} onClick={() => run(async () => {
                        await callFn('business-members', { action: 'set_member_active', business_id: bizId, user_id: m.user_id, active: !m.active })
                        await team.reload()
                      }, m.active ? 'Deactivated' : 'Reactivated')}>{m.active ? 'Deactivate' : 'Reactivate'}</button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <Modal title="Add staff member" onClose={() => setAdding(false)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const perms = Object.keys(PERM_LABELS).filter((p) => f[`perm_${p}`])
            run(async () => {
              const r = await callFn('business-members', { action: 'create_member', business_id: bizId, email: f.email, full_name: f.full_name, phone: f.phone, role: f.role, permissions: perms })
              setAdding(false)
              setSecret({ label: `Temporary password for ${f.email}`, value: r.temp_password })
              await team.reload()
            }, 'Staff member added')
          }}>
            <div class="row2">
              <Field label="Name"><input name="full_name" required maxLength={120} /></Field>
              <Field label="Email"><input name="email" type="email" required /></Field>
            </div>
            <div class="row2">
              <Field label="Phone (optional)"><input name="phone" maxLength={30} /></Field>
              <Field label="Role"><select name="role"><option value="employee">Employee</option><option value="manager">Manager</option></select></Field>
            </div>
            <fieldset class="p-card">
              <legend class="p-small">What can they do?</legend>
              <div class="p-grid" style={{ gap: '0.4rem' }}>
                {Object.entries(PERM_LABELS).map(([k, v]) => (
                  <label class="p-check" key={k}><input type="checkbox" name={`perm_${k}`} defaultChecked={['orders.view', 'orders.update', 'pos.sell'].includes(k)} /> {v}</label>
                ))}
              </div>
            </fieldset>
            <button class="btn btn-ink p-btn" disabled={busy}>Create account</button>
          </form>
        </Modal>
      )}

      {editing && (
        <Modal title={`Permissions — ${editing.profile?.full_name || editing.profile?.email}`} onClose={() => setEditing(null)}>
          <form class="p-form" onSubmit={(e) => {
            const f = formData(e)
            const perms = Object.keys(PERM_LABELS).filter((p) => f[`perm_${p}`])
            run(async () => {
              check(await sb().from('business_members').update({ permissions: perms, role: f.role }).eq('business_id', bizId).eq('user_id', editing.user_id))
              setEditing(null)
              await team.reload()
            }, 'Permissions saved')
          }}>
            <Field label="Role"><select name="role" defaultValue={editing.role}><option value="employee">Employee</option><option value="manager">Manager</option></select></Field>
            <div class="p-grid" style={{ gap: '0.4rem' }}>
              {Object.entries(PERM_LABELS).map(([k, v]) => (
                <label class="p-check" key={k}><input type="checkbox" name={`perm_${k}`} defaultChecked={editing.permissions.includes(k)} /> {v}</label>
              ))}
            </div>
            <button class="btn btn-ink p-btn" disabled={busy}>Save</button>
          </form>
        </Modal>
      )}
    </>
  )
}

export function Settings() {
  return (
    <Portal title="Business settings" need="business" perm="settings.manage">
      {(app) => <SettingsBody app={app} />}
    </Portal>
  )
}

function SettingsBody({ app }: { app: ReturnType<typeof useApp> }) {
  const bizId = app.bizId!
  const { busy, run } = useAction()
  const biz = useLoad(async () => check(await sb().from('businesses').select('*').eq('id', bizId).single()), [bizId])
  const sites = useLoad(async () => check(await sb().from('sites').select('id, name, url').eq('business_id', bizId)), [bizId])
  if (biz.loading) return <div class="p-loading">Loading…</div>
  const b: any = biz.data
  return (
    <>
      <PageHead title="Business settings" sub={`Created ${d(b?.created_at)}`} />
      <ErrorNote error={biz.error} />
      <div class="p-grid-2">
        <form class="p-card p-form" onSubmit={(e) => {
          const f = formData(e)
          run(async () => {
            check(await sb().from('businesses').update({ name: f.name.trim(), industry: f.industry.trim() || null, city: f.city.trim() || null, locality: f.locality.trim() || null }).eq('id', bizId))
            await app.reload()
          }, 'Saved')
        }}>
          <h2>Details</h2>
          <Field label="Business name"><input name="name" defaultValue={b?.name} required maxLength={160} /></Field>
          <Field label="Industry"><input name="industry" defaultValue={b?.industry ?? ''} maxLength={80} /></Field>
          <div class="row2">
            <Field label="City"><input name="city" defaultValue={b?.city ?? ''} maxLength={80} /></Field>
            <Field label="Locality"><input name="locality" defaultValue={b?.locality ?? ''} maxLength={80} /></Field>
          </div>
          <div><button class="btn btn-ink p-btn" disabled={busy}>Save</button></div>
        </form>
        <div class="p-card">
          <h2>Websites</h2>
          {(sites.data as any[] | undefined)?.length ? (
            <ul>{(sites.data as any[]).map((s) => <li key={s.id}>{s.name} {s.url && <a href={s.url} target="_blank" rel="noopener">{s.url}</a>}</li>)}</ul>
          ) : (
            <p class="p-muted">No website linked yet. Tomorrow Web links your site when it’s set up.</p>
          )}
        </div>
      </div>
    </>
  )
}
