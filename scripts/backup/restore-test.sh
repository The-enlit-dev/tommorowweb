#!/usr/bin/env bash
# Restores a backup produced by backup.sh into a THROWAWAY plain PostgreSQL and checks it.
#   TARGET_DB_URL  an empty scratch database (never the live project!)
#   IN             directory containing the backup files (default ./backup-out)
# Fails if checksums don't match, any restore step errors, or a table is missing.
set -euo pipefail
: "${TARGET_DB_URL:?set TARGET_DB_URL}"
IN="${IN:-backup-out}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$TARGET_DB_URL" in *supabase.co*|*supabase.com*) echo "refusing to restore into a Supabase project"; exit 1;; esac
cd "$IN"
sha256sum --check --quiet MANIFEST.sha256
P() { psql "$TARGET_DB_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
PGOPTIONS="-c client_min_messages=error" P -f "$ROOT/supabase/backup/restore-shim.sql"
# The dump recreates the public schema itself (safe: this is an empty scratch database).
P -c "drop schema if exists public cascade"
P -f platform-tables.sql
pg_restore --exit-on-error --no-owner --no-privileges -d "$TARGET_DB_URL" auth-data.dump
pg_restore --exit-on-error --no-owner --no-privileges -d "$TARGET_DB_URL" db.dump
pg_restore --exit-on-error --no-owner --no-privileges -d "$TARGET_DB_URL" storage-meta.dump
psql "$TARGET_DB_URL" -X -q -At -F $'\t' -v ON_ERROR_STOP=1 -f "$ROOT/scripts/backup/counts.sql" > restored-counts.tsv

missing=$(comm -23 <(cut -f1,2 counts.tsv | sort) <(cut -f1,2 restored-counts.tsv | sort) || true)
if [ -n "$missing" ]; then echo "MISSING TABLES after restore:"; echo "$missing"; exit 1; fi
if ! diff -q counts.tsv restored-counts.tsv > /dev/null; then
  echo "row counts differ (rows written during the dump are expected to cause small differences):"
  diff counts.tsv restored-counts.tsv || true
  # pg_dump takes one consistent snapshot per file; a difference larger than 5% of a table is an error.
  join -t $'\t' <(awk -F'\t' '{print $1"."$2"\t"$3}' counts.tsv | sort) <(awk -F'\t' '{print $1"."$2"\t"$3}' restored-counts.tsv | sort) |
    awk -F'\t' '{d=$2-$3; if (d<0) d=-d; if (d > ($2*0.05)+2) {print "too different: "$0; bad=1}} END {exit bad}'
fi
tables=$(wc -l < restored-counts.tsv); rows=$(awk -F'\t' '{s+=$3} END {print s+0}' restored-counts.tsv)
echo "restore verified: $tables tables, $rows rows"
echo "{\"tables\":$tables,\"rows\":$rows}" > restore-result.json
