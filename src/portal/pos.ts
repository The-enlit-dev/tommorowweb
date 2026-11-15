// POS helpers shared by the portal and unit tests. The server (create_order) is the source of truth
// for prices and totals; cartEstimate mirrors its maths only to show a preview while ringing up.
export interface CartLine { variant_id: string; name: string; price: number; qty: number; rate: number }

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function cartEstimate(lines: CartLine[], opts: { includeTax: boolean; discount?: { kind: 'percent' | 'amount'; value: number } | null }) {
  const subtotal = r2(lines.reduce((a, l) => a + r2(l.price * l.qty), 0))
  const d = opts.discount
  const discount = d ? Math.min(subtotal, r2(d.kind === 'percent' ? (subtotal * d.value) / 100 : d.value)) : 0
  const ratio = subtotal > 0 ? discount / subtotal : 0
  let tax = 0
  for (const l of lines) {
    const ls = r2(l.price * l.qty)
    const net = ls - r2(ls * ratio)
    tax += opts.includeTax ? r2(net - net / (1 + l.rate / 100)) : r2((net * l.rate) / 100)
  }
  tax = r2(tax)
  return { subtotal, discount, tax, total: r2(opts.includeTax ? subtotal - discount : subtotal - discount + tax) }
}

/** UPI deep link (NPCI format) for an exact amount; scanning it opens any UPI app pre-filled. */
export function upiLink(p: { vpa: string; name: string; amount: number; note: string; ref?: string }): string {
  const q = new URLSearchParams({ pa: p.vpa, pn: p.name.slice(0, 50), am: p.amount.toFixed(2), cu: 'INR', tn: p.note.slice(0, 50) })
  if (p.ref) q.set('tr', p.ref.slice(0, 35))
  return `upi://pay?${q.toString().replace(/\+/g, '%20')}`
}

export function changeDue(total: number, tendered: number) {
  return tendered >= total ? r2(tendered - total) : null
}

/** Fixed-width text for thermal printers (58 mm ≈ 32 chars, 80 mm ≈ 48 chars). */
export function receiptText(o: { business: string; number: number; created_at: string; items: { name: string; qty: number; line_total: number }[]; subtotal: number; discount_total: number; tax_total: number; total: number; payments: { method: string; amount: number }[]; footer?: string | null }, width: 32 | 48 = 32) {
  const money = (n: number) => `₹${Number(n).toFixed(2)}`
  const row = (l: string, r: string) => { const space = width - [...l].length - [...r].length; return space >= 1 ? l + ' '.repeat(space) + r : `${l}\n${' '.repeat(Math.max(0, width - [...r].length))}${r}` }
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - [...s].length) / 2))) + s
  const hr = '-'.repeat(width)
  const lines = [center(o.business), center(`Order #${o.number}`), center(new Date(o.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })), hr]
  for (const i of o.items) lines.push(row(`${i.qty} × ${i.name}`.slice(0, width - 11), money(i.line_total)))
  lines.push(hr, row('Subtotal', money(o.subtotal)))
  if (o.discount_total > 0) lines.push(row('Discount', `-${money(o.discount_total)}`))
  lines.push(row('GST (incl.)', money(o.tax_total)), row('TOTAL', money(o.total)))
  for (const p of o.payments) lines.push(row(`Paid (${p.method.toUpperCase()})`, money(p.amount)))
  if (o.footer) lines.push(hr, center(o.footer.slice(0, width)))
  return lines.join('\n')
}

export const newIdempotencyKey = () => `${Date.now().toString(36)}-${crypto.randomUUID()}`
