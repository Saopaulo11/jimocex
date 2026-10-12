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
