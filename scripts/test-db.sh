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
SOCK="$WORK/sock"

cleanup() {
  AS_PG "$BIN/pg_ctl -D $PGDATA stop -m immediate" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> fresh cluster in $WORK"
rm -rf "$WORK"
mkdir -p "$PGDATA" "$SOCK"
chown -R "$OWNER" "$WORK"
AS_PG "$BIN/initdb -D $PGDATA -A trust --locale=C --encoding=UTF8" >/dev/null
AS_PG "$BIN/pg_ctl -D $PGDATA -o \"-k $SOCK -c listen_addresses=''\" -l $WORK/log start -w" >/dev/null
AS_PG "$BIN/psql -h $SOCK -d postgres -q -c 'create database $DB'"

PSQL() { AS_PG "$BIN/psql -h $SOCK -d $DB -v ON_ERROR_STOP=1 $*"; }

run_file() {
  local src="$1" dst="$WORK/$(basename "$1")"
  cp "$src" "$dst"; chmod 644 "$dst"
  PSQL "-q -f $dst"
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
