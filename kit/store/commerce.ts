// Tomorrow Web storefront kit — copy into a client's Astro site as src/lib/commerce.ts.
// Build time: getCatalog() for product pages. Browser: cart (localStorage), checkout through the
// store-checkout Edge Function, Razorpay Checkout or manual UPI, and order status polling.
// Prices, discounts, tax, stock and shipping are always recalculated on the server.

const SUPABASE_URL = 'https://rijxesngcmhpxhoptsck.supabase.co'
const SUPABASE_KEY = 'sb_publishable_z9ilwxZjkoAOQB4p6GljiQ_iRRJK7y1' // public
export const SITE_KEY: string = (import.meta as any).env?.PUBLIC_TW_SITE_KEY ?? 'PASTE-SITE-KEY'
export const TRACK_URL = 'https://YOUR-TOMORROW-WEB-DOMAIN/track/' // Tomorrow Web's tracking page

export interface Variant { id: string; name: string; options: Record<string, string>; price: number; in_stock: boolean; low: boolean }
export interface Product { id: string; slug: string; name: string; description: string | null; category_id: string | null; image: string | null; images: { path: string; alt: string | null }[]; variants: Variant[] }
export interface Catalog { store: { name: string; shipping_flat: number; free_shipping_above: number | null; policies: string | null; contact_email: string | null; online_payment: boolean; manual_upi: boolean }; categories: { id: string; name: string }[]; products: Product[] }

export const mediaUrl = (path?: string | null) => (path ? `${SUPABASE_URL}/storage/v1/object/public/media/${path.split('/').map(encodeURIComponent).join('/')}` : '')
export const money = (n: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(n)

/** Build time (server). Returns null if the store is closed or unreachable — builds never fail. */
export async function getCatalog(): Promise<Catalog | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/store_catalog`, { method: 'POST', headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ p_key: SITE_KEY }) })
    return r.ok ? ((await r.json()) as Catalog | null) : null
  } catch {
    return null
  }
}

// ── Browser: cart ─────────────────────────────────────────────────────────
export interface CartItem { variant_id: string; qty: number; name: string; price: number }
const CART = `tw-cart-${SITE_KEY}`
export const cart = {
  get(): CartItem[] { try { return JSON.parse(localStorage.getItem(CART) ?? '[]') } catch { return [] } },
  set(items: CartItem[]) { try { localStorage.setItem(CART, JSON.stringify(items)) } catch { /* private mode */ } dispatchEvent(new CustomEvent('tw-cart')) },
  add(item: Omit<CartItem, 'qty'>, qty = 1) { const c = cart.get(); const ex = c.find((x) => x.variant_id === item.variant_id); if (ex) ex.qty = Math.min(99, ex.qty + qty); else c.push({ ...item, qty }); cart.set(c) },
  update(variant_id: string, qty: number) { cart.set(cart.get().map((x) => (x.variant_id === variant_id ? { ...x, qty } : x)).filter((x) => x.qty > 0)) },
  clear() { cart.set([]) },
  count() { return cart.get().reduce((a, x) => a + x.qty, 0) },
  subtotal() { return cart.get().reduce((a, x) => a + x.price * x.qty, 0) },
}

async function call(body: Record<string, unknown>) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/store-checkout`, { method: 'POST', headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ site_key: SITE_KEY, ...body }) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(data.error ?? `Checkout failed (${r.status})`)
  return data
}

export interface Address { name: string; phone: string; email?: string; line1: string; line2?: string; city: string; state: string; pin: string }

/**
 * Places the order. One checkout id per attempt: a double click or network retry returns the
 * same order. Then opens Razorpay (if the store uses it) or returns manual-UPI details.
 */
export async function checkout(address: Address, opts: { discountCode?: string; notes?: string } = {}) {
  const idKey = 'tw-checkout-id'
  let id = sessionStorage.getItem(idKey)
  if (!id) { id = `${Date.now().toString(36)}-${crypto.randomUUID()}`; sessionStorage.setItem(idKey, id) }
  const res = await call({ action: 'checkout', idempotency_key: id, items: cart.get().map(({ variant_id, qty }) => ({ variant_id, qty })), address, customer: { name: address.name, phone: address.phone, email: address.email }, discount_code: opts.discountCode, notes: opts.notes })
  return { ...res, done: () => { sessionStorage.removeItem(idKey); cart.clear() } }
}

/** Opens Razorpay Checkout; resolves when the customer finishes (payment is confirmed by webhook). */
export function payWithRazorpay(rzp: { key_id: string; order_id: string; amount: number; currency: string; name: string; prefill: Record<string, string> }) {
  return new Promise<'submitted' | 'dismissed'>((resolve, reject) => {
    const open = () => {
      const R = (window as any).Razorpay
      const r = new R({ key: rzp.key_id, order_id: rzp.order_id, amount: rzp.amount, currency: rzp.currency, name: rzp.name, prefill: rzp.prefill, handler: () => resolve('submitted'), modal: { ondismiss: () => resolve('dismissed') } })
      r.on('payment.failed', (e: any) => reject(new Error(e?.error?.description ?? 'Payment failed')))
      r.open()
    }
    if ((window as any).Razorpay) return open()
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = open
    s.onerror = () => reject(new Error('Couldn’t load the payment window. Check your connection.'))
    document.head.appendChild(s)
  })
}

/** Polls the order until the verified webhook marks it paid (or it fails). */
export async function waitForPayment(token: string, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const o = await call({ action: 'status', token })
    if (o.payment_status === 'paid') return 'paid'
    if (['payment_failed', 'failed', 'cancelled'].includes(o.status)) return 'failed'
    await new Promise((r) => setTimeout(r, 2500))
  }
  return 'pending'
}

export const findOrder = (number: number, phone: string) => call({ action: 'find', number, phone }) as Promise<{ token: string }>
export const trackingLink = (token: string) => `${TRACK_URL}?t=${token}`
