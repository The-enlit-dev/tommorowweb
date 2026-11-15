# Supabase free plan: limits and how we stay inside them

Project: **tomorrow-web** (ref `rijxesngcmhpxhoptsck`, Mumbai / ap-south-1), on the free plan.
Limits below were checked on the Supabase pricing page on **2026-11-15**. They can change —
re-check <https://supabase.com/pricing> before relying on them.

| Resource | Free limit | What uses it here | How we stay inside it |
| --- | --- | --- | --- |
| Database size | 500 MB per project | All business data, audit log, leads, orders | Admin → Infrastructure shows size and warns at 80%. Audit details are compact JSON. Large files never go in the database. |
| File storage | 1 GB | CMS images, change-request attachments, product photos | Upload size limits per bucket; images should be resized before upload. Usage shown in the portal. |
| Max upload size | 50 MB per file | — | Buckets set lower limits (images 5 MB, attachments 10 MB). |
| Egress | 5 GB (+5 GB cached) per month | Portal API traffic, image downloads | Public sites read CMS content at build time, not per visitor. |
| Monthly active users | 50,000 | Portal logins (clients, staff) | Far above our needs. |
| Edge Function invocations | 500,000 per month | Admin actions, AI gateway, Lead Finder, checkout, webhooks | AI and checkout are rate limited per site and per IP. |
| Realtime | 200 concurrent connections, 2 million messages per month | Orders board, kitchen display, new-order alerts | Only those screens subscribe, filtered to one business. |
| Active free projects | 2 per organisation | tomorrow-web plus one other | Don't create more free projects in this organisation without checking. |
| Inactivity pause | Paused after 1 week without activity | — | Daily keep-alive workflow (see below). |
| Backups | **Not included** on the free plan | — | Our own nightly encrypted backups via GitHub Actions (docs/BACKUP.md). |

## Pausing

Free projects pause after about a week with no database activity. The `Keep-alive` GitHub workflow
calls the database once a day and records the time; the portal's admin overview warns if the last
keep-alive is more than 3 days old.

**This is not guaranteed.** GitHub can disable scheduled workflows in a repository that has had no
commits for 60 days (it emails you first; re-enable it under Actions). If the project does pause:

1. Open <https://supabase.com/dashboard> → project **tomorrow-web** → **Restore project**.
2. Restoring takes a few minutes. Data is kept while paused (Supabase may delete projects paused for
   a very long time — restore promptly).
3. Run the `Keep-alive` workflow once by hand (Actions → Keep-alive → Run workflow).

## Upgrading

Never needed for the current scope. Upgrading the organisation to a paid plan is a billing decision
only the owner makes; nothing in this repository does it.

## Security advisor notes (accepted)

`get_advisors` reports these by design:

- **SECURITY DEFINER functions callable via the API** (`my_context`, `mark_password_changed`,
  `admin_usage`, `record_heartbeat`, and later RPCs such as `create_order`): each one checks the
  caller itself — own rows only, admin only, or a valid hashed token — and runs with an empty
  `search_path`. This is how the platform enforces rules the browser must not bypass.
- **Leaked password protection disabled**: a paid-plan Auth feature. The portal requires at least
  10 characters with a letter and a number instead.
