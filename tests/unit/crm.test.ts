import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pipelineStats, presetForIndustry, toIcs } from '../../src/portal/crm.ts'

test('pipeline figures come only from the leads given', () => {
  const now = new Date('2026-11-15T10:00:00+05:30')
  const s = pipelineStats([
    { stage: 'new', estimated_value_inr: null },
    { stage: 'contacted', estimated_value_inr: '5000', next_follow_up_at: '2026-11-14T10:00:00+05:30' },
    { stage: 'proposal_sent', estimated_value_inr: 8000, next_follow_up_at: '2026-11-15T18:00:00+05:30' },
    { stage: 'won', estimated_value_inr: 12000, next_follow_up_at: '2026-11-01T10:00:00+05:30' },
    { stage: 'lost', estimated_value_inr: 3000 },
  ], now)
  assert.equal(s.total, 5)
  assert.equal(s.pipelineValue, 13000)
  assert.equal(s.wonValue, 12000)
  assert.equal(s.overdue, 1, 'won leads never count as overdue')
  assert.equal(s.dueToday, 1)
  assert.equal(s.winRate, 50)
  assert.deepEqual(s.funnel.map((f) => f.count), [4, 3, 2, 2, 1])
  assert.equal(pipelineStats([]).winRate, null)
})

test('preset suggestion', () => {
  assert.equal(presetForIndustry('cafe'), 'restaurant')
  assert.equal(presetForIndustry('clothing'), 'clothing')
  assert.equal(presetForIndustry(null), 'website_only')
})

test('ics export escapes text and includes reminders', () => {
  const ics = toIcs([{ id: 't1', title: 'Call back, re: menu; prices', due_at: '2026-11-16T05:30:00Z', lead_name: 'Café X', url: 'https://x.test/portal/admin/leads/view/?id=1' }], new Date('2026-11-15T00:00:00Z'))
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/)
  assert.match(ics, /DTSTART:20261116T053000Z\r\nDTEND:20261116T054500Z/)
  assert.match(ics, /SUMMARY:Call back\\, re: menu\; prices — Café X/)
  assert.match(ics, /TRIGGER:-PT10M/)
  assert.ok(ics.split('\r\n').every((l) => l.length <= 75))
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'))
})
