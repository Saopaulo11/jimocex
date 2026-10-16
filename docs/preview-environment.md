# Preview environment: an isolated test database and a Vercel Preview (plan)

Status: **a plan.** Nothing described here exists yet: no test database, no Vercel project for this
repository. Every step marked **owner** needs the project owner's explicit go, and nothing here
touches the hosted JimoCex project (`sykhghtlkcrzwaoehlhf`) or its production settings.

## How sure each statement is

The evidence comes from several different sources, and a newly created hosted project is none of them.
New statements carry a tag saying which source they rest on:

| Tag | Meaning |
|---|---|
| **[local]** | verified on throwaway local PostgreSQL clusters (17.10, with stand-ins for Supabase's roles and `auth` schema), or on a local build of the app |
| **[local: libpq 16.15/17.10, Phase 3.3]** | observed with the libpq 16.15 and 17.10 client libraries, called directly with dummy values and without any network connection (Phase 3.3); says nothing about other libpq versions, the network or a server |
| **[local: psql(1) man page 16.15]** | stated in the psql(1) manual page installed with PostgreSQL 16.15 where this was checked; the online PostgreSQL documentation could not be reached from there |
| **[local: static analysis]** | read from the repository's files, the 20 migrations included, without running them |
| **[production, read-only]** | observed on the hosted project with read-only queries (Phase 2.4) |
| **[docs]** | taken from Supabase's documentation as read in Phase 2.4; not tested here |
| **[unverified]** | not established by any source available here; many items stay unknown until a separately authorized test project exists |

A local result does not show that a new hosted project has the same default privileges, RLS behaviour,
Auth triggers, PostgREST configuration, extensions or connection behaviour.

## Why a Preview needs its own database

There is one hosted Supabase project for JimoCex. A Preview that points at it writes there. Anyone who
can open the Preview can make these writes, and a Preview domain changes none of them:
- **Sign-up** creates a row in `auth.users`, and `handle_new_user()` adds a profile.
- **Email confirmation and password reset** send real emails.
- **Row-level updates** the policies allow (own profile name, own notifications) write to production.

A Preview may only use a database that holds no production users and no financial data.

## What the application reads from the environment

Every read of `process.env` in `src/` (Phase 2.2 search, refreshed in Slice 10; of `scripts/`, only the operator CLI `scripts/fund-demo-account.ts` reads the environment, see step 7):

| Variable | Read in | Without it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `src/lib/supabase/server.ts:25`, `browser.ts:34`, `admin.ts:27`, `src/proxy.ts:50` | the server and browser clients throw "… is not set"; the proxy (`src/proxy.ts:56`) skips the session refresh instead of failing. Pages that read the database need it (not tested without it) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `server.ts:26`, `browser.ts:35`, `proxy.ts:51` | the same. Holds the project's public client key (step 8) |
| `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/admin.ts:28` only | `createAdminClient()` throws when called: placing, previewing and cancelling an order, the limit check, a withdrawal request and the admin pages then fail with a generic error. See below |
| `NEXT_PUBLIC_APP_URL` | `src/app/auth/actions.ts:27` (origin of email links), `src/app/layout.tsx:12` (`metadataBase`) | email links use the request's `x-forwarded-host`, then `host`; `metadataBase` stays unset. What that relies on: step 6 |
| `JIMOCEX_MARKET_DATA_PROVIDER` | `src/lib/providers/market-data/index.ts:39` | the brand config decides (`product.demoMarketData`: the labelled demo source when true, `"unavailable"` when false); an unknown name falls back to `"unavailable"` |
| `JIMOCEX_EXECUTION_PROVIDER` | `src/lib/execution/index.ts:33` | `"unavailable"`: no venue; a LIMIT order rests OPEN and never fills. Leave it unset |

`NEXT_PUBLIC_*` values are inlined at build time. They must be set before the Preview is built.

**The service-role key is now needed for trading (Slice 10).** Phase 2.2 found it unused: then, only
`src/lib/engines/limit-engine.ts` imported `admin.ts`, and nothing imported that. That day has passed.
`createAdminClient()` is now called by the order engine (`src/lib/engines/order-engine.server.ts`, which
also runs `checkEligibility()`), the withdrawal request (`src/app/(app)/wallets/actions.ts`), the admin
pages (`src/lib/admin/reads.ts`) and the settlement wiring (`src/lib/settlement/service.server.ts`), all
`server-only`. Without the key, sign-up, sign-in and every read-only page still work; placing, previewing
or cancelling an order does not. As this section always said: only the **test** project's key may ever go
into the Preview environment, never production's, and putting it there is the owner's decision (**Open
decisions**). It stays server-only: never `NEXT_PUBLIC_`, never in client code (Slice 10's client-bundle
scan found no trace of it).

**Never copied into a Preview, in any form:** a production URL or project ref, a database password or
connection string, SMTP credentials, production's service-role or secret key, a JWT secret, an access token.
The Preview gets the test project's URL and its public client key, and — only on the owner's decision —
the test project's service-role key as a server-only variable.

## The test database

### Option A (recommended): a separate Supabase project

#### 1. Owner: create the project

- A project such as `jimocex-preview`, in "Saopaulo11's Org" (Pro plan: an extra project has its own compute cost). Use the production region (`ca-central-1`) and PostgreSQL 17.
- Keep the generated database password in a password manager. It never goes into the repository, a chat, a shell history or Vercel.
- Leave Branching, the GitHub integration and Supabase's Vercel integration off. The Vercel integration writes environment variables into the Vercel project by itself; which environments it writes to was not checked **[unverified]**.
- Supabase's documentation describes a Data API choice when a project is created, and a setting that grants access to new tables and functions in `public` automatically **[docs]**. What a project created now gets is **[unverified]**. Record what was chosen; step 2 reads the result.

#### 2. Read-only, before any migration: what the new project already has

One read-only query, run in either of two ways. Either way, `read_only` must say `on` in its result.
- **In the SQL Editor:** run the SQL text that follows the Bash block and its notes (the block that starts
  with `set transaction read only;`) as `postgres`, the whole text at once. Not the Bash block.
- **From a shell:** open an interactive Bash, fill in the first line of the Bash block below as in step 3,
  and paste the whole Bash block as one piece. It carries the same SQL text inside it, so it needs no file
  and runs from any directory.

```bash
conn='host=<test project host> port=5432 dbname=postgres user=<user> sslmode=require'
[[ ${BASH-} == */bash ]] && "$BASH" -p -s -- "${conn-}" <<'JIMOCEX_STEP2'
{
  set -u
  conn=${1-}
  stop() { echo "STOP: $*" >&2; exit 10; }
  echo "Exported PG variables (names only):"; compgen -e | grep '^PG' || echo "  none"
  case $conn in
    *[!\ ]*) ;;
    *) stop "conn is empty; psql was not started" ;;
  esac
  case $conn in
    -*|*://*|*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) stop "conn is not in the accepted form; psql was not started" ;;
    *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._=\ -]*)
      stop "conn is not in the accepted form (is a <placeholder> left in it?); psql was not started" ;;
  esac
  seen=' '
  IFS=' ' read -r -a pairs <<< "$conn"
  for pair in "${pairs[@]}"; do
    case $pair in
      *=*=*) stop "conn is not in the accepted form; psql was not started" ;;
      host=?*|port=?*|dbname=?*|user=?*|sslmode=?*) ;;
      *) stop "conn may give only host=, port=, dbname=, user= and sslmode=; psql was not started" ;;
    esac
    case $seen in *" ${pair%%=*} "*) stop "conn gives ${pair%%=*}= twice; psql was not started" ;; esac
    seen="$seen${pair%%=*} "
  done
  for key in host port dbname user sslmode; do
    case $seen in *" $key "*) ;; *) stop "conn does not give $key=; psql was not started" ;; esac
  done
  for var in PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGCLIENTENCODING; do
    [ -z "${!var:-}" ] || stop "$var is set; unset it in this shell first; psql was not started"
  done
  sql=$(command mktemp "${TMPDIR:-/tmp}/jimocex-step2.XXXXXXXXXX") || stop "could not create a temporary file; psql was not started"
  trap 'command rm -f -- "$sql"' EXIT
  command cat >| "$sql" <<'JIMOCEX_STEP2_SQL' || stop "could not write the query; psql was not started"
set transaction read only;
select current_setting('server_version') as server_version,
       current_user as connected_as,
       to_regclass('auth.users') is not null as auth_users,
       to_regprocedure('auth.uid()') is not null as auth_uid,
       (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as client_roles,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace) as relations_in_public,
       (select string_agg(pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '(all schemas)') || ' '
                          || d.defaclobjtype::text || ' ' || d.defaclacl::text, E'\n' order by 1)
          from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
         where d.defaclnamespace = 0 or n.nspname = 'public') as default_privileges,
       current_setting('transaction_read_only') as read_only;
JIMOCEX_STEP2_SQL
  command psql -X -1 -v ON_ERROR_STOP=1 -d "$conn" -c 'set transaction read only' -f "$sql"
}
JIMOCEX_STEP2
```

- **What the block checks.** Before `psql` starts, it refuses with exit status 10 and a `STOP:` line (names, never values) when `conn` is empty, when `conn` is not in the form step 3's gate accepts (**The connection**), or when `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGOPTIONS` or `PGCLIENTENCODING` is set and not empty. The gate runs its own checks only inside its own process, and a separate `psql` does not inherit their result; this block repeats them for its `psql`, and also refuses `PGCLIENTENCODING`, which the gate overrides instead. It lists the names of the exported `PG…` variables but does not check the others: handle them as step 3's **Environment** describes.
- **What runs.** The block takes no file name. It writes the SQL text it carries, the same text as the SQL block below, to a new private temporary file and runs it with `-c 'set transaction read only'` before it, in the same transaction (`-1`).
- **The temporary file** (`jimocex-step2.` and ten random characters, in `$TMPDIR` or else `/tmp`) holds only that SQL text, never `conn` or a password. An `EXIT` trap of the new Bash removes it when that Bash exits, after a refusal or an error too **[local]**. A trap cannot run after `kill -9`, a crash of that Bash or a power loss, and other signals were not tested: then the file can be left; delete it by hand. The block removes no other file there.
- **Why the query is inside the block.** `-c 'set transaction read only'` does not make an arbitrary file read-only. With the real `psql` 16.15 and a local PostgreSQL 17.10, a file with a write in it was refused, but a file that began with `set transaction read write;`, or ran `commit;` before writing, still wrote (Phase 3.12, below) **[local]**. So no other file can be handed to this block.
- **Where the checks run.** The lines between `<<'JIMOCEX_STEP2'` and `JIMOCEX_STEP2` are not run by your interactive shell: they are handed, as text, to a new Bash process. That process is not interactive, so it expands no aliases; `-p` keeps it from reading a startup file (`BASH_ENV`), from importing exported shell functions and from taking `SHELLOPTS` from the environment. `conn` reaches it as an argument, and the new Bash never prints `conn` (with `set -x`, your own shell does, in the lines that set it and start that Bash). The script is one `{ … }` group, so a syntax error in it stops the new Bash before any of its commands runs. Inside it, `command` keeps aliases and functions away from `mktemp`, `cat`, `psql` and `rm`; which programs those names find on `PATH` is not checked.
- **How the new Bash is started.** `$BASH` is the path of the Bash you paste the block into. The block's first line runs that path, quoted, only if it ends in `/bash`. A quoted word is not looked up as an alias, and the word is a path, so neither an alias nor a function named `command` or `bash` in your shell can replace it **[local]**. The test before it catches `BASH` set to another program (`/bin/true`, `/bin/echo`, `/bin/sh`, `/usr/bin/bashbug`), empty or unset: then nothing runs, there is no output, and the exit status is 1 **[local]**. It does not prove that the program is Bash. Three things still get past it, and the block checks for none of them: a program that is not Bash at a path ending in `/bash`; a function named after that exact path (for example `/bin/bash`), which replaces the program; an alias named `[[`, which can change the test. `rbash` is refused. In `dash` the line fails before anything runs, with exit status 127 **[local]**. zsh and other shells were not tried.
- **Exit status.** A refusal ends only the new Bash, never your terminal. The block's exit status is:
  - 10 for a refusal, 2 for a syntax error in the script;
  - 1 with no output at all when the first line refuses `$BASH`;
  - 127 when `$BASH` ends in `/bash` but names no program, and in `dash`;
  - otherwise `psql`'s: 1 for a fatal error of `psql` itself, 2 when the connection fails, 3 for an error in the SQL, whose transaction is then rolled back **[local: psql(1) man page 16.15]**; 2 and 3 were also observed (Phase 3.12) **[local]**.

  **An exit status of 0 alone does not show that the query ran.** The result is `psql`'s output: one row, ending in a `read_only` column whose value is `on`. Without that row, step 2 has no result. In a shell running with `set -e`, a non-zero status of the new Bash ends that shell, as it would for any other failing command; a refusal by the first line's test does not.
- **Not proof of the server.** Passing these checks shows only which host the connection names, not which server answers there (step 3, **What it does not check: the database**).

```sql
set transaction read only;
select current_setting('server_version') as server_version,
       current_user as connected_as,
       to_regclass('auth.users') is not null as auth_users,
       to_regprocedure('auth.uid()') is not null as auth_uid,
       (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as client_roles,
       (select count(*) from pg_class where relnamespace = 'public'::regnamespace) as relations_in_public,
       (select string_agg(pg_get_userbyid(d.defaclrole) || ' ' || coalesce(n.nspname, '(all schemas)') || ' '
                          || d.defaclobjtype::text || ' ' || d.defaclacl::text, E'\n' order by 1)
          from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
         where d.defaclnamespace = 0 or n.nspname = 'public') as default_privileges,
       current_setting('transaction_read_only') as read_only;
```

Expected: PostgreSQL 17; connected as `postgres`; `auth_users` and `auth_uid` true; `client_roles` 3;
`relations_in_public` 0. The migrations need no extension: `gen_random_uuid()` is part of PostgreSQL,
and `scripts/test-db.sh` builds all 20 files (001–018, 020, 021) on a bare cluster with none installed **[local]**. 001 creates a
trigger on `auth.users`. Production has one trigger there **[production, read-only]**, but whether a new
project accepts 001's is **[unverified]** until 001 runs there.

**Four different sets of privileges.** They must not be confused:

| | What it is | Status |
|---|---|---|
| What the migrations expect | The migrations grant the client roles no table privilege themselves. Their only `GRANT`s are EXECUTE to `service_role`: on three functions in 017, on `place_limit_order` and `cancel_order` in 018, on `apply_fill` in 020 (021 grants nothing). Table access for `anon`, `authenticated` and `service_role` comes from `postgres`'s default privileges in `public`, and RLS policies narrow it | **[local]**: the repository; the local stand-in `supabase/tests/00_supabase_stubs.sql` sets those defaults itself, so every local result assumes them |
| The new project's defaults | whatever Supabase gives a project created now. Supabase says it is moving the platform default to revoke the automatic grants in `public` **[docs]** | **[unverified]**: the query above shows them |
| Production's defaults | `postgres` in `public`: tables `arwdDxtm`, sequences `rwU`, functions `X`, each for `anon`, `authenticated` and `service_role`. `supabase_admin` in `public`: the same, for objects it creates (N3) | **[production, read-only]**, Phase 2.4; the project was created on 2026-10-10 |
| What 019 and B2 would add | 019 narrows the client roles' table privileges, under its own authorization. B2 would change `postgres`'s own defaults (decision E). Neither is part of the 20 files | `docs/rollout-019.md`; applied nowhere hosted |

017 itself changes `postgres`'s default for functions to EXECUTE for the owner only **[local]**. After
017 that row differs from production's by design; the comparison here is before 001.

Production's rows for `postgres`, as the query prints them:

```
postgres public r {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
postgres public f {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
postgres public S {postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}
```

Production has no `(all schemas)` row **[production, read-only]**.

**A difference blocks the clean install.**
- **What is compared.** `postgres`'s three rows must give the same roles the same privileges as production's (the order of entries may differ).
- **If any row differs** (missing, fewer privileges, a grantee missing or added, an extra `(all schemas)` row), **stop: the clean install is blocked.** The migrations would then build tables with other privileges than production's. The 017 privilege check (step 5) would not match, and the Preview would not test production's privilege model.
- **Do not change the defaults to look like production on your own initiative.** The way forward is the owner's decision, and each option is its own step:
  - a new project created with other settings;
  - a separately authorized, documented ACL change on the test project;
  - accepting a test project whose privileges differ, and saying so in every result taken from it.
- **`supabase_admin`'s rows are a different matter (N3).** On production they exist, and `postgres` cannot change them (`docs/rollout-019.md` §10). They apply only to objects `supabase_admin` creates, not to what the migrations create as `postgres`. Record whether the new project has them. Either way they do not block the install, but they must be named in any comparison with production. `postgres`'s own rows are the ones a project can change (B2).

#### 3. Owner, separate go: apply 001–018, 020 and 021, fail-closed

The gate is a separate Bash script. The block below writes it to a new private file outside the
repository, checks that file against the reviewed sha256, runs it with `bash` as a process of its own,
removes the file, prints the exit status and returns it. The script applies each file in its own transaction (`-1`),
as `postgres`, from a private copy checked against the reviewed hashes. Nothing runs unless every check
passes, and the sequence stops at the first file that does not succeed. Passing the checks is not a
permission: this step needs the owner's separate go.

Before pasting, replace `<test project host>` and `<user>` in the first line with the test project's values
(step 2), and leave the other three keys as they are: the gate accepts these five keys and no others, and
refuses the line while a placeholder is left in it. Open an interactive Bash at the repository root and check
its `PG…` variables first (**Environment**, below). Then paste the whole block into it, as one piece.

```bash
conn='host=<test project host> port=5432 dbname=postgres user=<user> sslmode=require'
gate=$(command mktemp "${TMPDIR:-/tmp}/jimocex-gate.XXXXXXXXXX")
command cat >| "$gate" <<'JIMOCEX_GATE'
# JimoCex migration gate: applies supabase/migrations 001-018, 020, 021 to the test project, from a checked
# private copy. Run it only as docs/preview-environment.md (Option A, step 3) describes.
set -u
umask 077
shopt -s nullglob dotglob
conn=${1:-}
src=supabase/migrations
work=

# A refusal before the first psql call: nothing was applied. Exit status 10.
stop() { echo "STOP: $*" >&2; echo "Nothing was applied. Do not edit this script to get past a refusal." >&2; exit 10; }
# On every exit, also after HUP, INT or TERM: keep the exit status, then remove the private copy.
# HUP, INT and TERM are ignored from here on, and rm inherits that, so a repeated signal can neither
# interrupt the removal nor replace the saved status.
cleanup() {
  rc=$?
  trap '' HUP INT TERM
  trap - EXIT
  case $work in
    */jimocex-migrations.*)
      if [ -d "$work" ] && [ ! -L "$work" ] && [ -O "$work" ]; then
        command rm -rf -- "$work" || echo "WARNING: could not remove $work. Delete it by hand." >&2
      fi ;;
  esac
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
echo "gate running as pid $$; stop it with Ctrl-C or: kill -INT $$"

# The approved files, in the order they run. Only these run; nothing found on disk is ever run.
approved=(
  001_initial_schema.sql
  002_account_tiers.sql
  003_assets_pairs.sql
  004_wallets_ledger.sql
  005_orders_trades.sql
  006_swaps.sql
  007_deposits_withdrawals.sql
  008_fees_kyc_risk.sql
  009_audit_idempotency_events.sql
  010_rls.sql
  011_seed_reference_data.sql
  012_harden_functions.sql
  013_account_status_restricted.sql
  014_limit_usage.sql
  015_tier0_exchange_trade_limits.sql
  016_money_functions_return_text.sql
  017_money_integrity.sql
  018_order_placement.sql
  020_fill_settlement.sql
  021_enable_demo_trading.sql
)
# The reviewed sha256 of each: "<file> <sha256>", in the same order. It adds nothing to what runs.
manifest=(
  "001_initial_schema.sql 4b0b064ff93c2a2f63902469672b8715a5bf3a6439bb494e550b776dba355406"
  "002_account_tiers.sql 7f9a1ca37123afabf6634890317995e80d5052eb777927d779bb432fe9e655a0"
  "003_assets_pairs.sql e7154230a98bf5fd132eb9844b33d68bbf74f3f4fc913a75e8ffd3c079bbc667"
  "004_wallets_ledger.sql b73b69bb4ce4c5d05006ba030000292a4d96497bf1cb41f653c872fb25a9fc0c"
  "005_orders_trades.sql da7930b74d543ebaad6119536086c19c78f02377fb5b06e3957d82e59bd23a2f"
  "006_swaps.sql ae44942f3dca74b5c72500fd16acab72b2142dac58f301a1e06d10194196e616"
  "007_deposits_withdrawals.sql e74268d25eb565c355771780e50f8f6ed0c55c88bc9a53a0598981c55085c6bf"
  "008_fees_kyc_risk.sql 89cc20f01eedf4655eeb63995f40d8bca9e546270fe39f8a8a7cb57d9e5c7e10"
  "009_audit_idempotency_events.sql fb5420be73782d7e939305a31caf3ae58b1d2c0396e4a1fc422e80b3bdd1eaa5"
  "010_rls.sql 97b4f6192e939c4418b7dec146e653da2dfff054c7676d74d15b2a470e9b5521"
  "011_seed_reference_data.sql c6f9f9a9cdae77e7bc2022234049cbd8aae9da281e06784395c4ab3e321b9112"
  "012_harden_functions.sql 586df2043df26519a566af9af69f6a70293a3c018659cb2bd57597b4d7df2644"
  "013_account_status_restricted.sql 89ea66522bf0389b9ef418b204d8a7bb82c0b415e993371ec746487f3a99ab96"
  "014_limit_usage.sql e9fac1b572f76fe13aeade6f8b8b3d04bd2e24e2a45eb955f3ffe6eb4c60e388"
  "015_tier0_exchange_trade_limits.sql 79eb3ee9a78a68c6c9af183b2d2777019cd0de44936b4a97feaee10d6d2c904f"
  "016_money_functions_return_text.sql 73d599bbcc9484e369c073e8a4134504fd8e17d8b4df9ead11e984d2385111cf"
  "017_money_integrity.sql efbc5be4286992df8f490928a8915a83c125e4d1929f3dd00c708e4bbe6b431f"
  "018_order_placement.sql 8a08ab96f0be351b4dd47e74452196d9377080a0c0029ddf06ae71bcf782f49f"
  "020_fill_settlement.sql 76d856b38be503d2cbf612a69ca6264d8855d50d58a36a69bc9e476701cfff3a"
  "021_enable_demo_trading.sql e7b154ea7358959bdc1bbec99b25c838f83731567e3c792b74e67dd39577d2cc"
)

# True only for exactly 64 characters from 0-9 and a-f. An empty value never passes.
is_sha256() { case $1 in *[!0123456789abcdef]*) return 1 ;; esac; [ "${#1}" -eq 64 ]; }
# Prints the sha256 of one file. Fails if sha256sum fails or prints anything but "<sha256>  -".
sha256_of() {
  out=$(command sha256sum < "$1") || return 1
  sum=${out%% *}
  { [ "$out" = "$sum  -" ] && is_sha256 "$sum"; } || return 1
  printf '%s\n' "$sum"
}
# $1 must be a regular file, not a symlink, whose sha256 is $2.
check_file() {
  { [ -f "$1" ] && [ ! -L "$1" ]; } || stop "missing, or not a regular file: $1"
  got=$(sha256_of "$1") || stop "could not compute the sha256 of $1"
  [ "$got" = "$2" ] || stop "$1 is not the reviewed text"
}
# $1 must be a directory, not a symlink, holding approved names only (hidden entries included).
check_dir() {
  { [ -d "$1" ] && [ ! -L "$1" ]; } || stop "$1 is not a directory here; run this from the repository root"
  for path in "$1"/*; do
    found=no
    for a in "${approved[@]}"; do [ "${path##*/}" = "$a" ] && found=yes; done
    [ "$found" = yes ] || stop "unexpected entry in $1: ${path##*/}"
  done
}

# 1. The connection: the first argument, in the one form this step supports: host=, port=, dbname=,
#    user= and sslmode=, each exactly once, as key=value pairs separated by spaces, the values made of
#    letters, digits, '.', '_' and '-'. Anything else is refused. The value itself is never printed.
case $conn in
  *[!\ ]*) ;;
  *) stop "no connection given: pass the test project's connection as the first argument" ;;
esac
case $conn in
  -*) stop "the connection must not start with '-'" ;;
  *://*) stop "give the connection as key=value pairs (host=... user=...), not as a URI" ;;
  *[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) stop "the connection must not contain a password" ;;
  *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._=\ -]*)
    stop "the connection may contain only letters, digits, '.', '_', '-', '=' and spaces (is a <placeholder> left in it?)" ;;
esac
IFS=' ' read -r -a pairs <<< "$conn"
seen=' '
for pair in "${pairs[@]}"; do
  case $pair in
    *=*=*) stop "a value in the connection must not contain '='" ;;
    host=?*|port=?*|dbname=?*|user=?*|sslmode=?*) ;;
    *) stop "the connection may give only host=, port=, dbname=, user= and sslmode=, each with a value" ;;
  esac
  key=${pair%%=*}
  case $seen in *" $key "*) stop "the connection gives $key= more than once" ;; esac
  seen="$seen$key "
done
for key in host port dbname user sslmode; do
  case $seen in *" $key "*) ;; *) stop "the connection does not give $key=" ;; esac
done

# 2. The environment. Set, these would let libpq connect elsewhere than host= says (PGHOSTADDR), fill in
#    parameters from a service file (PGSERVICE, PGSERVICEFILE), or change the session's server settings
#    (PGOPTIONS). They must be empty. Only the name is printed, never the value.
for var in PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS; do
  [ -z "${!var:-}" ] || stop "$var is set in the environment: unset it in this shell, then paste the block again"
done

# 3. The tools are on PATH. `command` below ignores shell aliases and functions of the same name.
for tool in sha256sum mktemp cp rm psql; do
  type -P "$tool" >/dev/null || stop "$tool not found on PATH"
done

# 4. The lists: 20 approved files; manifest entry n is exactly "<approved file n> <sha256>".
[ "${#approved[@]}" -eq 20 ] || stop "the approved list has ${#approved[@]} entries, not 20"
[ "${#manifest[@]}" -eq 20 ] || stop "the manifest has ${#manifest[@]} entries, not 20"
want=()
for i in "${!approved[@]}"; do
  sum=${manifest[$i]#* }
  { [ "${manifest[$i]}" = "${approved[$i]} $sum" ] && is_sha256 "$sum"; } \
    || stop "manifest entry $((i + 1)) is not '${approved[$i]} <64 characters 0-9a-f>'"
  want+=("$sum")
done

# 5. The working tree: the approved files and nothing else, each with its reviewed sha256.
check_dir "$src"
for i in "${!approved[@]}"; do check_file "$src/${approved[$i]}" "${want[$i]}"; done

# 6. A private copy: a new directory (mode 0700), the 20 files copied without following
#    symlinks, then the same checks again on the copy.
work=$(command mktemp -d "${TMPDIR:-/tmp}/jimocex-migrations.XXXXXXXXXX") || stop "could not create a temporary directory"
{ [ -d "$work" ] && [ ! -L "$work" ] && [ -O "$work" ]; } || stop "not a private directory: $work"
for name in "${approved[@]}"; do
  command cp -P -- "$src/$name" "$work/$name" || stop "could not copy $name"
done
check_dir "$work"
for i in "${!approved[@]}"; do check_file "$work/${approved[$i]}" "${want[$i]}"; done

# 7. Apply the checked copies in the approved order. The first psql that does not exit 0 ends the sequence.
#    All options come first and the connection is the value of -d, so it is never read as an option.
#    The files are UTF-8 and contain non-ASCII text: PGCLIENTENCODING=UTF8 keeps the operator's
#    environment and locale from changing how psql sends it.
for name in "${approved[@]}"; do
  echo "applying $name"
  PGCLIENTENCODING=UTF8 command psql -X -q -1 -v ON_ERROR_STOP=1 -d "$conn" -f "$work/$name"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "STOP after $name: psql exited $rc. It failed, or its outcome is unknown." >&2
    echo "Do not run it again and do not run the next file. Establish the state with the read-only diagnostics in step 4 first." >&2
    exit "$rc"
  fi
done
echo "All 20 files ran. The schema is NOT verified until the read-only checks of step 5 pass."
JIMOCEX_GATE
{ if [ -n "$gate" ] && [ "$(command sha256sum < "$gate")" = "a6178a03e4baa5b6f448a363e0ef6ec2cd334afbc7102e8408ab6521bf4ed284  -" ]; then
    BASH_ENV= command bash "$gate" "$conn"; status=$?
  else
    echo "STOP: the gate file is missing or is not the reviewed text. Nothing was run." >&2; status=10
  fi
  command rm -f -- "$gate"; echo "exit status: $status"; (exit "$status"); }
```

- **Why a separate script.** Pasted as a `( … )` subshell into an interactive Bash, Bash 5.2 skipped the `INT` trap when `psql` handled Ctrl-C and exited 0, and the next file ran (Phase 2.9). Run as its own `bash` process, the gate's traps belong to the process that receives the signal (Phase 3.0, below).
- **Shell.** The gate itself always runs under Bash (`bash "$gate"`). The lines around it were tested only in an interactive Bash 5.2; zsh, Bash 3.2 and macOS are not tested. If the paste is altered on the way (by the shell, the terminal or an editor), the sha256 check refuses to run it.
- **Trusted environment.** Run this gate, and steps 2 and 5, only in a controlled environment with a trusted toolchain. The gate finds every external command it runs — `bash`, `sha256sum`, `mktemp`, `cp`, `rm`, `psql`, and in step 5 `git`, `mv` and `node` — through `PATH`, and it does not prove any of them is genuine; `command` only keeps your shell's aliases and functions away, not a program planted earlier on `PATH`. A substituted `node`, `git`, `psql`, `sha256sum` or `bash` can make a step report success while doing nothing of the kind, or run altered code: for example a `node` ahead on `PATH` that merely exits 0 makes step 5 print `RESULT` though no checker ran **[local, Phase 3.17/3.18]**. Printing a resolved path (`command -v node`) or a tool's version can help you confirm your own environment, but a hostile program answers those the same way a real one would, so neither proves authenticity — and neither does pinning an absolute path, which a compromised system can still redirect. Treat the gate as sound only on a machine you trust, with the real tools first on `PATH`; it is **not** safe against a hostile `PATH`, a compromised system or an untrusted toolchain, and nothing in the document can make it so. This is a precondition on your shell, not a guarantee the gate provides.
- **Where and how.** From the repository root, in the foreground of a terminal: not in the background (`&`), not under `nohup` or `setsid`. Bash cannot trap a signal that was already ignored when it started, so such a run would not stop on that signal. `BASH_ENV=` keeps a startup file from running before the gate; `command` keeps shell aliases and functions out.
- **The connection** is the gate's first argument, taken from `conn` in the first line. The gate accepts one form only: `host=`, `port=`, `dbname=`, `user=` and `sslmode=`, each exactly once, as `key=value` pairs separated by spaces, the values made of letters, digits, `.`, `_` and `-`. This is a deliberately narrow subset of libpq's connection strings, not a general one. It refuses, with exit 10 and without printing the value: an empty connection; one starting with `-`; a URI (`://`); `password` in any spelling; any other character (quotes, tabs, line breaks, `,`, `:`, `<` …, so also a placeholder left in the first line); a key that is missing, repeated or not one of the five (`hostaddr`, `service`, `options` …); an empty value, or one containing `=`. So the connection names exactly one host. `psql` receives it as the value of its `-d` option, which accepts a connection string **[local: psql(1) man page 16.15]**. Every other argument the gate passes is an option or an option's value (`-X -q -1 -v ON_ERROR_STOP=1 … -f <checked copy>`), and there is no positional argument; the man page's synopsis is `psql [option...] [dbname [username]]` **[local: psql(1) man page 16.15]**. A connection starting with `-` is refused before any `psql` call.
- **Environment.** `psql` inherits the exported variables of the shell the block is pasted into. `compgen -e | grep '^PG'` lists their names, not their values. The gate checks only its own environment, which its `psql` calls inherit: this covers the 20 `psql` calls of this step and no other command. The libpq observations below were made with the two libpq versions named and are not claimed for other versions. The gate treats the variables as follows:
  - *Refused* (exit 10; the name is printed, never the value) when not empty:
    - `PGHOSTADDR`: with `host=` given, libpq still used this address for the connection **[local: libpq 16.15/17.10, Phase 3.3]**.
    - `PGSERVICE`: libpq took `hostaddr` and `options` from the named entry of the service file, while the connection's five keys kept their values **[local: libpq 16.15/17.10, Phase 3.3]**.
    - `PGSERVICEFILE`: it names the service file. Without a service name, no effect of it was observed **[local: libpq 16.15/17.10, Phase 3.3]**. Refusing it is a conservative limit, not evidence that it redirects a connection.
    - `PGOPTIONS`: libpq passes it on as the connection's `options` **[local: libpq 16.15/17.10, Phase 3.3]**; that the server applies it as settings for the session is **[unverified]**.
  - *Overridden.* `PGHOST`, `PGPORT`, `PGDATABASE` and `PGUSER` are default connection parameters **[local: psql(1) man page 16.15]**. With all five keys in the connection, libpq kept the connection's values over these four and over `PGSSLMODE` **[local: libpq 16.15/17.10, Phase 3.3]**. The client encoding: every `psql` of the gate runs with `PGCLIENTENCODING=UTF8`, which also replaces the encoding `psql` would otherwise take from the terminal's locale **[local: psql(1) man page 16.15]**. The 20 files are valid UTF-8. 19 hold non-ASCII characters in comments (021 is plain ASCII); 15 of 001–017 also in string literals or function bodies that the database stores, and 018 and 020 in one comment line each inside a stored function body (`—`, `§`) **[local: static analysis]**. What the server would make of these bytes under another client encoding is **[unverified]**. For the database's own encoding, see **Database encoding** below.
  - *Not checked:* every other `PG…` name the command lists. Unset it (`unset NAME`) unless you know why it is set. `PGPASSWORD` above all: libpq takes the password from it without asking **[local: libpq 16.15/17.10, Phase 3.3]**, which breaks the **Password** rule below. With the others set at once (`PGPASSWORD`, `PGPASSFILE`, `PGCHANNELBINDING`, `PGREQUIREAUTH`, `PGREQUIREPEER`, the `PGSSL…` variables, `PGGSSENCMODE`, `PGGSSDELEGATION`, `PGKRBSRVNAME`, `PGTARGETSESSIONATTRS`, `PGLOADBALANCEHOSTS`, `PGCONNECT_TIMEOUT`, `PGAPPNAME`, `PGSYSCONFDIR`, `PGLOCALEDIR`, `PGTZ`, `PGDATESTYLE`, `PGGEQO`), libpq still passed on the connection's host, port, database, user and `sslmode`, with no `hostaddr` and no `options` **[local: libpq 16.15/17.10, Phase 3.3]**. That covers the parameters libpq passes on, not authentication, encryption or the network: what each of these variables changes there is **[unverified]**. `PGTZ`, `PGDATESTYLE` and `PGGEQO` would set session settings **[unverified]**; no statement of the 20 files depends on them while the files run: they hold no date or timestamp literals, no `timestamp` without time zone and no date conversions **[local: static analysis]**.
- **Before the first `psql` call**, in this order. Any failure exits 10, and nothing is applied:
  1. the gate file is the reviewed text (the sha256 in the block);
  2. the connection has the one accepted form (**The connection**);
  3. `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE` and `PGOPTIONS` are empty (**Environment**);
  4. `sha256sum`, `mktemp`, `cp`, `rm` and `psql` are on `PATH`;
  5. the approved list has 20 files, and manifest entry *n* is exactly `<approved file n> <sha256>`. The manifest only supplies hashes: it cannot add, remove or reorder what runs;
  6. `supabase/migrations` is a real directory holding the approved files and nothing else (hidden entries, subdirectories and symlinks are refused), each a regular file with its reviewed sha256;
  7. `mktemp -d` creates a new private directory (mode 0700, owned by you), the 20 files are copied into it without following symlinks, and the copy passes the same checks again.

  A sha256 passes only if the expected and the computed value are both exactly 64 characters from `0-9a-f`, and equal. A missing or failing `sha256sum`, empty output, output in another form, or a damaged manifest entry is a refusal, never a pass.
- **While applying.** Each file runs as `PGCLIENTENCODING=UTF8 psql -X -q -1 -v ON_ERROR_STOP=1 -d <connection> -f <checked copy>`. Every `psql` call reads the checked copy, never the working tree: an edit, a checkout or a pull in the working tree during the run changes nothing that runs. On the first `psql` that does not exit 0, the sequence stops, runs no later file and exits with `psql`'s code. It retries nothing, and uses no `break` and no pipeline whose status could hide a failure.
- **Signals.**
  - *To the gate.* Ctrl-C sends `INT` to the gate and to `psql`; `kill -INT`, `-TERM` or `-HUP` with the pid the gate prints reaches the gate alone. The gate runs no further file. It acts once the running `psql` has exited (signalled alone, that `psql` first finishes its file), then exits 130, 143 or 129. Whether the file that was running committed is unknown.
  - *To `psql` alone.* The gate follows `psql`'s exit status: a non-zero status ends the sequence with that status (128+*n* if `psql` was killed by signal *n*); 0 lets the sequence continue, because the gate itself was not interrupted.
  - *During clean-up.* `HUP`, `INT` and `TERM` are ignored until the private copy is removed (`rm` inherits this), then the saved status is returned. A removal that hangs can only be stopped with `kill -9`; then delete the directory by hand.
  - *`QUIT` (Ctrl-\\).* Not handled. Depending on the terminal session it is ignored, or it ends the gate without clean-up. Stop the gate with Ctrl-C.
  - How the real `psql` reacts to Ctrl-C (cancel request, exit code) is **[unverified]**.
- **Clean-up.** The private copy is removed after success, after a failure, and after `HUP`, `INT` or `TERM`. A failed removal prints a warning and leaves the exit status unchanged. It is not removed automatically after `kill -9`, Ctrl-\ (`QUIT`), a system crash or a power loss, or after a signal in the short window while `mktemp` creates the directory and before its path is recorded. The block removes the gate file after the run; if the terminal closes during the run, the gate still removes its copy, but the gate file stays. Leftovers are `${TMPDIR:-/tmp}/jimocex-migrations.*` and `${TMPDIR:-/tmp}/jimocex-gate.*`; delete them by hand.
- **Exit status**, printed as `exit status: N` and returned by the block itself: `$?` right after the block is the same N, also when a removal failed:
  - `0`: every `psql` exited 0;
  - `10`: refused before the first `psql` call, or the gate file was not the reviewed text; nothing was applied;
  - `psql`'s own code at the file where it stopped: `3` is an SQL error, rolled back; after `1` or `2`, whether that file committed is unknown; 128+*n* if `psql` was killed by signal *n*;
  - `129`, `130` or `143`: the gate received `HUP`, `INT` or `TERM`. Whether the file then running committed is unknown. (`130` is also what a `psql` killed by `INT` returns.)

  After any non-zero status: step 4.
- **What it does not check: the database.** The gate does not check which database the connection reaches. A production connection is neither detected nor blocked by it. Before running it, the operator confirms that `<test project host>` belongs to the authorized test project (its ref in the dashboard, never `sykhghtlkcrzwaoehlhf`), and that step 2 ran on the same connection. The checks on the connection and the environment only keep the parameters libpq passes on to the host that `host=` names **[local: libpq 16.15/17.10, Phase 3.3]**. Which server answers there is decided by DNS, the local hosts file and the network. Whether `sslmode=require` checks the server's certificate against that name is **[unverified]**; this document does not rely on it to identify the server. Nothing in the gate proves, cryptographically or otherwise, that the server is the test project.
- **Database encoding.** The gate sets only the client encoding, to UTF-8. It assumes that the test project's database is UTF-8 as well. That is **[unverified]** for this project, and nothing in this workflow checks it automatically. Before the owner's go for this step, the operator confirms it read-only (for example `show server_encoding;` in the SQL Editor, which should say `UTF8`). If it says anything else, do not run this step.
- **Not a permission.** Passing every check authorizes nothing. Applying the migrations needs the owner's separate go for this step.
- **Limits of the private copy.** It protects the run against ordinary changes to the source files, such as an edit, a checkout or a pull during the run. It does not protect against a changed copy of the gate, against a process running as the same user or as root that changes the private copy after it was checked, or against other deliberate interference with the file system.
- **Changing what runs.** The script, its two lists and its sha256 in the block are part of this reviewed document. Never edit them to get past a refusal: a new or changed migration needs a reviewed update of this document, including a new sha256 of the script.
- **Password.** Never on the command line, in `conn` or in the script. psql asks for it at each file, or reads it from `~/.pgpass` (mode `0600`), removed afterwards.
- **Connection.** `<test project host>` and `<user>` come from the test project's Connect dialog, for its direct connection or its session pooler. These are the two connections that the header of `supabase/drafts/v4/apply_016_017.sql` names ("direct or session-pooler connection"); package v4's `README.md` names none. That both use port 5432, as the template's `port=5432` assumes, is **[unverified]**: if the dialog shows another port for the connection you use, stop and have this document reviewed. How either connection behaves with this sequence is **[unverified]**.
- **Not proof.** "All 20 files ran" says each `psql` exited 0. Whether the schema is right is decided by step 5.
- **Checked so far.** Only the control flow, with a stand-in for `psql` and stand-ins for failing tools; never against a database, and with Bash 5.2 only. The block was pasted into an interactive Bash in a pseudo-terminal. Phase 3.0 checked the previous version of the gate, whose signal handling and clean-up this version keeps unchanged:
  - Normal runs: success, and `psql` failing at 001, 009 and 017, ended with 0, 3, 2 and 1, with no later file run.
  - `INT`, `TERM` and `HUP`, sent while `psql` ran to the gate alone, to its process group, or as Ctrl-C, stopped the sequence at that file with 130, 143 or 129. This includes a `psql` that caught `INT` and exited 0.
  - Sent to `psql` alone, a signal ended the sequence with `psql`'s own status. A `psql` that caught `INT` and exited 0 let the sequence continue.
  - A second `INT`, `TERM` or `HUP` during clean-up neither stopped the removal nor changed the status; the stand-in for `rm` was started with all three ignored. A failing removal kept the status and printed the warning.
  - Every `psql` call received the reviewed content from the private copy. Files and directories placed in `TMPDIR` beforehand, including a `jimocex-migrations.*` decoy and a symlink, were left alone.
  - An altered gate file, a missing, URI or password connection, and the Phase 2.8 refusals ended with 10 before any `psql` call.
  - Ctrl-\\ could not be checked: in this environment, processes started from the interactive Bash had `QUIT` ignored already.

  Phase 3.2 checked the previous, 17-file version, without sending any signal. The `$?` cases pasted the block as above; the others started the gate directly:
  - The block's own `$?` equalled the printed status every time: 0; 3, 2 and 1 from `psql` at 009, 001 and 017, with no later file run; 130 from a stand-in `psql` that exited 130 by itself; 10 for a refused connection, a refused variable and an altered gate file; 3 also when neither the copy nor the gate file could be removed.
  - 35 malformed connections ended with 10 before any `psql` call; in the 32 that carried a marker, the marker never appeared in the output. They were: empty, starting with `-` (`-c select 1`), URIs, `password` in three spellings, keys without values, missing, repeated and other keys (`hostaddr`, `service`, `options`), quotes, tabs, line breaks, `,`, `:`, non-ASCII, `$(…)`, backticks, `;`, `|`, `*`, `\` and the unfilled template line.
  - Five accepted connections (the filled template, the session pooler's `user=postgres.<ref>` form, another key order, extra spaces with `sslmode=verify-full`, and one carrying a marker that never appeared in the output) reached each of the 17 `psql` calls exactly as `-X -q -1 -v ON_ERROR_STOP=1 -d <connection> -f <checked copy>` with `PGCLIENTENCODING=UTF8`; so did the template with `POSIXLY_CORRECT`, or `PGCLIENTENCODING=LATIN1` and other `PG…` variables, exported.
  - `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE` and `PGOPTIONS` were each refused when set; set but empty, they were not.
  - The Phase 2.8 refusals still ended with 10 before any `psql` call, and an edit to the working tree during the run did not reach `psql`.

  Slice 10 changed only the two lists (018, 020 and 021 added, with their sha256), the three counts from 17
  to 20, the header comment and the final message — `diff` of the two scripts shows nothing else — and
  pinned the new script's sha256. Control flow, connection and environment checks, signal handling and
  clean-up are the text Phase 3.0/3.2 checked. Re-checked with a stand-in for `psql`, never a database,
  Bash 5.2, not interactively and without signals **[local]**:
  - The previous gate refused this tree before any `psql` call (exit 10, `unexpected entry in
    supabase/migrations: 018_order_placement.sql`): the documented install had been blocked since 018 was added.
  - The whole block, placeholders filled: the gate file matched the pinned sha256, all 20 files ran in the
    approved order with `PGCLIENTENCODING=UTF8`, `exit status: 0`, and no `jimocex-*` file was left in `TMPDIR`.
    A block whose script lists one more file refused with 10 and ran nothing.
  - The gate itself: `psql` failing at 018 stopped after 18 calls, at 021 after 20, each with 3; an extra
    file (`022_extra.sql`), a hidden entry, an altered 021 and a missing 020 each ended with 10 and no `psql` call.

Not part of this step:
- **Package v4** (`supabase/drafts/v4/apply_016_017.sql`) is for the hosted project only. It is built for production's exact 015 state, refuses anything else and writes production's history rows. It is never the way to install a new project.
- **019** (`supabase/drafts/019_table_privileges.sql`) is not part of the 20 files. Only if the owner decides, under its own authorization, after `sha256sum -c` (as `npm run test:db:019` does locally).
- **History rows.** The sequence writes none to `supabase_migrations.schema_migrations`. Writing them is DML and needs its own decision.
- **Reference data** comes from the migrations (011, 015, and 021's three trading flags). Nothing is copied from production.
- **Demo trading.** 021 enables LIMIT orders on BTC-USDT, ETH-USDT and SOL-USDT only; the other 13 pairs stay disabled, no pair swaps, and no execution provider is connected, so an order is reserved and can be cancelled but never fills, and nothing is settled. A demo balance is a separate step (step 7).

#### 4. If the sequence stops, or its outcome is unclear

**Never run a migration again because the client timed out, the connection dropped or the output is
unclear.** Stop, and establish the database's actual state read-only first.

Re-running a file that has already committed is not harmless. Observed **[local]**, on PostgreSQL 17.10
clusters built from 001–017 with the stand-ins (Phase 2.4). Each re-run used `psql -1 -v ON_ERROR_STOP=1`
inside a transaction that was then rolled back. Each file was re-run right after it had committed, and
again on the finished 017 state:

| Re-run of | Observed |
|---|---|
| `001_initial_schema.sql` … `010_rls.sql`, `014_limit_usage.sql`, `017_money_integrity.sql` | failed on the first object that already existed; rolled back, nothing changed |
| `011_seed_reference_data.sql`, `012_harden_functions.sql`, `013_account_status_restricted.sql` | succeeded without changing anything: catalog fingerprint and every table's rows identical |
| `015_tier0_exchange_trade_limits.sql` | succeeded; same limit values, but `updated_at` changed on the six TIER_0 SWAP/TRADE rows (trigger `tier_limits_touch`) |
| `016_money_functions_return_text.sql` | right after 016: no change. **On the 017 state: succeeded and silently replaced 017's `reconcile_wallets()` with 016's (other body and comment), and removed `service_role`'s EXECUTE on it** |
| `018_order_placement.sql`, `020_fill_settlement.sql` | Slice 10, on the finished 021 state: succeeded without changing anything: every function in `public` kept its definition and its privileges |
| `021_enable_demo_trading.sql` | Slice 10, on the finished 021 state: succeeded; the trading and swap flags of all 16 pairs unchanged, but `updated_at` moved on the three demo pairs (trigger `trading_pairs_touch`) |

The Slice 10 rows were observed on PostgreSQL 16.15 built from the 20 files on Supabase Auth v2.177.0's own
`auth` schema, each re-run inside a transaction that was rolled back. These are local observations, not a guarantee for any hosted configuration. They are why no step here
re-runs anything.

Read-only diagnostics:
- **A file either committed entirely or not at all.** It runs in one transaction (`-1`), and no migration contains its own `BEGIN` or `COMMIT` **[local]**. Only a lost connection can hide which.
- **Did the file that was running commit?** Check, read-only, for what it creates: `to_regclass('public.<table>')`, `to_regtype('public.<type>')`, `to_regprocedure('public.<function>(<argument types>)')`. Three files change data only **[local]**:
  - `011`: `select count(*) from public.trading_pairs` gives 16 after it, 0 before;
  - `015`: `select max_amount from public.tier_limits where tier_code = 'TIER_0' and operation = 'SWAP' and window_kind = 'SINGLE'` gives 5000 after it, 2000 before;
  - `021`: `select count(*) from public.trading_pairs where trading_enabled` gives 3 after it, 0 before. If one of its three pairs is missing it refuses and changes nothing (`021: expected the pairs …, found 2 of them`, observed in Slice 10).

  And functions mark 016, 017, 018 and 020 (from the files' text):
  - after `016`, no function `public.limit_usage_in_window` exists;
  - after `017`, `public.limit_usage_total` exists;
  - after `018`, `public.place_limit_order` and `public.cancel_order` exist;
  - after `020`, `public.apply_fill` exists.
- **Then** continue with the first file that has not committed, under the owner's go, once the cause of the stop is known.
- **If the state cannot be established,** a new, empty test project is cleaner than repairing this one (owner decision; this project holds no data).

#### 5. Read-only: verify the schema and privileges

Completing step 3 is not proof of a valid schema. These checks are:

```bash
[[ ${BASH-} == */bash ]] && "$BASH" -p -s -- "${conn-}" <<'JIMOCEX_STEP5'
{
  set -u
  conn=${1-}
  stop() { echo "STOP: $*" >&2; exit 10; }
  for var in NODE_OPTIONS NODE_COMPILE_CACHE; do
    [ -z "${!var:-}" ] || stop "$var is set; unset it in this shell first; nothing was done"
  done
  unset GIT_DIR GIT_WORK_TREE; export GIT_NO_REPLACE_OBJECTS=1
  inputs=(supabase/tests/02_money_catalog.sql scripts/check-privileges.ts scripts/privilege-check.ts
          scripts/privilege-registry.ts scripts/check-money-catalog.ts src/lib/db/money-columns.ts)
  top=$(command git rev-parse --show-toplevel 2>/dev/null) || stop "git found no working tree here; nothing was done"
  [ "$top" = "$(pwd -P)" ] || stop "run this block at the top of the repository; nothing was done"
  commit=$(command git rev-parse -q --verify HEAD) || stop "HEAD names no commit here (no commit made yet?); nothing was done"
  for f in "${inputs[@]}"; do
    p=$f; while [ ! -L "$p" ] && [ "$p" != "${p%/*}" ]; do p=${p%/*}; done
    [ -f "$f" ] && [ ! -L "$p" ] || stop "$f is missing, not a regular file, or reached through a symbolic link; nothing was done"
    entry=$(command git ls-tree "$commit" -- "$f") && blob=$(command git hash-object --no-filters -- "$f") \
      && [ "${entry%%$'\t'*}" = "100644 blob $blob" ] || stop "$f is not, byte for byte, a regular file of commit $commit; nothing was done"
  done
  echo "Commit: $commit"
  command rm -f -- catalog.json || stop "could not remove catalog.json from an earlier run"
  echo "Exported PG variables (names only):"; compgen -e | grep '^PG' || echo "  none"
  case $conn in
    *[!\ ]*) ;;
    *) stop "conn is empty; psql was not started" ;;
  esac
  case $conn in
    -*|*://*|*[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]*) stop "conn is not in the accepted form; psql was not started" ;;
    *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._=\ -]*)
      stop "conn is not in the accepted form (is a <placeholder> left in it?); psql was not started" ;;
  esac
  seen=' '
  IFS=' ' read -r -a pairs <<< "$conn"
  for pair in "${pairs[@]}"; do
    case $pair in
      *=*=*) stop "conn is not in the accepted form; psql was not started" ;;
      host=?*|port=?*|dbname=?*|user=?*|sslmode=?*) ;;
      *) stop "conn may give only host=, port=, dbname=, user= and sslmode=; psql was not started" ;;
    esac
    case $seen in *" ${pair%%=*} "*) stop "conn gives ${pair%%=*}= twice; psql was not started" ;; esac
    seen="$seen${pair%%=*} "
  done
  for key in host port dbname user sslmode; do
    case $seen in *" $key "*) ;; *) stop "conn does not give $key=; psql was not started" ;; esac
  done
  for var in PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGCLIENTENCODING; do
    [ -z "${!var:-}" ] || stop "$var is set; unset it in this shell first; psql was not started"
  done
  tmp=$(command mktemp catalog.json.XXXXXXXXXX) || stop "could not create a temporary file"
  trap 'command rm -f -- "$tmp"' EXIT
  command psql -X -q -At -1 -v ON_ERROR_STOP=1 -d "$conn" \
    -c 'set transaction read only' -f supabase/tests/02_money_catalog.sql >| "$tmp" || exit
  [ -s "$tmp" ] || stop "psql exited 0 but wrote no catalog; no checker was run"
  command mv -f -- "$tmp" catalog.json || exit
  command node --experimental-strip-types scripts/check-privileges.ts catalog.json 017 || exit
  command node --experimental-strip-types scripts/check-money-catalog.ts catalog.json || exit
  echo "RESULT: both checkers matched the catalog of this run (commit $commit)."
}
JIMOCEX_STEP5
```

- **Where to run it.** At the top of the repository, in the Bash in which step 3's block ended with `exit status: 0`, so that `conn` still holds the connection the gate accepted. In another Bash, first set `conn` exactly as the first line of that block.
- **The repository.** Before it touches anything, `catalog.json` included, the block checks the following and stops with 10, naming what failed, at the first that does not hold:
  - the current directory is the top of a Git working tree;
  - `HEAD` names a commit (a repository or branch with no commit yet gets its own message);
  - each of the six files this run reads (the catalog query and the checkers with the files they load: `supabase/tests/02_money_catalog.sql`, `scripts/check-privileges.ts`, `scripts/privilege-check.ts`, `scripts/privilege-registry.ts`, `scripts/check-money-catalog.ts`, `src/lib/db/money-columns.ts`) is a regular file, neither a symbolic link nor reached through one, and that commit holds it as a regular file (mode `100644`) with the same bytes.

  It then prints that commit: record it with the result. The block needs `git` on `PATH`.
- **What the repository check does not show.** It shows which commit's query and checkers ran, not that this is the JimoCex repository or the reviewed commit. A repository made to look like this one, with its own commit, passes it too **[local]**. Compare the printed commit with the commit the owner named for this run: the block does not know that commit.
- **How the files are compared.** Byte for byte with the commit (`git hash-object --no-filters` against `git ls-tree`), not through Git's index:
  - neither the index nor `.gitattributes` filters play a part, so a checkout whose line endings Git converted (`core.autocrlf`) is refused **[local]**;
  - nor do file modes in the working tree: a file whose only change is its executable bit, which is how a file system without such bits can look to Git, passes **[local: simulated with `chmod +x`; no such file system was tested, nor macOS]**. That bit does not change what `psql -f` and `node` read, and the commit's own mode must still be `100644`;
  - symbolic links are refused, also a linked directory on the way to a file: `node` resolves a checker's imports from where the link points, not from this repository **[local]**.
- **Git's environment.** The block ignores `GIT_DIR` and `GIT_WORK_TREE` from your shell. It sets `GIT_NO_REPLACE_OBJECTS=1`, because a replacement ref (`git replace`) can make a commit show files that are not its own **[local]**. It leaves other `GIT_…` variables and Git's configuration as they are. In the Phase 3.14 tests (git 2.43.0), none of the following made it accept a file whose bytes differ from the commit, and no command named in a configuration ran **[local]**:
  - `GIT_INDEX_FILE` naming another index, `GIT_COMMON_DIR` naming another repository, `GIT_NAMESPACE`;
  - `GIT_OBJECT_DIRECTORY` or `GIT_ALTERNATE_OBJECT_DIRECTORIES` naming a directory that holds a forged tree;
  - `core.fileMode`, `core.checkStat`, `core.fsmonitor`, `core.autocrlf` or a clean filter, each set through `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS` and `GIT_CONFIG_GLOBAL`.
- **Node.js.** First of all, before the repository check, before `catalog.json` is touched and before `psql` starts, the block stops with 10 when `NODE_OPTIONS` or `NODE_COMPILE_CACHE` is set and not empty (the `STOP:` line names the variable, never its value). `node` reads both at every start, so they would reach both checkers. With Node.js 22.22.0 and the real first checker, on a catalog that did not match **[local]**:
  - a module loaded through `NODE_OPTIONS` (`--import`, `--require` or `--experimental-loader`) ran before the checker, and when it ended the process with 0, so did `node`, without the checker having run; with the Phase 3.14 form of this block, that printed `RESULT`;
  - `NODE_OPTIONS=--experimental-default-type=commonjs` alone made `node` exit 0 without running the checker;
  - a directory prepared beforehand and named by `NODE_COMPILE_CACHE` made the unchanged checker exit 0 without running (Phase 3.15). A cache that Node itself filled during normal runs changed no result (Phase 3.16). The block cannot tell the two apart, so it refuses the variable whatever the directory holds.

  An empty value of either changed nothing. **Every other value of `NODE_OPTIONS` is refused, a harmless one such as `--max-old-space-size=4096` included.** Node applies these options before the checker runs, and letting harmless ones through would mean reproducing Node's own reading of the variable: a harmless option followed by `--require`, or `--require` with a quoted path containing spaces, still loaded a module that ended the process with 0 **[local]**. Nothing in step 5 needs `NODE_OPTIONS` or `NODE_COMPILE_CACHE`: run `unset NODE_OPTIONS NODE_COMPILE_CACHE` in the shell first. Not every Node.js variable carries this risk; the next item lists those tested.
- **What the Node.js check does not cover.**
  - `NODE_PATH` is not checked. The checkers import only `node:` modules and files by relative path, which `NODE_PATH` does not affect: with it naming modules that end the process, the checkers still ran and failed on that catalog **[local]**. `NODE_REPL_EXTERNAL_MODULE`, `NODE_PRESERVE_SYMLINKS` and `NODE_CHANNEL_FD` did not change the result either **[local]**; Node's other variables were not tested.
  - `NODE_DISABLE_COMPILE_CACHE` is not checked: it only turns the compile cache off. Through this block, with it set to `1`, `0` or empty, the real checkers matched a local 017 catalog with one `RESULT`, failed without `RESULT` on a catalog that did not match and on output that was not JSON, and an edited checker was still refused **[local]**. Other values, other combinations and other Node.js versions were not tried.
  - `package.json` is not one of the six checked files, yet Node reads the nearest one above each checker to decide how to load it: the repository's own or, if that is missing, one in a directory above the repository. Through this block, `package.json` missing, malformed, declaring `"type": "commonjs"` (also as an untracked `scripts/package.json` or `src/package.json`, or in a directory above a repository without one), `"type": "module"`, an unknown type, or an `"imports"` map either let the checkers run as usual or made them fail with their own error and no `RESULT`; none made them exit 0 without running **[local]**. Such a failure is a stop: restore `package.json` from the commit.
  - It does not show that `node` is genuine. `command node` runs the first `node` on `PATH`, and whatever program has that name decides what the checkers report, as for `git` and `psql`; check `command -v node` yourself if in doubt. A `node` earlier on `PATH` that merely exits 0 makes the block print `RESULT` although no checker ran **[local]**. The block cannot close this: a machine-agnostic document has no trusted path to pin to, and the whole runbook — step 3's gate included — already trusts the `PATH` that reaches it (the same holds for `git`, `psql`, `sha256sum`, `mktemp`, `node`). It is a precondition on the operator's shell, not a check the block can make; the limitation remains for that reason.
  - **Run step 5 only when** `NODE_OPTIONS` and `NODE_COMPILE_CACHE` are unset or empty, `command -v node` names the Node.js you expect (these tests used 22.22.0 only), and `package.json` is the committed one. The block checks only the first of these.
- **What the block checks.** Before `psql` starts, it refuses with exit status 10 and a `STOP:` line (names, never values) when `conn` is empty, when `conn` is not in the form step 3's gate accepts (**The connection**), or when `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGOPTIONS` or `PGCLIENTENCODING` is set and not empty. These repeat the gate's checks for this `psql`, which does not inherit the gate's result, and also refuse `PGCLIENTENCODING`, which the gate overrides instead. The block lists the names of the exported `PG…` variables but does not check the others: handle them as step 3's **Environment** describes.
- **Where the checks run.** As in step 2: after the same test of `$BASH`, the block starts the new Bash as `"$BASH"`, which no alias and no function named `command` or `bash` can replace (step 2, **How the new Bash is started**, also for what that test does not catch); the lines between `<<'JIMOCEX_STEP5'` and `JIMOCEX_STEP5` are handed, as text, to that new, non-interactive Bash started with `-p`, so your shell's aliases, its functions (exported or not), `BASH_ENV` and `SHELLOPTS` do not reach them, and a syntax error stops that Bash before any of its commands runs. `conn` reaches it as an argument, and that Bash never prints it. Inside it, `command` keeps aliases and functions away from `git`, `rm`, `mktemp`, `psql`, `mv` and `node`; which programs those names find on `PATH` is not checked.
- **`catalog.json`.** After the repository check, the block removes a `catalog.json` left by an earlier run, also when a later check refuses. `psql` writes to a new temporary file next to it (`catalog.json.` and ten random characters, created by `mktemp`, readable by you only), which becomes `catalog.json` only after `psql` exited 0 and wrote something. If `psql` fails, the temporary file is removed, there is no `catalog.json`, and no checker runs. The second checker runs only if the first succeeded.
- **When a checker fails.** The block keeps this run's `catalog.json`, so that you can see what the checker read, and ends with that checker's status, without a `RESULT` line. Such a file is not a confirmed result.
- **Exit status.** A refusal ends only the new Bash, never your terminal. The block's exit status is:
  - 10 for a refusal or an empty result, 2 for a syntax error in the script;
  - 1 with no output at all when the first line refuses `$BASH`, and 127 when `$BASH` names no program (both as in step 2);
  - otherwise that of the command that stopped it (`psql`, `mv` or a checker).

  It is 0 only after both checkers succeeded and the block printed `RESULT: both checkers matched the catalog of this run (commit …)`. That line, printed by this run, is the result: a `catalog.json` on disk is not one, and neither is an exit status read on its own. In a shell running with `set -e`, a non-zero status of the new Bash ends that shell; a refusal by the first line's test does not.
- **Afterwards.** Delete `catalog.json` once the result is recorded: git does not ignore it. Besides an earlier `catalog.json`, the block removes only the temporary file it created, through an `EXIT` trap. A trap cannot run after `kill -9`, a crash or a power loss, and other signals, such as a closed terminal, were not tested: then a `catalog.json.*` temporary file can be left; delete it by hand.
- **Both checkers must report a match.** Use profile `019` instead of `017` only if 019 was applied. A match says that the catalog of the database `psql` actually reached matches the registries. It does not show which server or Supabase project that was: passing the checks above shows only which host the connection names.
- **Locally.**
  - *Phase 2.4:* the real `psql` 16.15 with this block's options (`-X -q -At -1 -v ON_ERROR_STOP=1 -c 'set transaction read only' -f supabase/tests/02_money_catalog.sql`), connected with `-h <socket directory> -U postgres -d fp`, not with a connection string, gave catalogs that matched at 017 and at 017 + 019, and a 019 database failed the 017 profile as it should **[local]**.
  - *Slice 10:* both checkers matched (profile 017: 23 tables, 22 functions, 21 policies; 36 money columns, 6 jsonb columns, 14 functions) a catalog taken read-only with `02_money_catalog.sql` from PostgreSQL 16.15 built from the 20 files on Supabase Auth v2.177.0's own `auth` schema, connected through a socket, not through this block **[local]**.
  - *The connection string as the value of `-d`*, this block's form, has not been run against a database built from the migrations, nor against a hosted one. The psql(1) man page says `-d` accepts a connection string **[local: psql(1) man page 16.15]**. In Phase 3.12 the same options with a connection string after `-d` ran against a throwaway local PostgreSQL 17.10 that holds no JimoCex schema; the string named a Unix-socket directory, which this block's own check refuses, so `psql` was called directly, not through the block. There a file with a write in it was refused, an SQL error ended with 3, a failed connection with 2, and the real first checker reported a mismatch for that database **[local]**.
  - *The block itself* (its checks, the repository check, the temporary file, the order of the checkers) was run only with stand-ins for `psql` (Phases 3.6, 3.8, 3.12 and 3.14 in earlier forms, Phase 3.15 as written here), never against a database.
- **On a real project** a mismatch can also come from Supabase's own roles or settings **[unverified]**. Either way a mismatch is a stop, not something to adjust by hand.
- `supabase/tests/01_invariants.sql` is for throwaway local clusters (`scripts/test-db.sh`), not for a hosted project.
- `supabase/drafts/019_preflight.sql` is a check for the hosted rollout. Its history checks (`H1`–`H4`) expect production's history rows, which step 3 does not write, so it is not a check for a test project.

#### 6. Owner: Auth settings of the test project only

Before anyone claims that sign-up, confirmation or password reset works on a Preview, the settings
below must be made **and** each flow tested end to end on the Preview, reading the link in the email
that actually arrived. Until then this plan claims neither.

- **Site URL:** a Preview URL of this project, such as its branch alias. Never a production URL.
- **Redirect URLs:**
  - prefer the exact Preview hosts that will be used, such as `https://<branch alias>/**`, over a pattern;
  - Supabase's documentation suggests `https://*-<team-or-account-slug>.vercel.app/**` for Vercel previews, where `*` matches any characters but `.` and `/` **[docs]**. Such a pattern also matches any other `*.vercel.app` name ending in `-work-app1`, and whether only this team can obtain such a name is **[unverified]**;
  - never a production URL, and never a bare `**`.
- **Email templates.**
  - Supabase's server-side (PKCE) flow needs the "Confirm signup" and "Reset password" templates to link to `/auth/confirm` with `token_hash` and `type` **[docs]**. This app's `src/app/auth/confirm/route.ts` reads exactly `token_hash`, `type` and `next`.
  - Until the test project's templates are changed, confirmation and reset links are not expected to complete in this app. That follows from the documentation and the code; it has not been tested.
  - The app's targets (`src/app/auth/actions.ts`): sign-up and resend send `emailRedirectTo: <origin>/auth/confirm` (lines 73, 163); reset sends `redirectTo: <origin>/auth/confirm?next=/reset-password` (line 108).
  - The owner chooses between two forms (both untested):

  | Template base | Confirm signup | Reset password | Effect |
  |---|---|---|---|
  | `{{ .SiteURL }}` | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` | `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password` | every link goes to the Site URL, whichever Preview sent the email |
  | `{{ .RedirectTo }}` | `{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email` | `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery` | the link follows the Preview that sent the email; the redirect allow-list is the control |

  - **Two pitfalls.** The `{{ .RedirectTo }}/auth/confirm…` example in Supabase's documentation assumes a bare origin, but this app already sends the path, and for reset a query string. Do not put `{{ .RedirectTo }}` into `next` either: `safeRedirectPath` (`src/lib/auth/validation.ts:78`) refuses absolute URLs and falls back to `/dashboard`.
  - What Auth puts in `{{ .RedirectTo }}` when the requested target is not on the allow-list is **[unverified]**. Test it.
- **`NEXT_PUBLIC_APP_URL` unset is not proof that redirects are safe.**
  - Without it, `appOrigin()` (`src/app/auth/actions.ts:26–34`) builds email links from `x-forwarded-host`, then `host`, then `http://localhost:3000`. Whether a client can set `X-Forwarded-Host` through Vercel's edge is **[unverified]**.
  - Supabase's documentation requires redirect targets to match the allow-list **[docs]**, so the allow-list is the control until that is verified. What Auth does with a target that does not match is **[unverified]**.
  - Verify on the first Preview: send a sign-up with a forged `X-Forwarded-Host`, then check that the link in the email does not point at the forged host.
  - Never set `NEXT_PUBLIC_APP_URL` to a production URL on a Preview.
- **Email sending:** the default provider is rate-limited **[docs]**. Use addresses you control, or a test SMTP account. Never production SMTP credentials.

#### 7. Test accounts

Sign up through the Preview with addresses you control (plus-addressing works). There are no
production users and no production data in this project, and none are copied into it.

**The demo account (Slice 10).** A new account holds nothing, so every order is refused as an
insufficient balance. To exercise the order lifecycle, the owner may give ONE dedicated test account a
ledger-backed opening balance (10,000 USDT, 1 BTC, 10 ETH, 100 SOL) with `scripts/fund-demo-account.ts`:

1. Sign the account up through the Preview and confirm its email (step 6), like any test account.
2. In an env file outside the repository, readable by you only, put the **test** project's values:
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_JIMOCEX_DEMO_MODE=true`,
   `JIMOCEX_DEMO_FUNDING_PROJECT_REF=<test ref>` and `JIMOCEX_DEMO_ACCOUNT_EMAIL=<that account>`.
3. From the repository root: `node --env-file=<that file> --experimental-strip-types scripts/fund-demo-account.ts`.
   Exit 0 means funded (or already funded); 10, refused with nothing written; 1, failed (run it again).
4. Delete the env file.

What it does and what it refuses:
- **Fail-closed environment check, before it connects** (exit 10; it names what failed, never a value):
  demo mode must be exactly `true`; nothing may say production (`NODE_ENV`, `VERCEL_ENV`); the URL must be
  a local stack (loopback) or `https://<ref>.supabase.co` whose `<ref>` is named again in
  `JIMOCEX_DEMO_FUNDING_PROJECT_REF` and is not the production project `sykhghtlkcrzwaoehlhf`; the key
  and the email must be set. Any other environment is unknown and refused.
- **Account and assets** are checked before anything is posted: an email without a profile, an account
  that is not ACTIVE, or a missing or inactive asset ends with 10 and posts nothing.
- **Ledger only, once.** Each balance is one `ledger_post` `ADJUSTMENT` (reference `demo_funding`, dedup
  key `demo-funding:v1:<user>:<asset>`), with a `demo.funding` row in `audit_logs`. A second run posts
  nothing; the database's unique dedup key refuses a concurrent repeat. No balance is written directly.
- **Not a faucet, not part of the app.** It funds the configured account with fixed amounts. No route,
  server action or page imports it, and it needs the target's service-role key, which no browser has.
- **No undo.** The ledger is append-only; a new, empty test project is the clean reset (step 4).

Checked locally only **[local, Slice 10]**: its refusals (demo mode off, a production marker, the
production project, an unknown account) ended with 10 and wrote nothing; a first run posted four
`ADJUSTMENT` entries and four audit rows; a second run posted nothing; the wallets reconciled with the
ledger. Not run against a test project.

#### 8. Keys

- **Into the Vercel Preview environment:** the test project's URL, and its public client key in `NEXT_PUBLIC_SUPABASE_ANON_KEY`. The key is either a publishable key (`sb_publishable_…`) or the legacy anon key.
- **Public, but the test project's.** A public client key is not a secret, since it ships to the browser. It must still belong to the test project.
- **Legacy keys** (`anon`, `service_role`) keep working until the end of 2026 **[docs]**.
- **Publishable keys.** The installed `@supabase/supabase-js` 2.117.3 recognizes them and sends them only in the `apikey` header (read in its code) **[local]**. Whether this application works with one is **[unverified]** until it is tried against the test project.
- **The test project's secret or service-role key** stays unset (see above) and is not copied anywhere.

### Option B: Supabase Branching on the JimoCex project

The plan allows it (Pro), and the project has no branches today. It needs Branching switched on for the
production project (a change to that project), the GitHub integration and a `supabase/config.toml`.
Branches start empty and run `supabase/migrations`, so a branch would be at 021 (001–018, 020, 021) while
production is at 015. Depending on configuration, the integration can also run migrations against production when the
production branch changes. That conflicts with the manual, authorized v4 procedure in
`docs/rollout-019.md`, so it is not recommended until the migration process is settled.

## Vercel Preview

Read-only, Phase 2.2: there is no Vercel project for this repository.
- The `work-app1` team has six projects, deployed from `Saopaulo11/Trust-` and `Saopaulo11/WorkAPP`, so the Vercel GitHub App is installed for the account.
- Whether its repository list includes `Saopaulo11/jimocex` cannot be seen from here.

Steps, all **owner**, after the test database exists:

1. **Decide the Production branch first.** GitHub's default branch is `feature/jimocex-mvp`. An import with default settings makes it the Production branch, and every push to it a Production deployment. Choosing another Production branch (for instance a `main` created from an agreed commit) is a separate decision. Until it is made, do not import.
2. **Import** `Saopaulo11/jimocex` into `work-app1`, giving the GitHub App access to the repository if it is not listed.
3. **Build settings:**
   - framework Next.js (`vercel.json`);
   - install `npm ci`;
   - build `npm run build` (`next build`);
   - output default;
   - **Node.js 22.x**, the version the tests ran on (22.22.0).
4. **Environment variables, scope Preview only:**
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the test project's URL and public client key (Option A, step 8);
   - `SUPABASE_SERVICE_ROLE_KEY`: unset, unless the owner decides to enable demo trading on the Preview (**Open decisions**); then the **test** project's key, scope Preview only, never `NEXT_PUBLIC_`. Unset, the Preview is read-only: sign-up, sign-in and browsing work, placing an order does not;
   - leave unset:
     - `NEXT_PUBLIC_APP_URL`: links then follow each Preview's own host, and one fixed value would send every Preview's links to that one URL. What that relies on: Option A, step 6;
     - `JIMOCEX_MARKET_DATA_PROVIDER`.

   Set nothing for Production. A Production deployment then cannot reach any database.
5. **Deployment Protection:** Vercel Authentication on Preview deployments, as on the team's other projects.
6. **Isolation checks around the first Preview build:**
   1. Before: record the hosted project's read-only history and fingerprint checks (`docs/rollout-019.md`).
   2. The Preview variables name the test project's ref, not `sykhghtlkcrzwaoehlhf`; Production has none.
   3. The Preview's built client code contains the test project's URL and not `sykhghtlkcrzwaoehlhf`.
   4. In the browser's network panel, the Preview calls only `https://<test ref>.supabase.co`.
   5. A test sign-up appears in the test project's Auth users and nowhere else, and the link in its email points at the Preview (or the test Site URL), never at production.
   6. After: the hosted project's read-only history and fingerprint checks show no change.

   Then: `/`, `/markets` (pairs from the test database), `/login` and `/signup` load, and `/dashboard` sends a signed-out visitor to `/login?next=%2Fdashboard`.

## Evidence

### Verified locally **[local]**

**Phase 2.2: the app.** A production build of Next.js 16.3.8 ran against a stand-in for a test project:
PostgreSQL 17.10 built from 001–017, PostgREST 12.2.3, and a gateway for `/rest/v1` with `/auth/v1`
stubbed. The build had only a test URL and a locally signed anon key: no service-role key, no
`NEXT_PUBLIC_APP_URL`, no market-data provider.
- Every public page answered 200, and `/markets` rendered 16 pairs read from the database.
- The application sent only `GET` requests to `/rest/v1`.
- `/auth/confirm` sent a forged token with `next=https://evil.example` back to `/login?error=invalid_link` on the same origin.
- `/markets` still answered with the database unreachable.
- `safeRedirectPath` refused absolute, protocol-relative, backslash and `javascript:` targets.

**Phase 2.4: the migrations.**
- **The repository's text differs from production's in four files, in comments only.** In `001_initial_schema.sql`, `004_wallets_ledger.sql`, `008_fees_kyc_risk.sql` and `009_audit_idempotency_events.sql`, the repository's text differs from the text production ran (md5 recorded in production's history). The differences are comments, plus a `create extension if not exists "pgcrypto"` in production's 001 that did nothing there.
- **A clean 001–015 matches production's 015 but for three items.** It differs from a local rebuild of production's 015, made from the exact text production ran, in three catalog items: the `wallets` table comment, and the leftover `_jimocex_ddl_probe()` function with its grant.
- **A clean 001–017** gives the catalog fingerprint that package v4's postflight requires (`f48db42e…`, 1191 items).
- **Also verified:** the re-run results (step 4), and the catalog command with both checkers (step 5).

**Phase 3.0: the install sequence of step 3**, with stand-ins for `psql` and for failing tools only, never a
database, and with Bash 5.2 only. The cases and their results are listed under step 3 ("Checked so far").

**Phase 3.2: the connection, environment and exit-status checks of step 3**, with the same kind of stand-ins,
without sending any signal, never a database, and with Bash 5.2 only. Listed under step 3 ("Checked so far").

**Phase 3.3: how libpq fills in connection parameters**, with the libpq 16.15 and 17.10 client libraries,
called directly with dummy values only. The connection named a Unix-socket directory that does not exist,
and the `hostaddr` values were not addresses, so nothing left the machine and no server was involved:
- with `PGHOSTADDR` set, both versions tried to use it although `host=` was given;
- with `PGSERVICE` naming an entry of a service file, both took `hostaddr` and `options` from it and kept the connection's `host`, `port`, `dbname`, `user` and `sslmode`; `PGSERVICEFILE` alone had no effect; an empty `PGSERVICE` made the connection fail;
- `PGOPTIONS` and `PGCLIENTENCODING` became the connection's `options` and `client_encoding`;
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGSSLMODE` and the other variables listed under step 3's **Environment** left the connection's five values unchanged, with no `hostaddr` and no `options`; `PGPASSWORD` supplied a password.

This shows how these two versions fill in parameters, not what the network or a server does. The online
PostgreSQL documentation could not be reached from this environment; the psql(1) man page of PostgreSQL 16.15
installed there was read instead.

**Phase 3.6: the blocks of steps 2 and 5 in their earlier form**, a subshell `( … )` run by the interactive shell
itself, pasted into an interactive Bash 5.2 with stand-ins for `psql` and `node`; never a database, and without
sending any signal:
- with `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGOPTIONS` or `PGCLIENTENCODING` set, or with `conn` empty, unset or in another form (the unfilled template, a leading `-`, a URI, `password`, missing, repeated or other keys, quotes, `=` in a value), neither block started `psql` and step 5 ran no checker; each ended with 10, and no value appeared in a `STOP:` line;
- with none of the five set, also under `set -e`, under `noclobber` and with aliases for the commands, both blocks ran `psql` with the options shown; step 5's `psql` wrote to a `catalog.json.*` file of mode 600, and the checkers ran in order on that run's output;
- a failing `psql` (3, or 2 after writing part of its output) left neither `catalog.json` nor a temporary file and ran no checker; a failing first checker kept the second from running; an empty result ended with 10; with the real checkers, output that was not JSON or was cut short made the first one fail and the block end with 1;
- with `noclobber` and a `catalog.json` from an earlier run, the checkers never read the old file;
- the real checkers matched a catalog taken from a local 017 cluster in Phase 2.4;
- the connection and environment checks, the same 27 lines in both blocks, accepted and refused the same 44 connections as the gate (compared through the step 2 block, run without a terminal);
- the block's exit status reached the shell; under `set -e` the shell ended with it.

The same checks run against the version of these blocks before Phase 3.6 failed: `psql` ran with a refused variable
set and with an empty `conn`, the checkers ran after a failing `psql`, and under `noclobber` they read the old
`catalog.json`.

**Phase 3.7** found that this earlier form failed when the interactive shell had an alias `stop` of more than one
word (`systemctl stop`, `docker stop`): the line defining `stop` became a syntax error, the shell went on with the
rest of the pasted lines itself, `psql` ran with `PGOPTIONS` set, and in step 5 both checkers ran and the
temporary file's `EXIT` trap stayed in that shell.

**Phase 3.8: the blocks of steps 2 and 5 in their Phase 3.8 form**, which started the new Bash with
`command bash -p -s`, step 2 with a file name as its second argument and step 5 with no repository check,
pasted into an interactive Bash 5.2 (aliases and history expansion on) with stand-ins for `psql` and `node`;
never a database, and without sending any signal. After each block the shell was asked for its `EXIT` trap
and for the blocks' variables:
- with an alias `stop` for `systemctl stop`, `docker stop` or `echo`, with aliases for `psql`, `rm`, `mv`, `mktemp`, `node`, `bash`, `grep` and `echo`, and with functions named `stop`, `psql`, `echo` and `bash`, also exported with `export -f`: with a refused variable set (`PGOPTIONS` with the `stop` aliases and the functions, `PGSERVICE` with the other aliases, `PGHOSTADDR` with the exported functions) and, with the `stop` aliases, with `conn` empty, neither block started `psql` and each ended with 10; without them, both ran `psql` with the options shown and step 5 ran the checkers in order;
- with `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, `PGOPTIONS` or `PGCLIENTENCODING` set, or with `conn` empty, unset, blank or in another form (the unfilled template, a leading `-`, a URI, `password`, a repeated or other key, quotes), neither block started `psql` and step 5 ran no checker; each ended with 10;
- a syntax error put into the handed-over text ended the new Bash with 2 before any of its commands ran, also those above the error;
- a failing `psql` (3, or 2 after writing part of its output), `mktemp` or `mv` left neither `catalog.json` nor a temporary file and ran no checker; a failing first checker kept the second from running; a failing second checker gave its status; an empty result ended with 10; with the real checkers, output that was not JSON or was cut short ended with 1, and a catalog taken from a local 017 cluster in Phase 2.4 matched;
- with `noclobber` and a `catalog.json` from an earlier run, the checkers never read the old file; outside the repository root step 5 stopped with 10 and left an existing `catalog.json` alone;
- with `set -e`, the shell ended with the block's non-zero status (10, 3 or 5) and stayed open on 0; with `set -x` and an exported `SHELLOPTS`, the new Bash traced nothing, and an exported `BASH_ENV` was not read;
- whenever the shell stayed open, it had no `EXIT` trap and none of the blocks' variables afterwards; no value of a refused variable appeared in the output;
- a stand-in for `bash` received the text between the heredoc's lines and the arguments (`-p -s --`, `conn` and, in step 2, the file) byte for byte;
- run without a terminal, the two blocks' checks accepted and refused the same 58 connections as the gate, under the `C.UTF-8` and `C` locales.

The same check, an alias `stop` for `systemctl stop` or `docker stop` with `PGOPTIONS` set, run against the
Phase 3.6 form failed in both steps, as Phase 3.7 found. Not checked: other shells and Bash versions, a function
or alias named `command` or `builtin`, other programs found under these names on `PATH`, and how a real `psql`
asks for a password when its standard input is the heredoc.

**Phase 3.12: the blocks of steps 2 and 5 in their Phase 3.12 form**, which started the new Bash without testing
`$BASH` first, and in which step 5 compared the six files with `git ls-files` and `git diff`.
- *With the real `psql` 16.15*, called directly with the options of steps 2 and 5 and a connection string after
  `-d`, against a throwaway PostgreSQL 17.10 on this machine (Unix socket only, no TCP; an empty database, no
  migration run; stopped with `pg_ctl stop -m fast` and removed afterwards):
  - a file with `create table` or `insert` was refused with 3, and nothing changed; step 2's SQL text ran with `read_only` `on`, although it repeats `set transaction read only`;
  - a file that began with `set transaction read write;`, or ran `commit;` before writing, wrote: `-c 'set transaction read only'` alone does not stop such a file;
  - an SQL error ended with 3, and the statements after it did not run; a missing database or socket ended with 2;
  - `02_money_catalog.sql` ended with 3 on a database without the three client roles; with them, it gave one JSON document, which the real first checker reported as a mismatch.
- *Pasted into an interactive Bash 5.2* with stand-ins for `psql`, `node` and failing tools, step 5 in a scratch
  Git repository holding the six files it checks; never a database, and no signal sent to a block:
  - step 2 passed `-c 'set transaction read only' -f` and a private temporary file (mode 600, removed afterwards) whose content was, byte for byte, the SQL text above; a file name added after `conn` was ignored; `psql`'s 2 and 3 became the block's status;
  - with an alias or a function named `command` or `bash`, also exported, both blocks ran as they do without one: step 2 started `psql` once, a refused variable still ended with 10, and step 5 replaced an earlier `catalog.json` with this run's or, when `psql` failed, left none and printed no `RESULT`;
  - with `$BASH` unset or naming no program, and in `dash`, the line ended with 127 (1 under `set -u`) and nothing ran; step 5 then left an earlier `catalog.json` as it was and printed no `RESULT`;
  - step 5 stopped with 10, before touching `catalog.json`, outside a Git working tree, in a Git repository that does not track the six files, below the top of the repository, with one of the six files edited or missing, and with `git` not on `PATH`; it ran normally with `GIT_DIR` and `GIT_WORK_TREE` exported elsewhere, and when entered through a symlink;
  - failures of `psql`, `mktemp` and `mv` and an empty result left no `catalog.json`; a failing checker left this run's `catalog.json`, and a failing first checker kept the second from running; none of them printed `RESULT`; with the real checkers, a local 017 catalog matched and output that was not JSON failed;
  - both blocks refused each of the five variables and eight malformed connections; `set -e`, `set -x` with an exported `SHELLOPTS`, an exported `BASH_ENV`, an alias `stop` and an injected syntax error behaved as in Phase 3.8; a stand-in for Bash, set as `$BASH`, received the text between the heredoc's lines and `-p -s -- <conn>` byte for byte;
  - run without a terminal, the two blocks' checks accepted and refused the same 240 connections as the gate, under the `C.UTF-8` and `C` locales.

The same tests failed against the Phase 3.8 blocks: with a function or an alias named `command`, both ended
with 0 without starting anything, and step 5 kept the earlier `catalog.json`; in a directory that only holds
`supabase/tests/02_money_catalog.sql`, step 5 removed `catalog.json` and ran `psql` and both checkers. Not
checked: shells other than Bash 5.2 and `dash`, other Bash versions, a function named after the path in
`$BASH`, other programs found under these names on `PATH`, signals, and either block against a database built
from the migrations or a hosted one.

**Phase 3.14: the blocks of steps 2 and 5 in their Phase 3.14 form**, which did not check `NODE_OPTIONS` or
`NODE_COMPILE_CACHE`. Three kinds of evidence, kept apart:
- *Real Bash 5.2, git 2.43.0 and file system, with stand-ins only for `psql` and `node`.* The blocks were pasted
  into an interactive Bash on a terminal, step 5 in scratch copies of a fixture Git repository holding the six
  files; no database and no network:
  - with `BASH` set to `/bin/true`, `/bin/echo`, `/bin/sh`, `/usr/bin/bashbug`, `/bin/rbash` or empty, or unset (also under `set -u` and under `set -e`), the first line ended with 1, printed nothing and started nothing, step 5 kept an earlier `catalog.json`, and the shell stayed open; `/nonexistent/bash` and `dash` ended with 127. A program at a path ending in `/bash`, a function named after that path and an alias `[[` got past the test, as step 2 says;
  - step 5 stopped with 10 before removing `catalog.json` and before `psql`: a checker committed as a symbolic link to a file outside the repository; a checker, `scripts/` or `src/lib/` replaced by a link to an identical copy; a dangling link; a FIFO; a checker committed with mode `100755`; a file present but not in the commit; a repository and an orphan branch without commits, with their own message; and an edited checker under each Git setting listed under step 5's **Git's environment**, where no configured command ran;
  - it ran normally after `chmod +x` or `chmod 600` alone, with `GIT_INDEX_FILE` naming an empty index, with `core.fsmonitor` or a clean filter configured (neither ran), and with `GIT_CEILING_DIRECTORIES` at the top. A look-alike repository with an edited checker committed ran and printed its own commit;
  - step 2's temporary file was removed after a normal run and after `psql` failed, and an unrelated `jimocex-step2.*` file in `TMPDIR` was kept. After `kill -9` of the new Bash while `psql` ran, step 2's file (the SQL text only, no `conn`) and step 5's `catalog.json.*` file stayed;
  - after a failing first or second checker, this run's `catalog.json` stayed and no `RESULT` was printed; unrelated files next to it were kept after every outcome;
  - these Phase 3.12 tests passed again: aliases and functions named `command` or `bash`, also exported; the five variables and eight malformed connections; failures of `psql`, `mktemp` and `mv`, an empty result, the real checkers; `noclobber`, `set -e`, `set -x` with an exported `SHELLOPTS`, an exported `BASH_ENV`, an alias `stop`, an injected syntax error; a recorder as `$BASH` received the text and arguments byte for byte. The checks of both blocks accepted and refused the same 480 connections as the gate.
- *What only the `psql` stand-in shows:* the arguments each block passes (`-c 'set transaction read only'` before
  `-f`, the other options, the connection) and that step 2's file holds the SQL text above byte for byte.
  Removing `-c 'set transaction read only'` is caught only as a changed argument: these tests say nothing about
  what a server does with it.
- *Not run again:* what the real `psql` 16.15 and PostgreSQL 17.10 did with these arguments is the Phase 3.12
  result above. No database was started in Phase 3.14.

The same tests failed against weakened copies of these blocks: without the test of `$BASH`; with the link test on
the file only; accepting any committed mode; without `GIT_NO_REPLACE_OBJECTS=1`; hashing through filters; taking
the blob id from `git rev-parse`; without step 2's `EXIT` trap. They also failed against the Phase 3.12 form, which
accepted a committed link, an edited checker hidden by `GIT_INDEX_FILE`, by a clean filter or by replacement refs,
refused a file whose only change was `chmod +x`, and gave a misleading message without a commit. Not checked:
zsh and shells other than Bash 5.2 and `dash`, other Bash and Git versions, macOS, a file system without
executable bits (only simulated with `chmod`), signals other than `kill -9`, other programs found under these
names on `PATH`, and either block against a database.

**Phases 3.15 and 3.16: step 5 as written above** (step 2 is unchanged since Phase 3.14). These tests reuse the
harness, stand-ins and fixture repository of Phases 3.12–3.14, so they are not independent of them. By kind:
- *The real `node` 22.22.0 running the real first checker directly*, outside the block, on a scratch copy of the
  six files and a catalog that did not match:
  - `NODE_OPTIONS` loading a module that ends the process with 0 (`--import`, `--require` or `--experimental-loader`, also after a harmless option, or with a quoted path containing spaces), or set to `--experimental-default-type=commonjs` (also on a matching catalog): exit 0, and the checker never ran. A module ending with 3, or one that throws: 3 and 1. `--eval`, `-e`, `--env-file` or an unknown option: 9;
  - `NODE_COMPILE_CACHE` naming a directory prepared beforehand: exit 0, and the unchanged checker never ran (Phase 3.15 only, not repeated; how it was prepared is not described here);
  - with a cache Node filled itself, `NODE_DISABLE_COMPILE_CACHE` (`1`, `0`, empty), `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_PRESERVE_SYMLINKS`, `NODE_CHANNEL_FD`, empty values or `--max-old-space-size=4096`, the checker ran, matched a matching catalog and failed on the other.
- *The block pasted into an interactive Bash 5.2, with the real `node` behind a stand-in that records its
  arguments and `psql` a stand-in:*
  - with `NODE_OPTIONS` (each value above, blanks only included) or `NODE_COMPILE_CACHE` set, step 5 stopped with 10 before the repository check: also with both set, with `NODE_OPTIONS` exported within the session, outside a Git working tree, with `PGOPTIONS` set too, and under `POSIXLY_CORRECT=1`. It kept an earlier `catalog.json` as it was, started neither `psql` nor `node`, printed neither `RESULT` nor a value, and left a compile-cache directory untouched;
  - the Phase 3.14 form printed `RESULT` for a catalog that did not match with `NODE_OPTIONS` loading a module that exits 0 (`--import`, `--require`, `--experimental-loader`), or set to `--experimental-default-type=commonjs`;
  - with empty values, `NODE_DISABLE_COMPILE_CACHE`, `NODE_PATH`, a `NODE_OPTIONS` assigned but not exported, and each `package.json` variant listed under step 5, the real checkers either matched a local 017 catalog with exactly one `RESULT`, or failed with their own error, a non-zero status and no `RESULT`, having read this run's `catalog.json` only;
  - an environment holding two `NODE_OPTIONS` entries, built with a raw `execve` and handed to the block's text, was refused when the last entry was the module. When the last entry was empty, `node` received the empty value and the checker ran and failed: what the check reads is what `node` gets;
  - a program named `node` earlier on `PATH` that exits 0 made the block print `RESULT` for any catalog. This is a limitation, not fixed.
- *Stand-ins only:* the order of the checkers and `RESULT` (a failing first checker keeps the second from running, a failing second checker gives its status, neither prints `RESULT`), and the Phase 3.12–3.14 tests above, passed again.
- *Mutation controls and comparison:* the same tests failed against copies of step 5 without the Node.js check, with it after the removal of `catalog.json`, or checking `NODE_OPTIONS` only, as they did against the weakenings of Phase 3.14 (22 detected out of 22). The checks of both blocks accepted and refused the same 480 connections as the gate.
- *Not run again:* the real `psql` results of Phase 3.12. No database was started.

Not checked: Node.js versions other than 22.22.0, Node's variables not named here, other values and
combinations of `NODE_DISABLE_COMPILE_CACHE`, a `node` other than the first on `PATH`, and step 5 against a
database.

**Slice 10: the order lifecycle through the real UI.** A production build of the app (`next start`)
ran against PostgreSQL 16.15 built from the 20 files on Supabase Auth v2.177.0's own `auth` schema,
PostgREST 12.2.3 and Supabase Auth v2.177.0 (the real servers, behind a local gateway for `/rest/v1` and
`/auth/v1`), with locally signed keys. Auth confirmed emails automatically in place of the email link of
step 6. Driven by Playwright in Chromium; every money effect was read back from the database. 46 of 46
checks passed:
- sign-up through `/signup`; the demo account funded by `scripts/fund-demo-account.ts`, twice (second run: nothing posted);
- sign-in through `/login` → dashboard → Markets → BTC/USDT ("Limit orders: Enabled", "Order execution: Not connected") → Trade;
- BUY LIMIT 0.01 BTC @ 60,000: the server preview showed 601.20 USDT reserved; placed OPEN; USDT 10,000/0 → 9,398.8/601.2 (available/locked); one HOLD; no trade;
- order detail: pair, side, Limit, price, amount, Open, reserve, timestamps, links to the market and the trade terminal, "execution is not connected"; Cancel → CANCELLED, one RELEASE, 10,000/0; a second Cancel from a stale page: "This order cannot be cancelled.", still one RELEASE;
- SELL LIMIT 0.01 BTC: BTC 1/0 → 0.99/0.01, USDT untouched; cancelled from Open Orders: one RELEASE, 1/0;
- a placement whose response was lost after the server placed it: the form says it could not confirm the order and allows a retry; the retry returned the same order (one order, one HOLD); a different price and amount under the same key returned the original order and its original reserve (290.58, not 621.24);
- a cancel whose response was lost: the page says so; the database shows one cancel and one RELEASE;
- after 20 seconds the open orders were still OPEN; no trade row, nothing filled;
- ETH/BRL: market page with demo data, "Limit orders: Not enabled", the trade terminal view only with no submit button;
- afterwards all balances were back to the funded amounts, the wallets reconciled with the ledger, and the page raised no uncaught error.

### Observed read-only on production **[production, read-only]** (Phase 2.4)

- **Migration history:** 15 rows (001–015).
- **Schema fingerprint:** `87f076b6…` (1240 items), unchanged since Phase 1.7.
- **Row-level security:** enabled on all 23 tables in `public`, forced on none.
- **Auth:** one trigger on `auth.users`.
- **Default privileges:** as in step 2.
- **Extensions:** `pg_stat_statements`, `pgcrypto`, `plpgsql`, `supabase_vault`, `uuid-ossp`.
- **Server:** PostgreSQL 17.11.

### From Supabase's documentation **[docs]**

- The move of the platform default to revoke automatic grants in `public`.
- The end of legacy keys (end of 2026).
- The `token_hash` templates for the server-side flow.
- The redirect-URL wildcard rules and the Vercel pattern.
- The default email provider's rate limit.

### Not verified until a test project exists **[unverified]**

- **The project itself:** its default privileges, RLS behaviour through its gateway, the `auth.users` trigger of 001, its PostgREST configuration and extensions.
- **Install and Auth:** the behaviour of its connections with step 3, the Auth flows and templates, and a publishable key with this app.
- **Vercel:** forwarded-host handling, the build environment and the edge network.

## Open decisions (owner)

Not settled by this document:
- whether the test project gets 018, 020 and 021 (step 3 now applies them with 001–017; 021 enables LIMIT orders on BTC-USDT, ETH-USDT and SOL-USDT);
- whether the Preview gets the **test** project's service-role key, which placing and cancelling orders needs (**What the application reads from the environment**);
- whether a demo account is funded on the test project (step 7), and which;
- whether the test project gets 019;
- whether it gets migration history rows;
- what to do if its default privileges differ from production's (step 2);
- the email-template form and the redirect allow-list (step 6);
- the key type (step 8);
- Vercel's Production branch.
