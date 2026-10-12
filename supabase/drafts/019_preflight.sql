-- =============================================================================
-- JimoCex — read-only preflight for 019 (supabase/drafts/019_table_privileges.sql)
--
-- `set transaction read only` and ONE SELECT over the system catalog and the
-- migration history (version, name and the md5 of the recorded SQL; nothing
-- else from it). It reads no application table, writes nothing and calls no
-- function with a side effect. It must still run inside a READ ONLY
-- transaction, so that the database itself refuses any write; check T1 fails
-- (and the verdict is BLOCKED) when it does not:
--
--   psql "<connection>" -X -v ON_ERROR_STOP=1 \
--     -c 'begin transaction read only' -f 019_preflight.sql -c 'rollback'
--
--   SQL Editor: paste this whole file and run it as it is. The editor sends
--   it as one message, which PostgreSQL runs as one transaction, so the first
--   line makes the SELECT read only; the editor shows the SELECT's rows.
--
--   Plain `psql -f` without the BEGIN above: SET TRANSACTION only warns there,
--   T1 fails and the verdict is BLOCKED. Use the BEGIN form.
--
-- Output: one row per check, the verdict first. The verdict is PASS only if
-- every check of severity "block" holds; a check that cannot be evaluated
-- counts as failed. "warn" rows are known risks outside 019 (they do not change
-- the verdict); "info" rows only report. If the query itself errors, the result
-- is BLOCKED (not verified).
--
-- Second, separate read-only step before rollout: run
-- supabase/tests/02_money_catalog.sql the same way, save its JSON, and run
--   node --experimental-strip-types scripts/check-privileges.ts <json> 017
-- which compares every privilege, policy expression and function attribute with
-- the registry. Both must pass. Expected values below match the state package
-- v4 leaves on the hosted project (PostgreSQL 17).
-- =============================================================================

set transaction read only;

with
expected_history(version, name, statements_md5) as (values
  ('20261010162334', '001_initial_schema',               '8455d51de02e38615af632dc29857909'),
  ('20261010163011', '002_account_tiers',                '35b25a34fdbe67b554444f324bde310f'),
  ('20261010163304', '003_assets_pairs',                 '13bd8855fe9634835be856fe927debf4'),
  ('20261010163345', '004_wallets_ledger',               '2265b618e6e105224d3492d7484dffa6'),
  ('20261010163453', '005_orders_trades',                'c4e61c777a41857d7168d35c91ab0c01'),
  ('20261010163557', '006_swaps',                        '4269dc5860711d41bbd602ed7f177428'),
  ('20261010163845', '007_deposits_withdrawals',         'a2e8b31c89c82bba072bad3482c44920'),
  ('20261010163928', '008_fees_kyc_risk',                'b09175242cc3e2938b7379a6dfe552f1'),
  ('20261010164021', '009_audit_idempotency_events',     '0e7d9e9d1325828c2882a2c1f9385f4b'),
  ('20261010164158', '010_rls',                          'fdb6b8beef2ae7cc683e121a5deb253a'),
  ('20261010164332', '011_seed_reference_data',          'e7752de23a2b2029bf2dcf7066c3664f'),
  ('20261010170148', '012_harden_functions',             '8204ac70615c4dc1de333145a85461c7'),
  ('20261010172408', '013_account_status_restricted',    '5bc684f495369e647c97fe99978acd2f'),
  ('20261010172555', '014_limit_usage',                  'd7d5983a4811c8c422bc4e05b0005eb1'),
  ('20261010175618', '015_tier0_exchange_trade_limits',  'a16b15d009dc9a77acf2c05cc5e3442a')
),
-- What package v4 records for 016 and 017: the md5 of the reviewed files' text.
expected_v4(name, statements_md5) as (values
  ('016_money_functions_return_text', '5f7d9d01cee5c693baf55626e487e3cb'),
  ('017_money_integrity',             'e83898e978d513ffac57f77e4def931f')
),
hist as (
  select version, name, md5(statements[1]) as statements_md5
  from supabase_migrations.schema_migrations
),
expected_tables(name) as (values
  ('account_tiers'), ('admin_users'), ('asset_networks'), ('assets'), ('audit_logs'), ('deposits'),
  ('fee_rules'), ('idempotency_keys'), ('kyc_verifications'), ('ledger_entries'), ('limit_usage'),
  ('notifications'), ('profiles'), ('provider_events'), ('risk_events'), ('swap_orders'), ('swap_quotes'),
  ('tier_limits'), ('trades'), ('trading_orders'), ('trading_pairs'), ('wallets'), ('withdrawals')
),
expected_functions(name) as (values
  ('claim_deposit_for_credit'), ('claim_provider_event'), ('consume_quote'), ('expire_stale_quotes'),
  ('forbid_mutation'), ('guard_notification_columns'), ('guard_order_status_transition'),
  ('guard_profile_privileged_columns'), ('guard_swap_status_transition'), ('guard_withdrawal_status_transition'),
  ('handle_new_user'), ('has_admin_role'), ('is_admin'), ('ledger_post'), ('limit_usage_total'),
  ('mark_trade_settled'), ('reconcile_wallets'), ('release_withdrawal_hold'), ('touch_updated_at')
),
-- The functions 019 changes, by exact signature.
changed_functions(sig) as (values
  ('public.claim_deposit_for_credit(uuid)'), ('public.claim_provider_event(uuid)'), ('public.expire_stale_quotes()'),
  ('public.has_admin_role(public.admin_role[])'), ('public.is_admin()'),
  ('public.ledger_post(uuid, uuid, public.ledger_entry_type, numeric, numeric, numeric, text, uuid, text, jsonb)'),
  ('public.mark_trade_settled(uuid)'), ('public.release_withdrawal_hold(uuid)')
),
-- Every RLS policy (010), with expressions as pg_get_expr prints them,
-- whitespace collapsed and `public.` removed (as scripts/privilege-check.ts compares them).
expected_policies(tbl, name, cmd, permissive, roles, using_expr, check_expr) as (values
  ('account_tiers', 'account_tiers_public_read', 'r', true, 'anon,authenticated', 'true', null),
  ('admin_users', 'admin_users_self_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('asset_networks', 'asset_networks_public_read', 'r', true, 'anon,authenticated', 'true', null),
  ('assets', 'assets_public_read', 'r', true, 'anon,authenticated', 'true', null),
  ('deposits', 'deposits_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('fee_rules', 'fee_rules_public_read', 'r', true, 'anon,authenticated', 'is_active', null),
  ('kyc_verifications', 'kyc_verifications_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('ledger_entries', 'ledger_entries_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('limit_usage', 'limit_usage_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('notifications', 'notifications_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('notifications', 'notifications_own_update', 'w', true, 'authenticated', '(user_id = auth.uid())', '(user_id = auth.uid())'),
  ('profiles', 'profiles_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('profiles', 'profiles_own_update', 'w', true, 'authenticated', '(user_id = auth.uid())', '(user_id = auth.uid())'),
  ('swap_orders', 'swap_orders_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('swap_quotes', 'swap_quotes_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('tier_limits', 'tier_limits_public_read', 'r', true, 'anon,authenticated', 'is_active', null),
  ('trades', 'trades_own_read', 'r', true, 'authenticated',
   '(EXISTS ( SELECT 1 FROM trading_orders o WHERE ((o.id = ANY (ARRAY[trades.buy_order_id, trades.sell_order_id])) AND (o.user_id = auth.uid()))))', null),
  ('trading_orders', 'trading_orders_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('trading_pairs', 'trading_pairs_public_read', 'r', true, 'anon,authenticated', 'true', null),
  ('wallets', 'wallets_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null),
  ('withdrawals', 'withdrawals_own_read', 'r', true, 'authenticated', '(user_id = auth.uid())', null)
),
actual_policies as (
  select c.relname as tbl, p.polname as name, p.polcmd::text as cmd, p.polpermissive as permissive,
         array_to_string(array(select case when r = 0 then 'PUBLIC' else pg_get_userbyid(r) end
                               from unnest(p.polroles) r order by 1), ',') as roles,
         btrim(regexp_replace(regexp_replace(pg_get_expr(p.polqual, p.polrelid), '\mpublic\.', '', 'g'), '\s+', ' ', 'g')) as using_expr,
         btrim(regexp_replace(regexp_replace(pg_get_expr(p.polwithcheck, p.polrelid), '\mpublic\.', '', 'g'), '\s+', ' ', 'g')) as check_expr
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relnamespace = 'public'::regnamespace
),
client(role) as (values ('anon'), ('authenticated'), ('service_role')),
public_relations as (
  select c.oid, c.relname, c.relkind::text as kind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
),
public_functions as (
  select p.oid, p.proname, p.proowner, p.proacl from pg_proc p where p.pronamespace = 'public'::regnamespace
),
default_acl as (
  select pg_get_userbyid(d.defaclrole) as owner, coalesce(n.nspname, '<every schema>') as schema,
         d.defaclobjtype::text as objtype, case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
         a.privilege_type
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join aclexplode(d.defaclacl) a
  where pg_get_userbyid(d.defaclrole) in ('postgres', 'supabase_admin')
),
checks(id, severity, ok, detail) as (
  -- History --------------------------------------------------------------------
  select 'H1', 'block', (select count(*) > 0 from hist),
         format('migration history: %s entries', (select count(*) from hist))
  union all
  select 'H2', 'block',
         not exists (select version, name, statements_md5 from expected_history
                     except select version, name, statements_md5 from hist),
         coalesce('001-015 missing or different: ' || (select string_agg(name, ', ' order by version) from (
                    select version, name, statements_md5 from expected_history
                    except select version, name, statements_md5 from hist) x),
                  '001-015 recorded exactly as applied (version, name, statement md5)')
  union all
  select 'H3', 'block',
         (select count(*) = 2 from hist h join expected_v4 e using (name, statements_md5))
         and (select max(version) from hist where name = '015_tier0_exchange_trade_limits')
             < (select min(version) from hist where name = '016_money_functions_return_text')
         and (select min(version) from hist where name = '016_money_functions_return_text')
             < (select min(version) from hist where name = '017_money_integrity'),
         coalesce('016/017 must be recorded by package v4 (md5 5f7d9d01, e83898e9), after 015, 016 before 017; recorded: '
                  || (select string_agg(h.name || ' ' || h.version || ' md5 ' || left(h.statements_md5, 8), ', ' order by h.version)
                      from hist h where h.name in (select name from expected_v4)),
                  '016/017 not recorded')
  union all
  select 'H4', 'block',
         (select count(*) = 17 from hist) and not exists (select 1 from hist where name ~* '019|privilege'),
         format('history holds %s entries (17 expected: 001-017, no 019)', (select count(*) from hist))
  -- State after 016/017 ---------------------------------------------------------
  union all
  select 'S1', 'block',
         coalesce((select prorettype = 'text'::regtype from pg_proc
                   where oid = to_regprocedure('public.limit_usage_total(uuid, public.limit_operation, text, timestamp with time zone)')), false)
         and not exists (select 1 from public_functions where proname = 'limit_usage_in_window'),
         '016 dropped public.limit_usage_in_window(); 017 created public.limit_usage_total(uuid, limit_operation, text, timestamptz) returning text'
  union all
  select 'S2', 'block', to_regprocedure('public._jimocex_ddl_probe()') is null,
         '016: the diagnostic probe public._jimocex_ddl_probe() is gone'
  union all
  select 'S3', 'block',
         (select count(*) = 2 from pg_trigger t join pg_class c on c.oid = t.tgrelid
          where c.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgenabled <> 'D'
            and (t.tgname, c.relname) in (('ledger_entries_no_truncate', 'ledger_entries'),
                                          ('limit_usage_no_truncate', 'limit_usage'))),
         '017: TRUNCATE guards on ledger_entries and limit_usage exist and are enabled'
  union all
  select 'S4', 'block',
         (select count(*) = 6 and bool_and(not has_table_privilege(cr.role, to_regclass(t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE'))
          from client cr cross join (values ('public.wallets'), ('public.ledger_entries')) t(tbl)
          where to_regclass(t.tbl) is not null),
         coalesce('017: client roles that can write or truncate wallets or ledger_entries directly: '
                  || (select string_agg(cr.role || ' on ' || t.tbl, ', ')
                      from client cr cross join (values ('public.wallets'), ('public.ledger_entries')) t(tbl)
                      where to_regclass(t.tbl) is not null
                        and has_table_privilege(cr.role, to_regclass(t.tbl), 'INSERT, UPDATE, DELETE, TRUNCATE')),
                  '017: no client role can write or truncate wallets or ledger_entries directly')
  union all
  select 'S5', 'block',
         not exists (select 1 from public_functions f where has_function_privilege('public', f.oid, 'EXECUTE')),
         coalesce('017: functions in public executable by PUBLIC: '
                  || (select string_agg(proname, ', ' order by proname) from public_functions f
                      where has_function_privilege('public', f.oid, 'EXECUTE')),
                  '017: no function in public is executable by PUBLIC')
  union all
  select 'S6', 'block',
         not exists (select 1 from default_acl where owner = 'postgres' and objtype = 'f' and privilege_type = 'EXECUTE'
                     and ((schema = '<every schema>' and grantee = 'PUBLIC')
                          or (schema = 'public' and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role'))))
         and exists (select 1 from pg_default_acl where defaclrole = 'postgres'::regrole and defaclnamespace = 0 and defaclobjtype = 'f'),
         '017: a function postgres creates is executable by no client role and not by PUBLIC by default'
  -- What 019 names ----------------------------------------------------------------
  union all
  select 'O1', 'block',
         not exists (select name from expected_tables except select relname from public_relations where kind = 'r')
         and not exists (select relname from public_relations except select name from expected_tables),
         coalesce('relations differ from the 23 expected tables: '
                  || (select string_agg(x, ', ') from (
                        (select 'missing ' || name from expected_tables except select 'missing ' || relname from public_relations where kind = 'r')
                        union all (select 'extra ' || relname || ' (' || kind || ')' from public_relations
                                   where relname not in (select name from expected_tables))) y(x)),
                  'public holds exactly the 23 expected tables and no other relation')
  union all
  select 'O2', 'block',
         not exists (select sig from changed_functions where to_regprocedure(sig) is null)
         and to_regprocedure('public.forbid_mutation()') is not null,
         coalesce('missing: ' || (select string_agg(sig, ', ') from changed_functions where to_regprocedure(sig) is null),
                  'the 8 functions 019 changes exist with their exact signatures, and forbid_mutation() exists')
  union all
  select 'O3', 'block',
         (select count(*) = 19 from public_functions)
         and not exists (select proname from public_functions except select name from expected_functions),
         format('public holds %s functions (19 expected)', (select count(*) from public_functions))
         || coalesce('; missing: ' || (select string_agg(name, ', ' order by name) from (
                       select name from expected_functions except select proname from public_functions) m), '')
         || coalesce('; unexpected: ' || (select string_agg(proname, ', ' order by proname) from (
                       select proname from public_functions except select name from expected_functions) u), '')
  -- Ownership ---------------------------------------------------------------------
  union all
  select 'W1', 'block',
         not exists (select 1 from public_relations where pg_get_userbyid(relowner) <> 'postgres')
         and not exists (select 1 from public_functions where pg_get_userbyid(proowner) <> 'postgres'),
         coalesce('not owned by postgres: '
                  || (select string_agg(n, ', ') from (
                        select relname || ' (' || pg_get_userbyid(relowner) || ')' from public_relations where pg_get_userbyid(relowner) <> 'postgres'
                        union all select proname || '() (' || pg_get_userbyid(proowner) || ')' from public_functions where pg_get_userbyid(proowner) <> 'postgres') o(n)),
                  'every table and function in public is owned by postgres')
  union all
  select 'W2', 'warn',
         (select rolsuper from pg_roles where rolname = current_user) or pg_has_role(current_user, 'postgres', 'USAGE'),
         format('running as %s: 019 must run as postgres (the owner); its own preflight refuses anyone else', current_user)
  -- Privileges ----------------------------------------------------------------------
  union all
  select 'A1', 'block',
         not exists (select 1 from public_relations r cross join aclexplode(r.relacl) a
                     where a.grantee = 0 or pg_get_userbyid(a.grantee) not in ('postgres', 'anon', 'authenticated', 'service_role')),
         coalesce('unexpected table grantees in public: '
                  || (select string_agg(distinct r.relname || ' -> ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end, ', ')
                      from public_relations r cross join aclexplode(r.relacl) a
                      where a.grantee = 0 or pg_get_userbyid(a.grantee) not in ('postgres', 'anon', 'authenticated', 'service_role')),
                  'table grants in public go to postgres, anon, authenticated and service_role only (not PUBLIC)')
  union all
  select 'A2', 'block',
         not exists (select 1 from pg_attribute att join public_relations r on r.oid = att.attrelid where att.attacl is not null),
         coalesce('column-level grants in public (017 has none; drift or a partial 019): '
                  || (select string_agg(r.relname || '.' || att.attname, ', ' order by r.relname, att.attname)
                      from pg_attribute att join public_relations r on r.oid = att.attrelid where att.attacl is not null),
                  'no column-level grants in public')
  union all
  select 'A3', 'block',
         not exists (select 1 from public_functions f cross join aclexplode(f.proacl) a
                     where a.grantee = 0 or pg_get_userbyid(a.grantee) not in ('postgres', 'service_role'))
         and not exists (select 1 from public_functions where proacl is null),
         coalesce('unexpected function grantees in public: '
                  || (select string_agg(x, ', ' order by x) from (
                        select distinct f.proname || '() -> ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end
                        from public_functions f cross join aclexplode(f.proacl) a
                        where a.grantee = 0 or pg_get_userbyid(a.grantee) not in ('postgres', 'service_role')
                        union all
                        select proname || '() -> PUBLIC (no ACL: built-in default)' from public_functions where proacl is null) g(x)),
                  'function grants in public go to postgres and service_role only')
  union all
  select 'A4', 'block',
         not exists (select 1 from changed_functions c
                     where to_regprocedure(c.sig) is null
                        or not has_function_privilege('service_role', to_regprocedure(c.sig), 'EXECUTE')
                        or has_function_privilege('anon', to_regprocedure(c.sig), 'EXECUTE')
                        or has_function_privilege('authenticated', to_regprocedure(c.sig), 'EXECUTE')),
         coalesce('the 8 functions 019 changes are not in the state 017 leaves (service_role executes all, anon and authenticated none): '
                  || (select string_agg(c.sig, ', ') from changed_functions c
                      where to_regprocedure(c.sig) is null
                         or not has_function_privilege('service_role', to_regprocedure(c.sig), 'EXECUTE')
                         or has_function_privilege('anon', to_regprocedure(c.sig), 'EXECUTE')
                         or has_function_privilege('authenticated', to_regprocedure(c.sig), 'EXECUTE')),
                  '017 state of the 8 functions 019 changes: service_role executes all, anon and authenticated none')
  union all
  select 'A5', 'block',
         not exists (select 1 from public_relations r where r.kind = 'r' and not has_table_privilege('anon', r.oid, 'SELECT'))
         and coalesce(has_table_privilege('service_role', to_regclass('public.audit_logs'), 'TRUNCATE'), false)
         and not exists (select 1 from pg_trigger
                         where tgname in ('audit_logs_no_truncate', 'risk_events_no_truncate') and not tgisinternal),
         coalesce('019 has run, at least in part: '
                  || nullif(concat_ws('; ',
                       (select 'anon no longer reads ' || string_agg(relname, ', ' order by relname) from public_relations r
                        where r.kind = 'r' and not has_table_privilege('anon', r.oid, 'SELECT')),
                       case when not coalesce(has_table_privilege('service_role', to_regclass('public.audit_logs'), 'TRUNCATE'), false)
                            then 'service_role cannot truncate audit_logs' end,
                       (select 'trigger ' || string_agg(tgname, ', ') from pg_trigger
                        where tgname in ('audit_logs_no_truncate', 'risk_events_no_truncate') and not tgisinternal)), ''),
                  '019 has not run, not even in part: anon still reads every table, service_role still truncates audit_logs, 019''s triggers absent')
  -- RLS -------------------------------------------------------------------------------
  union all
  select 'R1', 'block', not exists (select 1 from public_relations where kind = 'r' and not relrowsecurity),
         'RLS is enabled on every table in public'
  union all
  select 'R2', 'block', not exists (select 1 from public_relations where relforcerowsecurity),
         'no table forces RLS (the registry expects none)'
  union all
  select 'R3', 'block',
         not exists (select tbl, name, cmd, permissive, roles, using_expr, check_expr from expected_policies
                     except select tbl, name, cmd, permissive, roles, using_expr, check_expr from actual_policies)
         and not exists (select tbl, name, cmd, permissive, roles, using_expr, check_expr from actual_policies
                         except select tbl, name, cmd, permissive, roles, using_expr, check_expr from expected_policies),
         coalesce('policies differ: ' || (select string_agg(x, ', ') from (
                    (select 'missing/changed ' || tbl || '.' || name from (
                       select tbl, name, cmd, permissive, roles, using_expr, check_expr from expected_policies
                       except select tbl, name, cmd, permissive, roles, using_expr, check_expr from actual_policies) m)
                    union all
                    (select 'unexpected/changed ' || tbl || '.' || name from (
                       select tbl, name, cmd, permissive, roles, using_expr, check_expr from actual_policies
                       except select tbl, name, cmd, permissive, roles, using_expr, check_expr from expected_policies) u)) d(x)),
                  'the 21 RLS policies, whole: command, permissive, roles, USING and WITH CHECK')
  -- Roles -------------------------------------------------------------------------------
  union all
  select 'M1', 'block',
         (select count(*) = 3 from pg_roles r join client c on c.role = r.rolname
          where not (r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolcanlogin)
            and r.rolbypassrls = (r.rolname = 'service_role')),
         'anon, authenticated, service_role: no SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, LOGIN; only service_role BYPASSRLS'
  union all
  select 'M2', 'block',
         not exists (select 1 from pg_auth_members m where pg_get_userbyid(m.member) in (select role from client)),
         coalesce('client roles that are members of a role: ' || (select string_agg(pg_get_userbyid(m.member) || ' in ' || pg_get_userbyid(m.roleid), ', ')
                   from pg_auth_members m where pg_get_userbyid(m.member) in (select role from client)),
                  'no client role is a member of any role (SET-only included)')
  union all
  select 'M3', 'block',
         not exists (select 1 from pg_auth_members m
                     where pg_get_userbyid(m.roleid) in (select role from client)
                       and not (pg_get_userbyid(m.member) = 'postgres'
                                or (pg_get_userbyid(m.member) in ('authenticator', 'supabase_realtime_admin')
                                    and coalesce((to_jsonb(m) ->> 'inherit_option')::boolean, false) = false))),
         (select 'members of the client roles: ' || string_agg(distinct pg_get_userbyid(m.member)
                   || coalesce(' (inherit ' || (to_jsonb(m) ->> 'inherit_option') || ')', ''), ', ')
          from pg_auth_members m where pg_get_userbyid(m.roleid) in (select role from client))
  union all
  select 'M4', 'warn',
         not exists (select 1 from pg_auth_members m
                     where pg_get_userbyid(m.roleid) in ('pg_read_all_data', 'pg_write_all_data', 'pg_maintain'))
         and not exists (select 1 from pg_roles where rolsuper),
         coalesce('outside the model — read every row whatever 019 grants: '
                  || (select string_agg(distinct n, ', ') from (
                        select pg_get_userbyid(m.member) || ' (' || pg_get_userbyid(m.roleid) || ')' from pg_auth_members m
                        where pg_get_userbyid(m.roleid) in ('pg_read_all_data', 'pg_write_all_data', 'pg_maintain')
                        union all select rolname || ' (superuser)' from pg_roles where rolsuper) z(n)), 'none')
  union all
  select 'M5', 'info', true,
         format('postgres is %sa member of supabase_admin (decides whether postgres can change supabase_admin''s default privileges)',
                case when pg_has_role('postgres', 'supabase_admin', 'MEMBER') then '' else 'not ' end)
  -- Default privileges for objects created later ------------------------------------------
  union all
  select 'D1', 'warn',
         not exists (select 1 from default_acl where owner = 'supabase_admin' and schema = 'public'
                     and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')),
         coalesce('supabase_admin default privileges in public (N3, not changed by 017 or 019): '
                  || (select string_agg(objtype || ':' || grantee || ' ' || privilege_type, ', ' order by objtype, grantee, privilege_type)
                      from default_acl where owner = 'supabase_admin' and schema = 'public'), 'none')
  union all
  select 'D2', 'info', true,
         coalesce('postgres default privileges: ' || (select string_agg(schema || '/' || objtype || ':' || grantee || ' ' || privilege_type, ', '
                                                          order by schema, objtype, grantee, privilege_type)
                                                      from default_acl where owner = 'postgres'), 'none')
  union all
  select 'I1', 'info', true,
         format('this session: statement_timeout=%s lock_timeout=%s idle_in_transaction_session_timeout=%s; '
                || 'stored timeouts for postgres or this database: %s (019 sets lock_timeout 5s itself; a '
                || 'statement_timeout shorter than its run would cancel it, and nothing would be applied)',
                current_setting('statement_timeout'), current_setting('lock_timeout'),
                current_setting('idle_in_transaction_session_timeout'),
                -- timeout settings only: other stored settings may hold values that do not belong in a report
                coalesce((select string_agg(case when s.setrole = 0 then 'database ' else 'postgres ' end || cfg, ', ')
                          from pg_db_role_setting s cross join unnest(s.setconfig) cfg
                          where cfg ~ '^[a-z_]*timeout='
                            and (s.setrole = (select oid from pg_roles where rolname = 'postgres')
                                 or (s.setrole = 0 and s.setdatabase = (select oid from pg_database where datname = current_database())))),
                         'none'))
  union all
  select 'T1', 'block', current_setting('transaction_read_only') = 'on',
         'this check ran inside a READ ONLY transaction (transaction_read_only = '
         || current_setting('transaction_read_only') || ')'
  union all
  select 'V1', 'block', current_setting('server_version_num')::integer >= 170000,
         'PostgreSQL ' || current_setting('server_version') || ' (package v4 and this preflight expect 17)'
),
verdict as (
  select case when bool_and(ok is true) filter (where severity = 'block') then 'PASS' else 'BLOCKED' end as v,
         count(*) filter (where severity = 'block' and ok is not true) as blocking,
         count(*) filter (where severity = 'warn' and ok is not true) as warnings
  from checks
)
select '0 VERDICT' as check_id, '' as severity, v as result,
       format('%s blocking check(s) failed, %s warning(s); read only: %s', blocking, warnings,
              current_setting('transaction_read_only')) as detail
from verdict
union all
select id, severity,
       case when ok is true then 'ok' when severity = 'block' then 'FAIL' when severity = 'warn' then 'WARN' else 'info' end,
       detail
from checks
order by 1;
