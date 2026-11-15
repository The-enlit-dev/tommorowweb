# Storefront kit (clothing brands and shops)

Turns a client's Astro site into a store backed by the Tomorrow Web platform.

## Files

| File | Copy to | Purpose |
| --- | --- | --- |
| `commerce.ts` | `src/lib/commerce.ts` | Catalogue (build time), cart, checkout, Razorpay, payment polling, tracking |
| `pages/shop/index.astro` | `src/pages/shop/index.astro` | Product listing by category |
| `pages/shop/[slug].astro` | `src/pages/shop/[slug].astro` | Product page with size/colour selection |
| `pages/cart.astro` | `src/pages/cart.astro` | Cart + checkout form + payment |

Style the pages with the client's design system; the markup uses plain classes.

## Setup

1. Admin portal → client → modules: **Online store** (+ Orders, Inventory), optionally **Razorpay
   payments** and **Printify fulfilment**.
2. Admin → client → Websites: add the site with **allowed origins** (e.g. `https://brand.in`).
   Checkout is refused from any other origin.
3. Client portal → Online store: open the store, set shipping and policies. Products appear when
   “Sell in the online store” is ticked.
4. Payments:
   - **Razorpay** (client's own account, test mode first): save Key ID, key secret and a webhook
     secret in the portal; in Razorpay add the webhook URL shown there with events
     `payment.captured`, `order.paid`, `payment.failed`; enable automatic capture. Orders become
     paid only when the verified webhook arrives.
   - **Manual UPI** (no gateway): customers pay to the shop’s UPI ID shown after checkout; staff
     confirm each payment in Orders. Unpaid orders expire (default 30 min, configurable) and stock
     is released.
5. Set `PUBLIC_TW_SITE_KEY` in the site's Netlify environment and `TRACK_URL` in `commerce.ts`.
6. Connect a Netlify build hook in the portal (Website content → Automatic publishing) so product
   changes rebuild the site.

## Printify

Each brand connects **its own** Printify account (portal → Printify). Import products (they arrive
hidden — check prices first). Paid orders containing Printify products are sent to Printify once
(unique per order; Printify `external_id` = our order id), and shipping updates arrive through a
verified webhook. Production, shipping and plan costs are shown per order, separate from
Razorpay fees and from Tomorrow Web's fees.
