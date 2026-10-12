-- =============================================================================
-- JimoCex — 019: table privileges that follow the RLS policies (DRAFT)
--
-- Status: reviewed draft, NOT a migration yet. It lives outside
-- supabase/migrations so that neither scripts/test-db.sh's migration loop nor
-- the Supabase CLI picks it up. The review, the expected privileges and the
-- test results are in docs/review-019-privileges.md; the exact text reviewed is
-- identified by 019_table_privileges.sql.sha256 next to this file, which
-- scripts/test-db.sh verifies before it runs the file
-- (npm run test:db:019).
--
-- THE WHOLE FILE IS ONE SQL STATEMENT (a DO block). PostgreSQL runs a single
-- statement atomically: if the preflight refuses or anything later fails,
-- nothing is applied, however the client sends it (psql with or without -1 or
-- ON_ERROR_STOP, the SQL Editor, a migration runner).
--
-- Order: 016 and 017 (package v4) first. 019 does not repeat what 017 does —
-- it relies on it — so the preflight refuses a database 017 has not reached.
-- Run as the owner of the objects in public (postgres on the hosted project).
-- =============================================================================

do $migration$
declare
  v_problems text[] := '{}';
  v_has_history boolean;
  v_name text;
begin
  -- 017 takes locks on money tables; 019's CREATE TRIGGER takes a lock on
  -- audit_logs and risk_events that blocks their writers. Give up rather than
  -- queue behind a long transaction and stall every writer queued behind us.
  perform set_config('lock_timeout', '5s', true);

  -- ---------------------------------------------------------------------------
  -- 0. Preflight: read-only checks of the catalog. Nothing above changes state.
  -- ---------------------------------------------------------------------------

  -- Only the owner (or a superuser) can revoke; anyone else's REVOKE is a
  -- warning that changes nothing, and the result would look applied.
  if not exists (select 1 from pg_roles where rolname = current_user and rolsuper) then
    if exists (select 1 from pg_class c
               where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
                 and not pg_has_role(current_user, c.relowner, 'USAGE'))
       or exists (select 1 from pg_proc p
                  where p.pronamespace = 'public'::regnamespace
                    and not pg_has_role(current_user, p.proowner, 'USAGE')) then
      v_problems := v_problems || format('%s does not own every table and function in public', current_user);
    end if;
  end if;

  -- Where the database records its migration history, 016 and 017 must be in it.
  -- (Looked up through pg_class: resolving the name in a schema the role may not
  -- use would raise instead of reporting.)
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'supabase_migrations' and c.relname = 'schema_migrations') then
    if not (has_schema_privilege('supabase_migrations', 'USAGE')
            and has_table_privilege('supabase_migrations.schema_migrations', 'SELECT')) then
      v_problems := v_problems || format('%s cannot read supabase_migrations.schema_migrations', current_user);
      v_has_history := false;
    else
      execute 'select exists (select 1 from supabase_migrations.schema_migrations)' into v_has_history;
    end if;
    if v_has_history then
      foreach v_name in array array['016_money_functions_return_text', '017_money_integrity'] loop
        if not exists (select 1 from supabase_migrations.schema_migrations s where s.name = v_name) then
          v_problems := v_problems || format('migration %s is not in supabase_migrations.schema_migrations', v_name);
        end if;
      end loop;
    end if;
  end if;

  -- What 016 leaves behind.
  if to_regprocedure('public.limit_usage_total(uuid, public.limit_operation, text, timestamp with time zone)') is null
     or (select prorettype from pg_proc
          where oid = to_regprocedure('public.limit_usage_total(uuid, public.limit_operation, text, timestamp with time zone)'))
        <> 'text'::regtype then
    v_problems := v_problems || '016: public.limit_usage_total(…) returning text does not exist'::text;
  end if;
  if to_regprocedure('public._jimocex_ddl_probe()') is not null then
    v_problems := v_problems || '016: the diagnostic probe public._jimocex_ddl_probe() still exists'::text;
  end if;

  -- What 017 leaves behind, and 019 relies on without repeating it.
  foreach v_name in array array['ledger_entries_no_truncate', 'limit_usage_no_truncate'] loop
    if not exists (select 1 from pg_trigger where tgname = v_name and not tgisinternal) then
      v_problems := v_problems || format('017: trigger %s does not exist', v_name);
    end if;
  end loop;
  if has_table_privilege('service_role', 'public.wallets', 'INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('service_role', 'public.ledger_entries', 'INSERT, UPDATE, DELETE, TRUNCATE') then
    v_problems := v_problems || '017: service_role can still write wallets or ledger_entries directly'::text;
  end if;
  if exists (select 1 from pg_proc p
             where p.pronamespace = 'public'::regnamespace and has_function_privilege('public', p.oid, 'EXECUTE')) then
    v_problems := v_problems || '017: a function in public is still executable by PUBLIC'::text;
  end if;

  -- Every object this file names exists.
  foreach v_name in array array[
    'public.account_tiers', 'public.asset_networks', 'public.assets', 'public.fee_rules', 'public.tier_limits',
    'public.trading_pairs', 'public.admin_users', 'public.deposits', 'public.kyc_verifications',
    'public.ledger_entries', 'public.limit_usage', 'public.notifications', 'public.profiles',
    'public.swap_orders', 'public.swap_quotes', 'public.trades', 'public.trading_orders', 'public.wallets',
    'public.withdrawals', 'public.audit_logs', 'public.risk_events'] loop
    if to_regclass(v_name) is null then
      v_problems := v_problems || format('table %s does not exist', v_name);
    end if;
  end loop;
  foreach v_name in array array[
    'public.claim_deposit_for_credit(uuid)', 'public.claim_provider_event(uuid)', 'public.expire_stale_quotes()',
    'public.has_admin_role(public.admin_role[])', 'public.is_admin()',
    'public.ledger_post(uuid, uuid, public.ledger_entry_type, numeric, numeric, numeric, text, uuid, text, jsonb)',
    'public.mark_trade_settled(uuid)', 'public.release_withdrawal_hold(uuid)'] loop
    if to_regprocedure(v_name) is null then
      v_problems := v_problems || format('function %s does not exist', v_name);
    end if;
  end loop;

  -- 019 has not run already.
  foreach v_name in array array['audit_logs_no_truncate', 'risk_events_no_truncate'] loop
    if exists (select 1 from pg_trigger where tgname = v_name and not tgisinternal) then
      v_problems := v_problems || format('019 has already run: trigger %s exists', v_name);
    end if;
  end loop;

  if cardinality(v_problems) > 0 then
    raise exception '019 refused: the database is not in the state 019 was written for (% problem(s)); nothing was changed',
                    cardinality(v_problems)
      using errcode = 'object_not_in_prerequisite_state',
            detail = array_to_string(v_problems, E'\n'),
            hint = 'Apply 016 and 017 (package v4) first, as the owner of the objects in public; 019 runs once.';
  end if;

  -- ---------------------------------------------------------------------------
  -- 1. Client roles: exactly the privileges their policies use.
  -- ---------------------------------------------------------------------------
  revoke all on all tables in schema public from anon, authenticated;
  grant select on public.account_tiers, public.asset_networks, public.assets, public.fee_rules,
                  public.tier_limits, public.trading_pairs
    to anon, authenticated;
  grant select on public.admin_users, public.deposits, public.kyc_verifications, public.ledger_entries,
                  public.limit_usage, public.notifications, public.profiles, public.swap_orders,
                  public.swap_quotes, public.trades, public.trading_orders, public.wallets, public.withdrawals
    to authenticated;
  -- The columns the guard triggers let an owner change; the rest stay refused by the grant first.
  grant update (display_name, country_code) on public.profiles to authenticated;
  grant update (read_at, status) on public.notifications to authenticated;

  -- ---------------------------------------------------------------------------
  -- 2. service_role: data privileges only, and not what an append-only trigger refuses anyway.
  -- ---------------------------------------------------------------------------
  revoke truncate, references, trigger on all tables in schema public from service_role;
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on all tables in schema public from service_role';
  end if;
  revoke update, delete on public.audit_logs, public.limit_usage from service_role;
  revoke delete on public.risk_events from service_role;

  -- ---------------------------------------------------------------------------
  -- 3. The remaining append-only tables refuse TRUNCATE for every role, as ledger_entries and limit_usage do.
  -- ---------------------------------------------------------------------------
  create trigger audit_logs_no_truncate
    before truncate on public.audit_logs
    for each statement execute function public.forbid_mutation();
  create trigger risk_events_no_truncate
    before truncate on public.risk_events
    for each statement execute function public.forbid_mutation();

  -- ---------------------------------------------------------------------------
  -- 4. Functions whose service_role grant came only from Supabase's default: state it, or withdraw it.
  -- ---------------------------------------------------------------------------
  revoke all on function
    public.claim_deposit_for_credit(uuid),
    public.claim_provider_event(uuid),
    public.expire_stale_quotes(),
    public.has_admin_role(public.admin_role[]),
    public.is_admin(),
    public.ledger_post(uuid, uuid, public.ledger_entry_type, numeric, numeric, numeric, text, uuid, text, jsonb),
    public.mark_trade_settled(uuid),
    public.release_withdrawal_hold(uuid)
    from public, anon, authenticated, service_role;
  grant execute on function
    public.claim_deposit_for_credit(uuid),
    public.claim_provider_event(uuid),
    public.expire_stale_quotes(),
    public.ledger_post(uuid, uuid, public.ledger_entry_type, numeric, numeric, numeric, text, uuid, text, jsonb),
    public.mark_trade_settled(uuid),
    public.release_withdrawal_hold(uuid)
    to service_role;
  -- is_admin() and has_admin_role() answer for auth.uid(); the service_role key carries no user, so for
  -- service_role they always return false. No policy and no application code calls them: no executor.
end;
$migration$;
