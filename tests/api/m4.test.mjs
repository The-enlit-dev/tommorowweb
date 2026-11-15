// M4 live tests: pipeline automation through RLS-protected tables, conversion to a client, isolation.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { fn, makeClient, qaEmail, signIn } from './helpers.mjs'

const s = {}
after(async () => { if (s.lead) await s.admin.from('leads').delete().eq('id', s.lead) })

test('lead → contacted → proposal → won → client account', async () => {
  s.admin = await signIn(process.env.TW_QA_EMAIL, process.env.TW_QA_PASSWORD)
  const add = await fn(s.admin, 'leads', { action: 'add', name: 'QA CRM Bakery', locality: 'Aundh', industry: 'cafe', phone: '+91 98000 33333' })
  assert.equal(add.status, 200, JSON.stringify(add.data))
  s.lead = add.data.lead_id
  assert.ifError((await s.admin.from('lead_activities').insert({ lead_id: s.lead, kind: 'whatsapp', body: 'Sent intro', outcome: 'replied' })).error)
  assert.equal((await s.admin.from('leads').select('stage').eq('id', s.lead).single()).data.stage, 'contacted')
  await s.admin.from('lead_tasks').insert({ lead_id: s.lead, title: 'Share examples', due_at: new Date(Date.now() + 86400000).toISOString() })
  assert.ok((await s.admin.from('leads').select('next_follow_up_at').eq('id', s.lead).single()).data.next_follow_up_at)
  const p = await s.admin.from('proposals').insert({ lead_id: s.lead, title: 'Bakery website', amount_inr: 6000, status: 'sent' }).select('id').single()
  assert.ifError(p.error)
  assert.equal((await s.admin.from('leads').select('stage').eq('id', s.lead).single()).data.stage, 'proposal_sent')
  await s.admin.from('proposals').update({ status: 'accepted' }).eq('id', p.data.id)
  const won = (await s.admin.from('leads').select('stage, estimated_value_inr').eq('id', s.lead).single()).data
  assert.deepEqual([won.stage, Number(won.estimated_value_inr)], ['won', 6000])
  const r = await fn(s.admin, 'admin-users', { action: 'create_client', email: qaEmail('crm'), full_name: 'QA Baker', business: { name: 'QA CRM Bakery', preset: 'restaurant' } })
  assert.equal(r.status, 200)
  assert.ifError((await s.admin.from('leads').update({ converted_business_id: r.data.business_id }).eq('id', s.lead)).error)
  const { data: logs } = await s.admin.from('audit_logs').select('id').eq('action', 'lead:converted').eq('entity_id', s.lead)
  assert.equal(logs.length, 1)
})

test('clients never see CRM data', async () => {
  const c = (await makeClient(s.admin, { name: 'QA CRM Client' })).owner
  for (const t of ['leads', 'lead_activities', 'lead_tasks', 'proposals']) {
    const { data } = await c.from(t).select('id')
    assert.equal(data.length, 0, t)
  }
})
