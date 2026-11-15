// Sales CRM logic shared by the portal pages and unit tests (no browser APIs).
export const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'researched', label: 'Researched' },
  { key: 'contacted', label: 'Contacted' },
  { key: 'interested', label: 'Interested' },
  { key: 'meeting', label: 'Meeting scheduled' },
  { key: 'proposal_sent', label: 'Proposal sent' },
  { key: 'negotiation', label: 'Negotiation' },
  { key: 'won', label: 'Won' },
  { key: 'lost', label: 'Lost' },
] as const
export type Stage = (typeof STAGES)[number]['key']
export const stageLabel = (k: string) => STAGES.find((s) => s.key === k)?.label ?? k
export const OPEN_STAGES: Stage[] = ['new', 'researched', 'contacted', 'interested', 'meeting', 'proposal_sent', 'negotiation']

export interface CrmLead { stage: string; estimated_value_inr: number | string | null; next_follow_up_at?: string | null }

/** Live pipeline figures, computed only from real leads. */
export function pipelineStats(leads: CrmLead[], now = new Date()) {
  const by = Object.fromEntries(STAGES.map((s) => [s.key, 0])) as Record<Stage, number>
  let pipelineValue = 0, wonValue = 0, dueToday = 0, overdue = 0
  const endOfDay = new Date(now); endOfDay.setHours(23, 59, 59, 999)
  for (const l of leads) {
    if (l.stage in by) by[l.stage as Stage]++
    const v = Number(l.estimated_value_inr ?? 0) || 0
    if (OPEN_STAGES.includes(l.stage as Stage)) pipelineValue += v
    if (l.stage === 'won') wonValue += v
    if (l.next_follow_up_at && OPEN_STAGES.includes(l.stage as Stage)) {
      const t = new Date(l.next_follow_up_at)
      if (t < now) overdue++
      else if (t <= endOfDay) dueToday++
    }
  }
  const reached = (k: Stage) => {
    // Leads that reached at least this stage (won counts as having passed every open stage; lost excluded).
    const idx = STAGES.findIndex((s) => s.key === k)
    return leads.filter((l) => l.stage !== 'lost' && STAGES.findIndex((s) => s.key === l.stage) >= idx).length
  }
  const decided = by.won + by.lost
  return {
    total: leads.length, byStage: by, pipelineValue, wonValue, dueToday, overdue,
    funnel: (['new', 'contacted', 'interested', 'proposal_sent', 'won'] as Stage[]).map((k) => ({ stage: k, label: stageLabel(k), count: reached(k) })),
    winRate: decided ? Math.round((by.won / decided) * 100) : null,
  }
}

/** Suggested module preset when a won lead becomes a client. */
export function presetForIndustry(industry: string | null | undefined): string {
  return ({ restaurant: 'restaurant', cafe: 'restaurant', clothing: 'clothing', salon: 'salon', education: 'tutor', fitness: 'sports_academy' } as Record<string, string>)[industry ?? ''] ?? 'website_only'
}

const icsEsc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
/** iCalendar (.ics) file for follow-up tasks; 15-minute events with a 10-minute reminder. */
export function toIcs(tasks: { id: string; title: string; due_at: string; lead_name?: string; url?: string }[], now = new Date()): string {
  const fold = (line: string) => line.match(/.{1,74}/g)!.join('\r\n ')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tomorrow Web//CRM//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH']
  for (const t of tasks) {
    const start = new Date(t.due_at), end = new Date(start.getTime() + 15 * 60_000)
    lines.push('BEGIN:VEVENT', `UID:${t.id}@tomorrowweb-crm`, `DTSTAMP:${icsDate(now)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
      fold(`SUMMARY:${icsEsc(t.lead_name ? `${t.title} — ${t.lead_name}` : t.title)}`), ...(t.url ? [fold(`URL:${t.url}`)] : []),
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Follow-up', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
