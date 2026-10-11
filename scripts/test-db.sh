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
AS_PG "$BIN/psql -h $SOCK -d postgres -q -c 'create database $DB'"

PSQL() { AS_PG "$BIN/psql -h $SOCK -d $DB -v ON_ERROR_STOP=1 $*"; }

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

echo "==> invariant suite"
src="$ROOT/supabase/tests/01_invariants.sql"
cp "$src" "$WORK/inv.sql"; chmod 644 "$WORK/inv.sql"
AS_PG "$BIN/psql -h $SOCK -d $DB -v ON_ERROR_STOP=1 -f $WORK/inv.sql"

# The money registry (src/lib/db/money-columns.ts) is checked against the
# catalog of the database the migrations actually built — not against a reading
# of the migration text, which cannot see ALTER TABLE, casing or a column added
# in an unusual way.
echo "==> money registry vs. database catalog"
cp "$ROOT/supabase/tests/02_money_catalog.sql" "$WORK/catalog.sql"; chmod 644 "$WORK/catalog.sql"
AS_PG "$BIN/psql -h $SOCK -d $DB -v ON_ERROR_STOP=1 -qAt -f $WORK/catalog.sql -o $WORK/catalog.json"
node --experimental-strip-types --no-warnings "$ROOT/scripts/check-money-catalog.ts" "$WORK/catalog.json"
