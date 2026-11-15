#!/usr/bin/env bash
# Applies every migration in order to a throwaway plain PostgreSQL database (with the Supabase
# shim) and fails on the first error. Usage: DATABASE_URL=postgres://… scripts/verify-migrations.sh
set -euo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL to a throwaway database}"
PGOPTIONS='-c tw.shim_auth_tables=on -c client_min_messages=error' psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/backup/restore-shim.sql
for f in supabase/migrations/*.sql; do
  echo "applying $f"
  PGOPTIONS="-c client_min_messages=warning" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done
# Migrations written and tested but still awaiting the owner's confirmation on the live project.
for f in supabase/pending/*.sql; do
  [ -e "$f" ] || continue
  echo "applying (pending) $f"
  PGOPTIONS="-c client_min_messages=warning" psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -1 -f "$f"
done
echo "all migrations applied"
