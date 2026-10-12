# Database privileges: policy and rules for new migrations

Status: policy implemented by migration 017. The hosted project is still at 015 until 016/017 are applied.
Table privileges are covered by a separate, not yet approved proposal: `docs/proposal-table-privileges.md`.

## Functions: what 017 changes, and why it stays

PostgreSQL gives a new function two layers of default privileges, and both granted EXECUTE:

- the **per-schema** default in `public`, where Supabase grants EXECUTE to `anon`, `authenticated` and
  `service_role` for functions created by `postgres`;
- the **global** default, whose built-in value grants EXECUTE to `PUBLIC` — every role, `anon` included.

A per-schema rule can only add to the global default. 017 therefore revokes both:

```sql
alter default privileges for role postgres in schema public revoke execute on functions from anon, authenticated, service_role;
alter default privileges for role postgres revoke execute on functions from public;
```

From then on a function `postgres` creates — in any schema, `pg_temp` included — is executable by its
owner only, until a migration grants more. Without the second statement the first changes nothing that
matters: `PUBLIC` still reaches every role (measured on PostgreSQL 17: a new function stays executable by
`anon` under the per-schema revoke alone).

What it does **not** touch, each verified on PostgreSQL 17:

| Case | Effect |
|---|---|
| Functions that already exist | none — privileges are fixed when a function is created |
| `CREATE OR REPLACE` of an existing function | none — the ACL is kept |
| `DROP` + `CREATE` | the new function starts owner-only: **re-grant explicitly** |
| Functions created by another role (`supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`, …), even if later handed to `postgres` | none — defaults belong to the creating role |
| A per-schema `GRANT … TO PUBLIC` added later | re-opens that schema (the per-schema layer can add back) |
| Triggers | still fire: EXECUTE is checked when the trigger is created, not when it fires |

Why it stays (decision: keep). Every function in the project already has the privileges it needs without
it: the 11 callable functions are executable by `service_role` only, the 8 trigger functions by nobody,
RLS policies call only `auth.uid()` (owned by `supabase_auth_admin`), and the application calls exactly
one RPC, `limit_usage_total`, through the service-role client. The alternative — revoking only per schema —
leaves a function that a migration or the SQL Editor creates without a REVOKE immediately callable by
`anon` at `/rest/v1/rpc`. With the global revoke the same mistake fails loudly (`42501`) instead.

Known consequence outside this repository: a function created in the SQL Editor or in the Studio function
editor as `postgres` is now executable by nobody until granted. Whether Supabase's extension installer
creates extension functions as `postgres` (they would then start owner-only) could not be verified
locally; the hosted ACLs of existing extension functions suggest they are created by another role.

To undo: `alter default privileges for role postgres grant execute on functions to public;`

### Functions whose service_role grant has no source in the migrations

`claim_deposit_for_credit`, `claim_provider_event`, `expire_stale_quotes`, `has_admin_role`, `is_admin`,
`ledger_post`, `mark_trade_settled` and `release_withdrawal_hold` are executable by `service_role` because
the Supabase default granted it when they were created; no migration grants it explicitly. That is
correct on the hosted project and in `scripts/test-db.sh`, and 017 keeps it (it does not drop any of
them). A future migration that drops and recreates one of them must grant it again; the catalog check
fails if it does not. The draft of migration 019 (`supabase/drafts/019_table_privileges.sql`, reviewed
in `docs/review-019-privileges.md`) states the grant for six of them and withdraws it from `is_admin` and
`has_admin_role`, which answer for `auth.uid()` and so always return false for `service_role`.

## Rules for a migration that creates or replaces a function

1. Follow every `create function` with, in the same migration:
   ```sql
   revoke all on function public.f(<args>) from public, anon, authenticated, service_role;
   grant execute on function public.f(<args>) to <each role that calls it>;
   ```
   The defaults already give nothing; the explicit statements are the record of intent.
2. Classify it in `DB_FUNCTIONS` (callable) or `TRIGGER_FUNCTIONS` in `src/lib/db/money-columns.ts`, with
   the exact `executors`, and give it its executors in `scripts/privilege-registry.ts`. `scripts/test-db.sh`
   fails on a function in neither list (`new_rpc() is not classified in DB_FUNCTIONS`,
   `new_rpc() is not in the privilege registry`) and on any difference between the registered executors
   and the database (`is_admin() is executable by [authenticated,service_role], the registry says [service_role]`).
3. `DROP` + `CREATE` (needed to change a return type) loses the privileges: re-grant.
4. `SECURITY DEFINER` only with `set search_path = ''`, every object schema-qualified, no SQL built from
   arguments. Owner `postgres`.
5. A trigger function is granted to nobody.
6. A function called from an RLS policy must be granted to every role the policy applies to; otherwise
   every query that evaluates the policy fails with `42501` for that role.
7. A public RPC: grant `anon` (and `authenticated`, if signed-in users call it too) explicitly. Without the
   grant PostgREST answers "permission denied for function" — the call fails, it is never silently open.
8. The application calls only functions created by migrations. A function made by hand in the SQL Editor
   is owner-only and is not part of the API.

## Checks that enforce it

| Check | Where | Catches |
|---|---|---|
| catalog vs. money registry | `scripts/check-money-catalog.ts` via `scripts/test-db.sh` | unclassified function; a money function executable by PUBLIC/`anon`/`authenticated`; any default that would give a new function to `PUBLIC`/`anon`/`authenticated`/`service_role` |
| catalog vs. privilege registry | `scripts/check-privileges.ts` via `scripts/test-db.sh` (profile `017`, or `019` for the draft) | executors ≠ registry, EXECUTE for PUBLIC or any other role, unregistered or missing function; every table privilege of every role, column grants, unregistered relations (details in `docs/review-019-privileges.md`) |
| behaviour | `supabase/tests/01_invariants.sql` | a function created now is executable by no client role; every function called as anon, authenticated and service_role: executors' calls complete, everyone else gets `permission denied for function` |
| package postflight | `apply_016_017.sql` | the same, on the hosted project, before COMMIT |
| after a deployment (read-only) | the query below | drift on the hosted project |

```sql
select p.oid::regprocedure, pg_get_userbyid(p.proowner) as owner, p.proacl,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service_role
from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1;
```

## Tables

Today every table follows the Supabase default: `anon`, `authenticated` and `service_role` receive all
table privileges, and RLS decides. The exact state is recorded as profile `017` in
`scripts/privilege-registry.ts` and checked on every run. On money tables 017 removes client writes and `TRUNCATE`; elsewhere
the default remains, including `TRUNCATE` (which RLS does not govern), `TRIGGER`, `REFERENCES` and, on
PostgreSQL 17, `MAINTAIN`. Narrowing them to what each table's policies use is proposed — not decided —
in `docs/proposal-table-privileges.md`, reviewed as the draft of 019 in `docs/review-019-privileges.md`.
