# Dependencies and costs

Every third-party service the platform uses, what it costs, and what happens if it is unavailable.
The same table is shown in the portal at **/portal/admin/infrastructure/**. It is generated from
`src/portal/dependencies.ts` (run `npm run docs:deps`), so the portal and this file always agree.

Free limits are as published on 2026-11-15 and **can change at any time** — follow the links before relying on them.

**Rule:** nothing that can cost money is switched on automatically. Billing, paid plans, credits,
payment providers and APIs that need billing are off until the owner (you) explicitly sets them up.

| Service | Required? | Used for | Needs | Free limits | Could it cost money? | If unavailable |
| --- | --- | --- | --- | --- | --- | --- |
| [Supabase](https://supabase.com/pricing) | Required | Logins, database, file storage, realtime, Edge Functions, Vault (secrets) | Free account (yours) | ≈500 MB database, ≈1 GB file storage, 2 active free projects, pauses after ≈7 days without activity, no downloadable backups | None unless you upgrade the organisation plan yourself | Portal and dynamic features stop; the public website keeps working |
| [Netlify](https://www.netlify.com/pricing/) | Required | Hosting the website, form email alerts | Free account (yours) | Free plan allowance for bandwidth, builds and form submissions (see pricing page) | None unless you upgrade | Website offline until redeployed elsewhere |
| [GitHub](https://github.com/pricing) | Required | Code, scheduled keep-alive and backup jobs | Free account (yours) | Actions minutes/storage limits on private repos; scheduled jobs can be paused on inactive repos; artifacts expire (≤90 days) | None unless you buy extra minutes/storage | Backups and keep-alive stop — check the dashboard warnings |
| [OpenStreetMap (Overpass)](https://wiki.openstreetmap.org/wiki/Overpass_API) | Optional | Lead Finder business discovery | Nothing (attribution required) | Fair-use rate limits on the public Overpass server | None | Use manual entry / CSV import |
| [Google PageSpeed Insights API](https://developers.google.com/speed/docs/insights/v5/get-started) | Optional | Lead Finder website audits (mobile performance/SEO scores) | Google Cloud API key (billing not required) | Free daily quota | None | Audits still run the built-in checks without PageSpeed scores |
| [Google Places API](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing) | Optional | Optional extra Lead Finder source | Google Cloud project WITH BILLING ENABLED | Monthly free usage per SKU, then pay-per-request | Yes — charges beyond the free usage. Off by default; only you can enable billing. | Lead Finder works with OpenStreetMap + manual + CSV |
| [OpenRouter](https://openrouter.ai/models?max_price=0) | Optional | Optional hosted AI models | Free OpenRouter account and API key | Free models with daily/minute request limits that OpenRouter can change at any time | Only if you set a spending limit above ₹0 and add credits yourself. Default limit is ₹0: paid models are refused. | FAQ fallback answers instead |
| [Self-hosted AI (Ollama / llama.cpp)](https://ollama.com) | Optional | AI replies without per-message API charges | A computer or server you run | No API charges; you pay for hardware, electricity, hosting and upkeep | Hosting costs if you rent a server | FAQ fallback answers instead |
| [Razorpay](https://razorpay.com/pricing/) | Optional | Optional online payments for client stores/POS | Each client’s own Razorpay account (KYC) | No monthly fee on the standard plan; fee per transaction | Transaction fees charged to the client by Razorpay | Cash and manually-confirmed UPI still work |
| [Printify](https://printify.com/pricing/) | Optional | Optional print-on-demand fulfilment for clothing brands | Each brand’s own Printify account | Free plan available; production, shipping and premium plan charges apply | Production and shipping costs charged to the brand by Printify | Store keeps working with its own stock |
| [Brevo (email)](https://www.brevo.com/pricing/) | Optional | Optional password-reset and notification emails | Free Brevo account + SMTP settings in Supabase | Free daily email allowance | None on the free plan | Temporary passwords are shared manually |

## Account ownership

All accounts (Supabase, Netlify, GitHub, Google Cloud, OpenRouter, Brevo) belong to Tomorrow Web.
Razorpay and Printify accounts always belong to **each client business**, never to Tomorrow Web.
