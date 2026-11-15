#!/usr/bin/env bash
# Records a heartbeat ("keepalive" or "backup") in the Supabase project. The call itself is real
# database activity, which keeps a free project from pausing. Usage:
#   TW_HEARTBEAT_TOKEN=… scripts/heartbeat.sh keepalive '{"source":"github"}'
set -euo pipefail
KIND="${1:-keepalive}"
DETAILS="${2:-{\}}"
URL="$(sed -n "s/^export const SUPABASE_URL = '\(.*\)'.*/\1/p" src/lib/supabase-config.js)"
KEY="$(sed -n "s/^export const SUPABASE_KEY = '\(.*\)'.*/\1/p" src/lib/supabase-config.js)"
: "${TW_HEARTBEAT_TOKEN:?missing TW_HEARTBEAT_TOKEN}"
BODY=$(jq -nc --arg k "$KIND" --arg t "$TW_HEARTBEAT_TOKEN" --argjson d "$DETAILS" '{p_kind:$k,p_token:$t,p_details:$d}')
RES=$(curl -sS --fail-with-body -X POST "$URL/rest/v1/rpc/record_heartbeat" \
  -H "apikey: $KEY" -H "content-type: application/json" -d "$BODY")
echo "heartbeat $KIND: $RES"
[ "$RES" = "true" ] || { echo "heartbeat rejected (wrong token?)"; exit 1; }
