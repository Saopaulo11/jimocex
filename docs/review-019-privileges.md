# Review: migration 019 — privileges that follow the policies

Status: **reviewed and tested draft (Phases 1.3–1.7), not a migration, not approved, not applied.**
Supersedes the B1 SQL in `docs/proposal-table-privileges.md`. Depends on 016/017 (package v4) being
applied first. The hosted project is at 015 (read-only check: 1240 objects, fingerprint `87f076b6…`,
15 history rows). Nothing that changes state ran against it; Phase 1.7 ran read-only catalog queries
only ([Phase 1.7](#phase-17-hosted-readiness)). The rollout plan is `docs/rollout-019.md`.

Evidence comes from local throwaway clusters, and in Phase 1.7 from read-only catalog queries on the
hosted project ([Phase 1.7](#phase-17-hosted-readiness)). The local clusters are PostgreSQL 16.15 and 17.10 built by
`scripts/test-db.sh`, and a PostgreSQL 17.10 replica of the hosted schema with package v4, reached
directly and through PostgREST 12.2.3. Phase 1.4 turned the review into tests that live in the
repository and run with or without 019 ([Tests in the repository](#tests-in-the-repository)). The checks
that prove those tests can fail, the order and atomicity scenarios and the HTTP smoke test ran from the
session scratchpad, and are reported separately. Nothing else is claimed.

## The SQL

**One file, one hash.** The SQL under review is `supabase/drafts/019_table_privileges.sql`, identified
by `supabase/drafts/019_table_privileges.sql.sha256`:

```
69881ea76f4531c6e5c4890500c85c334c1057ed1f7d789ca8ce724ad14d95d4  019_table_privileges.sql
```

This document holds no copy of it; earlier copies (here, and the Phase 1.3 draft in the session
scratchpad) are superseded. The file sits outside `supabase/migrations`, so neither the migration loop of
`scripts/test-db.sh` nor the Supabase CLI picks it up. `npm run test:db:019` (part of `npm test`) runs
the suites on exactly this file. `scripts/test-db.sh` refuses to start if the file no longer matches its
`.sha256` (checked before any cluster exists), and prints the hash it ran. Since Phase 1.7 it also
refuses a file under `supabase/drafts` that has no `.sha256`, and runs a copy whose hash it checks again
after copying, so the text cannot change between the check and the run.

**Shape.** The whole file is one SQL statement, a `DO` block, like package v4. A failure anywhere
therefore applies nothing, however the file is sent: psql with or without `-1` or `ON_ERROR_STOP`, the
SQL Editor, or a migration runner. Inside it, in order:

0. `lock_timeout` 5 s, for the statement's own transaction.
1. **Preflight**: read-only catalog checks. It refuses — `55000`, `019 refused: …; nothing was
   changed`, one detail line per problem — unless:
   - the current role owns every table and function in `public` (or is a superuser); otherwise its
     REVOKEs would be silent no-ops;
   - wherever `supabase_migrations.schema_migrations` has rows, `016_money_functions_return_text` and
     `017_money_integrity` are among them, and the role can read that table;
   - `limit_usage_total(…)` exists and returns `text` (017 creates it; 019's message labels this check
     "016", [finding 9](#findings-phase-17)), and `_jimocex_ddl_probe()` is gone (016 drops it);
   - 017's result is there: the TRUNCATE triggers on `ledger_entries` and `limit_usage` exist;
     `service_role` cannot write `wallets` or `ledger_entries`; no function in `public` is executable by
     PUBLIC;
   - every table and function the file names exists;
   - 019 has not run already (its two triggers are absent).
2. The privilege changes reviewed below. They are unchanged from the 16-statement draft of Phase 1.3:
   the independent check of Phase 1.6 gives the same ACL and schema difference, entry for entry.

Changes from the Phase 1.2 proposal, each from evidence:

- **Column-level UPDATE** on `profiles` and `notifications`. The guard triggers allow an owner to change
  only `display_name`, `country_code` (profiles) and `read_at`, `status` (notifications); the grant now says
  the same, so a forbidden column is refused by the grant before the trigger. The triggers stay as the
  second line.
- **Append-only tables**: `forbid_mutation` already refuses UPDATE/DELETE on `audit_logs` and
  `limit_usage` and DELETE on `risk_events` for every role. `service_role` (which bypasses RLS, so its
  grants are its only table-level gate) loses exactly those privileges. No behaviour changes.
- **Functions**: executors derived per function, below — not one set for all eight.

Changes in Phase 1.6, from the Phase 1.5 audit:

- **Single statement, preflight, lock timeout** (above). Applied to the hosted-015 replica before package
  v4, the 16-statement draft succeeded silently. It left `service_role` able to write balances directly
  and trigger functions executable by PUBLIC, and then v4 refused to apply, because its preflight no
  longer recognised the schema.
- **Owner check reads no table it cannot read.** The first version of the preflight, run by a role
  without USAGE on `supabase_migrations`, failed with `permission denied for schema` instead of its own
  refusal. Nothing changed either way, but the message was wrong. The history is now looked up through
  `pg_class` and read only when the role may.

## Executors for the eight functions

The executors and their evidence are recorded per function in `scripts/privilege-registry.ts`
(`FUNCTIONS_019`, field `calledFrom`); `scripts/check-privileges.ts` fails if the database differs.
`limit_usage_total` (not one of the eight: 016 recreated it with an explicit grant) is the one function the
application calls today — `src/lib/engines/limit-engine.ts`, through the service-role client.

| Function | Call sites today | What it does | Executors |
|---|---|---|---|
| `ledger_post` | `release_withdrawal_hold` (runs as owner, needs no grant); documented server call via the admin client (`money-write.ts`) | the only way to move a balance | `service_role` |
| `release_withdrawal_hold` | none in code yet | single-winner release of a failed withdrawal's hold | `service_role` |
| `claim_deposit_for_credit` | none yet (deposit crediting) | single-winner claim, CONFIRMED deposits only | `service_role` |
| `claim_provider_event` | none yet (webhook handling) | single-winner claim, signature-verified events only | `service_role` |
| `mark_trade_settled` | none yet (settlement) | single-winner settlement claim | `service_role` |
| `expire_stale_quotes` | none yet (a scheduled job) | expires quotes past `expires_at` — what time does anyway | `service_role` |
| `is_admin` | none: no policy, no application code (`requireAdmin()` reads `admin_users` through the user's own client) | answers for `auth.uid()` | **none** |
| `has_admin_role` | none, as above | answers for `auth.uid()` | **none** |

The six server functions are the designed server entry points of flows that are not written yet; each
is a bounded, single-winner operation, and the grant is unchanged — 019 only states it in a migration, so
a DROP + CREATE cannot silently lose it. Granting them only when each flow is written is the stricter
alternative; it is a valid choice, not required by any evidence.

`is_admin()` and `has_admin_role()` read `auth.uid()`. The service-role key carries no user, so for
`service_role` they always return false: the grant it holds today serves nothing. Measured effect of the
draft: these two are the only functions whose executors change (`service_role` → none). Whether to keep
them owner-only or drop them is a decision (below); dropping is a schema change and not in 019.

## ACL, RLS and FORCE ROW LEVEL SECURITY

Every table in `public` has RLS enabled and none has FORCE. The roles that write past RLS — `postgres`
(owner, and `BYPASSRLS` on the hosted project) and `service_role` (`BYPASSRLS`) — are unaffected by FORCE
either way, because `BYPASSRLS` bypasses even forced RLS; `SECURITY DEFINER` functions run as `postgres`.
Client roles never bypass RLS. FORCE would therefore change nothing; 019 leaves it off.

With the draft, a client operation is decided in this order: the grant (refused with *permission denied*
unless a policy uses it), then RLS (filters rows: SELECT/UPDATE see only the caller's rows), then the
triggers (guards and append-only). Removing TRUNCATE, TRIGGER, REFERENCES and MAINTAIN does not affect
any of that: PostgREST and pg_graphql use only SELECT/INSERT/UPDATE/DELETE and EXECUTE; triggers fire
without any privilege of the caller (EXECUTE and TRIGGER are checked when a trigger is created, by its
creator, the owner); foreign keys are checked with the owner's privileges; migrations run as the owner.

Trigger functions read no tables as the caller: `touch_updated_at`, the status guards and
`forbid_mutation` work on `OLD`/`NEW`; the two column guards test `current_user`; `handle_new_user` is
`SECURITY DEFINER`. They behave the same after the draft (all invariant tests involving them pass — see
results).

## Privileges before and after (identical on PostgreSQL 16 and 17, except that 16 has no MAINTAIN)

`S` select · `I` insert · `U` update · `D` delete · `T` truncate · `R` references · `G` trigger · `M` maintain · `u(…)` column-level UPDATE

| Tables | Policies | anon before → after | authenticated before → after | service_role before → after |
|---|---|---|---|---|
| account_tiers, asset_networks, assets | SELECT anon+auth | SIUDTRGM → S | SIUDTRGM → S | SIUDTRGM → SIUD |
| fee_rules, tier_limits, trading_pairs | SELECT anon+auth | SRGM → S | SRGM → S | SIUDRGM → SIUD |
| admin_users | SELECT own (auth) | SIUDTRGM → – | SIUDTRGM → S | SIUDTRGM → SIUD |
| kyc_verifications | SELECT own | STRGM → – | STRGM → S | SIUDTRGM → SIUD |
| deposits, swap_orders, swap_quotes, trades, trading_orders, withdrawals | SELECT own | SRGM → – | SRGM → S | SIUDRGM → SIUD |
| limit_usage | SELECT own; append-only | SRGM → – | SRGM → S | SIUDRGM → SI |
| wallets, ledger_entries | SELECT own; ledger_post only | SRGM → – | SRGM → S | SRGM → S |
| profiles | SELECT, UPDATE own | SIUDTRGM → – | SIUDTRGM → S u(display_name, country_code) | SIUDTRGM → SIUD |
| notifications | SELECT, UPDATE own | S.U.TRGM → – | S.U.TRGM → S u(read_at, status) | SIUDTRGM → SIUD |
| idempotency_keys, provider_events | none | STRGM → – | STRGM → – | SIUDTRGM → SIUD |
| audit_logs | none; append-only | STRGM → – | STRGM → – | SIUDTRGM → SI |
| risk_events | none; DELETE refused | STRGM → – | STRGM → – | SIUDTRGM → SIU |

Every remaining privilege has a basis: a client privilege is the command a policy governs; a
`service_role` privilege is the server's write path for a table it owns, minus what an append-only
trigger refuses. `service_role` keeps SIUD on server-owned tables whose flows are not written yet
(deposits, withdrawals, orders, quotes, …); narrowing those belongs with each flow.

## Tests in the repository

Uncommitted, in the working tree. `npm test` runs all of it: the unit tests, `scripts/test-db.sh`
against the migrations in the repository (privilege profile `017`), and `npm run test:db:019`, the same
on top of the canonical 019 file (profile `019`).

| File | What it holds |
|---|---|
| `scripts/privilege-registry.ts` (new) | The exact privileges per profile: every table × `anon`/`authenticated`/`service_role` as letters `SIUDTRGM` (PUBLIC: none, everywhere), the column-level grants, and the executors of every function — for 019 with the call site that justifies each. Since Phase 1.6, the same in both profiles: the client roles' attributes and allowed members, schema `public` USAGE/CREATE, the SECURITY DEFINER functions and `search_path=""` for all, FORCE RLS (none), and all 21 policies whole |
| `scripts/privilege-check.ts` (new, 1.6) | The rules, as a pure function `checkPrivileges(catalog, profile)` |
| `scripts/__tests__/check-privileges.test.ts` (new, 1.6) | 48 unit tests: a catalog built from the registry passes for both profiles on 16 and 17; each rule then fails on a catalog that breaks it, with the message that names the break |
| `scripts/check-privileges.ts` (new) | The CLI over `privilege-check.ts`. Fails on: a privilege granted but not listed (extra) or listed but not granted (missing), per table × role, PUBLIC included; a relation in `public` the registry does not know (table, view, sequence, …) or a registered one that does not exist; RLS disabled on a table; any column-level grant not listed, or listed and missing; a table grant to any role outside the registry; a function not in the registry, a registered one that does not exist, an overloaded name; executors ≠ registry; EXECUTE for PUBLIC; EXECUTE granted to a role outside the registry; an RLS policy that calls a function one of its roles cannot execute. Since Phase 1.6 also on: a policy added, dropped or changed in command, permissive/restrictive, roles, USING or WITH CHECK (whitespace and `public.` ignored); a client role that is a member of any role — SET-only included — or has SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, LOGIN, or BYPASSRLS other than `service_role`'s; a member of a client role other than `authenticator` and `supabase_realtime_admin` (both SET-only) and `postgres`; CREATE on schema `public` for a client role or PUBLIC, or a client role without USAGE; SECURITY DEFINER/INVOKER other than the registry's, or a function without `search_path=""`; FORCE RLS; a table or function owned by a client role. MAINTAIN is compared on PostgreSQL 17 and reported as not checked on 16 |
| `supabase/tests/02_money_catalog.sql` | Adds `privileges` to the snapshot (1.6: plus role attributes, memberships with their INHERIT/SET/ADMIN options, schema `public` privileges, owner and FORCE per relation, each policy whole, and SECURITY DEFINER, config and owner per function): server version, the privilege kinds the server has (MAINTAIN only from 17 — the list comes from the version, never a literal `has_table_privilege(…, 'MAINTAIN')`), relations with their RLS flag, effective table privileges (`has_table_privilege`, so PUBLIC and role membership count) for the three roles and PUBLIC, explicit column ACLs (`pg_attribute.attacl`), table grantees outside the registry, policy expressions; and `PUBLIC` and `otherGrantees` per function |
| `scripts/check-money-catalog.ts` | The exact-executor comparison moved to `check-privileges.ts` (it depends on the profile); the money rule stays and now also counts PUBLIC: a function that carries money may not be executable by PUBLIC, `anon` or `authenticated` |
| `scripts/test-db.sh` | `PSQLBIN` (a psql when `PGBIN` has none, as with the PostgreSQL 17 build used here), `JIMOCEX_EXTRA_SQL` (applied as one transaction after the migrations; refuses to run without an explicit profile), `JIMOCEX_PRIVILEGE_PROFILE` (`017` default, or `019`; passed to the invariants as a psql variable and to `check-privileges.ts`); prints the server version; runs the new check. Since 1.6: refuses an extra SQL file that does not match its `.sha256`, and prints the hash it ran |
| `package.json` | `test:db:019` (the canonical file, profile 019), part of `npm test`; `test:unit` also runs `scripts/**/__tests__` |
| `supabase/tests/01_invariants.sql` | See below |

### Changes in `01_invariants.sql`

- **No error passes as a refusal any more.** `pg_temp.is_test_defect(sqlstate)`: class 42 except
  `42501` (syntax, unknown table/column/function, type mismatch), and classes 08, 25, 2F, 39, 3D, 3F,
  40, 53, 54, 55, 57, 58, F0, XX (connection, transaction state, resources, internal). `rejects`,
  `rejects_with`, `rejects_with_message`, `no_effect` and `takes_effect` re-raise these, so the run stops
  with the real error. Before the change, all 41 refusals the suite recorded had a domain SQLSTATE
  (15 × `42501`, 12 × `23514`, 8 × `23001`, 5 × `23505`, 1 × `22003`), so none was passing on a defect;
  the sensitivity run shows the old helpers would have passed one.
- **The seven assertions** (`audit_logs`, `risk_events`, `provider_events`, `idempotency_keys` for a
  user; `wallets`, `profiles`, `trading_orders` for an anonymous visitor) use
  `pg_temp.sees_no_forbidden_rows(name, table, forbidden_rows, expected_layer)`. It reads
  `has_table_privilege` first, then runs the query either way:
  - SELECT granted: the query must succeed and return none of the forbidden rows;
  - SELECT not granted: it must fail with `42501` and exactly `permission denied for table <t>`.

  Only `insufficient_privilege` is caught. A succeeding query without the grant, a different `42501`
  message (e.g. *permission denied for schema*) and any other error all fail. For these seven
  `expected_layer` is NULL (either outcome, checked strictly); the assertion is named after the layer
  that answered: `[RLS]` under 017, `[ACL]` under 019. New fixtures in `provider_events` and
  `idempotency_keys`, and a precondition that every probed table holds a row, keep the "no row
  visible" branch from passing on an empty table.
- **Other raw reads in the RLS section** (`§47 user sees only their own wallet`, reference data
  readable, …) go through `pg_temp.reads()`. A privilege refusal there becomes a failed assertion
  instead of stopping the run.
- **New section "Which layer refuses what".** Every assertion is tagged `[ACL]`, `[column grant]`,
  `[RLS]`, `[trigger]` or `[ACL+RLS]` (a read both allow), and checks that layer's own signature:
  - `[ACL]`: `42501` + `permission denied for table|function <x>`;
  - `[column grant]`: the same message, and the role holds UPDATE on some columns of the table but not
    this one;
  - `[RLS]` write: no error and `ROW_COUNT = 0`, or `42501` + `new row violates row-level security
    policy` for an INSERT;
  - `[trigger]`: the trigger's SQLSTATE and message prefix.

  Where 017 and 019 refuse in different layers, the expectation is written per profile.

| Behaviour | 017 | 019 |
|---|---|---|
| reference tables readable by anon and authenticated (each of the 6) | `[ACL+RLS]` | `[ACL+RLS]` |
| a user reads own profile/notification; sees no other user's `admin_users`, `kyc_verifications`, `notifications`, `profiles` row | `[ACL+RLS]` / `[RLS]` | same |
| a user reads `audit_logs`, `idempotency_keys`, `provider_events`, `risk_events` | `[RLS]` 0 rows | `[ACL]` |
| anon reads each of the 17 non-reference tables | `[RLS]` 0 rows | `[ACL]` |
| a user updates own `profiles.country_code`, own notification `read_at`+`status` | allowed | allowed (column grant) |
| `touch_updated_at` fires on those updates, with the role's TRIGGER privilege asserted (held / not held) | `[trigger]`, TRIGGER held | `[trigger]`, TRIGGER not held |
| a user changes own `profiles.user_id/email/tier_code/status/kyc_status`, `notifications.user_id/channel/title/body/entity_type/entity_id/sent_at` | `[trigger]` guard | `[column grant]` |
| a user changes own `profiles`/`notifications` `id`, `created_at`, `updated_at` | **not refused** (finding below) — no assertion | `[column grant]` |
| guard triggers with the column grant temporarily widened inside the test transaction | `[trigger]` | `[trigger]` |
| a user updates another user's profile / notification | `[RLS]` 0 rows (+ checked unchanged as owner) | same |
| a user deletes own profile / creates a profile | `[RLS]` 0 rows / `[RLS]` WITH CHECK | `[ACL]` / `[ACL]` |
| a user deletes a notification; anon updates notifications | `[ACL]`; `[RLS]` 0 rows | `[ACL]`; `[ACL]` |
| service_role writes `audit_logs`, `risk_events` (+ review UPDATE), `provider_events` (+ status), `idempotency_keys` (+ DELETE), `notifications` (+ sent), `deposits`; changes a tier past the guard | allowed | allowed |
| service_role reopens a FAILED withdrawal | `[trigger]` | `[trigger]` (no TRIGGER privilege) |
| service_role UPDATE/DELETE `audit_logs`, `limit_usage`; DELETE `risk_events` | `[trigger]` | `[ACL]` |
| service_role TRUNCATE `audit_logs`, `risk_events` | **allowed** — no assertion (finding below) | `[ACL]` |
| service_role UPDATE/DELETE/TRUNCATE `ledger_entries`, TRUNCATE `limit_usage` | `[ACL]` | `[ACL]` |
| owner UPDATE/DELETE `audit_logs`, `ledger_entries`, `limit_usage`; DELETE `risk_events`; TRUNCATE `ledger_entries`, `limit_usage` | `[trigger]` | `[trigger]` |
| owner TRUNCATE `audit_logs`, `risk_events` | **allowed** — no assertion | `[trigger]` |
| EXECUTE: each of 19 functions × anon, authenticated, service_role | `[ACL]` executor's call completes (and is undone), anyone else `permission denied for function` | same; `is_admin`, `has_admin_role` executable by nobody |

The EXECUTE matrix calls every function with harmless arguments, then raises a private SQLSTATE so that
whatever the call did is rolled back. An executor's call must complete. If a function runs but fails
inside, that also counts as a failure. A test also requires that every function in `public` has an
expectation and that every expectation has a function. The expectations are written in SQL per profile
and are independent of the TypeScript registry. Both are checked against the same database in the same
run, so if they disagree, one of them fails.

### Changes in Phase 1.6

- **N1 — an UPDATE the UPDATE policy alone decides.** `[RLS] … UPDATE of another user's profile` filtered
  on `user_id`. That reads a column, so the SELECT policy applied too, and it hid the other user's row by
  itself: a widened `profiles_own_update` went unnoticed (Phase 1.5: 279/279 with the policy at
  `true`). New: `pg_temp.update_reaches_only_own_rows()` runs `update … set …` with no WHERE clause. It
  must succeed and reach exactly the user's own rows. Then, as the owner (the trusted context, who sees
  every row), `[RLS] no other user's profile or notification was changed by the user` checks every other
  user's rows. The `user_id`-filtered tests stay, renamed `… by user_id …`: they are what a PostgREST
  filter sends.
- **N5 — no conversion error passes as a refusal.** `is_test_defect()` also covers `22P02`, `22P03`,
  `22007`, `22008`, `22018`, `22021` and `22025` (a malformed uuid, number, enum, timestamp or cast in
  the test's own SQL). `rejects_with()` / `rejects_with_message()` still accept a defect code that the
  test names explicitly. The nine access and append-only refusals that used the generic `rejects()` now
  name their code and message (`42501 permission denied for …`, `23001 … is append-only; …`).
  - Helper self-tests in the suite: `rejects()` must stop on a syntax error, an unknown table, column or
    function, and a malformed uuid, number or timestamp; `rejects_with(…, '42501')` must stop on an
    unknown table; `no_effect()` must stop on a malformed uuid.
  - What they must still accept: a genuine `42501`, and a conversion error a test names explicitly.

No assertion expects a REVOKE to stop the table owner. The owner tests expect the trigger's `23001`
(`… is append-only; TRUNCATE is not permitted`); see [The table owner](#the-table-owner-separate-trust-model).

## How to run

```bash
npm test                 # unit tests, then test:db (profile 017), then test:db:019
npm run test:db          # PostgreSQL 16 (newest under /usr/lib/postgresql), migrations 001–017
npm run test:db:019      # the same plus supabase/drafts/019_table_privileges.sql, profile 019
# PostgreSQL 17 from a directory with server binaries only (initdb, pg_ctl, postgres)
PGBIN=/tmp/pg17/bin PSQLBIN=/usr/lib/postgresql/16/bin npm run test:db
PGBIN=/tmp/pg17/bin PSQLBIN=/usr/lib/postgresql/16/bin npm run test:db:019
```

## Results

Final runs of Phase 1.6, on the working tree as it stands (019 file sha256 `69881ea7…`). Local throwaway
clusters only; psql 16.15 is the client for both server versions.

| Server | Built by | 019 | Profile | Invariants | Money catalog | Privilege registry | Round trip |
|---|---|---|---|---|---|---|---|
| 16.15 | `scripts/test-db.sh` | no | 017 | 282/282 | ok | ok — 23 tables × 4 roles × 7 privileges, 0 column grants, 19 functions, 21 policies, 0 memberships; MAINTAIN not checked | ok |
| 16.15 | `npm run test:db:019` | yes | 019 | 292/292 | ok | ok — same, 4 column grants | ok |
| 17.10 | `scripts/test-db.sh` | no | 017 | 282/282 | ok | ok — 23 × 4 × 8 privileges | ok |
| 17.10 | `npm run test:db:019` | yes | 019 | 292/292 | ok | ok — 23 × 4 × 8, 4 column grants | ok |
| 17.10 | scratchpad: hosted-015 replica + package v4 + 019 | yes | 019 | 292/292 | ok | ok — 6 memberships (authenticator SET-only, postgres) | ok |
| 16.15 | scratchpad: clean build 001–015, then 016, 017, 019 | yes | 019 | 292/292 | ok | ok — 6 memberships | ok |

Before Phase 1.4 the suite had 115 assertions; Phase 1.4 brought it to 269 (017) / 279 (019); Phase 1.6
adds 13 (11 helper self-tests, the two unfiltered UPDATEs) to 282 / 292. All 115 earlier assertions are
still there and pass (rechecked on the final tree). 36 money columns, 6 jsonb columns, 11 callable functions,
409 ledger postings and 1106 window-usage rows round-tripped exactly in every run.

**Order and atomicity** (scratchpad `order_atomic.py`). Each case below was sent three ways: psql with
`-1` and `ON_ERROR_STOP`, psql in autocommit without `ON_ERROR_STOP`, and as one Query message (SQL
Editor). After each attempt the whole schema and every ACL in the database were compared with the state
before it:

| Case | PostgreSQL 17 (hosted-015 replica) | PostgreSQL 16 (clean build) |
|---|---|---|
| 015 without 016/017 (package v4 not applied) | refused, unchanged, ×3; **v4 then applies** | refused, unchanged, ×3 |
| 016 applied, 017 not | — | refused, unchanged, ×3 |
| run by a role that owns nothing (`authenticator`) | refused, unchanged, ×3 | refused, unchanged, ×3 |
| failure after the first changes (an event trigger refuses 019's CREATE TRIGGER) | failed in step 3, unchanged, ×3 | failed in step 3, unchanged, ×3 |
| right order | applied; 292/292, both registries, round trip | applied; the same |
| second run | refused ("019 has already run"), unchanged, ×3 | refused, unchanged, ×3 |

psql without `ON_ERROR_STOP` exits 0 even though the statement was refused. Only the printed error shows
the refusal; the procedure must read it, or use `ON_ERROR_STOP`.

**Independent check** (scratchpad `indep16.py`). Expected privileges were derived from the pre-019
database itself — its policies, its guard and append-only triggers, its existing grants — without the
registry, and read back with `aclexplode` and `has_*_privilege`:

- PostgreSQL 16 clean, 17 clean and the 17 replica: 0 mismatches for 6 roles × 23 tables;
- ACL entries removed and added: 231/4 on 16 and 300/4 on 17, none outside `public`;
- non-ACL schema changes: the two triggers only;
- the registry's 019 profile equals the derivation for tables, columns and functions;
- the result is identical between psql and the SQL Editor path.

**HTTP through PostgREST 12.2.3** (scratchpad `postgrest_smoke.py`; closes C3). PostgREST ran against the
hosted-015 replica + v4, with roles carried by HS256 JWTs as Supabase sends them. Each request the
application makes was sent before and after the canonical 019, with the same path, the select string
`moneySelect()` builds, the filters, and `Accept` for `.single()`:

- anon: trading pairs with embedded assets; assets;
- authenticated: the same two, own profile, account tiers, own staff row, the tier on the dashboard,
  tier limits, own wallets;
- service_role: profile, tier limits, tiers, higher tiers, and RPC `limit_usage_total`.

All 15 returned the same status (200) and a byte-identical body. The requests no application code makes
changed exactly as intended:

| Request | Before 019 | After 019 |
|---|---|---|
| anon reads `wallets`, `profiles` | 200, `[]` | 401, `42501` |
| user reads `audit_logs` | 200, `[]` | 403, `42501` |
| `service_role` calls `is_admin` | 200, `false` | 403, `42501` |

Unchanged:

- a user reading another user's profile: 200 `[]`;
- renaming oneself: 204;
- changing one's own tier: 403;
- marking one's own or another user's notifications read: 204 — RLS matches no row of the other user's;
- anon calling `limit_usage_total`: 401.

## Sensitivity (scratchpad only)

A passing test proves nothing until it has been seen failing. Two layers do this.

**In the repository.** `scripts/__tests__/check-privileges.test.ts` breaks every rule of the privilege
check on a synthetic catalog (48 tests). The helper self-tests in `01_invariants.sql` require each
helper to stop on a malformed statement.

**Against real databases.** The scratchpad harness (`sensitivity16.py`, the Phase 1.4 set plus the N1/N2
mutations) builds the database as `scripts/test-db.sh` does, profile 019 with the canonical file. For
each mutation it:

1. copies the database and applies one declarative change — a privilege, membership, attribute, policy
   or trigger;
2. runs the repository's invariants, money catalog check and privilege check unchanged;
3. applies the exact inverse to the same database and runs all three again.

A mutation counts only if the named check fails with the named message (for invariants: a FAIL row, or
the run stopping with that error), and only if all three pass again after the inverse.

Final run on the final tree:

- PostgreSQL 17.10: 51 of 51 detected and restored;
- PostgreSQL 16.15: 49 of 49 — the same mutations without the two MAINTAIN ones, with identical
  outcomes.

"Fails" means the check reported the mutation:

| Mutation (then undone) | Profile | Registry | Invariants |
|---|---|---|---|
| extra table grant | 017, 019 | fails | passes |
| missing table grant | 017, 019 | fails | fails |
| extra column grant | 017, 019 | fails | 017: passes / 019: fails |
| extra EXECUTE | 017, 019 | fails | fails |
| missing EXECUTE | 017, 019 | fails | fails |
| unregistered table | 017, 019 | fails | fails |
| unregistered function | 017, 019 | fails | fails |
| grant to a role outside the registry | 017, 019 | fails | passes |
| RLS disabled | 017, 019 | fails | 017: fails / 019: passes |
| policy calls a function its role cannot execute (folded away) | 017, 019 | fails | passes |
| policy calls a function its role cannot execute (reached) | 017, 019 | fails | fails |
| leaking read policy | 017, 019 | fails | fails |
| guard trigger removed | 017, 019 | passes | fails |
| missing MAINTAIN | 017 | fails | passes |
| N1 UPDATE policy widened: USING and WITH CHECK true | 017, 019 | fails | fails |
| N2 client role is a SET-only member of service_role | 017, 019 | fails | passes |
| N2 CREATE on schema public for a client role | 017, 019 | fails | passes |
| N2 SECURITY INVOKER function made DEFINER | 017, 019 | fails | passes |
| N2 FORCE RLS | 017, 019 | fails | passes |
| missing column grant | 019 | fails | fails |
| column SELECT grant (ACL branch strictness) | 019 | fails | fails |
| PUBLIC table grant | 019 | fails | fails |
| owner TRUNCATE trigger removed | 019 | passes | fails |
| extra MAINTAIN | 019 | fails | passes |
| N1 UPDATE policy widened: USING true only | 019 | fails | fails |
| N1 notifications UPDATE policy widened | 019 | fails | fails |
| N2 client role inherits pg_read_all_data | 019 | fails | fails |
| N2 unexpected member of service_role | 019 | fails | passes |
| N2 authenticator inherits a client role | 019 | fails | passes |
| N2 anon gets BYPASSRLS | 019 | fails | passes |
| N2 search_path no longer pinned | 019 | fails | passes |
| N2 extra restrictive policy | 019 | fails | fails |
| N2 table owned by a client role | 019 | fails | fails |

Every mutation is reported by at least one of the two checks, and neither covers all of them:

- the registry alone sees grants that another layer still neutralises, and role, schema and function
  attributes;
- the invariants alone see removed triggers.

**Malformed statements inside a test** (the same clusters):

| Statement made malformed | Helpers before Phase 1.4 | Helpers after Phase 1.5 | Helpers now |
|---|---|---|---|
| `public.walets` (unknown table) in §80.12 | 115/115 PASS | — | run stops: `relation "public.walets" does not exist` |
| `'WITHDRAWL'` (bad enum literal) in the generic `rejects()` test §19.1 | — | 269/269 PASS | run stops: `invalid input value for enum` |
| `'not-a-uuid'` in the access test §80.12 | — | 269/269 PASS | run stops: `invalid input syntax for type uuid` |

## Findings

1. **Under 017 a signed-in user can change their own `profiles.id`, `profiles.created_at`,
   `notifications.id` and `notifications.created_at`.** The table-level UPDATE grant allows it, the
   own-row policy matches, and the guard triggers do not cover these columns (`updated_at` is
   overwritten by `touch_updated_at`). Measured on PostgreSQL 16.15. Each statement updated the row
   under 017. Under the draft, each was refused with `permission denied for table …`. The application
   looks profiles up by `user_id` and does not read `notifications` at all (code search), so nothing
   depends on these values today. 019 closes it with the column grants. The repository tests assert the
   refusal under 019 only.
2. **Under 017 `service_role` can TRUNCATE `audit_logs` and `risk_events`, and so can the owner.** These
   are append-only by row trigger, which TRUNCATE does not fire. 019 removes the privilege from
   `service_role` and adds statement triggers that refuse the owner (`[trigger]`, tested).
3. **An existing assertion was vacuous.** `§47 user cannot change another user's account status` checks
   "Bob's row is not `Hijacked`" as Alice, who cannot see Bob's row at all, so the check held whatever
   happened. It still passes. It is now backed by the `user_id`-filtered and the unfiltered UPDATE tests,
   and by a check run as the owner over every other user's profile and notification (Phase 1.6, N1).
4. **Behaviour tests cannot see every latent privilege fault.** A policy `using (public.is_admin())`
   added next to `assets_public_read` leaves every query working, because PostgreSQL folds
   `true OR is_admin()` and never calls the function. Only the catalog rule reports it. Added to a table
   where the call is reached, the same policy breaks the user's wallet read and both checks fail.
5. **(Phase 1.5) 019 had no protection against the wrong order.** Fixed in Phase 1.6 (preflight;
   [Results](#results)).
6. **(Phase 1.5) A widened own-row UPDATE policy went unnoticed.** With `profiles_own_update` at
   `using (true) with check (true)`, an UPDATE without WHERE changed another user's profile, and the
   whole suite still passed. Fixed in Phase 1.6 (N1). The same mutation now fails the unfiltered-UPDATE
   test, the owner's check and the policy registry, while the `user_id`-filtered test still passes —
   which is why it was not enough.
7. **(Phase 1.6) The preflight's own non-owner path** raised `permission denied for schema` instead of
   refusing (fixed, above).

## Phase 1.5 conditions and findings: status

| Item | Status | Evidence |
|---|---|---|
| C1 one canonical SQL file, by hash | **closed** | `supabase/drafts/019_table_privileges.sql` + `.sha256`. This document holds no copy. `test-db.sh` refuses a file that does not match (a one-word edit is refused before any cluster exists) and prints the hash it ran. Every Phase 1.6 run used the file |
| C2 order protection | **closed** | Preflight; single statement. [Order and atomicity](#results) on 16 and 17 |
| C3 HTTP compatibility | **closed for PostgREST 12.2.3 on a local replica** | [HTTP through PostgREST](#results). Not covered: Supabase's gateway (Kong, API keys), the hosted PostgREST version, pg_graphql, Studio |
| C4 hosted preflight and postflight (read-only) | **prepared; open until v4 is applied** | Phase 1.7: `supabase/drafts/019_preflight.sql`, tested on 40 local states, run read-only on hosted: BLOCKED for exactly the reasons the 015 replica gives. Postchecks and their expected signature in `docs/rollout-019.md` (rehearsed locally) |
| C5 decisions recorded | **open** | Recommendations A–E in `docs/rollout-019.md` §9, each awaiting the owner's approval |
| N1 widened UPDATE policy | **closed** | Unfiltered-UPDATE test, owner check, policy registry; 3 mutations detected on 16 and 17 |
| N2 catalog completeness | **closed for what is listed**; the rest is named in [Outside the model](#outside-the-model) | New rules with 48 unit tests, and DB mutations on 16 and 17 |
| N3 `supabase_admin` default ACL on hosted | **analysed; open as decision C** | [N3](#n3-default-privileges-for-objects-created-later): latent (no object in `public` is `supabase_admin`'s today), not fixable by `postgres`, not changed by 017 or 019 |
| N4 local environment vs hosted | **tabulated; no blocker found** | [N4](#n4-hosted-against-the-local-environments); residual: `supautils` and 17.11 not reproduced |
| N5 error classification | **closed** | Conversion errors are defects; 11 helper self-tests in the suite; typo mutations stop the run |
| N6 document overstatements | closed | This revision |
| N7 evidence only in the scratchpad | open | Harnesses and logs are in the session scratchpad. Package v4 is in `supabase/drafts/v4/` since Phase 1.9. The repository changes are uncommitted. Minimal set and proposed paths: [Evidence](#evidence-to-keep-n7) |

## Phase 1.7: hosted readiness

### Canonical SQL, re-checked

- The baseline matched the Phase 1.6 hashes. 019 is the only SQL copy in the repository. It sits outside `supabase/migrations`, and every harness reads it from its path.
- **Hash check fixed.** `test-db.sh` used to skip the check for a draft without a `.sha256`, and ran the file after checking it (a window to change it). Both are fixed above.
  - Negative runs: a one-byte change and an unpinned draft in `supabase/drafts` are both refused before any cluster exists.
- **Reruns on the current tree, all passing:**
  - test-db, profiles 017/019 on 16.15 and 17.10 (282/292 assertions);
  - order and atomicity (16, 17);
  - independent derivation (16 clean, 17 clean, 17 replica);
  - PostgREST smoke.
- **Scope of the SQL.** The text does exactly what [The SQL](#the-sql) lists:
  - table and column grants for the client roles;
  - `service_role`'s table privileges;
  - two TRUNCATE triggers;
  - the eight functions' EXECUTE.

  The preflight reads the catalog only and sets `lock_timeout` for its own transaction. Nothing else: no default privileges, policy, role, owner or history row.

**Refusal, atomicity, exit code and state are four different things:**

| Client | 019 refuses | What is applied | Exit code | Database afterwards |
|---|---|---|---|---|
| psql `-1 -v ON_ERROR_STOP=1` | error shown | nothing | 3 | unchanged |
| psql without `ON_ERROR_STOP` | error shown | nothing (one statement) | **0** | unchanged |
| one message (SQL Editor) | error shown | nothing | 1 (psql `-c`) | unchanged |

The exit code alone is not evidence of success, and an error message alone does not say what was
committed. Only a read-only check of the state does. That stops being academic once 019 is sent
together with a second statement, e.g. its history row: under psql without `ON_ERROR_STOP` the refusal
does not stop the insert, and the history then records a 019 that never ran (rehearsed). Hence the rules
in `docs/rollout-019.md` §4.

### The read-only preflight

`supabase/drafts/019_preflight.sql`:
- `set transaction read only` and one `SELECT` over the catalog and the migration history (version, name, md5 of the text);
- one row per check and a verdict: `PASS` only if every blocking check holds; a query error means BLOCKED (not verified);
- `T1` fails unless the run itself was read-only.

Checks:
- **H1–H4** history 001–017 exactly, no 019;
- **S1–S6** 016/017 markers;
- **O1–O3** exactly the expected tables and functions;
- **W1** owners;
- **A1–A5** grantees, column grants, function grants, the 017 state of the eight functions, no partial 019;
- **R1–R3** RLS, FORCE, all 21 policies whole;
- **M1–M3** client-role attributes and memberships, SET-only included;
- **V1** PostgreSQL 17;
- warnings **D1** (N3) and **M4** (roles that read everything);
- info rows for postgres's default privileges, `postgres ∈ supabase_admin`, and timeouts.

Local results, PostgreSQL 17.10 replica unless noted. All 40 states gave the expected verdict and reasons.

| State | Verdict | Failing checks |
|---|---|---|
| hosted 015 replica | BLOCKED | A3 H3 H4 O3 S1–S6 |
| replica + v4: psql read-only, one message, as `authenticator` | PASS, PASS, BLOCKED (query error) | — / — / no access to history |
| replica + v4 with `psql -f` and no BEGIN (not read-only) | BLOCKED | T1 |
| 32 drifts, each rolled back: extra grantee, PUBLIC grant, owner change, SET-only and inheriting memberships, BYPASSRLS, PUBLIC/anon EXECUTE, lost EXECUTE, `service_role` INSERT on wallets, disabled TRUNCATE guard, default EXECUTE for anon, policy changed/dropped/added/re-roled, FORCE RLS, RLS off, partial 019 (column grant, one SELECT revoked, one trigger), extra table/sequence/function, probe back, history row missing/extra/altered/reordered | BLOCKED, each naming its cause | as expected per drift |
| `supabase_admin` defaults in `public` as on hosted; `postgres ∈ pg_read_all_data` | PASS + WARN | D1; M4 |
| replica + v4 + 019 | BLOCKED | A2 A4 A5 (the post-019 signature, with H4 once the history row exists) |
| clean 001–017 build without history, 17.10 / 16.15 | BLOCKED | H1–H4 / H1–H4 V1 |

On replica + v4, step 2 (`02_money_catalog.sql` → `check-privileges.ts 017`) matched, and the replica's
catalog was unchanged after all of the above.

**Hosted (read-only, 2026-10-12).** First a probe returned `transaction_read_only = on` with no transaction
id assigned: the MCP SQL channel runs a batch as one read-only transaction. Then the final preflight file
(sha256 in `019_preflight.sql.sha256`) returned:
- **BLOCKED**, read only: on;
- failures A3 H3 H4 O3 S1–S6: the set the 015 replica gives, i.e. package v4 not applied. O3 names them: `limit_usage_total` missing; `_jimocex_ddl_probe` and `limit_usage_in_window` present;
- ok: H1 H2 O1 O2 W1 A1 A2 A4 A5 R1–R3 M1–M3 T1 V1 (PostgreSQL 17.11);
- warnings D1, M4;
- I1: `statement_timeout` 2 min in that session, none stored for `postgres` or the database. The SQL Editor's own limit was not read.

An earlier run of a draft of the file gave the same verdict and failures. The verdict will stay BLOCKED
until v4 is applied.

Two more read-only queries:
- **Fingerprint.** The `public` schema's catalog fingerprint (13 categories, 1188 items: columns, constraints, indexes, triggers, policies, functions and their ACLs, table ACLs, default ACLs, schema ACL, enums, comments) is identical, category by category, to the one taken before Phase 1.5. The category that reads `tier_limits` rows was left out.
- **Dependents.** `pg_depend` shows no object that depends on any of the eight functions 019 changes. `track_functions` is `none`, so there are no call statistics. Step 2 was not run on hosted: at 015 it can only
report v4's differences, and its 105 kB JSON belongs in a file, not an agent transcript.

### N3: default privileges for objects created later

Read on hosted (read-only, `pg_default_acl`; no role has a global row):

| Creating role | Schemas | Tables | Sequences | Functions |
|---|---|---|---|---|
| `postgres` | `public`, `storage` | `anon`, `authenticated`, `service_role`, `postgres`: `arwdDxtm` | the same four: `rwU` | the same four: `X` |
| `supabase_admin` | `public`, `graphql`, `graphql_public` | `postgres`, `anon`, `authenticated`, `service_role`: `arwdDxtm` | the same four: `rwU` | the same four: `X` |
| `supabase_admin` | `extensions` | `postgres` only, with grant option | `postgres` only | `postgres` only |
| `supabase_admin` | `realtime` | `postgres`, `dashboard_user` | the same | the same |
| `supabase_auth_admin` | `auth` | `postgres`, `dashboard_user` | the same | the same |

What a new object in `public` gets (global default, or the built-in one when there is no global row, plus
the `public` row):

| Created by | Table | Sequence | Function | Type |
|---|---|---|---|---|
| `postgres` today (hosted, 015) | client roles: all 8, direct | client roles: SELECT, UPDATE, USAGE, direct | EXECUTE via PUBLIC (built-in) **and** direct to the client roles | USAGE via PUBLIC |
| `postgres` after 017 (+019) | unchanged (B2) | unchanged | owner only | USAGE via PUBLIC |
| `supabase_admin` (unchanged by 017 and 019) | client roles and `postgres`: all 8, direct | `rwU`, direct | EXECUTE via PUBLIC and direct | USAGE via PUBLIC |

Locally, on replica + v4 + 019 with hosted's `supabase_admin` rows recreated, each case rolled back
(`n3_local.py`):
1. `postgres` running `alter default privileges for role supabase_admin …`: `permission denied to change default privileges`.
2. A table `postgres` creates after 017 + 019: `anon` SELECT/INSERT/UPDATE/DELETE/TRUNCATE, RLS off. A function `postgres` creates: owner only.
3. A table and a function `supabase_admin` creates in `public`: client roles hold every table privilege; PUBLIC, `anon`, `authenticated`, `service_role` can execute the function.
4. `postgres` then revoking from `anon`/PUBLIC: `WARNING: no privileges could be revoked`, nothing changes. `postgres` is neither the owner nor the grantor, and its own grant carries no grant option.
5. Handed to `postgres` with ALTER OWNER: every grant survives, now with `postgres` as grantor. Only from then on can `postgres` revoke them.
6. Run by `supabase_admin` itself (per-schema revokes for tables, sequences and functions, plus a global `revoke execute on functions from public`): a new table and function give the client roles nothing.
7. (Phase 1.8) The three per-schema revokes alone, without the global one: a new table gives the client roles nothing, but a new function is still executable through PUBLIC, `anon` included.

**Why `alter default privileges for role postgres` cannot fix it.**
- Default privileges are rows keyed by the creating role. A statement for `postgres` writes `postgres`'s rows and applies to objects `postgres` creates.
- Changing `supabase_admin`'s rows requires being `supabase_admin` or a member of it.
- On hosted, `postgres` is not a member (info row M5), and `supautils.reserved_roles` lists `supabase_admin`.
- No project migration (they run as `postgres`) can change those rows.

**Who creates in `public` as `supabase_admin`.** Platform jobs, and per `supautils.privileged_extensions_superuser = supabase_admin`, the privileged extensions. If one is installed with schema `public`, its objects are created there by that role. Whether `supautils` afterwards hands them to `postgres` was not verified. Today no extension lives in `public` and every object there is `postgres`'s (W1), so N3 is latent.

**Minimal separate fixes** (proposals; none applied, none changes an existing ACL):
- **N3-a**, removes the cause for tables and sequences; needs `supabase_admin`, i.e. Supabase support:
  - per-schema `revoke all on tables|sequences|functions from anon, authenticated, service_role` for role `supabase_admin` in schema `public` (case 7);
  - PUBLIC's EXECUTE on new functions comes from the built-in global default and can only be removed by a global `revoke execute on functions from public` for that role (case 6). That row would apply to functions `supabase_admin` creates in every schema (`extensions`, `graphql`, …), so it is not minimal and is left to Support's advice (draft request: `docs/rollout-019.md` §10).
- **N3-b**, compensating, within the project's reach. The rule: nothing is created in `public` except by `postgres` through reviewed migrations, and extensions go to `extensions`. Plus the preflight run read-only on a schedule: W1, O1, O3, A1, A3 and D1 report any object not owned by `postgres`, any unexpected relation or function, any new grantee, any change of these defaults. If such an object appears it must be handed to `postgres` (case 5) or dropped, which again needs `supabase_admin`.
- **B2**, `postgres`'s own table and sequence defaults:
  - `alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated`, and the same for sequences;
  - `… revoke truncate, references, trigger on tables from service_role`, and MAINTAIN on 17 only (rehearsed in Phase 1.8: `docs/rollout-019.md` §10).

  `postgres` can run this as a migration. It is the same kind of gap and is closer at hand: every future table starts fully granted unless its migration says otherwise.

**Four things that must not be confused:**
1. **Existing objects' privileges.** What 019 changes. Default privileges never touch an existing object.
2. **Default privileges.** Applied once, at creation, from the creating role's rows only. 017 changed `postgres`'s function defaults. Nothing has changed table or sequence defaults, or anything of `supabase_admin`'s.
3. **The owner's powers.** `postgres` owns everything in `public`. Its privileges are implicit: no REVOKE removes them, and it can drop its own triggers. It also has BYPASSRLS and `pg_read_all_data`. `supabase_admin` is a superuser. 019 constrains neither ([The table owner](#the-table-owner-separate-trust-model)).
4. **SECURITY DEFINER functions.** 12 functions in `public` (at 015) run as `postgres` with `search_path = ''`. 019's table REVOKEs do not limit what they do. Who may call them is decided by their EXECUTE ACL alone, and what they do by their bodies.

### N4: hosted against the local environments

Sources:
- **RO** — read-only on hosted in Phase 1.7;
- **P1.5** — Phase 1.5 read-only artifact;
- **L** — local run;
- **A** — assumption, not verified.

| Difference | Hosted | Local (`test-db.sh` stub / h4 replica) | Effect on 019 | Reproduced | Source | Blocks rollout |
|---|---|---|---|---|---|---|
| Client roles' `rolinherit` | `anon`, `authenticated`, `service_role` INHERIT | NOINHERIT in both | none while they belong to no role (M2 ok on hosted); an inheriting membership would add privileges 019 does not see | membership drifts yes; INHERIT client roles no | RO, L | no (M2 blocks if it changes) |
| Members of the client roles | `authenticator` and `supabase_realtime_admin`: SET only; `postgres`: INHERIT, ADMIN | stub: none; replica: `postgres`, `authenticator` SET only; no `supabase_realtime_admin` | SET-only members get exactly the client role's privileges, which 019 reduces | partly | RO, L | no (M3) |
| `postgres` memberships | `pg_read_all_data`, `pg_monitor`, `pg_signal_backend`, `pg_create_subscription`, `supabase_privileged_role` | none of these | none: `postgres` is the owner anyway | `pg_read_all_data` as a drift (M4 warn) | RO, L | no |
| Server version | 17.11 | 16.15 and 17.10 | MAINTAIN exists on 17 (019 revokes it there); no catalog change expected between minor releases | 17.10 only | RO, L, A | no |
| Event triggers | 6: `pgrst_ddl_watch`, `pgrst_drop_watch`, `issue_pg_cron_access`, `issue_pg_graphql_access`, `issue_pg_net_access` (ddl_command_end, tag CREATE EXTENSION), `issue_graphql_placeholder` (sql_drop, tag DROP EXTENSION) | stub: none; replica: the two `pgrst_*` with hosted's definitions | `pgrst_ddl_watch` fires on 019's CREATE TRIGGER (schema reload; exercised with PostgREST). The four `issue_*` are filtered by tag in the catalog and do not fire for 019's commands | 2 of 6 | RO, L | no |
| `supautils` (session preload) | reserved roles, privileged role, privileged extensions run as `supabase_admin` | absent | not expected to touch table/function GRANT/REVOKE or CREATE TRIGGER. If it refuses something, 019 refuses whole | no | RO (settings), A (behaviour) | no; first real run is the test |
| Owners | `public` schema: `pg_database_owner`; 23 tables, 20 functions: `postgres`; no sequences | stub: superuser `postgres`; replica: `postgres` | 019 needs the owner (its preflight; W1) | yes | RO | no |
| Default ACL | see N3; no global rows; `supabase_admin` in `public` | stub/replica: `postgres` rows only | none on 019; future objects (N3, B2) | `supabase_admin` rows only in `n3_local.py` | RO, L | no; decision C |
| RLS, FORCE, policies | RLS on 23/23, FORCE 0, 21 policies equal to 010 | the same (replica from hosted's text) | 019 relies on the policies; R1–R3 | yes | RO | no |
| Schema privileges | `public`: `pg_database_owner` UC; PUBLIC, `postgres`, client roles U | PUBLIC U (PostgreSQL default), client roles U (stub); no explicit `postgres` entry (it has USAGE through PUBLIC and as database owner) | none (019 does not touch schemas) | yes, in effect | RO, L | no |
| SECURITY DEFINER, `search_path`, EXECUTE | 12 definer functions, all non-probe functions `search_path=""`; definer functions: `postgres` + `service_role`; 7 trigger functions: PUBLIC + client roles (017 removes) | replica: hosted's text, the same | A3/A4 pin the state 019 starts from | yes | RO | no |
| Extensions | `pgcrypto`, `uuid-ossp`, `pg_stat_statements` in `extensions`; `supabase_vault`; none in `public` | `pgcrypto`, `uuid-ossp` | none | partly | RO | no |
| Data volume and traffic | real rows, concurrent writers | none / test rows | lock waits: 019 gives up after 5 s per lock and applies nothing (rehearsed) | lock case yes | L | no; rollout window |

The replica is not the hosted project. What it does not have (supautils, four event triggers, Supabase's
other roles, real traffic, 17.11) is listed above. The preflight checks the parts that 019 depends on.

### Findings (Phase 1.7)

8. **`test-db.sh`'s hash check was optional and had a gap** (above). Fixed; negative-tested.
9. **A label in 019's refusal message is wrong.** It reports a missing `limit_usage_total` as "016: …", but 017 creates that function (016 drops `limit_usage_in_window`). The check itself is right. Changing the text changes the pinned hash, so it is left for the owner's decision on 019.

   Phase 1.8 analysis:
   - **Exact text.** Line 76, `'016: public.limit_usage_total(…) returning text does not exist'`, and the comment on line 71, `-- What 016 leaves behind.`
   - **Who depends on the text.** No test or harness matches it; they look for `019 refused` only.
   - **Option A**, correct the text. Changing the message alone gives sha256 `e9350ce2…`; with the comment, `4fc613ad…` (computed on scratch copies, the canonical file untouched). That means:
     - a new `.sha256`;
     - new hash and md5 references in both documents;
     - re-running everything that ran on 019: test-db (16/17, profiles 017/019), order and atomicity, independent derivation, sensitivity 16/17, PostgREST smoke, preflight tests, rollout rehearsal, `npm run verify`;
     - a new approval by the new hash.

     The Phase 1.4–1.7 logs would then describe the previous file.
   - **Option B**, keep the SQL and document the label. The operator note is in `docs/rollout-019.md` §8.
   - **Recommendation:** B, and fold A into any later change of 019 (decision D, owner approval required).
10. **The comment in `src/lib/db/money-columns.ts`** says `is_admin`/`has_admin_role` are "used by server code". No code in the repository calls them (search below). Left unchanged: application code is outside this phase.

### Decisions A–C: evidence (recommendations in the Phase 1.7 report)

- **Callers found** (repository search of `src`, `scripts`, `supabase`; no `supabase/functions`; no `pg_cron` on hosted):
  - `limit_usage_total` is the only database function the application calls (`src/lib/engines/limit-engine.ts`);
  - `ledger_post` is named in the write helper's documentation and called inside `release_withdrawal_hold` (as `postgres`, needing no grant);
  - `claim_deposit_for_credit`, `claim_provider_event`, `expire_stale_quotes`, `mark_trade_settled` and `release_withdrawal_hold` have no caller;
  - `is_admin` and `has_admin_role` are used by no policy, no function and no code.
- **Not searched:** callers outside this repository (Edge Functions deployed from elsewhere, external jobs). Before revoking or dropping anything, check those, and if wanted the function call statistics (`pg_stat_user_functions`, with `track_functions` on).

### Evidence to keep (N7)

Nothing was moved in Phase 1.7. The scratchpad copies stay where they are. Minimal set and proposed
places, if the owner wants the evidence in the repository:

| Material | Scratchpad source | Proposed path |
|---|---|---|
| Replica builder and suite runner | `hosted4/h4.py`, `p14/p14lib.py` (its `P019` still points at the superseded Phase 1.3 draft: delete it when moving), `p15/indep.py` | `scripts/replica/` |
| Hosted 015 as applied: history, text of 001–015, the probe, the fingerprint query (no user data; `created_by` not kept) | `hosted4/hosted_history.txt`, `hosted4/hosted_text/`, `hosted4/probe_exact.sql`, `hosted4/fp_core.sql` | `supabase/tests/replica/hosted-015/` |
| Package v4 and its hash | `hosted5/apply_016_017.sql` (sha256 `2816d689…`) | **done in Phase 1.9**: `supabase/drafts/v4/apply_016_017.sql`, byte-identical, with `.sha256` and `README.md` (not yet committed) |
| Order/atomicity, independent derivation, sensitivity 16/17, PostgREST smoke | `p16/order_atomic.py`, `p16/indep16.py`, `p16/sensitivity16.py`, `p16/postgrest_smoke.py`, `p16/selects.json` | `scripts/replica/scenarios/` |
| Preflight tests, rollout rehearsal, N3 cases | `p17/preflight_local.py`, `p17/rollout_rehearsal.py`, `p17/n3_local.py` | `scripts/replica/scenarios/` |
| Final logs, sensitivity table, tree hashes | `p16/final/`, `p17/runs/` | `docs/evidence/019/` |
| Hosted read-only outputs | `p17/hosted/` | `docs/evidence/019/hosted/` |
| Tools | Node 22.22.0, npm 10.9.4, Python 3.13.16, PostgreSQL 16.15 (Ubuntu) and 17.10 (server-only build at `/tmp/pg17`), psql 16.15, PostgREST 12.2.3 (binary sha256 `870a77f4…`, 17 MB) | versions in `docs/evidence/019/README.md`; the binary not kept |

Every harness hard-codes the scratchpad path and expects `/tmp/pg17` and `/usr/lib/postgresql/16`.
Moving means parameterising those paths, and re-running to show the moved copy reproduces the logs.
Leave out: cluster directories (already deleted), the PostgREST binary, catalog JSON (regenerated on
each run).

## The table owner (separate trust model)

`postgres` owns every table and function in `public`. An owner's privileges are implicit: no GRANT
adds them and no REVOKE removes them, so no test here expects a REVOKE to stop the owner. On the
append-only tables only triggers stand in the owner's way, and the owner can disable or drop its own
triggers. The suite itself disables `profiles_touch` and `notifications_touch` for one statement, to
write an old timestamp. The column guards also let `postgres` through by design (`current_user` check).

On the hosted project, the role that owns everything is also the role of the SQL Editor, of migrations
and of the MCP SQL path. The append-only guarantee for `ledger_entries`, `audit_logs`, `limit_usage` and
`risk_events` therefore holds against every API role and against `service_role`, not against whoever can
run SQL as `postgres`. Closing that is a design decision outside 019, and none of these options has been
tested:

- a separate owner role that is not used for day-to-day SQL;
- restricting who holds the database password;
- detection rather than prevention: reconciliation (`reconcile_wallets`) and an audit trail kept outside
  the database.

## Not verified

- Nothing that changes state ran against the hosted project. It is still at 015. Phase 1.7 read its
  catalog only (read-only transactions). The replica is a reconstruction from what those checks saw, not
  the project itself.
- **The API surface beyond PostgREST.** The application's own requests were exercised through
  PostgREST 12.2.3 on a local replica (C3). Not exercised:
  - Supabase's gateway (Kong, `apikey` handling) and the hosted PostgREST version;
  - pg_graphql, Studio, and Realtime (the application has no Realtime subscription).
- **PostgreSQL versions.** PostgreSQL 15 was not run. The exact refusal messages the tests compare
  (`permission denied for table|function <x>`, `new row violates row-level security policy …`) were
  measured on 16.15 and 17.10 only. MAINTAIN exists on 17 only, and the check says so on 16.
- **Relations other than tables.** None exist in `public`. A view or sequence fails the check as
  unregistered, but the registry has no model of what their privileges should be.
- **Function behaviour.** The EXECUTE matrix proves the privilege, and that each executor's call
  completes with harmless arguments. It does not test the functions' business logic.
- **B2** (default privileges for tables created later) is not part of 019 and not tested. A new table
  fails `check-privileges.ts` until it is registered.

## Outside the model

What `scripts/privilege-registry.ts` does not pin, so that a passing check says nothing about it:

- **Schemas other than `public`.** Covers `auth`, `storage`, `extensions`, `graphql`, `realtime` and
  `supabase_migrations`: their privileges, functions and default ACLs. Read-only on hosted (Phase 1.5),
  `supabase_admin` holds default privileges in `public` itself that give a table it creates `arwdDxtm`,
  and a function EXECUTE, for all three client roles. 017 does not touch them. An object
  `supabase_admin` creates in `public` (e.g. an extension installed there from the dashboard) would
  appear only on hosted, where `test-db.sh` does not run.
- **Default privileges for tables and sequences (B2).** Function defaults are checked by the money
  catalog.
- **Roles other than the three client roles.** On hosted, `postgres`, `supabase_read_only_user` and
  `supabase_etl_admin` are members of `pg_read_all_data`, all three with BYPASSRLS: they read every row
  whatever 019 says.
  - Pinned: who may be a member *of* a client role, and that a client role is a member of nothing.
  - Not pinned: the client roles' own INHERIT flag (INHERIT on hosted, NOINHERIT in the stub; it has no
    effect while they belong to no role), ADMIN options, and on PostgreSQL 15 the per-membership
    INHERIT/SET options (they are null there).
- **Owners** beyond "not a client role".
- **Triggers and event triggers.** The guard, append-only and TRUNCATE triggers are exercised by the
  invariant suite instead (removing one fails it; Phase 1.4 and 1.6 mutations).
- **Policy semantics.** Expressions are compared as normalised text. An equivalent rewrite fails the
  check (safe direction); a changed one fails it even if harmless.
- **Sequences, views and other relations** have no model of their own; any of them fails as
  unregistered.

## Decisions and residual risks

- **019 itself**: approve, adjust or reject the file whose sha256 is in `019_table_privileges.sql.sha256`.
  Adopting it means:
  - move the file, unchanged, into `supabase/migrations`, after 018 if 018 lands first;
  - put the 019 executors into `DB_FUNCTIONS`;
  - drop profile 017 from the registry and from the per-profile branches of the suite;
  - remove `test:db:019` (the migration loop then runs it).
- **How it is applied to hosted** (C4): `docs/rollout-019.md` — preflight, one transaction for 019 and its
  history row, postchecks with an expected signature, no reverse script.
- **`is_admin` / `has_admin_role`**: no executor in 019, because nothing calls them and they answer
  false for `service_role`. Alternatives are to keep them owner-only, or to drop them (a schema change,
  not 019). Recommendation A in `docs/rollout-019.md` §9 (owner approval required).
- **The six server functions without a caller yet** (and `consume_quote`/`reconcile_wallets`) keep
  `service_role` as designed entry points. The stricter alternative is to grant each when its flow is
  written. Recommendation B in `docs/rollout-019.md` §9 (owner approval required): Edge Functions and
  external jobs have not been checked.
- **`trades` UPDATE/DELETE for `service_role`**: still granted. This is a settlement-design decision.
- **The owner** (above).
- **API-visible change**: refusals instead of empty results for reads no policy allows. No application
  code depends on the old behaviour (Phase 1.3 search).
- **Two encodings of the expectations**: the TypeScript registry (exact grants) and the SQL suite
  (behaviour per profile, EXECUTE expectations). Both are compared with the same database in each run,
  so a divergence fails one of them. Both carry a 017 branch that goes when 019 lands.

## Not in 019

- `ledger_post` amount/type rules — `docs/ledger-posting-model.md`; before the first new posting flow.
- `parseMoney()` precision. The point to refuse a 19th decimal from outside data is `asDecimalString()`
  in `src/lib/money.ts`. The provider contract (`src/lib/providers/market-data/types.ts`) makes it the
  only way an adapter produces a `DecimalString`, but it checks the format only, not the scale. Refusing
  more than 18 decimals there covers every adapter, and `limit-engine.ts` then never truncates. This is
  needed before a market-data provider is connected.
- B2, above.
