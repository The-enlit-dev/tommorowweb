#!/usr/bin/env bash
# Nightly backup of the Tomorrow Web database (run by .github/workflows/backup.yml, or by hand).
#   SOURCE_DB_URL  Supabase *session pooler* connection string (Project → Connect → Session pooler)
#   OUT            output directory (default ./backup-out)
# Produces in $OUT:
#   db.dump              schema + data of the app schemas (public, private) — pg_dump custom format
#   auth-data.dump       data of auth.users and auth.identities (logins)
#   storage-meta.dump    data of storage.buckets and storage.objects (file metadata)
#   platform-tables.sql  plain stand-ins for those platform tables (used only by the restore test)
#   counts.tsv           row count of every app table at backup time
#   MANIFEST.sha256      checksums of everything above
set -euo pipefail
: "${SOURCE_DB_URL:?set SOURCE_DB_URL}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${OUT:-backup-out}"
mkdir -p "$OUT"
cd "$OUT"

pg_dump "$SOURCE_DB_URL" -Fc --no-owner --no-privileges -n public -n private -f db.dump
pg_dump "$SOURCE_DB_URL" -Fc --data-only -t auth.users -t auth.identities -f auth-data.dump
pg_dump "$SOURCE_DB_URL" -Fc --data-only -t storage.buckets -t storage.objects -f storage-meta.dump

# Validate the archives are readable.
for f in db.dump auth-data.dump storage-meta.dump; do pg_restore --list "$f" > /dev/null; done

psql "$SOURCE_DB_URL" -X -q -At -v ON_ERROR_STOP=1 -f "$HERE/platform-tables.sql" > platform-tables.sql
psql "$SOURCE_DB_URL" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -f "$HERE/counts.sql" > counts.tsv

sha256sum db.dump auth-data.dump storage-meta.dump platform-tables.sql counts.tsv > MANIFEST.sha256
echo "backup written to $OUT ($(du -sh . | cut -f1))"
