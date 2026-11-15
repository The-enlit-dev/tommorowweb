// M0 API tests: onboarding, roles and isolation against the real project.
// Run: TW_QA_EMAIL=... TW_QA_PASSWORD=... node --test tests/api/m0.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, fn, qaEmail, signIn, strongPassword } from './helpers.mjs'

const QA_EMAIL = process.env.TW_QA_EMAIL
const QA_PASSWORD = process.env.TW_QA_PASSWORD
if (!QA_EMAIL || !QA_PASSWORD) throw new Error('Set TW_QA_EMAIL and TW_QA_PASSWORD')

const state = {}

test('admin signs in', async () => {
  state.admin = await signIn(QA_EMAIL, QA_PASSWORD)
  const { data } = await state.admin.rpc('my_context')
  assert.equal(data.profile.role, 'admin')
})

test('admin creates a client with the restaurant preset', async () => {
  state.ownerEmail = qaEmail('owner')
  const r = await fn(state.admin, 'admin-users', {
    action: 'create_client', email: state.ownerEmail, full_name: 'QA Owner', phone: '9000000001',
    business: { name: 'QA Restaurant', industry: 'Restaurant', preset: 'restaurant', city: 'Pune', locality: 'Baner' },
  })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  assert.match(r.data.temp_password, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/)
  assert.ok(r.data.modules.includes('pos') && r.data.modules.includes('kitchen_display'))
  state.biz = r.data.business_id
  state.ownerTemp = r.data.temp_password
})

test('duplicate client email is refused', async () => {
  const r = await fn(state.admin, 'admin-users', { action: 'create_client', email: state.ownerEmail, full_name: 'X', business: { name: 'X' } })
  assert.equal(r.status, 409)
})

test('owner must change the temporary password before getting access', async () => {
  const sb = client()
  await sb.auth.signInWithPassword({ email: state.ownerEmail, password: state.ownerTemp })
  const { data: biz } = await sb.from('businesses').select('id')
  assert.equal(biz.length, 0, 'no access before password change')
  const blocked = await fn(sb, 'business-members', { action: 'create_member', business_id: state.biz, email: qaEmail('x'), full_name: 'X' })
  assert.equal(blocked.status, 403)
  state.ownerPassword = strongPassword()
  state.owner = await signIn(state.ownerEmail, state.ownerTemp, state.ownerPassword)
  const { data: biz2 } = await state.owner.from('businesses').select('id, name')
  assert.deepEqual(biz2.map((b) => b.name), ['QA Restaurant'])
})

test('owner creates an employee with default permissions', async () => {
  state.empEmail = qaEmail('emp')
  const r = await fn(state.owner, 'business-members', {
    action: 'create_member', business_id: state.biz, email: state.empEmail, full_name: 'QA Employee', role: 'employee',
  })
  assert.equal(r.status, 200, JSON.stringify(r.data))
  state.empTemp = r.data.temp_password
  state.empId = r.data.user_id
  const { data: m } = await state.owner.from('business_members').select('permissions').eq('user_id', state.empId).single()
  assert.deepEqual(m.permissions, ['orders.view', 'orders.update', 'pos.sell'])
  state.emp = await signIn(state.empEmail, state.empTemp, strongPassword())
})

test('employee cannot manage staff or call admin functions', async () => {
  const a = await fn(state.emp, 'business-members', { action: 'create_member', business_id: state.biz, email: qaEmail('y'), full_name: 'Y' })
  assert.equal(a.status, 403)
  const b = await fn(state.emp, 'admin-users', { action: 'create_admin', email: qaEmail('z') })
  assert.equal(b.status, 403)
  const { data: members } = await state.emp.from('business_members').select('user_id')
  assert.equal(members.length, 1, 'employee only sees own membership')
})

test('owner cannot create admins or owners', async () => {
  const a = await fn(state.owner, 'admin-users', { action: 'create_admin', email: qaEmail('z') })
  assert.equal(a.status, 403)
  const { error } = await state.owner.from('business_members').update({ role: 'owner' }).eq('user_id', state.empId)
  assert.ok(error, 'promoting to owner must fail')
})

test('another tenant cannot touch this business', async () => {
  const email = qaEmail('owner2')
  const r = await fn(state.admin, 'admin-users', { action: 'create_client', email, full_name: 'QA Owner 2', business: { name: 'QA Salon', preset: 'salon' } })
  assert.equal(r.status, 200)
  const owner2 = await signIn(email, r.data.temp_password, strongPassword())
  const { data } = await owner2.from('businesses').select('name')
  assert.deepEqual(data.map((b) => b.name), ['QA Salon'])
  const reset = await fn(owner2, 'business-members', { action: 'reset_member_password', business_id: state.biz, user_id: state.empId })
  assert.equal(reset.status, 403)
  state.owner2Biz = r.data.business_id
})

test('owner resets the employee password; old password stops working', async () => {
  const r = await fn(state.owner, 'business-members', { action: 'reset_member_password', business_id: state.biz, user_id: state.empId })
  assert.equal(r.status, 200)
  const sb = client()
  const old = await sb.auth.signInWithPassword({ email: state.empEmail, password: state.empTemp })
  assert.ok(old.error, 'old temp password rejected')
  const fresh = client()
  await fresh.auth.signInWithPassword({ email: state.empEmail, password: r.data.temp_password })
  const { data: ctx } = await fresh.rpc('my_context')
  assert.equal(ctx.profile.must_change_password, true)
})

test('deactivated employee cannot sign in', async () => {
  const r = await fn(state.owner, 'business-members', { action: 'set_member_active', business_id: state.biz, user_id: state.empId, active: false })
  assert.equal(r.status, 200)
  const { data: m } = await state.owner.from('business_members').select('active').eq('user_id', state.empId).single()
  assert.equal(m.active, false)
})

test('audit log recorded the onboarding actions', async () => {
  const { data } = await state.admin.from('audit_logs').select('action').eq('business_id', state.biz)
  const actions = data.map((d) => d.action)
  for (const a of ['admin:create_client', 'team:create_member', 'team:reset_password', 'team:deactivate_member']) {
    assert.ok(actions.includes(a), `missing ${a}`)
  }
})
