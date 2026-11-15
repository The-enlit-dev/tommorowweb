# Pending migrations

Written and tested locally (scripts/verify-migrations.sh + scripts/test-rls.sh) but **not yet applied**
to the live project, because they need the owner's confirmation (e.g. they delete data).
Once applied, move the file into `supabase/migrations/` renamed to the version the project records.

| File | Why it's waiting |
| --- | --- |
| `20261115120500_m2_vault_cleanup.sql` | Deletes two orphaned Vault secrets (fake test keys) and adds triggers that delete secrets with their owner rows. Awaiting approval. |
| `20261115130000_m3_lead_finder.sql` | Lead Finder tables and functions (creates only; DELETE appears inside function bodies). Supabase asked for confirmation; awaiting approval. |
