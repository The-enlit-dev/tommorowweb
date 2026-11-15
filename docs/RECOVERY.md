# Recovery procedure

Use this if the Supabase project is lost, corrupted or deleted. For a merely **paused** project,
see "Pausing" in docs/SUPABASE-FREE-TIER.md — no restore is needed.

Have ready: the latest decrypted backup (docs/BACKUP.md), this repository, and access to the
Supabase, GitHub and Netlify accounts.

## 1. Create the replacement project

Only if the old project is gone. Creating a project is an account decision; free projects are
limited to 2 per organisation. Region: Mumbai (ap-south-1).

## 2. Recreate the schema from the repository

Apply every file in `supabase/migrations/` in filename order (Supabase CLI: `supabase link` then
`supabase db push`, or paste each file into the SQL editor in order). The schema is versioned
here, so the backup's data matches it.

## 3. Restore the data

Uses the Supabase-recommended `session_replication_role = replica` so triggers (audit, new-user
profile creation) don't fire twice while loading.

```bash
pg_restore --data-only -f auth-data.sql auth-data.dump
```

```bash
pg_restore --data-only -f app-data.sql db.dump
```

```bash
pg_restore --data-only -f storage-meta.sql storage-meta.dump
```

```bash
psql "$NEW_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -c 'SET session_replication_role = replica' -f auth-data.sql -f app-data.sql -f storage-meta.sql
```

Then compare row counts with `counts.tsv`:

```bash
psql "$NEW_DB_URL" -At -F $'\t' -f scripts/backup/counts.sql | diff counts.tsv -
```

## 4. Restore Storage files

Recreate buckets by applying the migrations (step 2), then upload `storage-files/<bucket>/…` with
the Supabase dashboard or CLI (`supabase storage cp -r storage-files/media ss:///media`).

## 5. Redeploy Edge Functions

Deploy every folder in `supabase/functions/` (`supabase functions deploy <name>`), with the
JWT setting noted at the top of each function's `index.ts`.

## 6. Re-enter secrets (by name — values come from your password manager)

| Where | Name | Purpose |
| --- | --- | --- |
| `private.settings` | `heartbeat_token_sha256` | SHA-256 of the keep-alive token (`printf %s "$TOKEN" \| sha256sum`) |
| Vault | `openrouter_api_key` | Optional OpenRouter key (portal → AI infrastructure re-saves it) |
| Vault | `ai_provider_token:<id>` | Optional tokens for self-hosted AI servers |
| Vault | `google_api_key` | Optional PageSpeed / Places key |
| Vault | `razorpay:<business>` | Each client's own Razorpay keys and webhook secret |
| Vault | `printify:<business>` | Each brand's own Printify token |
| Vault | `site_build_hook:<site>` | Netlify build hooks for CMS publishing |

Vault secrets are re-entered through the portal screens that created them, so they are never
typed into SQL by hand.

## 7. Auth settings

Dashboard → Authentication → Sign In / Providers: Email enabled, **Allow new users to sign up: off**.
URL configuration: Site URL = the live website address (Netlify URL or custom domain), redirect
`https://<site>/portal/**`.

## 8. Point the website at the new project

Update `src/lib/supabase-config.js` (URL and publishable key), commit, and let Netlify redeploy.
Update GitHub secrets `SUPABASE_DB_URL` and `TW_HEARTBEAT_TOKEN`.

## 9. Checklist and smoke test

- [ ] Admin can sign in at /portal/login/
- [ ] A client owner can sign in and sees only their business
- [ ] Admin overview shows the expected number of businesses and accounts
- [ ] Row counts match `counts.tsv`
- [ ] A test image loads from the CMS
- [ ] Keep-alive and Backup workflows run green
- [ ] `npm run test:api` passes against the new project
