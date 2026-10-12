# Runbook: applying 019 to the hosted project (plan only)

Status: **a plan, not an authorization.** Of the steps below, only the read-only preflight has been run
against the hosted project (Phase 1.7, result BLOCKED: the project is at 015). Phase 1.7 also ran other
read-only catalog queries, listed in `docs/review-019-privileges.md`. Every step that changes the
database needs the project owner's explicit go for that step, given after the preflight output has been
shown. The review of the SQL is in `docs/review-019-privileges.md`.

The procedure was rehearsed on a local PostgreSQL 17.10 replica of the hosted schema (hosted 015 text,
package v4, then this procedure). Every claim below marked *rehearsed* comes from that run. The real
project differs from the replica (see the N4 table in the review): PostgreSQL 17.11, `supautils`, four
more event triggers, Supabase's own roles. The first real run is the first test of those differences.
019 being one statement is what bounds the damage if one of them interferes: it then refuses as a whole.

## Files

| File | Identity | Role |
|---|---|---|
| `supabase/drafts/019_table_privileges.sql` | sha256 in `019_table_privileges.sql.sha256` (`69881ea7…`); md5 `5384d51b1428e1f95bc49d83484eab49` | the change; one `DO` statement |
| `supabase/drafts/019_preflight.sql` | sha256 in `019_preflight.sql.sha256` | read-only state check, before and after |
| `supabase/tests/02_money_catalog.sql` | — | read-only catalog snapshot (one `SELECT`, JSON) |
| `scripts/check-privileges.ts` | — | compares the snapshot with `scripts/privilege-registry.ts` |
| `supabase/drafts/v4/apply_016_017.sql` (package v4) | sha256 in `apply_016_017.sql.sha256` (`2816d6898259be0057043b588f0becaceb053383050dab234b6ce788ebc2c081`); `README.md` beside it | 016 + 017; a separate rollout with its own authorization. Copied byte for byte from the session scratchpad in Phase 1.9; durable only once committed and pushed |

## 0. Two stages, two authorizations

Package v4 (016 + 017) and 019 are applied in separate stages, each under its own explicit authorization
from the owner. **Neither authorization has been given.** 019 is not ready for the hosted project until
its preflight passes on the state that stage 1 leaves.

| | Stage 1: package v4 | Stage 2: 019 |
|---|---|---|
| Authorization | the owner's go for v4, naming sha256 `2816d689…` — **not given** | the owner's go for 019, naming sha256 `69881ea7…` — **not given**; possible only after stage 1 and its postchecks passed |
| Preconditions | (1) `supabase/drafts/v4/apply_016_017.sql` is committed and pushed, its sha256 checks, and the embedded-text check in its README gives `matches` twice; (2) therefore the 016/017 committed in the repository are the texts inside it (`73d599bb…`, `efbc5be4…`); (3) the deployed application is compatible: §11 (no reachable path depends on 016/017 today); (4) a backup or PITR point; (5) a window with little write traffic: v4 takes ACCESS EXCLUSIVE locks on money tables and gives up after 5 s per lock; (6) no long transaction open (query in §1) | §1 below |
| Preflight (read-only) | `019_preflight.sql` gives the **015 signature**: `BLOCKED`, failures exactly `A3 H3 H4 O3 S1 S2 S3 S4 S5 S6`, `T1` and `V1` ok, warnings `D1` `M4` (seen on hosted, Phase 1.7). Anything else: stop. v4's own preflight then also requires the exact 015 fingerprint (`87f076b6…`, 1240 items) and history text | §2: `PASS`, and step 2 with profile 017 matches |
| Application | the v4 file unchanged, one `DO` statement: `psql "<conn>" -X -v ON_ERROR_STOP=1 -f apply_016_017.sql`, or the SQL Editor with the whole file and the destructive-operation prompt (DROP FUNCTION). It writes its two history rows inside the same statement | §4 |
| Postchecks | `DO` (psql) or "Success. No rows returned" (editor); then `019_preflight.sql` gives `PASS` (`H3`: rows md5 `5f7d9d01…`, `e83898e9…`; `S1`–`S6`, `A3`, `O3` ok); step 2 with profile 017 matches; the owner checks the limits path of the application | §5: failures exactly `A2 A4 A5 H4`; history md5 `5384d51b…`; step 2 with profile 019 |
| Stop criteria | anything but the 015 signature before; a hash mismatch; application compatibility unknown; v4 refuses (keep the error text, do not edit or re-run); anything but `PASS` after | §6 |
| Ambiguous result (editor error or timeout, lost connection) | no write, no re-run. Run `019_preflight.sql` read-only: the 015 signature means v4 was not applied (find the cause); `PASS` means applied and recorded (continue with the postchecks); anything else: stop and escalate | §8 |

The two stages share the tools (`019_preflight.sql`, `02_money_catalog.sql`, `check-privileges.ts`) but
not the expected results. Between stages, a regular read-only drift check compares with the signature of
the current stage: the 015 signature, then `PASS`, then `A2 A4 A5 H4`.

## 1. Admission conditions for stage 2 (all of them)

1. Package v4 has been applied to the hosted project under its own authorization, and its built-in
   postflight passed.
2. The owner has recorded decisions A, B and C (§9), and has approved this file by its sha256.
3. `cd supabase/drafts && sha256sum -c 019_table_privileges.sql.sha256 019_preflight.sql.sha256` succeeds
   on the machine that will send the SQL. The text sent is built from that file only — never copied from a
   document, a chat or a scratch directory.
4. A backup or point-in-time recovery point newer than v4 exists. It is a disaster-recovery tool, not a
   rollback: restoring it also discards every write made since.
5. A window with little write traffic. 019 waits at most 5 s for each lock it needs (`lock_timeout`
   inside the file), then refuses as a whole (*rehearsed*: an open transaction that had written to `audit_logs` made it
   give up after 5.0 s with nothing applied and no history row). Before starting, check read-only that no
   long transaction is open, without reading query texts:

   ```sql
   set transaction read only;
   select pid, usename, state, now() - xact_start as xact_age, wait_event_type
   from pg_stat_activity where xact_start < now() - interval '30 seconds' and pid <> pg_backend_pid();
   ```

## 2. Preflight, immediately before

Read-only; both must pass, and the outputs are kept with the rollout record.

1. `019_preflight.sql`:
   - psql: `psql "<connection>" -X -v ON_ERROR_STOP=1 -c 'begin transaction read only' -f supabase/drafts/019_preflight.sql -c 'rollback'`;
   - or the SQL Editor: paste the whole file and run it all at once.

   Required: verdict `PASS`, `T1 ok` (read only: on). Read `I1`: a `statement_timeout` shorter than 019's
   run would cancel it (nothing applied). 019 writes catalog rows only and reads no table data; its
   duration on hosted was not measured. Expected warnings: `D1` (N3) and `M4` (roles that
   read everything). Run it in the SQL Editor even if 019 will go through psql: `T1 ok` there proves that
   the editor ran the pasted text as one transaction, which step 4 relies on.
2. `02_money_catalog.sql` the same way. Save its JSON (about 105 kB) to a file and run
   `node --experimental-strip-types scripts/check-privileges.ts <file> 017`. Required: it matches. Keep the
   file: it is the exact record of every privilege before 019.

## 3. What confirms 016/017

The preflight checks history and state separately:
- **History.** `H2`: 001–015 exactly as applied (version, name, md5 of the text). `H3`: 016 and 017 recorded by v4 (md5 `5f7d9d01…`, `e83898e9…`), after 015, in order. `H4`: 17 rows, no 019.
- **State.** `S1`–`S6`: 016 and 017 markers. `A4`: the eight functions in the state 017 leaves.
- **Everything else.** Step 2 compares every privilege, policy and function attribute.

## 4. Applying

The file is one `DO` statement. PostgreSQL runs a statement atomically, so 019 itself is all-or-nothing
in every client (*rehearsed* in Phase 1.6 on 16 and 17, three client modes). The history row is a second
statement. It is atomic with 019 only when both run in one transaction, so it is appended to the same
text:

```bash
cd supabase/drafts
grep -q 'jimocex019' 019_table_privileges.sql && echo "tag collision: stop"
V=$(date -u +%Y%m%d%H%M%S)
{ cat 019_table_privileges.sql
  printf "\ninsert into supabase_migrations.schema_migrations (version, name, statements)\nvalues ('%s', '019_table_privileges', array[\$jimocex019\$" "$V"
  cat 019_table_privileges.sql
  printf "\$jimocex019\$]);\n"; } > /tmp/apply_019.sql
```

Methods, in order of preference:

| Method | What makes it atomic | What the client tells you |
|---|---|---|
| `psql "<conn>" -X -v ON_ERROR_STOP=1 -1 -f /tmp/apply_019.sql` | `-1`: one transaction | exit 0 committed; exit 3 refused and rolled back; exit 2 connection lost: unknown, see §8 |
| SQL Editor, the whole of `apply_019.sql` pasted and run at once (no selection) | one message is one implicit transaction (shown by `T1` in step 2.1) | an error means rolled back; a timeout or a closed tab means unknown, see §8 |

*Rehearsed* (psql sending the text as one message, as the editor does):
- a history insert that fails rolls 019 back too;
- the successful run records the row with the md5 above.

Never:
- **`psql -f` without `-1` and `ON_ERROR_STOP`.** *Rehearsed*: when 019 refuses, psql carries on, the history row is written anyway and psql exits 0, so the history then claims 019 ran. For 019 alone this mode is harmless; with the history row it is not.
- **Running the statements one at a time** (selection in the editor).
- **Running a copy of the text.**
- **An agent's `apply_migration` call.**

Authorization: the owner gives the go for this step after seeing the step-2 outputs. Nobody runs it twice.
A second run is refused by 019's own preflight (*rehearsed*: refused, unchanged, still one history row),
but that is a safety net, not a procedure.

## 5. Postchecks, immediately after

1. **`019_preflight.sql` (read-only).** Expected: `BLOCKED` with exactly these failures:
   - `A2`: the four columns `notifications.read_at`, `notifications.status`, `profiles.country_code`, `profiles.display_name`;
   - `A4`: `has_admin_role`, `is_admin`;
   - `A5`: anon no longer reads the 17 non-reference tables, `service_role` cannot truncate `audit_logs`, the two triggers exist;
   - `H4`: 18 rows.

   That set is the signature of "019 applied and nothing else changed" (*rehearsed*). Any other failure is a stop.
2. **History row.** `select md5(statements[1]) from supabase_migrations.schema_migrations where name = '019_table_privileges'` returns `5384d51b1428e1f95bc49d83484eab49`.
3. **Catalog comparison.** `02_money_catalog.sql` (read-only), then `check-privileges.ts <file> 019`: it matches (*rehearsed*).
4. **Application smoke, by the owner, through the real gateway.** Sign in; read your own wallet, ledger and notifications; rename the profile; mark a notification read; open the public market pages signed out. Each must work. A refusal where the app expected rows means an app path read a table its role may no longer read: §7, not a re-grant.

## 6. Stop criteria

Before applying, stop and do not apply when:
- the preflight is not `PASS`;
- step 2 does not match;
- a hash does not match;
- `T1` is not ok in the editor that will be used;
- a long transaction is open;
- 019 refuses with `lock_timeout` twice: find the transaction instead of retrying;
- the owner's go is missing.

After applying, stop and go to §7 when:
- the postcheck signature differs;
- step 2 with profile 019 does not match;
- the history md5 differs;
- the smoke test fails.

Never "fix" the state by hand under time pressure.

## 7. Rollback limits and recovery

019 is not fully reversible, and there is no prepared reverse script.
- **ACL.** The previous state can be recomputed from the step-2 JSON. But restoring it means granting again
  INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN to `anon` and `authenticated` on every table,
  TRUNCATE to `service_role` on `audit_logs` and `risk_events`, and EXECUTE on `is_admin`/`has_admin_role`.
  That widens access to exactly what the review found excessive. Re-granting also does not reproduce the
  ACL arrays byte for byte (order of entries), and the four column grants must be revoked explicitly.
- **Triggers.** Dropping `audit_logs_no_truncate` and `risk_events_no_truncate` gives TRUNCATE back to any
  role that holds the privilege. Nothing else depends on them.
- **Policies and functions.** 019 does not change them; there is nothing to restore.

Recovery is forward and narrow:
1. Identify the refused request (role, table, privilege) from the application error.
2. Write the smallest grant that serves it (e.g. `grant select on public.<table> to authenticated`) as a new reviewed migration (020), registry entry included.
3. Run it through the same preflight → authorization → postcheck path.

A blanket re-grant, or the "inverse of 019", needs the owner's explicit decision, given with the knowledge
that it re-opens the privileges above.

## 8. When the result is ambiguous

The SQL Editor shows an error or times out, the tab closes, psql exits 2, or the network drops after the
text was sent. The commit may or may not have happened. **Do not run anything that writes, and do not run
019 again.** First, read-only:

1. Run `019_preflight.sql` (read-only) and classify:

| Preflight result | Meaning | Next |
|---|---|---|
| `PASS` | 019 was not applied; nothing changed | find the cause (lock timeout, statement timeout — see `I1` — or a lost connection) before a new authorized attempt |
| `BLOCKED`, failures exactly `A2 A4 A5 H4` | 019 applied and recorded | continue with §5 |
| `BLOCKED`, failures exactly `A2 A4 A5`, `H4` ok | 019 applied without its history row (only possible if the row was sent separately) | record the row in a separate authorized step; do not re-run 019 |
| `BLOCKED`, `H4` only (history has 019, state is 017) | the history row was written without 019 (the psql trap in §4) | remove that row in a separate authorized step; re-assess |
| anything else | drift or a partial state that no procedure here produces | stop; take step 2's JSON; escalate |

2. Keep both outputs with the rollout record.

**One refusal message is mislabelled.** If 019 refuses with
`016: public.limit_usage_total(…) returning text does not exist`, the function concerned is created by
**017**, not 016: 017 has not been applied, or not fully. The check is right; only the label is wrong
(review, finding 9). The text is left as it is unless the owner decides otherwise (§9, decision D).

## 9. Owner decisions

Each row is a recommendation. **None has been approved.**

| | Question | Recommendation | Evidence | Risks | Revisit when | Status |
|---|---|---|---|---|---|---|
| A | `is_admin()`, `has_admin_role()` | Leave them without client executors, as 019 does (owner only). Postpone dropping them until the admin policies and UI are designed | No policy, function, application code or `pg_depend` entry uses them (repository search; hosted catalog, Phase 1.7). They answer `false` for `service_role` | Keeping: dead SECURITY DEFINER code, callable by the owner only. Dropping: recreating them if admin policies need them | admin UI or admin policies are designed | **RECOMMENDATION — OWNER APPROVAL REQUIRED** |
| B | `service_role` EXECUTE on `claim_deposit_for_credit`, `claim_provider_event`, `expire_stale_quotes`, `ledger_post`, `mark_trade_settled`, `release_withdrawal_hold` | Keep the grants 019 gives until Edge Functions, external jobs and the actual server contracts have been checked. No call site in this repository does not prove there is no call elsewhere | Repository: no caller of these six; `release_withdrawal_hold` calls `ledger_post` internally, as the owner, without a grant; `money-write.ts` documents `ledger_post` via `service_role` as the write path. Hosted: no `pg_depend` dependents, no `pg_cron`; `track_functions = none`, so no call statistics. Not checked: Edge Functions, external jobs | Keeping: a server key that leaks can call them (as it can already write the tables it holds). Revoking: a server flow written later fails until re-granted. Since 017, `ledger_post` is the only way to change a balance | each flow is written (with a test calling it as `service_role`), or the external check is done | **RECOMMENDATION — OWNER APPROVAL REQUIRED** |
| C | `supabase_admin`'s default privileges in `public` (N3) | Interim ban on creating objects in `public` other than through reviewed migrations run as `postgres` (§10), a request to Supabase Support (§10), and a regular read-only drift check. A project migration cannot do it: it runs as `postgres`, which may not change `supabase_admin`'s defaults (Phase 1.7, measured locally) | Hosted rows read in Phase 1.7; local cases 1–6 (`n3_local.py`) | The ban is procedural: a dashboard action can break it; detection is after the fact, and removing such an object needs `supabase_admin` | Support has changed the defaults, or before the first extension or new object in `public` | **RECOMMENDATION — OWNER APPROVAL REQUIRED** |
| D | the mislabelled refusal message (finding 9) | Leave the SQL as it is and keep the note in §8. Correct the text only together with another change to 019 | Phase 1.8: the label is in one DETAIL line; no test or harness matches it; the check itself is right | Changing it: new sha256, full re-test, new approval; the Phase 1.4–1.7 logs then describe the previous file | 019 changes for any other reason | **RECOMMENDATION — OWNER APPROVAL REQUIRED** |
| E | B2: `postgres`'s own default privileges for tables and sequences in `public` | A separate reviewed migration after 019 (§10), not part of 019 | Phase 1.7 case 2: a table `postgres` creates after 017 + 019 starts with every privilege for the client roles and RLS off | Without it, a future migration that forgets its GRANT/RLS lines exposes the table; with it, such a table is refused to the client roles (fail-closed) | the next migration that creates a table | **RECOMMENDATION — OWNER APPROVAL REQUIRED** |

## 10. Not part of 019: objects created later in `public` (N3, B2)

### Interim rule (decision C)

Until `supabase_admin`'s defaults in `public` are changed, nothing is created in `public` except by
`postgres` through a reviewed migration in `supabase/migrations`. In particular:
- extensions are installed with schema `extensions`, never `public`;
- no table, view, sequence or function is created from the Table Editor or the SQL Editor outside a migration;
- no integration that creates objects in `public` is switched on without a preflight before and after.

What can still create objects there (exceptions, each needing the owner's approval and a preflight before
and after):

| Creator | Runs as | What it may create in `public` | Source |
|---|---|---|---|
| Privileged extensions (`supautils.privileged_extensions`: `pg_trgm`, `vector`, `citext`, `hstore`, `pg_net`, …) installed with schema `public` | `supabase_admin` (`supautils.privileged_extensions_superuser`) | the extension's functions, types, operators, sometimes tables, with `supabase_admin`'s defaults | settings: Phase 1.7 read-only; ownership afterwards: not verified |
| Supabase platform maintenance and upgrades | `supabase_admin` | not known in advance | assumption |
| Dashboard features (Database Webhooks, Table Editor) | not verified | Webhooks add triggers to existing tables; the Table Editor creates tables | assumption; to verify before use |
| Migrations in this repository | `postgres` | anything they say, with `postgres`'s defaults (B2) | repository |

### Detection

Read-only, on a schedule (weekly), before and after every migration, and after any change to extensions:
1. `019_preflight.sql`, compared with the signature of the current stage (§0). A new object in `public` not owned by `postgres` fails `W1`; a new relation or function fails `O1` or `O3`; a new grantee fails `A1` or `A3`; a change of `supabase_admin`'s defaults shows in `D1`.
2. The catalog fingerprint of `public` (Phase 1.7's `fp_catalog_only.sql`, today only in the scratchpad: N7), compared with the previous run.

If an object appears that `postgres` does not own:
- stop deployments;
- do not try to REVOKE it: `postgres` is neither owner nor grantor, and the REVOKE does nothing (Phase 1.7, case 4);
- ask Support to hand it to `postgres` or drop it.

### Request to Supabase Support (draft, not sent)

> Project `sykhghtlkcrzwaoehlhf`. Role `supabase_admin` holds default privileges in schema `public` that
> grant every table privilege, sequence USAGE/SELECT/UPDATE and function EXECUTE to `anon`, `authenticated`
> and `service_role` on any object it creates there (`pg_default_acl`, read-only). Our migrations run as
> `postgres`, which is not a member of `supabase_admin` and cannot change these rows. We ask you to run, as
> `supabase_admin`, only the following, and nothing that changes existing objects:
>
> ```sql
> alter default privileges for role supabase_admin in schema public revoke all on tables    from anon, authenticated, service_role;
> alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated, service_role;
> alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated, service_role;
> ```
>
> Questions:
> 1. Do objects of a privileged extension installed in `public` stay owned by `supabase_admin`, or are they handed to `postgres`?
> 2. Does any platform job rely on these defaults in `public`?
> 3. Can a platform update restore them?
> 4. Do you advise a global `revoke execute on functions from public` for `supabase_admin`? We do not ask for it, because it would apply to functions you create in every schema.

The three statements leave `postgres`'s grant in each row, and leave PUBLIC's EXECUTE on new functions,
which comes from the built-in global default. A per-schema row cannot take that away; only a global
change can, and that one reaches every schema (see question 4). Rehearsed locally (Phase 1.8, rolled
back, on replica + v4 + 019 with hosted's rows recreated). After the three statements:
- a table `supabase_admin` creates gives the client roles nothing (`postgres` keeps `arwdDxtm`);
- a function it creates is still executable through PUBLIC, `anon` included.

Checks around the intervention, all read-only:
- **Before:** the three `supabase_admin` rows for `public` read as in Phase 1.7; the fingerprint; the preflight signature of the current stage.
- **After:**
  - the `public` rows of `supabase_admin` list `postgres` only;
  - its rows for `graphql`, `graphql_public`, `extensions` and `realtime` are unchanged;
  - the fingerprint is unchanged: no existing object was touched;
  - `D1` no longer warns.

  Then compute what a new object would get:

  ```sql
  set transaction read only;
  select o.rolname || ' creates ' || t.label || ': ' ||
         coalesce((select string_agg(distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                                     || ' ' || a.privilege_type, ', ')
                   from aclexplode(coalesce((select defaclacl from pg_default_acl where defaclrole = o.oid and defaclnamespace = 0 and defaclobjtype = t.objtype::"char"),
                                            acldefault(t.acltype::"char", o.oid))
                                   || coalesce((select defaclacl from pg_default_acl where defaclrole = o.oid and defaclnamespace = 'public'::regnamespace and defaclobjtype = t.objtype::"char"),
                                               '{}'::aclitem[])) a
                   where a.grantee <> o.oid), 'nothing beyond the owner')
  from pg_roles o
  cross join (values ('r', 'r', 'table'), ('S', 's', 'sequence'), ('f', 'f', 'function')) t(objtype, acltype, label)
  where o.rolname in ('postgres', 'supabase_admin');
  ```

### B2: `postgres`'s own defaults (decision E)

Independent of N3, and within the project's reach. The minimal change is a migration run as `postgres`, after 019:

```sql
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke truncate, references, trigger on tables from service_role;
-- PostgreSQL 17 only (MAINTAIN does not exist on 16), as 019 does it:
-- revoke maintain on tables from service_role, inside a version check
```

It changes no existing ACL, and nothing in 019. Rehearsed locally (Phase 1.8, rolled back):
- a table `postgres` then creates gives `anon` and `authenticated` nothing, and `service_role` SELECT, INSERT, UPDATE, DELETE only;
- without it, the same table gives all three roles every privilege.

Tests it would need (none written yet):
- **Fail-closed behaviour.** In `01_invariants.sql`: a table created as `postgres` inside the test transaction is not readable or writable by `anon` and `authenticated`, and `service_role` holds only data privileges on it.
- **Registry rule.** In `privilege-registry.ts`: `postgres`'s default rows for `r` and `S` in `public` grant nothing to `anon` or `authenticated`.
- **Negative test.** A test that re-grants a default fails the check.
- **Hosted.** Read-only, before and after: the computation above.

`postgres`'s defaults in `storage` are of the same kind and are not covered here.

## 11. The application against the schema (Phase 1.9)

Every place the application reaches the database, in the working tree. `src/` is unchanged since `b0ea211`.

| Application code | Needs | Hosted 001–015 | After v4 (017) | After 019 |
|---|---|---|---|---|
| `src/lib/engines/limit-engine.ts:163`: `rpc("limit_usage_total")` in `usageInWindow`, used only by `checkEligibility` (line 54), with the admin client | the function 017 creates; EXECUTE for `service_role` | missing: the call errors, `usageInWindow` returns null, `checkEligibility` answers `UNAVAILABLE` ("limit usage could not be read"), never "assume zero" | works | works (019 does not change `limit_usage_total`) |
| reachability of the row above | `checkEligibility` has no caller: no page, route handler or server action in `src/app` uses it | not reached | not reached | not reached |
| GitHub tip `1131d9e`, `limit-engine.ts:87`: `rpc("limit_usage_in_window")` | the 014 function | works | missing (016 drops it); refused the same way | missing |
| reachability at `1131d9e` | `checkEligibility` has no caller there either | not reached | not reached | not reached |
| `src/app/(app)/dashboard/page.tsx:62, 67, 84`: `account_tiers`, `tier_limits`, `wallets` (user client; money columns as `::text`) | SELECT for `authenticated`; column types unchanged | works | works: 017 adds CHECK constraints, replaces functions and revokes writes; it revokes no SELECT and changes no column | works: `authenticated` keeps SELECT (the application's own requests ran under 019 through PostgREST, Phase 1.6) |
| `src/lib/auth/session.ts:53, 139, 184`: `profiles`, `account_tiers`, `admin_users` | SELECT for `authenticated` | works | works | works |
| `src/lib/markets/pairs.ts:33, 108`: `trading_pairs`, `assets`, also signed out | SELECT for `anon` and `authenticated` | works | works | works: the six reference tables keep `anon` SELECT |
| `src/app/auth/actions.ts`, `src/app/auth/confirm/route.ts`, `src/proxy.ts`: Supabase Auth; a sign-up fires `handle_new_user()` | the trigger; EXECUTE is not checked when a trigger fires | works | works: the invariant suite inserts into `auth.users` under profiles 017 and 019 | works |
| `src/lib/db/money-write.ts` (`moneyInsert`, `moneyArgs`) | — | no caller outside tests | — | — |
| `src/lib/supabase/database.types.ts` | describes 017, written by hand | compile time only | — | — |

**What detects a mismatch:**
- `test:db` and `test:db:019` build the schema from the repository (001–017). They check the code against 017, never against the hosted 015.
- The unit tests do not reach a database: `limit-rules.test.ts` covers the pure rules.
- On hosted, `019_preflight.sql` check S1 reports a missing `limit_usage_total` (read-only).
- At run time `checkEligibility` refuses instead of guessing.

**Order.**
- Every path the application can reach today behaves the same on 015 and on 017, so publishing a Preview and applying v4 do not depend on each other.
- The dependency appears with the first change that calls `checkEligibility` from a route. On 015 that path answers `UNAVAILABLE` to every request: blocked, not unsafe. That release goes live after v4, or behind a switch.
- A deployment of `1131d9e` would lose `limit_usage_in_window` when 016 runs, also on an unreachable path. No such deployment exists in the Vercel account checked in Phase 1.8.

**Before any public deployment** (not part of 019):
- **Next.js.** 16.3.5 was affected by seven advisories, among them GHSA-vcvr-r3jv-pc5j (critical, code execution through `next/og`'s `ImageResponse`, fixed in 16.3.6) and GHSA-cjq9-62q9-8jv4 (high, SSRF in Image Optimization, fixed in 16.3.8). Phase 2.2 pins `next` and `eslint-config-next` to 16.3.8, the last 16.3.x patch: `npm audit --omit=dev` reports nothing, and the five dev-only findings left (GHSA-vfj7-8cjw-p6xm in `braces`, through the lint plugin) have no patched version.
- **The database behind a Preview.** There is one hosted project. A Preview pointed at it writes real rows (sign-ups) into it. The isolated test database and the Preview configuration are planned in `docs/preview-environment.md`.
