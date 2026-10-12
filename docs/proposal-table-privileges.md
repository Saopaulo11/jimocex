# Proposal: table privileges that match the RLS policies

Status: **proposal, not approved, not part of 017.** Intended as its own migration after 016/017 are
applied. Nothing here has been run against the hosted project; the evidence below comes from local
PostgreSQL 16 and 17 clusters (the 17 one a replica of the hosted schema with package v4 applied).

## What clients hold today

Supabase grants `anon`, `authenticated` and `service_role` every table privilege on tables `postgres`
creates in `public`, and leaves the rest to RLS. 017 narrows the money tables; the rest is unchanged.
Effective privileges on the hosted project (read-only query) and on the post-017 replica:

`S` select · `I` insert · `U` update · `D` delete · `T` truncate · `R` references · `G` trigger · `M` maintain (PostgreSQL 17)

| Table | RLS policies | anon | authenticated | service_role |
|---|---|---|---|---|
| account_tiers, asset_networks, assets | SELECT → anon, authenticated | SIUDTRGM | SIUDTRGM | SIUDTRGM |
| admin_users | SELECT own row → authenticated | SIUDTRGM | SIUDTRGM | SIUDTRGM |
| profiles | SELECT, UPDATE own row → authenticated | SIUDTRGM | SIUDTRGM | SIUDTRGM |
| notifications | SELECT, UPDATE own row → authenticated | S.U.TRGM | S.U.TRGM | SIUDTRGM |
| audit_logs, idempotency_keys, provider_events, risk_events | none (server only) | STRGM | STRGM | SIUDTRGM |
| kyc_verifications | SELECT own → authenticated | STRGM | STRGM | SIUDTRGM |
| fee_rules, tier_limits, trading_pairs (after 017) | SELECT → anon, authenticated | SRGM | SRGM | SIUDRGM |
| deposits, limit_usage, swap_orders, swap_quotes, trades, trading_orders, withdrawals (after 017) | SELECT own → authenticated | SRGM | SRGM | SIUDRGM |
| wallets, ledger_entries (after 017) | SELECT own → authenticated | SRGM | SRGM | SRGM |

What the extra privileges mean:

- **INSERT / UPDATE / DELETE without a policy** — RLS refuses them (INSERT with an error, UPDATE and
  DELETE by matching no row). Safe as long as RLS stays enabled and no permissive policy is added by
  mistake; the grant layer adds nothing.
- **TRUNCATE** — not governed by RLS and not seen by row-level triggers. On `audit_logs` and
  `risk_events` (append-only by row trigger) it is the one way to remove rows. PostgREST exposes no
  TRUNCATE.
- **TRIGGER** — lets the role attach a trigger to the table; the trigger function then runs with the
  privileges of whoever writes the table later, including `SECURITY DEFINER` functions owned by `postgres`.
- **MAINTAIN** (PostgreSQL 17) — includes `LOCK TABLE` in any mode, i.e. blocking every reader and writer
  of the table.
- **REFERENCES** — would allow a foreign key to the table; a client role can only create temporary
  tables, which cannot reference permanent ones (`42P16`), so it is unusable.

None of these is reachable through the public API: `anon` and `authenticated` cannot log in; they are used
only by PostgREST (and pg_graphql), which issue generated CRUD statements and RPC calls, never DDL, LOCK or
TRUNCATE; no function is executable by them after 017; and no function builds SQL from its arguments.
They become reachable only if some future path lets these roles run arbitrary SQL.

None is needed: PostgREST uses SELECT/INSERT/UPDATE/DELETE (and EXECUTE for RPC); RLS needs only the
privilege of the command it governs; triggers fire without any table privilege of the caller; migrations
and administration run as the table owner, whose privileges do not depend on these grants. In the
application every client-role read is a SELECT on a table that keeps SELECT below (`account_tiers`,
`admin_users`, `assets`, `profiles`, `tier_limits`, `trading_pairs`, `wallets`); everything else goes
through the service-role client. The application writes no table with a client role.

## The two options

| | A. Keep, document | B. Narrow to the policies |
|---|---|---|
| Security | relies on RLS for writes and on "no arbitrary SQL" for TRUNCATE/TRIGGER/MAINTAIN | the grant layer alone refuses everything no policy allows; TRUNCATE/TRIGGER/MAINTAIN gone for client roles and service_role |
| Compatibility | nothing changes | API reads unchanged; a request a policy never allowed now gets *permission denied* instead of an empty result (e.g. anon reading `wallets`) — no application code does this |
| Effort | none | one migration; the tests are ready (Phase 1.4: privilege profile `019`) |
| Risk | a future mistake in a policy or a SQL path is not contained | a future table or feature needs its grants written explicitly |

Recommendation: **B**, as its own migration, after 016/017.

## B1 — existing tables

Reviewed in Phases 1.3–1.6 as the draft of migration 019: **`docs/review-019-privileges.md`** holds the
before/after privileges, the tests and their results. The review
refined this proposal (column-level UPDATE on `profiles` and `notifications`; `service_role` loses on the
append-only tables what their triggers refuse anyway; explicit executors for the eight functions whose
`service_role` grant came only from the default, with `is_admin` and `has_admin_role` getting none). The
SQL itself is kept in one place only: `supabase/drafts/019_table_privileges.sql`, identified by its
`.sha256`; the review holds the test results.

## B2 — tables created later (separate decision)

```sql
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from service_role;
-- and, on PostgreSQL 17: revoke maintain on tables from service_role
```

Measured: a table created afterwards gets nothing for `anon`/`authenticated` and `SIUD` for
`service_role`. This applies the function rule to tables: every new table states its client grants next
to its policies. It departs from the Supabase convention, so Studio-created tables would also start with
no client access.
