# Owner setup checklist

Everything below is either an account decision or a dashboard click that only the owner can make.
Nothing here costs money unless marked **(costs money)**.

## 1. Apply the database changes (required for M3–M7)

Supabase → project **tomorrow-web** → **SQL Editor** → paste `supabase/pending/APPLY_ALL.sql` →
**Run**. It is one transaction (all or nothing) and was tested on a copy of the live schema.
It creates the Lead Finder, CRM, POS/orders, kitchen/appointments and store tables, and deletes
two orphaned test keys from Vault. It does not touch existing data.

Then tell Claude, which will: deploy the `leads`, `store-checkout`, `razorpay-webhook`, `printify`
and `printify-webhook` functions; run the live API and browser tests (`npm run test:api`,
`npm run test:e2e`); move the pending files into `supabase/migrations/`; switch the
`/features/` statuses to “Available”; and remove the QA test data (`scripts/cleanup-qa.sql`).

## 2. Supabase dashboard

- Authentication → Sign In / Providers → Email: turn **off** “Allow new users to sign up”.
- Edge Functions: **delete `dev-sql`** (a disabled leftover; it returns 410 and has no access).
- After the website is live: Authentication → URL Configuration → Site URL = the live address.

## 3. Your administrator login

A temporary password was created for `attharva.agarwal20@gmail.com` and saved privately for you
(see the final report). Sign in at `/portal/login/`; you’ll choose your own password. The QA admin
account used for testing can then be disabled from Clients & businesses → Disable.

## 4. GitHub → Settings → Secrets and variables → Actions

| Secret | Value |
| --- | --- |
| `TW_HEARTBEAT_TOKEN` | the heartbeat token you were given (keep-alive + backups) |
| `SUPABASE_DB_URL` | Supabase → Connect → Session pooler URI (with the database password) |
| `BACKUP_AGE_RECIPIENT` | the `age1…` public key from `age-keygen` (docs/BACKUP.md) |
| `SUPABASE_SERVICE_ROLE_KEY` (optional) | only to back up Storage files |

Then run Actions → **Keep-alive** and **Backup** once by hand.

## 5. Website hosting (Netlify)

Connect the GitHub repo in Netlify (build `npm run build`, publish `dist`). Netlify Forms (contact,
booking, portal alerts) start working once deployed.

## 6. Site details to fill in (`src/config/site.ts`)

`whatsapp` number, `location`, social links, and `pricing.upiId` (UPI QR on approved change
requests).

## 7. Optional integrations (off until you set them up)

| Integration | Where | Cost |
| --- | --- | --- |
| OpenRouter free models | Portal → AI infrastructure → Add provider | Free models only (₹0 limit) |
| Self-hosted AI (Ollama / llama.cpp) | docs/AI-SELF-HOSTING.md, then AI infrastructure | Your hardware/hosting |
| Google API key (PageSpeed) | Portal → Lead Finder → Settings | Free |
| Google Places | Lead Finder → Settings (needs billing + a monthly cap) | **(costs money)** beyond Google’s free usage |
| Razorpay | Client portal → Online store (client’s own account) | **(costs money)** per-payment fee, paid by the client |
| Printify | Client portal → Printify (brand’s own account) | **(costs money)** production/shipping, paid by the brand |
| Brevo email | Supabase → Auth → SMTP | Free tier |
| Cal.com connector | claude.ai → Customize → Connectors → `https://mcp.cal.com/mcp` | Free |
