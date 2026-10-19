#!/usr/bin/env bash
#
# Applies every migration to a throwaway PostgreSQL cluster and runs the
# financial invariant suite against it (spec §71).
#
# Why a real cluster and not a mock: the guarantees being tested — CHECK
# constraints, append-only triggers, RLS policies, single-winner claim functions
# — are PostgreSQL behaviour. A mock would test our belief about them, which is
# exactly the thing that can be wrong. The cluster is created fresh, used, and
# destroyed, so the suite never touches the hosted project.
#
#   ./scripts/test-db.sh
#
# Requires a local PostgreSQL (any of 15/16/17; 15+ for `unique nulls not
# distinct`). Exits non-zero if any migration or any invariant fails.
#
#   PGBIN=<dir>        server binaries (initdb, pg_ctl, postgres) to use
#   PSQLBIN=<dir>      psql to use, when PGBIN has none (default: PGBIN)
#   JIMOCEX_EXTRA_SQL=<file>
#                      SQL applied as one transaction after the migrations, to
#                      test a draft migration before it is one. Requires
#                      JIMOCEX_PRIVILEGE_PROFILE. If <file>.sha256 exists, the
#                      file must match it (npm run test:db:019 runs
#                      supabase/drafts/019_table_privileges.sql this way).
#   JIMOCEX_PRIVILEGE_PROFILE=017|019
#                      the privileges the database is expected to hold
#                      (scripts/privilege-registry.ts); default 017, what the
#                      migrations in the repository build.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${JIMOCEX_TEST_DIR:-/tmp/jimocex-pgtest}"
DB="jimocex_test"

# Pick the newest installed PostgreSQL rather than whatever is first on PATH.
if [ -n "${PGBIN:-}" ]; then
  BIN="$PGBIN"
elif [ -d /usr/lib/postgresql ]; then
  BIN="/usr/lib/postgresql/$(ls /usr/lib/postgresql | sort -n | tail -1)/bin"
else
  BIN="$(dirname "$(command -v postgres)")"
fi
[ -x "$BIN/initdb" ] || { echo "PostgreSQL not found (looked in $BIN)"; exit 1; }
PSQLDIR="${PSQLBIN:-$BIN}"
[ -x "$PSQLDIR/psql" ] || { echo "psql not found (looked in $PSQLDIR; set PSQLBIN)"; exit 1; }

EXTRA_SQL="${JIMOCEX_EXTRA_SQL:-}"
if [ -n "$EXTRA_SQL" ] && [ -z "${JIMOCEX_PRIVILEGE_PROFILE:-}" ]; then
  echo "JIMOCEX_EXTRA_SQL is set: also set JIMOCEX_PRIVILEGE_PROFILE to the privileges it should produce"; exit 1
fi
[ -z "$EXTRA_SQL" ] || [ -f "$EXTRA_SQL" ] || { echo "JIMOCEX_EXTRA_SQL: no such file: $EXTRA_SQL"; exit 1; }
# A reviewed draft is identified by its hash: an edit that was not re-reviewed
# fails here, before anything runs. A draft in supabase/drafts must be pinned;
# the copy that is finally run is checked again (below), so the file cannot
# change between this check and its use.
EXTRA_SHA=""
if [ -n "$EXTRA_SQL" ]; then
  case "$(realpath "$EXTRA_SQL")" in
    "$ROOT"/supabase/drafts/*)
      [ -f "$EXTRA_SQL.sha256" ] || { echo "$EXTRA_SQL is a draft in supabase/drafts but has no $EXTRA_SQL.sha256"; exit 1; } ;;
  esac
  if [ -f "$EXTRA_SQL.sha256" ]; then
    (cd "$(dirname "$EXTRA_SQL")" && sha256sum --quiet --strict -c "$(basename "$EXTRA_SQL").sha256") \
      || { echo "$EXTRA_SQL does not match $EXTRA_SQL.sha256"; exit 1; }
    EXTRA_SHA="$(cut -d' ' -f1 "$EXTRA_SQL.sha256")"
  fi
fi
PROFILE="${JIMOCEX_PRIVILEGE_PROFILE:-017}"
case "$PROFILE" in 017|019) ;; *) echo "JIMOCEX_PRIVILEGE_PROFILE must be 017 or 019, not '$PROFILE'"; exit 1 ;; esac

# PostgreSQL refuses to run as root, so when invoked as root the cluster is
# owned and driven by the `postgres` system user.
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || { echo "running as root but no 'postgres' user exists"; exit 1; }
  AS_PG() { su postgres -c "$1"; }
  OWNER="postgres:postgres"
else
  AS_PG() { bash -c "$1"; }
  OWNER="$(id -un):$(id -gn)"
fi

PGDATA="$WORK/data"
# The socket lives in its own short directory: a Unix socket path is limited to
# about 107 bytes, which a long JIMOCEX_TEST_DIR would otherwise exceed.
SOCK="$(mktemp -d /tmp/jcx-sock.XXXXXX)"

cleanup() {
  local status=$?
  AS_PG "$BIN/pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true
  # Keep the server log long enough to explain a failure.
  if [ "$status" -ne 0 ] && [ -f "$WORK/log" ]; then
    echo "---- last lines of the PostgreSQL log ----" >&2
    tail -n 40 "$WORK/log" >&2 || true
  fi
  rm -rf "$WORK" "$SOCK"
}
trap cleanup EXIT

echo "==> fresh cluster in $WORK"
rm -rf "$WORK"
mkdir -p "$PGDATA"
chown -R "$OWNER" "$WORK" "$SOCK"
AS_PG "$BIN/initdb -D $PGDATA -A trust --locale=C --encoding=UTF8" >/dev/null
AS_PG "$BIN/pg_ctl -D $PGDATA -o \"-k $SOCK -c listen_addresses=''\" -l $WORK/log start -w" >/dev/null
AS_PG "$PSQLDIR/psql -h $SOCK -d postgres -q -c 'create database $DB'"
AS_PG "$PSQLDIR/psql -h $SOCK -d postgres -qAt -c 'select version()'" | sed 's/^/    /'

PSQL() { AS_PG "$PSQLDIR/psql -h $SOCK -d $DB -v ON_ERROR_STOP=1 $*"; }

# Each file runs as ONE transaction (-1), which is how the hosted project
# applies a migration. Without it a failure halfway through would leave a
# partially applied migration behind, and a function could sit between its
# CREATE and its REVOKE with the default grants in effect.
run_file() {
  local src="$1" dst="$WORK/$(basename "$1")"
  cp "$src" "$dst"; chmod 644 "$dst"
  PSQL "-q -1 -f $dst"
}

echo "==> Supabase primitives (test scaffolding only)"
run_file "$ROOT/supabase/tests/00_supabase_stubs.sql"

echo "==> migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %-42s' "$(basename "$f")"
  run_file "$f"
  echo "ok"
done

if [ -n "$EXTRA_SQL" ]; then
  echo "==> extra SQL, not part of the migrations: $EXTRA_SQL"
  dst="$WORK/extra-$(basename "$EXTRA_SQL")"
  cp "$EXTRA_SQL" "$dst"; chmod 644 "$dst"
  ran_sha="$(sha256sum "$dst" | cut -d' ' -f1)"
  echo "    sha256 $ran_sha"
  if [ -n "$EXTRA_SHA" ] && [ "$ran_sha" != "$EXTRA_SHA" ]; then
    echo "$EXTRA_SQL changed after its hash was checked"; exit 1
  fi
  PSQL "-q -1 -f $dst"
fi

echo "==> invariant suite (privilege profile $PROFILE)"
src="$ROOT/supabase/tests/01_invariants.sql"
cp "$src" "$WORK/inv.sql"; chmod 644 "$WORK/inv.sql"
PSQL "-v privilege_profile=$PROFILE -f $WORK/inv.sql"

# The money registry (src/lib/db/money-columns.ts) is checked against the
# catalog of the database the migrations actually built — not against a reading
# of the migration text, which cannot see ALTER TABLE, casing or a column added
# in an unusual way.
echo "==> money registry vs. database catalog"
cp "$ROOT/supabase/tests/02_money_catalog.sql" "$WORK/catalog.sql"; chmod 644 "$WORK/catalog.sql"
PSQL "-qAt -f $WORK/catalog.sql -o $WORK/catalog.json"
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-money-catalog.ts" "$WORK/catalog.json"

# Every privilege of anon, authenticated, service_role and PUBLIC on every
# table, column and function in public, against scripts/privilege-registry.ts.
echo "==> privilege registry vs. database catalog (profile $PROFILE)"
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-privileges.ts" "$WORK/catalog.json" "$PROFILE"

# Precision, end to end: Money -> moneyArgs/moneyInsert -> JSON.stringify ->
# PostgREST-style binding -> numeric(38,18) -> ::text -> fromDatabase -> Money.
echo "==> money round trip through a JSON body"
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-money-roundtrip.ts" generate > "$WORK/roundtrip.sql"
chmod 644 "$WORK/roundtrip.sql"
PSQL "-qAt -f $WORK/roundtrip.sql -o $WORK/roundtrip.out"
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-money-roundtrip.ts" verify "$WORK/roundtrip.out"

# Two real sessions race for one order's submission claim (022). Session A
# claims and holds its transaction open; session B claims the same order
# meanwhile, so it blocks on A's row lock. If A commits, B must find the order
# no longer OPEN and get nothing; if A rolls back, B must win. Either way B
# waited for A — it never decided on a state A had not finished with.
echo "==> concurrent submission claims (two sessions)"
cat > "$WORK/race_setup.sql" <<'SQL'
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000014e1', 'race@test.invalid');
update public.trading_pairs set trading_enabled = true where symbol = 'BTC-USDT';
select public.ledger_post('00000000-0000-4000-8000-0000000014e1', (select id from public.assets where symbol = 'USDT'),
  'DEPOSIT', 1000, 1000, 0, 'test', null, 'tst:race:fund');
select public.place_limit_order('00000000-0000-4000-8000-0000000014e1',
  (select id from public.trading_pairs where symbol = 'BTC-USDT'), 'BUY', 80000, 0.001,
  (select id from public.assets where symbol = 'USDT'), 80.16, c, 0.16)
from unnest(array['race-1', 'race-2']) as c;
SQL
cat > "$WORK/race_a.sql" <<'SQL'
begin;
select 'won=' || (public.claim_order_for_submission('00000000-0000-4000-8000-0000000014e1',
  (select id from public.trading_orders where client_order_id = :'cid')) is not null)::text;
select pg_sleep(1.5) \g /dev/null
:fin;
SQL
cat > "$WORK/race_b.sql" <<'SQL'
select 'won=' || (public.claim_order_for_submission('00000000-0000-4000-8000-0000000014e1',
  (select id from public.trading_orders where client_order_id = :'cid')) is not null)::text
  || ' waited=' || (clock_timestamp() - statement_timestamp() > interval '0.8 seconds')::text;
SQL
chmod 644 "$WORK"/race_*.sql
PSQL "-qAt -f $WORK/race_setup.sql" > /dev/null

race() {  # race <client_order_id> <commit|rollback> <expected A> <expected B>
  local a_out
  PSQL "-qAt -v cid=$1 -v fin=$2 -f $WORK/race_a.sql" > "$WORK/race_a.out" &
  local a_pid=$!
  sleep 0.5
  local b_out
  b_out="$(PSQL "-qAt -v cid=$1 -f $WORK/race_b.sql")"
  wait "$a_pid"
  a_out="$(grep -m1 '^won=' "$WORK/race_a.out")"
  if [ "$a_out" != "$3" ] || [ "$b_out" != "$4" ]; then
    echo "    claim race ($1, A $2): A '$a_out' (expected '$3'), B '$b_out' (expected '$4')"; exit 1
  fi
  local verb="committed"; [ "$2" = rollback ] && verb="rolled back"
  echo "    $1: A claimed and $verb; B waited for it and $( [ "$4" = 'won=true waited=true' ] && echo won || echo lost)"
}
race race-1 commit   'won=true' 'won=false waited=true'
race race-2 rollback 'won=true' 'won=true waited=true'

summary="$(PSQL "-qAt -c \"select string_agg(o.client_order_id || ':' || o.status || ':' || (select count(*) from public.audit_logs a where a.action = 'order.submit' and a.entity_id = o.id), ',' order by o.client_order_id) from public.trading_orders o where o.client_order_id in ('race-1', 'race-2')\"")"
if [ "$summary" != "race-1:SUBMITTED:1,race-2:SUBMITTED:1" ]; then
  echo "    after the races: $summary (expected each order SUBMITTED once, one claim audited each)"; exit 1
fi
echo "    exactly one claim took effect per order: $summary"

# The 021 -> 022 upgrade package (supabase/drafts/upgrade_021_022): what upgrades
# an existing database built from 001–021 (the Preview's test project) without
# rebuilding it. Each scenario runs on its own copy of a 001–021 database that
# holds demo activity (supabase/tests/03_upgrade_fixture_021.sql). A refused or
# interrupted upgrade must leave everything as it was: checks.sql's whole
# output (verdicts, money checks, and every table's rows) is compared.
echo "==> upgrade 021 -> 022 on existing databases (supabase/drafts/upgrade_021_022)"
UPG="$ROOT/supabase/drafts/upgrade_021_022"
(cd "$UPG" && sha256sum --quiet --strict -c checks.sql.sha256 apply.sql.sha256) \
  || { echo "    the upgrade package does not match its .sha256 files"; exit 1; }
node -e '
  const fs = require("fs");
  const [apply, checks, mig] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
  const inner = (s, tag) => { const p = s.split(tag); return p.length === 3 ? p[1] : null; };
  if (inner(apply, "$mig022$") !== mig.replace(/\n$/, "") || inner(apply, "$checks$") !== checks.replace(/;\n$/, "")) {
    console.error("    apply.sql does not embed 022 and checks.sql as they are"); process.exit(1);
  }' "$UPG/apply.sql" "$UPG/checks.sql" "$ROOT/supabase/migrations/022_submitted_lifecycle.sql"
for f in checks.sql apply.sql; do cp "$UPG/$f" "$WORK/upg_$f"; done
cp "$ROOT/supabase/tests/03_upgrade_fixture_021.sql" "$WORK/upg_fixture.sql"
chmod 644 "$WORK"/upg_*.sql
PSQLD() { local d=$1; shift; AS_PG "$PSQLDIR/psql -X -h $SOCK -d $d -v ON_ERROR_STOP=1 $*"; }
CHECKS() { PSQLD "$1" "-qAt -1 -c 'set transaction read only' -f $WORK/upg_checks.sql"; }
APPLY() { PSQLD "$1" "-q -f ${2:-$WORK/upg_apply.sql}" > "$WORK/upg_$1.out" 2>&1; }
verdict() { CHECKS "$1" | grep -E '^(pre|post)\|(P99|Q99)\|' | cut -d'|' -f1,5 | tr '\n' ' '; }
fail() { echo "    $*"; exit 1; }

# The 001–021 base with demo activity, and a clean 001–022 build to compare with.
PSQLD postgres "-qc 'create database upg_base'"
PSQLD postgres "-qc 'create database upg_clean'"
for d in upg_base upg_clean; do PSQLD "$d" "-q -f $WORK/00_supabase_stubs.sql" > /dev/null; done
for f in "$ROOT"/supabase/migrations/*.sql; do
  n="$(basename "$f")"
  PSQLD upg_clean "-q -1 -f $WORK/$n" > /dev/null
  [[ "${n:0:3}" > "021" ]] || PSQLD upg_base "-q -1 -f $WORK/$n" > /dev/null
done
PSQLD upg_base "-q -1 -f $WORK/upg_fixture.sql"
clone() { PSQLD postgres "-qc 'create database $1 template upg_base'"; }

# A refused or failed upgrade: exit status 3, the expected message, nothing changed.
refused() {  # refused <db> <label> <expected text in the error> [apply file]
  local before after rc=0
  before="$(CHECKS "$1")"
  APPLY "$1" "${4:-}" || rc=$?
  after="$(CHECKS "$1")"
  [ "$rc" -ne 0 ] || fail "$2: the upgrade was NOT refused"
  grep -q -- "$3" "$WORK/upg_$1.out" || { cat "$WORK/upg_$1.out"; fail "$2: refused, but without '$3'"; }
  [ "$before" = "$after" ] || fail "$2: refused, but the database changed"
  echo "    $2: refused (exit $rc, '$3'), nothing changed"
}

# A. clean 001–022 build
[ "$(verdict upg_clean)" = "pre|BLOCKED post|PASS " ] || fail "A. clean 001-022 build: $(verdict upg_clean)"
echo "    A. clean 001-022 build: post PASS, pre BLOCKED"

# B. existing 021 database -> 022
clone upg_ok
[ "$(verdict upg_ok)" = "pre|READY post|FAIL " ] || fail "B. before: $(verdict upg_ok)"
before="$(CHECKS upg_ok | grep '^data|')"
APPLY upg_ok || { cat "$WORK/upg_upg_ok.out"; fail "B. the upgrade failed"; }
[ "$(verdict upg_ok)" = "pre|BLOCKED post|PASS " ] || fail "B. after: $(verdict upg_ok)"
[ "$before" = "$(CHECKS upg_ok | grep '^data|')" ] || fail "B. rows changed"
echo "    B. 021 -> 022: pre READY then post PASS; every row of $(echo "$before" | wc -l) tables unchanged"

# C. already 022: a second run
refused upg_ok "C. second run on the upgraded database" "P04 022 not applied"
refused upg_clean "C. run on a clean 001-022 build" "P04 022 not applied"

# D. order states 022 would strand, and inconsistent money
clone upg_d1; PSQLD upg_d1 "-qc \"update public.trading_orders set filled_amount = 0.005, status = 'PARTIALLY_FILLED' where client_order_id = 'fixture-open-buy'\""
refused upg_d1 "D1. a PARTIALLY_FILLED order" "P09 no order 022 would strand"
clone upg_d2; PSQLD upg_d2 "-qc \"insert into public.trading_orders (user_id, pair_id, side, type, price, amount) select user_id, pair_id, side, type, price, amount from public.trading_orders where client_order_id = 'fixture-open-buy'\""
refused upg_d2 "D2. a PENDING order" "P09 no order 022 would strand"
clone upg_d3; PSQLD upg_d3 "-qc \"update public.trading_orders set locked_amount = 1 where client_order_id = 'fixture-cancelled'\""
refused upg_d3 "D3. a cancelled order still holding funds" "M3 funds are locked only by live orders"
clone upg_d4; PSQLD upg_d4 "-qc \"update public.trading_orders set status = 'REJECTED' where client_order_id = 'fixture-open-eth'\""
refused upg_d4 "D4. a rejected order still holding funds" "M3 funds are locked only by live orders"
clone upg_d5; PSQLD upg_d5 "-qc \"update public.wallets set available_balance = available_balance + 1 where user_id = '00000000-0000-4000-8000-0000000021a2'\""
refused upg_d5 "D5. a wallet that differs from its ledger" "M5 every wallet equals its ledger"

# E. venue order ids
clone upg_e1; PSQLD upg_e1 "-qc \"update public.trading_orders set provider_order_id = 'V-1' where client_order_id = 'fixture-open-buy'\""
refused upg_e1 "E1. a recorded venue order id" "P10 no venue order id is recorded"
if PSQLD upg_e1 "-qc \"update public.trading_orders set provider_order_id = 'V-1' where client_order_id = 'fixture-open-sell'\"" > "$WORK/upg_e2.out" 2>&1; then
  fail "E2. a duplicate venue order id was accepted"
fi
grep -q 'trading_orders_provider_order_id_key' "$WORK/upg_e2.out" || fail "E2. refused for another reason"
echo "    E2. a duplicate venue order id cannot exist: the UNIQUE constraint of 005 refuses it"

# F. migration history. The stubs create an empty supabase_migrations.schema_migrations,
# as a Supabase project has one (B ran with it); the Preview's project has none (F3).
hist() {  # hist <db> <versions...>: rows written by another migration mechanism
  local d=$1; shift
  for v in "$@"; do PSQLD "$d" "-qc \"insert into supabase_migrations.schema_migrations (version, name) values ('$v', 'm$v')\""; done
}
clone upg_f1; hist upg_f1 001 002 003 004 005 006 007 008 009 010 011 012 013 014 015 016 017 018 020 021
refused upg_f1 "F1. a history listing 001-021" "P03 no migration history"
clone upg_f2; hist upg_f2 022
refused upg_f2 "F2. a history listing 022" "P03 no migration history"
clone upg_f3; PSQLD upg_f3 "-qc 'drop schema supabase_migrations cascade'"
[ "$(verdict upg_f3)" = "pre|READY post|FAIL " ] || fail "F3. before: $(verdict upg_f3)"
APPLY upg_f3 || { cat "$WORK/upg_upg_f3.out"; fail "F3. no history table: the upgrade failed"; }
[ "$(verdict upg_f3)" = "pre|BLOCKED post|PASS " ] || fail "F3. after: $(verdict upg_f3)"
echo "    F3. no history table at all (as on the Preview's project): upgraded, post PASS, no history written"

# G. interrupted or failing upgrades
clone upg_g1
PSQLD upg_g1 "-qc 'begin; lock table public.wallets in row exclusive mode; select pg_sleep(8); commit'" > /dev/null 2>&1 &
g1=$!; sleep 1
refused upg_g1 "G1. a writer holding a lock for longer than lock_timeout (5s)" "lock timeout"
wait "$g1" || true
sed 's/^  execute v022;$/  execute v022;\n  raise exception '"'"'injected failure after 022'"'"';/' "$WORK/upg_apply.sql" > "$WORK/upg_apply_fail.sql"
sed 's/^  execute v022;$/  execute v022;\n  perform pg_sleep(30);/' "$WORK/upg_apply.sql" > "$WORK/upg_apply_sleep.sql"
chmod 644 "$WORK"/upg_apply_*.sql
grep -q 'injected failure after 022' "$WORK/upg_apply_fail.sql" && grep -q 'pg_sleep(30)' "$WORK/upg_apply_sleep.sql" || fail "G: could not build the test copies"
clone upg_g2
refused upg_g2 "G2. an error after 022 ran, inside the statement" "injected failure after 022" "$WORK/upg_apply_fail.sql"
clone upg_g3
before="$(CHECKS upg_g3)"
(rc=0; APPLY upg_g3 "$WORK/upg_apply_sleep.sql" || rc=$?; echo "$rc" > "$WORK/upg_g3.rc") &
g3=$!; sleep 2
# The session waiting in the injected pg_sleep has run 022 and not yet ended its statement.
PSQLD postgres "-qAt -c \"select pg_terminate_backend(pid) from pg_stat_activity where datname = 'upg_g3' and wait_event = 'PgSleep'\"" | grep -qx t || fail "G3. no running upgrade to terminate"
wait "$g3" || true
[ "$(cat "$WORK/upg_g3.rc")" -ne 0 ] || fail "G3. the terminated upgrade reported success"
[ "$before" = "$(CHECKS upg_g3)" ] || fail "G3. the terminated upgrade changed the database"
echo "    G3. the session killed after 022 ran, before the statement ended: exit $(cat "$WORK/upg_g3.rc"), nothing changed"
clone upg_g4
PSQLD postgres "-qc 'create role upg_extra nologin'"
PSQLD upg_g4 "-qc 'alter default privileges for role postgres in schema public grant execute on functions to upg_extra'"
refused upg_g4 "G4. default privileges that would also grant the new functions to another role" "Q03 the six functions are 022's"
clone upg_g5
(rc=0; APPLY upg_g5 || rc=$?; echo "$rc" > "$WORK/upg_g5a.rc") &
(rc=0; APPLY upg_g5 || rc=$?; echo "$rc" > "$WORK/upg_g5b.rc") &
wait
rcs="$(sort "$WORK/upg_g5a.rc" "$WORK/upg_g5b.rc" | tr '\n' ' ')"
[ "$rcs" = "0 3 " ] || fail "G5. two concurrent runs ended with $rcs (expected one 0, one 3)"
[ "$(verdict upg_g5)" = "pre|BLOCKED post|PASS " ] || fail "G5. after: $(verdict upg_g5)"
echo "    G5. two runs at once: one upgraded, the other waited and was refused; post PASS"

# The upgraded database against the registries, the invariant suite, and 022 at work.
if [ -n "$EXTRA_SQL" ]; then PSQLD upg_ok "-q -1 -f $WORK/extra-$(basename "$EXTRA_SQL")"; fi
PSQLD upg_ok "-qAt -f $WORK/catalog.sql -o $WORK/upg_catalog.json"
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-privileges.ts" "$WORK/upg_catalog.json" "$PROFILE" | sed 's/^ */    upgraded: /'
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-money-catalog.ts" "$WORK/upg_catalog.json" | sed 's/^ */    upgraded: /'
PSQLD upg_ok "-v privilege_profile=$PROFILE -f $WORK/inv.sql" > "$WORK/upg_inv.out" 2>&1 \
  || { tail -20 "$WORK/upg_inv.out"; fail "the invariant suite failed on the upgraded database"; }
echo "    upgraded: invariant suite $(grep -A2 'passed | failed' "$WORK/upg_inv.out" | tail -1 | tr -s ' ')"
order_sql() { echo "select $1 from public.trading_orders where client_order_id = '$2'"; }
smoke="$(PSQLD upg_ok "-qAt -c \"$(order_sql "(public.claim_order_for_submission(user_id, id) = id)::text" fixture-open-buy)\"") \
$(PSQLD upg_ok "-qAt -c \"$(order_sql "(not public.cancel_order(user_id, id))::text" fixture-open-buy)\"") \
$(PSQLD upg_ok "-qAt -c \"$(order_sql "status::text" fixture-open-buy)\"") \
$(PSQLD upg_ok "-qAt -c \"$(order_sql "public.cancel_order(user_id, id)::text" fixture-open-sell)\"")"
[ "$smoke" = "true true SUBMITTED true" ] || fail "after the upgrade: claim/cancel gave '$smoke'"
echo "    upgraded: an existing OPEN order can be claimed (then the customer's cancel is refused); another is still cancelled by its owner"
