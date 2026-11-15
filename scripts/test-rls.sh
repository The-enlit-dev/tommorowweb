#!/usr/bin/env bash
# Runs every supabase/tests/*.sql security suite against a database and prints the results.
# Each suite rolls itself back and reports through a "TEST_RESULTS [json]" error.
# Usage: DATABASE_URL=postgres://… scripts/test-rls.sh   (a migrated scratch DB, or the live project)
set -uo pipefail
cd "$(dirname "$0")/.."
: "${DATABASE_URL:?set DATABASE_URL}"
fail=0
for f in supabase/tests/*.sql; do
  out=$(psql "$DATABASE_URL" -X -q -f "$f" 2>&1)
  json=$(printf '%s\n' "$out" | sed -n 's/.*TEST_RESULTS \(\[.*\]\).*/\1/p' | head -1)
  if [ -z "$json" ]; then echo "✗ $f did not report results:"; printf '%s\n' "$out" | grep -E "ERROR|error" | head -5; fail=1; continue; fi
  total=$(jq length <<<"$json"); bad=$(jq '[.[] | select(.ok != true)] | length' <<<"$json")
  echo "$f: $((total - bad))/$total passed"
  if [ "$bad" != 0 ]; then jq -r '.[] | select(.ok != true) | "  ✗ \(.n) \(.check) \(.detail // "")"' <<<"$json"; fail=1; fi
done
exit $fail
