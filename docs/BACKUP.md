# Backups

The Supabase free plan has **no downloadable backups**, so the platform backs itself up with
GitHub Actions (`.github/workflows/backup.yml`) every night at 02:13 IST.

## What a backup contains

| File | Contents |
| --- | --- |
| `db.dump` | Schema and data of the app schemas (`public`, `private`): businesses, members, content, leads, CRM, orders, audit log… (`pg_dump` custom format) |
| `auth-data.dump` | Login accounts (`auth.users`, `auth.identities`, including password hashes) |
| `storage-meta.dump` | Storage bucket and file metadata |
| `storage-files/` | Copies of every uploaded file (only if `SUPABASE_SERVICE_ROLE_KEY` is set) |
| `counts.tsv` | Row count of every table at backup time |
| `MANIFEST.sha256`, `storage-files.sha256` | Checksums |

Not included (they live in this repository or must be re-entered): migrations, Edge Function code,
Vault secrets and Edge Function secrets (listed by name in docs/RECOVERY.md).

## Integrity checks (every run)

1. Every dump is validated with `pg_restore --list`.
2. **Test restore**: the backup is restored into a throwaway PostgreSQL 17 inside the job
   (`scripts/backup/restore-test.sh`). The job fails if checksums don't match, any restore step
   errors, a table is missing, or a table's row count differs by more than 5%.
3. The archive is encrypted with [age](https://age-encryption.org) to your public key; its SHA-256
   is printed in the job summary.
4. Only after all of that, the job records "last successful backup", which the portal shows.

If any step fails, the job fails and GitHub emails you.

## One-time setup (owner)

1. **Encryption key** (on your own computer, keep the private key offline and safe):
   ```bash
   age-keygen -o tomorrow-web-backup.key
   ```
   It prints `Public key: age1…`. Without the private key **no one, including you, can read the backups**.
2. **Database connection string**: Supabase dashboard → project → **Connect** → **Session pooler**
   (IPv4). Copy the URI and put in the database password (reset it under Project Settings →
   Database if you don't have it).
3. GitHub → repository → Settings → Secrets and variables → **Actions** → New repository secret:
   - `SUPABASE_DB_URL` — the session pooler URI
   - `BACKUP_AGE_RECIPIENT` — the `age1…` public key
   - `TW_HEARTBEAT_TOKEN` — the heartbeat token you were given (also used by Keep-alive)
   - optional `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API keys → secret key; needed only
     to copy Storage files. It is powerful: keep it only in GitHub secrets.
4. Actions → **Backup** → Run workflow, and check that it goes green and the portal's
   Infrastructure page shows a recent backup.

## Your routine

- **Monthly:** download the newest backup artifact (Actions → Backup → latest run → Artifacts) and
  keep it on your own drive or a USB disk. Artifacts expire after **30 days**, and GitHub may
  disable schedules in quiet repositories, so this off-site copy is your real safety net.
- **Quarterly:** do a test restore on your computer (below) to prove you can.

## Decrypt and inspect a backup

```bash
age -d -i tomorrow-web-backup.key -o backup.tar.gz tomorrow-web-backup-YYYYMMDDTHHMMZ.tar.gz.age
```

```bash
mkdir backup && tar -xzf backup.tar.gz -C backup && cd backup && sha256sum --check MANIFEST.sha256
```

## Test restore on your computer

Needs Docker. This restores into a local throwaway database, never the live project.

```bash
docker run -d --name tw-restore -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:17
```

```bash
TARGET_DB_URL=postgresql://postgres:x@localhost:55432/postgres IN=backup scripts/backup/restore-test.sh
```

To restore into a real Supabase project after an incident, follow docs/RECOVERY.md.
