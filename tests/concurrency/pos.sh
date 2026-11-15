#!/usr/bin/env bash
# Two sessions race to sell the LAST item at the same moment. Exactly one must succeed; stock must
# end at 0 (never -1). Also checks two devices accepting the same order. Needs a migrated scratch DB.
# Usage: DATABASE_URL=postgres://… tests/concurrency/pos.sh
set -euo pipefail
: "${DATABASE_URL:?}"
P() { psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
OWNER=$(cat /proc/sys/kernel/random/uuid); EMP2=$(cat /proc/sys/kernel/random/uuid); BIZ=$(cat /proc/sys/kernel/random/uuid)
P <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, raw_user_meta_data) values
  ('00000000-0000-0000-0000-000000000000', '$OWNER', 'authenticated', 'authenticated', 'race-owner@x.invalid', 'x', '{"full_name":"Asha"}'),
  ('00000000-0000-0000-0000-000000000000', '$EMP2', 'authenticated', 'authenticated', 'race-emp@x.invalid', 'x', '{"full_name":"Priya"}');
update public.profiles set must_change_password = false where id in ('$OWNER', '$EMP2');
insert into public.businesses (id, name) values ('$BIZ', 'Race Café');
insert into public.business_members (business_id, user_id, role, permissions) values ('$BIZ', '$OWNER', 'owner', '{}'), ('$BIZ', '$EMP2', 'employee', '{orders.view,orders.update,pos.sell}');
insert into public.business_modules (business_id, module_key) values ('$BIZ', 'orders'), ('$BIZ', 'pos');
insert into public.products (business_id, name) values ('$BIZ', 'Last Croissant');
insert into public.product_variants (product_id, price, track_stock) select id, 60, true from public.products where business_id = '$BIZ';
SQL
VAR=$(P -At -c "select v.id from public.product_variants v where v.business_id = '$BIZ'")
AS() { echo "select set_config('request.jwt.claims', json_build_object('sub', '$1', 'role', 'authenticated')::text, false); set role authenticated;"; }
P -c "$(AS $OWNER) select public.adjust_stock('$VAR', 1, 'receive');" >/dev/null

sell() { P -At -c "$(AS $1) begin; select (public.create_order('$BIZ', '[{\"variant_id\":\"$VAR\",\"qty\":1}]', '$2')).number; select pg_sleep($3); commit;" 2>&1 | grep -E "ERROR|^[0-9]+$" | head -1; }
sell $OWNER race-key-AAAA-1 1.5 > /tmp/race_a.txt &
sleep 0.3
sell $EMP2 race-key-BBBB-2 0 > /tmp/race_b.txt &
wait
A=$(cat /tmp/race_a.txt); B=$(cat /tmp/race_b.txt)
STOCK=$(P -At -c "select stock from public.product_variants where id = '$VAR'")
ORDERS=$(P -At -c "select count(*) from public.orders where business_id = '$BIZ'")
echo "session A: $A"; echo "session B: $B"; echo "stock=$STOCK orders=$ORDERS"
[ "$STOCK" = "0" ] && [ "$ORDERS" = "1" ] && echo "$B" | grep -q "Only 0 left of Last Croissant" || { echo "FAIL: last-item race"; exit 1; }

ORDER=$(P -At -c "select id from public.orders where business_id = '$BIZ'")
accept() { P -At -c "$(AS $1) begin; select (public.order_transition('$ORDER', 1, 'accepted', null, '$2')).status; select pg_sleep($3); commit;" 2>&1 | grep -E "ERROR|^accepted$" | head -1; }
accept $EMP2 tablet 1.5 > /tmp/acc_a.txt &
sleep 0.3
accept $OWNER phone 0 > /tmp/acc_b.txt &
wait
echo "device 1: $(cat /tmp/acc_a.txt)"; echo "device 2: $(cat /tmp/acc_b.txt)"
grep -q "Already accepted by Priya at" /tmp/acc_b.txt || { echo "FAIL: double accept"; exit 1; }
echo "concurrency tests passed"
