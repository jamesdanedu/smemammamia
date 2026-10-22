#!/usr/bin/env bash
# ===========================================================================
#  Double-booking tests for the seat functions in schema-seating.sql.
#
#  Runs against a throwaway local Postgres — never the real Supabase project.
#
#      PGHOST=/path/to/socket PGPORT=5432 PGUSER=postgres tests/seat-holds.sh
#
#  It creates (and drops) a database called mm_seat_test, builds it from
#  schema.sql + schema-email.sql + schema-seating.sql, then checks:
#
#    1. many holds racing for the same seat — exactly one wins
#    2. two holds racing with one seat in common — all-or-nothing
#    3. an expired hold's seat is taken over by a new hold
#    4. the late payment on that expired hold is honoured and flagged
#    5. a late payment whose seats are still free gets them back
#    6. accessible seats refused to the public until released, allowed to staff
#    7. blocked seats refused to the public, allowed to staff
#    8. un-releasing an accessible seat somebody bought is refused
#    9. reseating clears a conflict; the primary key still refuses a duplicate
# ===========================================================================
set -euo pipefail

cd "$(dirname "$0")/.."

DB=mm_seat_test
PSQL=(psql -X -q -v ON_ERROR_STOP=1 -At)
PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  ok    $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL  $1"; }
check() { # description, expected, actual
    if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$2], got [$3]"; fi
}
q() { "${PSQL[@]}" -d "$DB" -c "$1"; }

# Supabase's roles, so the grants in the schema files have somewhere to go.
for role in anon authenticated service_role; do
    "${PSQL[@]}" -d postgres -c "do \$\$ begin create role $role; exception when duplicate_object then null; end \$\$;"
done

"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB"
for f in schema.sql schema-email.sql schema-seating.sql; do
    "${PSQL[@]}" -d "$DB" -f "$f" 2>/dev/null >/dev/null
done

NIGHT="'2027-01-28'"
RESTRICTED="array['J1','J2','J13','J14','J15','J16','J27','J28','K1','K2','K13','K14','K15','K16','K27','K28']"

# hold <ref> <seats sql array> [extra named args]
hold_sql() {
    echo "select booking_reference from public.create_hold(
            p_reference => '$1', p_date => $NIGHT, p_seats => $2, p_amount => 10,
            p_name => 'Test $1', p_email => 'test@example.com', p_phone => '',
            p_restricted => $RESTRICTED ${3:-})"
}

echo "1. many holds racing for the same seat"
for i in $(seq 1 25); do
    ( "${PSQL[@]}" -d "$DB" -c "$(hold_sql "MM-RACE$(printf '%02d' "$i")" "array['A1','A$(( (i % 13) + 2 ))']")" \
        >/dev/null 2>&1 && echo won || echo lost ) &
done > /tmp/mm_race.$$ ; wait
check "exactly one of 25 concurrent holds got A1" 1 "$(grep -c won /tmp/mm_race.$$)"
check "A1 has exactly one row" 1 "$(q "select count(*) from booking_seats where seat_id = 'A1'")"
check "losers left no booking behind" 1 "$(q "select count(*) from bookings where booking_reference like 'MM-RACE%'")"
check "every seat row belongs to a booking that exists" 0 \
      "$(q "select count(*) from booking_seats bs left join bookings b on b.id = bs.booking_id where b.id is null")"
rm -f /tmp/mm_race.$$

echo "2. two holds with one seat in common, the first one slow to commit"
# Session one takes B1-B3 and sits on its transaction for two seconds.
( "${PSQL[@]}" -d "$DB" -c "begin; $(hold_sql MM-SLOW01 "array['B1','B2','B3']"); select pg_sleep(2); commit;" >/dev/null ) &
sleep 0.5
# Session two wants B3-B5. It must wait for the lock, then be told B3 went.
OUT=$("${PSQL[@]}" -d "$DB" -c "$(hold_sql MM-SLOW02 "array['B3','B4','B5']")" 2>&1 || true)
wait
check "second hold told exactly which seat went" "SEAT_TAKEN:B3" "$(grep -o 'SEAT_TAKEN:[A-Z0-9,]*' <<<"$OUT")"
check "second hold took none of its seats (all or nothing)" 0 \
      "$(q "select count(*) from booking_seats where seat_id in ('B4','B5')")"
check "second hold left no booking" 0 "$(q "select count(*) from bookings where booking_reference = 'MM-SLOW02'")"
check "first hold has all three" 3 \
      "$(q "select count(*) from booking_seats bs join bookings b on b.id = bs.booking_id where b.booking_reference = 'MM-SLOW01'")"

echo "3. an expired hold is taken over"
q "$(hold_sql MM-OLD001 "array['C5','C6']")" >/dev/null
OUT=$(q "$(hold_sql MM-NEW001 "array['C6','C7']")" 2>&1 || true)
check "a live hold blocks the seat" "SEAT_TAKEN:C6" "$(grep -o 'SEAT_TAKEN:[A-Z0-9,]*' <<<"$OUT")"
q "update bookings set held_until = now() - interval '1 minute', sumup_checkout_id = 'chk_old' where booking_reference = 'MM-OLD001'"
check "the map no longer shows the expired seats" 0 "$(q "select count(*) from taken_seats where seat_id in ('C5','C6')")"
check "a new hold takes the expired seat" "MM-NEW001" "$(q "$(hold_sql MM-NEW001 "array['C6','C7']")")"
check "the expired hold's rows were swept" 0 \
      "$(q "select count(*) from booking_seats bs join bookings b on b.id = bs.booking_id where b.booking_reference = 'MM-OLD001'")"

echo "4. the expired hold's payment lands late"
q "select 1 from confirm_paid_booking('MM-OLD001', 'txn_1')" >/dev/null
check "the booking is confirmed — the money is honoured" "confirmed|paid|true" \
      "$(q "select status || '|' || payment_status || '|' || seat_conflict from bookings where booking_reference = 'MM-OLD001'")"
check "it was given no seats behind anyone's back" 0 \
      "$(q "select count(*) from booking_seats bs join bookings b on b.id = bs.booking_id where b.booking_reference = 'MM-OLD001'")"
check "C5 (still free) was not half-given either" 0 "$(q "select count(*) from booking_seats where seat_id = 'C5'")"
check "the new hold kept C6" "MM-NEW001" "$(q "select booking_reference from taken_seats where seat_id = 'C6'")"
q "select 1 from confirm_paid_booking('MM-OLD001', 'txn_1')" >/dev/null
check "confirming twice changes nothing" 1 "$(q "select count(*) from bookings where booking_reference = 'MM-OLD001' and seat_conflict")"

echo "5. a late payment whose seats are still free"
q "$(hold_sql MM-LATE01 "array['D1','D2']")" >/dev/null
q "update bookings set held_until = now() - interval '20 minutes' where booking_reference = 'MM-LATE01'"
q "select release_stale_seats($NIGHT)" >/dev/null
q "select 1 from confirm_paid_booking('MM-LATE01', 'txn_2')" >/dev/null
check "it gets its own seats back, no conflict" "D1,D2|false" \
      "$(q "select string_agg(bs.seat_id, ',' order by bs.seat_id) || '|' || bool_or(b.seat_conflict)
            from bookings b join booking_seats bs on bs.booking_id = b.id where b.booking_reference = 'MM-LATE01'")"

echo "6. accessible seats"
OUT=$(q "$(hold_sql MM-ACC001 "array['J1','J3']")" 2>&1 || true)
check "the public cannot hold an accessible seat" "SEAT_RESTRICTED:J1" "$(grep -o 'SEAT_RESTRICTED:[A-Z0-9,]*' <<<"$OUT")"
check "and nothing was held" 0 "$(q "select count(*) from booking_seats where seat_id in ('J1','J3')")"
q "select set_accessible_release($NIGHT, array['J1'], true)" >/dev/null
check "once released, the public can" "MM-ACC001" "$(q "$(hold_sql MM-ACC001 "array['J1','J3']")")"
check "staff can use an unreleased one" "MM-ACC002" \
      "$(q "$(hold_sql MM-ACC002 "array['K1','K2']" ", p_staff => true, p_confirm => true, p_payment_status => 'comp', p_payment_method => 'comp'")")"
check "a staff booking can be confirmed at once, as a comp" "confirmed|comp|0.00" \
      "$(q "update bookings set amount = 0 where booking_reference = 'MM-ACC002' returning status || '|' || payment_status || '|' || amount")"
OUT=$(q "$(hold_sql MM-ACC003 "array['A20']" ", p_confirm => true")" 2>&1 || true)
check "the public path cannot confirm without paying" "NOT_ALLOWED" "$(grep -o 'NOT_ALLOWED' <<<"$OUT")"

echo "7. blocked seats"
q "select set_seat_blocks($NIGHT, array['T14','T15'], true, 'Sound desk')" >/dev/null
OUT=$(q "$(hold_sql MM-BLK001 "array['T15','T16']")" 2>&1 || true)
check "the public cannot hold a blocked seat" "SEAT_TAKEN:T15" "$(grep -o 'SEAT_TAKEN:[A-Z0-9,]*' <<<"$OUT")"
check "staff can" "MM-BLK002" "$(q "$(hold_sql MM-BLK002 "array['T14']" ", p_staff => true")")"
OUT=$(q "select set_seat_blocks($NIGHT, array['A1'], true)" 2>&1 || true)
check "a sold seat cannot be blocked" "SEAT_TAKEN:A1" "$(grep -o 'SEAT_TAKEN:[A-Z0-9,]*' <<<"$OUT")"

echo "8. taking a released seat back"
OUT=$(q "select set_accessible_release($NIGHT, array['J1'], false)" 2>&1 || true)
check "refused while somebody holds it" "SEAT_TAKEN:J1" "$(grep -o 'SEAT_TAKEN:[A-Z0-9,]*' <<<"$OUT")"
q "select set_accessible_release($NIGHT, array['J27'], true)" >/dev/null
check "allowed when nobody has it" 1 "$(q "select set_accessible_release($NIGHT, array['J27'], false)")"

echo "9. reseating, and the primary key as the last line"
q "select 1 from reseat_booking('MM-OLD001', array['E1','E2'])" >/dev/null
check "a conflicted booking is reseated and cleared" "E1,E2|false" \
      "$(q "select string_agg(bs.seat_id, ',' order by bs.seat_id) || '|' || bool_or(b.seat_conflict)
            from bookings b join booking_seats bs on bs.booking_id = b.id where b.booking_reference = 'MM-OLD001'")"
OUT=$(q "select reseat_booking('MM-LATE01', array['E2','E3'])" 2>&1 || true)
check "reseating onto somebody else's seat is refused" "SEAT_TAKEN:E2" "$(grep -o 'SEAT_TAKEN:[A-Z0-9,]*' <<<"$OUT")"
OUT=$(q "insert into booking_seats (performance_date, seat_id, booking_id)
         select $NIGHT, 'E1', id from bookings where booking_reference = 'MM-LATE01'" 2>&1 || true)
check "a duplicate seat row is impossible, whatever the code does" "duplicate key" "$(grep -o 'duplicate key' <<<"$OUT")"

echo "10. the anon key can call nothing"
check "anon cannot create a hold" f \
      "$(q "select has_function_privilege('anon', 'public.create_hold(text, date, text[], numeric, text, text, text, text, integer, text, text, text[], boolean, boolean, text, text, text, uuid)', 'execute')")"
check "anon cannot confirm a payment" f "$(q "select has_function_privilege('anon', 'public.confirm_paid_booking(text, text)', 'execute')")"
check "service_role can" t "$(q "select has_function_privilege('service_role', 'public.confirm_paid_booking(text, text)', 'execute')")"

"${PSQL[@]}" -d postgres -c "drop database if exists $DB"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
