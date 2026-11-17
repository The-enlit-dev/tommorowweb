# Pending migrations

SQL that is written and tested locally (`scripts/verify-migrations.sh` + `scripts/test-rls.sh`) but
not yet applied to the live project goes here, with a line below saying why it is waiting.
`scripts/bundle-pending.sh` bundles it into one file you can paste into the Supabase SQL Editor.
Once applied, move the file into `supabase/migrations/`.

Nothing is pending. The M2–M7 files (Vault clean-up, Lead Finder, CRM, POS, business
configurations, commerce) were applied by the owner in the SQL Editor on 15 Nov 2026 and now live
in `supabase/migrations/`.
