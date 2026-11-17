# Wix features we can offer for free

Checked 17 Nov 2026 against Wix's own updates page, recent reviews (Style Factory, TechRadar,
Capterra and Top10) and this repo. "Free" means no new paid service. Everything runs on what we
already use: Supabase free tier, Netlify, GitHub Actions and free public APIs. Wix itself puts
ecommerce and bookings on its Core plan (about US$29/month) and marketing on its Business plans.

## Already built (no Wix plan needed)

| Wix feature | Ours |
| --- | --- |
| Blog, CMS, image uploads | Blog + content blocks in the portal, publish → rebuild |
| Online store, coupons, shipping rules, order tracking | Store kit + `store-checkout` (live-tested) |
| Wix POS (US/Canada/UK only) | POS with cash + UPI QR, GST-aware invoices: works in India |
| Bookings back office | Services, appointments and staff assignments (staff side) |
| Restaurant tables, menus, table areas | Tables, takeaway, menu, live kitchen display |
| Pipelines / CRM | Lead Finder + Kanban CRM, tasks, proposals, won lead → client |
| AI chat (Ascend chat box) | Website assistant with FAQ fallback, ₹0 by default |
| Invoices | Invoice numbering and A4 / thermal receipts |
| Staff roles and permissions | Owner / manager / employee permissions |
| Dropshipping (Modalyst) | Printify, using the brand's own account |
| SEO basics: titles, meta, sitemap, robots, Search Console | Built into every page, plus the GSC verification file |

## Worth building next (₹0)

Ranked by how useful they are to the clients we target (restaurants, salons, tutors, clothing brands).

1. **Public online booking page** (Wix Bookings). Customers pick a service, staff member and free
   slot. A booking request lands on the existing appointments board with a WhatsApp confirmation
   link. No payment needed. Built on Supabase plus an RPC like `store_checkout`.
2. **Form builder + submissions inbox** (Wix Forms, "Submissions board"). Clients add forms
   (enquiry, admission, catering) in the portal. Submissions are stored in Supabase with spam
   protection, CSV export and simple charts. Netlify Forms also allows 100 free submissions per
   site per month as a backup.
3. **Privacy-friendly visitor analytics** (Wix Analytics). A small script records page views and
   referrers into daily totals, with no cookies and no personal data, and the portal shows a
   per-site dashboard. Daily totals keep it well inside the 500 MB database limit.
4. **Reviews and testimonials** (Wix review apps). Collect reviews through a link, the owner
   approves them, and they show on the site with star-rating markup. A "Review us on Google"
   button links to the Google Business profile.
5. **Restaurant table reservations** (Wix Table Reservations). This uses the existing tables and
   areas: guests request a time and party size, and staff accept on the board. Card holds and
   no-show fees need Razorpay, so that part stays optional.
6. **Events with RSVP** (Wix Events). Free events with RSVP lists and QR check-in. Paid tickets
   reuse the Razorpay flow later.
7. **CMS item history** (Wix "Item history", 1 week on Wix's free plan). Keep past versions of
   content blocks and posts, and restore with one click.
8. **Site search** (Wix Site Search). Pagefind builds a static search index at build time, with no
   server and no cost.
9. **Multilingual pages** (Wix Multilingual). English, Hindi and Marathi with Astro's built-in i18n
   routing. Translations are written by people, or AI-drafted and labelled.
10. **Local SEO structured data**. `LocalBusiness` / `Restaurant` JSON-LD from business details:
    opening hours, address and phone. Wix generates this. We can too, at build time.
11. **Loyalty points** (Wix Loyalty). Points per order on the existing customers table, redeemed
    as a discount at the POS.
12. **Uptime check for client sites**. A GitHub Actions job pings each site and alerts on failures.

## Free with a separate free account

- **Email newsletters / automations** (Wix Email Marketing). Brevo's free plan sends up to 300
  emails a day. It needs a Brevo account in your name, so it stays off until you create one.
- **Abandoned-cart reminders**. Possible by email once Brevo is set up. Until then, staff can send
  a one-tap WhatsApp message from the order.

## Not free, so not planned

- **AI phone agent** (Wix "Alfred"). Needs a telephony provider and paid voice minutes.
- **Card holds and no-show fees**. These need a payment gateway (Razorpay fees apply).
- **Google Places-powered features**. These need billing on Google Cloud (already optional and off).
